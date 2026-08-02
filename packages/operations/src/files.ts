import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";

export interface LocalObjectFile {
  readonly absolutePath: string;
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
}

export function assertSafeChildPath(root: string, candidate: string): string {
  const absoluteRoot = resolve(root);
  const absoluteCandidate = resolve(candidate);
  const relativePath = relative(absoluteRoot, absoluteCandidate);
  if (
    relativePath === "" ||
    isAbsolute(relativePath) ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`)
  ) {
    throw new Error("Operational path escaped or equaled its protected root.");
  }
  return absoluteCandidate;
}

async function sha256(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(filePath), hash);
  return hash.digest("hex");
}

export async function collectImmutableObjects(rootDirectory: string): Promise<LocalObjectFile[]> {
  await mkdir(rootDirectory, { recursive: true, mode: 0o700 });
  const canonicalRoot = await realpath(rootDirectory);
  const files: LocalObjectFile[] = [];

  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const candidate = assertSafeChildPath(canonicalRoot, resolve(directory, entry.name));
      const metadata = await lstat(candidate);
      if (metadata.isSymbolicLink()) {
        throw new Error("Symbolic links are forbidden in immutable object storage backups.");
      }
      if (metadata.isDirectory()) {
        await walk(candidate);
        continue;
      }
      if (!metadata.isFile()) {
        throw new Error("Only regular files may be included in immutable object storage backups.");
      }
      const logicalPath = relative(canonicalRoot, candidate).split(sep).join("/");
      files.push({
        absolutePath: candidate,
        path: logicalPath,
        sha256: await sha256(candidate),
        size: metadata.size,
      });
    }
  }

  await walk(canonicalRoot);
  return files;
}

export async function ensureParentDirectory(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
}
