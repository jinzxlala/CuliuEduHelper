import { findLatestBackup, parseBackupConfig, verifyLocalBackupRestore } from "../index.js";

function backupArgument(arguments_: readonly string[]): string | undefined {
  const index = arguments_.indexOf("--backup");
  if (index === -1) return undefined;
  const value = arguments_[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error("--backup requires a completed backup directory.");
  }
  return value;
}

async function main(): Promise<void> {
  const config = parseBackupConfig();
  const backupDirectory =
    backupArgument(process.argv.slice(2)) ?? (await findLatestBackup(config.backupRoot));
  const verification = await verifyLocalBackupRestore({ backupDirectory, config });
  process.stdout.write(`${JSON.stringify(verification)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Backup verification failed."}\n`,
  );
  process.exitCode = 1;
});
