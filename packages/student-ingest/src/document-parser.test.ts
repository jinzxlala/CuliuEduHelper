import { describe, expect, it } from "vitest";

import { parseCsv, parseStudentImportDocument } from "./document-parser.js";

describe("student import document parsing", () => {
  it("parses BOM CSV, quoted commas, embedded newlines and blank trailing columns", async () => {
    const content = Buffer.from(
      '\uFEFF姓名,年级,备注,\r\n张同学,G8,"喜欢算法,\n愿意练习",\r\n',
      "utf8",
    );
    const parsed = await parseStudentImportDocument({
      content,
      fileName: "students.csv",
      mimeType: "text/csv",
    });

    expect(parsed.format).toBe("csv");
    expect(parsed.rows).toEqual([
      ["姓名", "年级", "备注", ""],
      ["张同学", "G8", "喜欢算法,\n愿意练习", ""],
    ]);
    expect(parsed.modelText).toContain("[R2C3] 喜欢算法,\n愿意练习");
  });

  it("rejects an unterminated quoted CSV cell", () => {
    expect(() => parseCsv('name,"broken')).toThrow("unterminated");
  });

  it("accepts UTF-8 Markdown and rejects unsupported extensions", async () => {
    await expect(
      parseStudentImportDocument({
        content: Buffer.from("学员姓名：张同学", "utf8"),
        fileName: "students.md",
        mimeType: "text/markdown",
      }),
    ).resolves.toMatchObject({ format: "markdown", modelText: "学员姓名：张同学" });

    await expect(
      parseStudentImportDocument({
        content: Buffer.from("content", "utf8"),
        fileName: "students.pdf",
        mimeType: "application/pdf",
      }),
    ).rejects.toThrow("Only .txt, .md, .docx and .csv");
  });
});
