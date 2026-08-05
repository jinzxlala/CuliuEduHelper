import { spawn } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const port = 3101;
const baseUrl = `http://127.0.0.1:${port}`;
const nextCli = resolve(root, "apps/knowledge-web/node_modules/next/dist/bin/next");
const output = [];
const authSecret = process.env.KNOWLEDGE_NEXTAUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
const databaseUrl = process.env.KNOWLEDGE_DATABASE_URL ?? process.env.DATABASE_URL;
let server;

const delay = (milliseconds) =>
  new Promise((resolveDelay) => {
    setTimeout(resolveDelay, milliseconds);
  });

function startServer() {
  const child = spawn(
    process.execPath,
    [nextCli, "start", "apps/knowledge-web", "-p", String(port)],
    {
      cwd: root,
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        KNOWLEDGE_DATABASE_URL: databaseUrl,
        KNOWLEDGE_NEXTAUTH_SECRET: authSecret,
        KNOWLEDGE_NEXTAUTH_URL: baseUrl,
        NEXTAUTH_SECRET: authSecret,
        NEXTAUTH_URL: baseUrl,
        NEXT_TELEMETRY_DISABLED: "1",
        NODE_ENV: "production",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      output.push(chunk);
      if (output.length > 40) output.shift();
    });
  }
  return child;
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (server?.exitCode !== null) throw new Error(`Knowledge Web exited.\n${output.join("")}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return response;
    } catch {
      // Connection refusal is expected while Next.js starts.
    }
    await delay(500);
  }
  throw new Error(`Knowledge Web did not start.\n${output.join("")}`);
}

try {
  if (authSecret === undefined || databaseUrl === undefined) {
    throw new Error("Knowledge Web smoke requires scoped or legacy database/auth configuration.");
  }
  server = startServer();
  const healthResponse = await waitForHealth();
  const health = await healthResponse.json();
  if (health.service !== "knowledge-web" || health.status !== "available") {
    throw new Error("Knowledge Web health payload was invalid.");
  }

  const homeResponse = await fetch(`${baseUrl}/`);
  const home = await homeResponse.text();
  if (!homeResponse.ok || !home.includes("醋溜教育知识系统")) {
    throw new Error("Knowledge Web home page smoke failed.");
  }

  const loginResponse = await fetch(`${baseUrl}/login`);
  const login = await loginResponse.text();
  if (!loginResponse.ok || !login.includes("知识系统登录")) {
    throw new Error("Knowledge Web login page smoke failed.");
  }

  for (const path of ["/search", "/smart-search", "/analysis"]) {
    const protectedPage = await fetch(`${baseUrl}${path}`, { redirect: "manual" });
    if (
      protectedPage.status !== 307 ||
      !protectedPage.headers.get("location")?.endsWith("/login")
    ) {
      throw new Error(`${path} did not require authentication.`);
    }
  }

  for (const [path, method] of [
    ["/api/smart-search", "POST"],
    ["/api/analysis/workspaces", "GET"],
  ]) {
    const protectedApi = await fetch(`${baseUrl}${path}`, {
      body: method === "POST" ? JSON.stringify({ prompt: "synthetic" }) : undefined,
      headers: method === "POST" ? { "Content-Type": "application/json" } : undefined,
      method,
      redirect: "manual",
    });
    if (
      protectedApi.status !== 401 ||
      protectedApi.headers.get("cache-control") !== "private, no-store"
    ) {
      throw new Error(`${path} did not enforce private unauthenticated API access.`);
    }
  }

  const operationsPage = await fetch(`${baseUrl}/students`, { redirect: "manual" });
  const operationsApi = await fetch(`${baseUrl}/api/students/synthetic`, { redirect: "manual" });
  if (operationsPage.status !== 404 || operationsApi.status !== 404) {
    throw new Error("Knowledge Web unexpectedly exposed an operations route.");
  }

  process.stdout.write("Knowledge Web runtime and route boundary smoke passed.\n");
} finally {
  if (server !== undefined && server.exitCode === null) {
    server.kill();
    await Promise.race([
      new Promise((resolveExit) => server.once("exit", resolveExit)),
      delay(5000),
    ]);
  }
}
