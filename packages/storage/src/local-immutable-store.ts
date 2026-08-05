import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, link, mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

import {
  StoreObjectInputSchema,
  StoredObjectReferenceSchema,
  type StoreObjectInput,
  type StoredObjectReference,
} from "./reference.js";

export interface ImmutableObjectStore {
  read(reference: StoredObjectReference): Promise<Uint8Array>;
  store(input: StoreObjectInput): Promise<StoredObjectReference>;
}

export class ObjectIntegrityError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ObjectIntegrityError";
  }
}

function sha256(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function isAlreadyExistsError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

export class LocalImmutableObjectStore implements ImmutableObjectStore {
  readonly #rootDirectory: string;

  public constructor(rootDirectory: string) {
    this.#rootDirectory = resolve(rootDirectory);
  }

  public async store(untrustedInput: StoreObjectInput): Promise<StoredObjectReference> {
    const input = StoreObjectInputSchema.parse(untrustedInput);
    const content = Buffer.from(input.content);
    const digest = sha256(content);
    const key = this.#createKey(input.domain, digest, input.studentId, input.purpose);
    const targetPath = this.#resolveKey(key);

    await mkdir(dirname(targetPath), { recursive: true });

    if (await this.#exists(targetPath)) {
      await this.#verifyFile(targetPath, digest);
    } else {
      await this.#writeOnce(targetPath, content, digest);
    }

    return StoredObjectReferenceSchema.parse({
      domain: input.domain,
      key,
      sha256: digest,
      size: content.byteLength,
      ...(input.studentId === undefined ? {} : { studentId: input.studentId }),
      ...(input.purpose === undefined ? {} : { purpose: input.purpose }),
    });
  }

  public async read(untrustedReference: StoredObjectReference): Promise<Uint8Array> {
    const reference = StoredObjectReferenceSchema.parse(untrustedReference);
    const expectedKey = this.#createKey(
      reference.domain,
      reference.sha256,
      reference.studentId,
      reference.purpose,
    );
    if (reference.key !== expectedKey) {
      throw new ObjectIntegrityError("Stored object key does not match its domain and digest.");
    }

    const targetPath = this.#resolveKey(reference.key);
    const content = await readFile(targetPath);
    if (content.byteLength !== reference.size || sha256(content) !== reference.sha256) {
      throw new ObjectIntegrityError(
        "Stored object content no longer matches its immutable reference.",
      );
    }

    return content;
  }

  #createKey(
    domain: StoreObjectInput["domain"],
    digest: string,
    studentId?: string,
    purpose?: StoreObjectInput["purpose"],
  ): string {
    if (domain === "knowledge") {
      if (purpose === "analysis_report") {
        return `knowledge/reports/${digest.slice(0, 2)}/${digest}`;
      }
      return `knowledge/${digest.slice(0, 2)}/${digest}`;
    }

    if (domain === "student_import") {
      return `student-import/${digest.slice(0, 2)}/${digest}`;
    }

    if (studentId === undefined) {
      throw new ObjectIntegrityError("studentId is required for student objects.");
    }

    return `student/${studentId}/${digest.slice(0, 2)}/${digest}`;
  }

  #resolveKey(key: string): string {
    const targetPath = resolve(this.#rootDirectory, ...key.split("/"));
    const relativePath = relative(this.#rootDirectory, targetPath);
    if (relativePath === "" || relativePath.startsWith(`..${sep}`) || relativePath === "..") {
      throw new ObjectIntegrityError("Stored object key escaped the configured root directory.");
    }
    return targetPath;
  }

  async #exists(filePath: string): Promise<boolean> {
    try {
      await access(filePath, constants.F_OK);
      return true;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return false;
      }
      throw error;
    }
  }

  async #verifyFile(filePath: string, expectedDigest: string): Promise<void> {
    const existing = await readFile(filePath);
    if (sha256(existing) !== expectedDigest) {
      throw new ObjectIntegrityError("Existing object content does not match its address.");
    }
  }

  async #writeOnce(targetPath: string, content: Uint8Array, digest: string): Promise<void> {
    const temporaryPath = `${targetPath}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporaryPath, "wx", 0o600);
      try {
        await handle.writeFile(content);
        await handle.sync();
      } finally {
        await handle.close();
      }

      try {
        await link(temporaryPath, targetPath);
      } catch (error) {
        if (!isAlreadyExistsError(error)) {
          throw error;
        }
        await this.#verifyFile(targetPath, digest);
      }
    } finally {
      await unlink(temporaryPath).catch((error: unknown) => {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
          throw error;
        }
      });
    }
  }
}
