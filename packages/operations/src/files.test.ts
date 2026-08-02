import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { assertSafeChildPath, collectImmutableObjects } from "./files.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("backup object traversal", () => {
  it("returns deterministic relative paths and content hashes", async () => {
    const root = join(tmpdir(), `culiu-objects-${crypto.randomUUID()}`);
    roots.push(root);
    await mkdir(join(root, "knowledge", "aa"), { recursive: true });
    await writeFile(join(root, "knowledge", "aa", "first"), "first");
    await writeFile(join(root, "knowledge", "aa", "second"), "second");

    const files = await collectImmutableObjects(root);

    expect(files.map((file) => file.path)).toEqual(["knowledge/aa/first", "knowledge/aa/second"]);
    expect(files.every((file) => /^[0-9a-f]{64}$/u.test(file.sha256))).toBe(true);
  });

  it("rejects traversal targets and symbolic links", async () => {
    const root = join(tmpdir(), `culiu-objects-${crypto.randomUUID()}`);
    roots.push(root);
    await mkdir(root, { recursive: true });
    expect(() => assertSafeChildPath(root, root)).toThrow(/protected root/iu);
    expect(() => assertSafeChildPath(root, join(root, "..", "outside"))).toThrow(/escaped/iu);

    const outside = join(tmpdir(), `culiu-outside-${crypto.randomUUID()}.txt`);
    roots.push(outside);
    await writeFile(outside, "outside");
    await symlink(outside, join(root, "link"));
    await expect(collectImmutableObjects(root)).rejects.toThrow(/symbolic/iu);
  });
});
