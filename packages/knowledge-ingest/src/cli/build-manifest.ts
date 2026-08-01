import { parseArgs } from "node:util";

import { KnowledgeSourceError } from "../errors.js";
import { writeKnowledgeSourceManifest, type TranscriptRootInput } from "../manifest.js";

interface CliOptions {
  readonly analysisRoot: string;
  readonly outputPath: string;
  readonly transcriptRoots: TranscriptRootInput[];
}

function usage(): string {
  return [
    "Usage:",
    "  node dist/cli/build-manifest.js --analysis-root <path> \\",
    "    --transcript-root <year=path> [--transcript-root <year=path> ...] \\",
    "    --output <path>",
  ].join("\n");
}

function requiredValue(value: string | undefined, option: string): string {
  if (value === undefined || value.trim() === "") {
    throw new KnowledgeSourceError("invalid_configuration", `${option} is required`);
  }
  return value;
}

function parseTranscriptRoot(value: string): TranscriptRootInput {
  const separatorIndex = value.indexOf("=");
  if (separatorIndex <= 0 || separatorIndex === value.length - 1) {
    throw new KnowledgeSourceError(
      "invalid_configuration",
      `invalid --transcript-root value; expected year=path`,
    );
  }
  const yearText = value.slice(0, separatorIndex);
  const path = value.slice(separatorIndex + 1);
  if (!/^\d{4}$/u.test(yearText)) {
    throw new KnowledgeSourceError(
      "invalid_configuration",
      `invalid transcript root year: ${yearText}`,
    );
  }
  return { lectureYear: Number(yearText), path };
}

export function parseCliOptions(args: readonly string[]): CliOptions {
  const parsed = parseArgs({
    allowPositionals: false,
    args: [...args],
    options: {
      "analysis-root": { type: "string" },
      help: { short: "h", type: "boolean" },
      output: { short: "o", type: "string" },
      "transcript-root": { multiple: true, type: "string" },
    },
    strict: true,
  });
  if (parsed.values.help === true) {
    process.stdout.write(`${usage()}\n`);
    process.exitCode = 0;
    throw new KnowledgeSourceError("invalid_configuration", "help requested");
  }
  const transcriptRootValues = parsed.values["transcript-root"] ?? [];
  if (transcriptRootValues.length === 0) {
    throw new KnowledgeSourceError(
      "invalid_configuration",
      "at least one --transcript-root is required",
    );
  }
  return {
    analysisRoot: requiredValue(parsed.values["analysis-root"], "--analysis-root"),
    outputPath: requiredValue(parsed.values.output, "--output"),
    transcriptRoots: transcriptRootValues.map(parseTranscriptRoot),
  };
}

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  const manifest = await writeKnowledgeSourceManifest(options);
  process.stdout.write(
    `${JSON.stringify({ corpus_hash: manifest.corpus_hash, lecture_count: manifest.lecture_count, output: options.outputPath })}\n`,
  );
}

try {
  await main();
} catch (error) {
  if (error instanceof KnowledgeSourceError && error.message === "help requested") {
    // Usage has already been printed.
  } else {
    const message = error instanceof Error ? error.message : "unknown manifest generation error";
    process.stderr.write(`Knowledge source manifest failed: ${message}\n`);
    process.exitCode = 1;
  }
}
