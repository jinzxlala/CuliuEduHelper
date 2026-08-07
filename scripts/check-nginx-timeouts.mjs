import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const template = await readFile(resolve(root, "infra/deploy/nginx/default.conf.template"), "utf8");
const proxyParameters = await readFile(resolve(root, "infra/deploy/nginx/proxy_params"), "utf8");

function count(text, pattern) {
  return [...text.matchAll(pattern)].length;
}

function requireCount(text, pattern, expected, description) {
  const actual = count(text, pattern);
  if (actual !== expected) {
    throw new Error(`${description}: expected ${String(expected)}, found ${String(actual)}.`);
  }
}

if (/^proxy_(?:connect|read|send)_timeout\s+/mu.test(proxyParameters)) {
  throw new Error(
    "Shared proxy_params must not define timeouts because selected locations override them.",
  );
}

requireCount(template, /^\s*proxy_connect_timeout 5s;$/gmu, 2, "server connect timeout");
requireCount(template, /^\s*proxy_read_timeout 65s;$/gmu, 2, "server read timeout");
requireCount(template, /^\s*proxy_send_timeout 65s;$/gmu, 2, "server send timeout");
requireCount(template, /^\s*proxy_read_timeout 660s;$/gmu, 1, "publication read timeout");
requireCount(template, /^\s*proxy_send_timeout 660s;$/gmu, 1, "publication send timeout");

const publicationLocation = template.match(
  /location = \/api\/knowledge\/imports \{(?<body>[\s\S]*?)^\s{4}\}/mu,
)?.groups?.body;
if (
  publicationLocation === undefined ||
  !publicationLocation.includes("include /etc/nginx/proxy_params;") ||
  !publicationLocation.includes("proxy_read_timeout 660s;") ||
  !publicationLocation.includes("proxy_send_timeout 660s;")
) {
  throw new Error("Knowledge publication location is missing its include or 660-second timeout.");
}

console.log("Nginx timeout layout check passed.");
