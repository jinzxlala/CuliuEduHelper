import { runWorker } from "./runtime.js";

void runWorker().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Worker startup failed.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
