import { spawn } from "node:child_process";
import { resolve } from "node:path";

const [application, command] = process.argv.slice(2);
const applications = {
  knowledge: {
    directory: "knowledge-web",
    port: "3000",
    scope: "KNOWLEDGE",
  },
  operations: {
    directory: "operations-web",
    port: "3001",
    scope: "OPERATIONS",
  },
};

if (!(application in applications) || !["dev", "start"].includes(command)) {
  throw new Error("Usage: run-next-app.mjs <knowledge|operations> <dev|start>");
}

const config = applications[application];
const root = resolve(import.meta.dirname, "..");
const applicationRoot = resolve(root, "apps", config.directory);
const nextCli = resolve(applicationRoot, "node_modules", "next", "dist", "bin", "next");
const scoped = (name) => process.env[`${config.scope}_${name}`] ?? process.env[name];
const environment = {
  ...process.env,
  DATABASE_POOL_MAX: scoped("DATABASE_POOL_MAX"),
  DATABASE_URL: scoped("DATABASE_URL"),
  NEXTAUTH_SECRET: scoped("NEXTAUTH_SECRET"),
  NEXTAUTH_URL: scoped("NEXTAUTH_URL"),
};

const child = spawn(process.execPath, [nextCli, command, "-p", config.port], {
  cwd: applicationRoot,
  env: environment,
  stdio: "inherit",
  windowsHide: true,
});

child.on("error", (error) => {
  throw error;
});
child.on("exit", (code, signal) => {
  if (signal !== null) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
