import { createLocalBackup, parseBackupConfig } from "../index.js";

async function main(): Promise<void> {
  const backupDirectory = await createLocalBackup({ config: parseBackupConfig() });
  process.stdout.write(`${JSON.stringify({ backupDirectory, status: "created" })}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Backup creation failed."}\n`);
  process.exitCode = 1;
});
