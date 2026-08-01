import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  CreateStudentFactInputSchema,
  EvidenceLocatorInputSchema,
  MAX_EVIDENCE_BYTES,
  RegisterStudentEvidenceInputSchema,
  StudentFactValueSchema,
} from "./contracts.js";

const locatorId = randomUUID();

describe("student record contracts", () => {
  it("accepts a namespaced structured fact with a valid evidence link", () => {
    expect(
      CreateStudentFactInputSchema.parse({
        accessLevel: "sensitive",
        confirmationStatus: "confirmed",
        evidenceLinks: [{ evidenceLocatorId: locatorId, relation: "supports" }],
        fieldKey: "academic.gpa",
        sourceType: "evidence",
        value: { scale: 4, value: 3.8 },
      }),
    ).toMatchObject({ fieldKey: "academic.gpa" });
  });

  it("rejects unstable or unsafe fact field keys", () => {
    for (const fieldKey of ["Academic GPA", "../academic.gpa", "学术成绩", "a/b"]) {
      expect(() =>
        CreateStudentFactInputSchema.parse({
          fieldKey,
          sourceType: "advisor",
          value: { text: "synthetic" },
        }),
      ).toThrow();
    }
  });

  it("requires a locator for evidence-sourced facts", () => {
    expect(() =>
      CreateStudentFactInputSchema.parse({
        fieldKey: "academic.gpa",
        sourceType: "evidence",
        value: { value: 3.8 },
      }),
    ).toThrow(/evidence locator/iu);
  });

  it("keeps the import provenance reserved for a future controlled importer", () => {
    expect(() =>
      CreateStudentFactInputSchema.parse({
        fieldKey: "academic.gpa",
        sourceType: "import",
        value: { value: 3.8 },
      }),
    ).toThrow();
  });

  it("rejects duplicate locator bindings", () => {
    expect(() =>
      CreateStudentFactInputSchema.parse({
        evidenceLinks: [
          { evidenceLocatorId: locatorId, relation: "supports" },
          { evidenceLocatorId: locatorId, relation: "contradicts" },
        ],
        fieldKey: "academic.gpa",
        sourceType: "evidence",
        value: { value: 3.8 },
      }),
    ).toThrow(/unique/iu);
  });

  it("rejects oversized fact values and prototype-like keys", () => {
    expect(() => StudentFactValueSchema.parse({ text: "x".repeat(20_000) })).toThrow();
    const sanitized = StudentFactValueSchema.parse(
      JSON.parse('{"__proto__":{"admin":true},"text":"safe"}'),
    );
    expect(Object.hasOwn(sanitized, "__proto__")).toBe(false);
    expect(sanitized).toEqual({ text: "safe" });
  });

  it("validates precise page and timestamp ranges", () => {
    expect(
      EvidenceLocatorInputSchema.parse({
        locator: { endPage: 4, page: 3 },
        locatorType: "page",
      }),
    ).toBeDefined();
    expect(() =>
      EvidenceLocatorInputSchema.parse({
        locator: { endPage: 2, page: 3 },
        locatorType: "page",
      }),
    ).toThrow();
    expect(() =>
      EvidenceLocatorInputSchema.parse({
        locator: { endMs: 1_000, startMs: 1_000 },
        locatorType: "timestamp",
      }),
    ).toThrow();
  });

  it("rejects empty, oversized, path-like, and malformed evidence uploads", () => {
    const base = {
      accessLevel: "sensitive" as const,
      fileName: "synthetic.txt",
      locators: [{ locator: { field: "whole_record" }, locatorType: "record_field" as const }],
      mimeType: "text/plain",
    };
    expect(() =>
      RegisterStudentEvidenceInputSchema.parse({ ...base, content: new Uint8Array() }),
    ).toThrow();
    expect(() =>
      RegisterStudentEvidenceInputSchema.parse({
        ...base,
        content: new Uint8Array(MAX_EVIDENCE_BYTES + 1),
      }),
    ).toThrow();
    expect(() =>
      RegisterStudentEvidenceInputSchema.parse({
        ...base,
        content: new Uint8Array([1]),
        fileName: "../synthetic.txt",
      }),
    ).toThrow();
    expect(() =>
      RegisterStudentEvidenceInputSchema.parse({
        ...base,
        content: new Uint8Array([1]),
        mimeType: "not-a-mime",
      }),
    ).toThrow();
  });
});
