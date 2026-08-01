import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const rootDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = 3100;
const baseUrl = `http://127.0.0.1:${port}`;
const nextCli = resolve(rootDirectory, "apps/web/node_modules/next/dist/bin/next");
const output = [];

const server = spawn(process.execPath, [nextCli, "start", "apps/web", "-p", String(port)], {
  cwd: rootDirectory,
  env: {
    ...process.env,
    NEXT_TELEMETRY_DISABLED: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

for (const stream of [server.stdout, server.stderr]) {
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    output.push(chunk);
    if (output.length > 40) {
      output.shift();
    }
  });
}

const delay = (milliseconds) =>
  new Promise((resolveDelay) => {
    setTimeout(resolveDelay, milliseconds);
  });

async function waitForHealth() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (server.exitCode !== null) {
      throw new Error(`Web server exited early.\n${output.join("")}`);
    }

    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) {
        return response;
      }
    } catch {
      // The server is expected to reject connections while it starts.
    }

    await delay(500);
  }

  throw new Error(`Web server did not become ready.\n${output.join("")}`);
}

try {
  const healthResponse = await waitForHealth();
  const health = await healthResponse.json();
  if (health.service !== "web" || health.status !== "available") {
    throw new Error("Unexpected health payload.");
  }

  const homeResponse = await fetch(`${baseUrl}/`);
  const home = await homeResponse.text();
  if (!homeResponse.ok || !home.includes("醋溜教育智能助手")) {
    throw new Error("Home page smoke test failed.");
  }

  console.log(
    JSON.stringify({
      healthService: health.service,
      healthStatus: health.status,
      homeStatus: homeResponse.status,
    }),
  );
} finally {
  server.kill();
  await Promise.race([new Promise((resolveExit) => server.once("exit", resolveExit)), delay(3000)]);
}
