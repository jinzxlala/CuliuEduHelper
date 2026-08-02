import { extname } from "node:path";

import mammoth from "mammoth";

import {
  StudentImportUploadSchema,
  type ParsedStudentImportDocument,
  type StudentImportFormat,
  type StudentImportUpload,
} from "./contracts.js";

function decodeUtf8(content: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(content).replace(/^\uFEFF/u, "");
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (!quoted && character === ",") {
      row.push(cell.trim());
      cell = "";
      continue;
    }
    if (!quoted && (character === "\n" || character === "\r")) {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(cell.trim());
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }
    cell += character ?? "";
  }
  if (quoted) throw new Error("CSV contains an unterminated quoted cell.");
  if (cell !== "" || row.length > 0) {
    row.push(cell.trim());
    rows.push(row);
  }
  return rows.filter((entry) => entry.some((value) => value !== ""));
}

function csvForModel(rows: readonly (readonly string[])[]): string {
  return rows
    .map((row, rowIndex) =>
      row
        .map((cell, columnIndex) => `[R${String(rowIndex + 1)}C${String(columnIndex + 1)}] ${cell}`)
        .join(" | "),
    )
    .join("\n");
}

function detectFormat(fileName: string): StudentImportFormat {
  const extension = extname(fileName).toLowerCase();
  if (extension === ".csv") return "csv";
  if (extension === ".docx") return "docx";
  if (extension === ".md") return "markdown";
  if (extension === ".txt") return "text";
  throw new Error("Only .txt, .md, .docx and .csv files are supported.");
}

export async function parseStudentImportDocument(
  untrustedUpload: StudentImportUpload,
): Promise<ParsedStudentImportDocument> {
  const upload = StudentImportUploadSchema.parse(untrustedUpload);
  const format = detectFormat(upload.fileName);
  if (format === "docx") {
    const result = await mammoth.extractRawText({ buffer: Buffer.from(upload.content) });
    const modelText = result.value.trim();
    if (modelText === "") throw new Error("Word document did not contain readable text.");
    return { format, modelText, rows: [] };
  }
  const text = decodeUtf8(upload.content).trim();
  if (text === "") throw new Error("Import document did not contain readable text.");
  if (format === "csv") {
    const rows = parseCsv(text);
    if (rows.length === 0) throw new Error("CSV did not contain any non-empty rows.");
    return { format, modelText: csvForModel(rows), rows };
  }
  return { format, modelText: text, rows: [] };
}
