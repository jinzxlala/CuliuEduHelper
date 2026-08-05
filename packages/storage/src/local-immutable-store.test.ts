import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LocalImmutableObjectStore, ObjectIntegrityError } from "./local-immutable-store.js";

const temporaryDirectories: string[] = [];

async function createStore(): Promise<{ root: string; store: LocalImmutableObjectStore }> {
  const root = await mkdtemp(join(tmpdir(), "culiu-storage-test-"));
  temporaryDirectories.push(root);
  return { root, store: new LocalImmutableObjectStore(root) };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("LocalImmutableObjectStore", () => {
  it("stores analysis reports in the dedicated immutable knowledge namespace", async () => {
    const { store } = await createStore();
    const reference = await store.store({
      content: Uint8Array.from(Buffer.from("<html>report</html>", "utf8")),
      domain: "knowledge",
      purpose: "analysis_report",
    });
    expect(reference.key).toMatch(/^knowledge\/reports\/[0-9a-f]{2}\/[0-9a-f]{64}$/u);
    expect(Buffer.from(await store.read(reference)).toString("utf8")).toBe("<html>report</html>");
  });
  it("stores restricted import sources outside every student namespace", async () => {
    const { store } = await createStore();

    const stored = await store.store({
      content: Buffer.from("two students in one restricted source", "utf8"),
      domain: "student_import",
    });

    expect(stored.domain).toBe("student_import");
    expect(stored.studentId).toBeUndefined();
    expect(stored.key).toMatch(/^student-import\/[0-9a-f]{2}\/[0-9a-f]{64}$/u);
    await expect(store.read(stored)).resolves.toEqual(
      Buffer.from("two students in one restricted source", "utf8"),
    );
  });

  it("stores identical knowledge content idempotently", async () => {
    const { store } = await createStore();
    const input = { content: Buffer.from("synthetic lecture"), domain: "knowledge" as const };

    const first = await store.store(input);
    const second = await store.store(input);

    expect(second).toEqual(first);
    expect(Buffer.from(await store.read(first)).toString("utf8")).toBe("synthetic lecture");
    expect(first.key).toMatch(/^knowledge\/[0-9a-f]{2}\/[0-9a-f]{64}$/u);
  });

  it("separates student objects by student identifier", async () => {
    const { store } = await createStore();
    const reference = await store.store({
      content: Buffer.from("synthetic student evidence"),
      domain: "student",
      studentId: "00000000-0000-4000-8000-000000000002",
    });

    expect(reference.key).toMatch(
      /^student\/00000000-0000-4000-8000-000000000002\/[0-9a-f]{2}\/[0-9a-f]{64}$/u,
    );
  });

  it("rejects student content without a student identifier", async () => {
    const { store } = await createStore();

    await expect(
      store.store({ content: Buffer.from("synthetic"), domain: "student" }),
    ).rejects.toThrow();
  });

  it("detects content tampering before returning bytes", async () => {
    const { root, store } = await createStore();
    const reference = await store.store({
      content: Buffer.from("original synthetic content"),
      domain: "knowledge",
    });
    await writeFile(join(root, ...reference.key.split("/")), "tampered content");

    await expect(store.read(reference)).rejects.toBeInstanceOf(ObjectIntegrityError);
    await expect(
      store.store({
        content: Buffer.from("original synthetic content"),
        domain: "knowledge",
      }),
    ).rejects.toBeInstanceOf(ObjectIntegrityError);
  });
});
