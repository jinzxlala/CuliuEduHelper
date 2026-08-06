import { describe, expect, it, vi } from "vitest";
import JSZip from "jszip";

import { parseTranscriptDocument } from "./transcript-documents.js";

const encoder = new TextEncoder();

describe("transcript document parsing", () => {
  it("parses a named UTF-8 Markdown transcript deterministically", async () => {
    const parsed = await parseTranscriptDocument({
      bytes: encoder.encode("\uFEFF第一段。\r\n\r\n第二段。"),
      fileName: "2026-08-02_人工智能与跨学科申请.md",
    });

    expect(parsed).toMatchObject({
      mimeType: "text/markdown",
      sourceKey: "2026-08-02_人工智能与跨学科申请",
      text: "第一段。\n\n第二段。",
      title: "人工智能与跨学科申请",
    });
    expect(parsed.contentHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(parsed.textHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("uses the Word extractor for a modern docx document", async () => {
    const extractDocxText = vi.fn().mockResolvedValue("Word 中的逐字稿正文。\r\n第二段。");
    const parsed = await parseTranscriptDocument(
      {
        bytes: encoder.encode("synthetic-docx-container"),
        fileName: "2026-08-02_Word测试.docx",
      },
      { extractDocxText },
    );

    expect(extractDocxText).toHaveBeenCalledOnce();
    expect(parsed.mimeType).toContain("wordprocessingml.document");
    expect(parsed.text).toBe("Word 中的逐字稿正文。\n第二段。");
  });

  it("accepts a legacy file name and keeps it as a model hint instead of trusted metadata", async () => {
    const extractDocxText = vi.fn().mockResolvedValue("讲座正文提到活动日期为2025年4月1日。");
    const parsed = await parseTranscriptDocument(
      { bytes: encoder.encode("synthetic-docx-container"), fileName: "0401_原文.docx" },
      { extractDocxText },
    );

    expect(parsed.title).toBe("0401_原文");
    expect(parsed.sourceKey).toMatch(/^pending_[0-9a-f]{32}$/u);
    expect(parsed.lectureId).toMatch(/^lecture_pending_[0-9a-f]{32}$/u);
  });

  it("extracts text from a real minimal docx container", async () => {
    const zip = new JSZip();
    zip.file(
      "[Content_Types].xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
    );
    zip.file(
      "_rels/.rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
    );
    zip.file(
      "word/document.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body><w:p><w:r><w:t>真实 DOCX 解析测试。</w:t></w:r></w:p></w:body>
</w:document>`,
    );
    const bytes = await zip.generateAsync({ type: "uint8array" });

    const parsed = await parseTranscriptDocument({
      bytes,
      fileName: "2026-08-02_真实DOCX解析.docx",
    });
    expect(parsed.text).toBe("真实 DOCX 解析测试。");
  });

  it.each(["2026-08-02_旧Word.doc", "../2026-08-02_路径.md", "没有扩展名"])(
    "rejects an unsupported or unsafe file name: %s",
    async (fileName) => {
      await expect(
        parseTranscriptDocument({ bytes: encoder.encode("正文"), fileName }),
      ).rejects.toThrow();
    },
  );

  it("treats an invalid date prefix as an untrusted filename hint", async () => {
    const parsed = await parseTranscriptDocument({
      bytes: encoder.encode("正文"),
      fileName: "2026-02-30_无效日期.md",
    });
    expect(parsed.sourceKey).toMatch(/^pending_/u);
    expect(parsed.title).toBe("2026-02-30_无效日期");
  });

  it("rejects empty extracted content", async () => {
    await expect(
      parseTranscriptDocument({
        bytes: encoder.encode("   \r\n"),
        fileName: "2026-08-02_空文件.md",
      }),
    ).rejects.toThrow(/empty/u);
  });
});
