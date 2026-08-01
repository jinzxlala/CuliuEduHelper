import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { extname } from "node:path";

const MAX_FILE_SIZE_BYTES = 1024 * 1024;
const TEXT_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".ps1",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
]);

const secretPatterns = [
  {
    name: "API key-like token",
    pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/u,
  },
  {
    name: "assigned application secret",
    pattern:
      /^\s*(?:DATABASE_URL|DEEPSEEK_API_KEY|MEILI_ADMIN_API_KEY|MEILI_MASTER_KEY|MEILI_SEARCH_API_KEY|NEXTAUTH_SECRET|POSTGRES_PASSWORD|REDIS_PASSWORD|REDIS_URL)\s*=\s*(?!(?:replace|example|changeme|postgresql:\/\/[^:\s]+:(?:replace|ci-only)|redis:\/\/:(?:replace|ci-only)|<|\$\{))\S+/imu,
  },
];

function listRepositoryFiles() {
  const output = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], {
    encoding: "utf8",
  });

  return output.split("\0").filter(Boolean);
}

function isScannable(filePath) {
  if (!TEXT_EXTENSIONS.has(extname(filePath).toLowerCase())) {
    return false;
  }

  return statSync(filePath).size <= MAX_FILE_SIZE_BYTES;
}

const violations = [];
const files = listRepositoryFiles().filter(isScannable);

for (const filePath of files) {
  const content = readFileSync(filePath, "utf8");
  for (const { name, pattern } of secretPatterns) {
    if (pattern.test(content)) {
      violations.push(`${filePath}: ${name}`);
    }
  }
}

if (violations.length > 0) {
  console.error("Potential secrets detected. Values are intentionally not displayed:");
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exitCode = 1;
} else {
  console.log(`Secret scan passed (${files.length} repository text files checked).`);
}
