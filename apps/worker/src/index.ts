import { buildWorkerHealth } from "./health.js";

const status = buildWorkerHealth();
process.stdout.write(`${JSON.stringify(status)}\n`);
