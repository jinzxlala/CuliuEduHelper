import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { decryptFile, encryptFile } from "./crypto.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("encrypted backup files", () => {
  it("round-trips arbitrary bytes without writing the key", async () => {
    const root = await mkdtemp(join(tmpdir(), "culiu-operations-"));
    roots.push(root);
    const source = join(root, "source.bin");
    const encrypted = join(root, "source.enc");
    const restored = join(root, "restored.bin");
    const secret = "a-strong-test-key-that-is-longer-than-32-characters";
    const content = Buffer.from([0, 1, 2, 3, 255, 13, 10, 99]);
    await writeFile(source, content);

    await encryptFile(source, encrypted, secret);
    await decryptFile(encrypted, restored, secret);

    expect(await readFile(restored)).toEqual(content);
    expect((await readFile(encrypted)).includes(Buffer.from(secret))).toBe(false);
  });

  it("rejects ciphertext tampering and leaves no plaintext output", async () => {
    const root = await mkdtemp(join(tmpdir(), "culiu-operations-"));
    roots.push(root);
    const source = join(root, "source.bin");
    const encrypted = join(root, "source.enc");
    const restored = join(root, "restored.bin");
    const secret = "another-strong-test-key-longer-than-32-characters";
    await writeFile(source, "private evidence");
    await encryptFile(source, encrypted, secret);
    const bytes = await readFile(encrypted);
    const tamperedIndex = Math.floor(bytes.length / 2);
    const originalByte = bytes[tamperedIndex];
    if (originalByte === undefined)
      throw new Error("Encrypted test fixture is unexpectedly empty.");
    bytes[tamperedIndex] = originalByte ^ 1;
    await writeFile(encrypted, bytes);

    await expect(decryptFile(encrypted, restored, secret)).rejects.toThrow(/authentication/iu);
    await expect(readFile(restored)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
