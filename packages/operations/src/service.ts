import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  createDatabaseClient,
  REDACTED_FIXTURE_IDS,
  type DatabaseClient,
  type DatabaseConnection,
} from "@culiu/database";
import { KnowledgeImporter } from "@culiu/knowledge-ingest";
import {
  createMeilisearchClient,
  KnowledgeIndexManager,
  type KnowledgeIndexNames,
} from "@culiu/search";
import { LocalImmutableObjectStore } from "@culiu/storage";
import { MeilisearchApiError } from "meilisearch";

import {
  BACKUP_FORMAT,
  BackupManifestSchema,
  BackupReceiptSchema,
  RestoreVerificationSchema,
  type BackupConfig,
  type BackupManifest,
  type BackupReceipt,
  type RestoreVerification,
} from "./contracts.js";
import { decryptFile, encryptFile, sha256File } from "./crypto.js";
import { DockerCommandRunner, type DockerRunner } from "./docker.js";
import { assertSafeChildPath, collectImmutableObjects, ensureParentDirectory } from "./files.js";

const SNAPSHOT_PATTERN = /^[0-9A-Fa-f-]+$/u;
const TABLE_PATTERN = /^[a-z_][a-z0-9_]*$/u;

export interface BackupServiceOptions {
  readonly config: BackupConfig;
  readonly docker?: DockerRunner;
  readonly now?: () => Date;
}

interface SnapshotDump {
  readonly evidenceReferences: EvidenceBackupReference[];
  readonly tableCounts: Record<string, number>;
}

export interface EvidenceBackupReference {
  readonly contentHash: string;
  readonly id: string;
  readonly storageKey: string;
}

const REDACTED_FIXTURE_HASH = "c".repeat(64);
const REDACTED_FIXTURE_STORAGE_KEY = `student/${REDACTED_FIXTURE_IDS.student}/cc/${REDACTED_FIXTURE_HASH}`;

function databaseUrlFor(databaseUrl: string, databaseName: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

async function loadExactTableCounts(
  connection: DatabaseConnection,
): Promise<Record<string, number>> {
  const tableResult = await connection.query<{ tablename: string }>(
    `select tablename from pg_tables where schemaname = 'public' order by tablename`,
  );
  const counts: Record<string, number> = {};
  for (const row of tableResult.rows) {
    if (!TABLE_PATTERN.test(row.tablename))
      throw new Error("Database returned an unsafe table name.");
    const countResult = await connection.query<{ count: string }>(
      `select count(*)::text as count from "${row.tablename}"`,
    );
    const count = Number(countResult.rows[0]?.count);
    if (!Number.isSafeInteger(count) || count < 0)
      throw new Error("Database returned an invalid row count.");
    counts[row.tablename] = count;
  }
  return counts;
}

async function createConsistentDatabaseDump(
  databaseClient: DatabaseClient,
  docker: DockerRunner,
  config: BackupConfig,
  hostDumpPath: string,
  containerDumpPath: string,
): Promise<SnapshotDump> {
  const connection = await databaseClient.pool.connect();
  try {
    await connection.query("begin isolation level repeatable read read only");
    const snapshotResult = await connection.query<{ snapshot: string }>(
      "select pg_export_snapshot() as snapshot",
    );
    const snapshot = snapshotResult.rows[0]?.snapshot;
    if (snapshot === undefined || !SNAPSHOT_PATTERN.test(snapshot)) {
      throw new Error("PostgreSQL returned an invalid exported snapshot identifier.");
    }
    const tableCounts = await loadExactTableCounts(connection);
    const evidenceResult = await connection.query<{
      content_hash: string;
      id: string;
      storage_key: string;
    }>(`select id, storage_key, content_hash from evidence_object order by storage_key`);
    const evidenceReferences = evidenceResult.rows.map((row) => ({
      contentHash: row.content_hash,
      id: row.id,
      storageKey: row.storage_key,
    }));
    await docker.run([
      "exec",
      config.postgresContainerName,
      "pg_dump",
      "--username",
      config.postgresUser,
      "--dbname",
      config.postgresDatabase,
      "--format=custom",
      "--compress=6",
      "--no-owner",
      "--no-privileges",
      `--snapshot=${snapshot}`,
      `--file=${containerDumpPath}`,
    ]);
    await connection.query("commit");
    await docker.run(["cp", `${config.postgresContainerName}:${containerDumpPath}`, hostDumpPath]);
    return { evidenceReferences, tableCounts };
  } catch (error) {
    await connection.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    connection.release();
    await docker.run(["exec", config.postgresContainerName, "rm", "-f", containerDumpPath]);
  }
}

async function writeServiceAudit(
  databaseClient: DatabaseClient,
  action: string,
  archiveId: string,
  result: "failed" | "succeeded",
  details: Record<string, unknown>,
): Promise<void> {
  await databaseClient.pool.query(
    `insert into audit_event
      (actor_type, action, object_type, object_id, result, request_correlation_id, details)
     values ('service', $1, 'encrypted_backup', $2, $3, $4, $5::jsonb)`,
    [action, archiveId, result, randomUUID(), JSON.stringify(details)],
  );
}

function assertNoStorageBackupOverlap(config: BackupConfig): void {
  const storage = resolve(config.localStorageRoot);
  const backups = resolve(config.backupRoot);
  const storageFromBackups = relative(backups, storage);
  const backupsFromStorage = relative(storage, backups);
  const contains = (value: string): boolean =>
    value === "" || (!isAbsolute(value) && value !== ".." && !value.startsWith(`..${sep}`));
  if (contains(storageFromBackups) || contains(backupsFromStorage)) {
    throw new Error("BACKUP_ROOT and LOCAL_STORAGE_ROOT must not overlap.");
  }
}

export async function createLocalBackup(options: BackupServiceOptions): Promise<string> {
  const config = options.config;
  assertNoStorageBackupOverlap(config);
  const docker = options.docker ?? new DockerCommandRunner();
  const now = options.now?.() ?? new Date();
  const archiveId = randomUUID();
  const timestamp = now.toISOString().replaceAll(":", "-").replaceAll(".", "-");
  await mkdir(config.backupRoot, { recursive: true, mode: 0o700 });
  const partialDirectory = assertSafeChildPath(
    config.backupRoot,
    join(config.backupRoot, `.partial-${archiveId}`),
  );
  const finalDirectory = assertSafeChildPath(
    config.backupRoot,
    join(config.backupRoot, `${timestamp}-${archiveId}`),
  );
  await mkdir(join(partialDirectory, "objects"), { recursive: true, mode: 0o700 });

  const databaseClient = createDatabaseClient({
    connectionString: config.databaseUrl,
    maxConnections: config.databasePoolMax,
  });
  let finalCreated = false;
  try {
    const plaintextDump = join(partialDirectory, "postgresql.dump.plain");
    const encryptedDump = join(partialDirectory, "postgresql.dump.enc");
    const containerDump = `/tmp/culiu-backup-${archiveId}.dump`;
    const snapshot = await createConsistentDatabaseDump(
      databaseClient,
      docker,
      config,
      plaintextDump,
      containerDump,
    );
    const dumpMetadata = await stat(plaintextDump);
    const dumpSha256 = await sha256File(plaintextDump);
    await encryptFile(plaintextDump, encryptedDump, config.backupEncryptionKey);
    await rm(plaintextDump, { force: true });

    const objects = await collectImmutableObjects(config.localStorageRoot);
    const excludedRedactedFixtureEvidenceCount = validateEvidenceReferencesForBackup(
      snapshot.evidenceReferences,
      objects,
      config.nodeEnvironment !== "production",
    );
    const objectManifest: BackupManifest["objects"] = [];
    for (const [index, object] of objects.entries()) {
      const encryptedFile = `objects/${String(index + 1).padStart(6, "0")}.enc`;
      await encryptFile(
        object.absolutePath,
        join(partialDirectory, ...encryptedFile.split("/")),
        config.backupEncryptionKey,
      );
      objectManifest.push({
        encryptedFile,
        path: object.path,
        sha256: object.sha256,
        size: object.size,
      });
    }

    const manifest = BackupManifestSchema.parse({
      archiveId,
      createdAt: now.toISOString(),
      database: {
        encryptedFile: "postgresql.dump.enc",
        excludedRedactedFixtureEvidenceCount,
        sha256: dumpSha256,
        size: dumpMetadata.size,
        tableCounts: snapshot.tableCounts,
      },
      format: BACKUP_FORMAT,
      gitCommitSha: config.gitCommitSha,
      objects: objectManifest,
    });
    const plaintextManifest = join(partialDirectory, "manifest.json.plain");
    const encryptedManifest = join(partialDirectory, "manifest.json.enc");
    await writeFile(plaintextManifest, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
    await encryptFile(plaintextManifest, encryptedManifest, config.backupEncryptionKey);
    await rm(plaintextManifest, { force: true });

    const receipt = BackupReceiptSchema.parse({
      archiveId,
      createdAt: now.toISOString(),
      encryptedManifest: "manifest.json.enc",
      encryptedManifestSha256: await sha256File(encryptedManifest),
      format: BACKUP_FORMAT,
    });
    await writeFile(
      join(partialDirectory, "backup-receipt.json"),
      `${JSON.stringify(receipt, null, 2)}\n`,
      {
        mode: 0o600,
      },
    );
    await rename(partialDirectory, finalDirectory);
    finalCreated = true;
    await writeServiceAudit(databaseClient, "system.backup.created", archiveId, "succeeded", {
      databaseTableCount: Object.keys(snapshot.tableCounts).length,
      excludedRedactedFixtureEvidenceCount,
      objectCount: objectManifest.length,
    });
    return finalDirectory;
  } catch (error) {
    await rm(finalCreated ? finalDirectory : partialDirectory, {
      recursive: true,
      force: true,
    }).catch(() => undefined);
    throw error;
  } finally {
    await databaseClient.close();
  }
}

export function validateEvidenceReferencesForBackup(
  references: readonly EvidenceBackupReference[],
  objects: readonly {
    readonly path: string;
    readonly sha256: string;
    readonly size: number;
  }[],
  allowRedactedFixtureGap: boolean,
): number {
  const byPath = new Map(objects.map((object) => [object.path, object]));
  let excludedRedactedFixtureEvidenceCount = 0;
  for (const reference of references) {
    const object = byPath.get(reference.storageKey);
    if (object === undefined || object.sha256 !== reference.contentHash) {
      const isRedactedFixtureGap =
        allowRedactedFixtureGap &&
        reference.id === REDACTED_FIXTURE_IDS.evidenceObject &&
        reference.contentHash === REDACTED_FIXTURE_HASH &&
        reference.storageKey === REDACTED_FIXTURE_STORAGE_KEY;
      if (isRedactedFixtureGap) {
        excludedRedactedFixtureEvidenceCount += 1;
        continue;
      }
      throw new Error(`Database evidence reference is absent or corrupt: ${reference.storageKey}`);
    }
  }
  return excludedRedactedFixtureEvidenceCount;
}

async function readReceipt(backupDirectory: string): Promise<BackupReceipt> {
  const content = await readFile(join(backupDirectory, "backup-receipt.json"), "utf8");
  return BackupReceiptSchema.parse(JSON.parse(content) as unknown);
}

function assertUniqueManifestEntries(manifest: BackupManifest): void {
  const paths = new Set<string>();
  const encryptedFiles = new Set<string>();
  for (const object of manifest.objects) {
    if (paths.has(object.path) || encryptedFiles.has(object.encryptedFile)) {
      throw new Error("Backup manifest contains duplicate object entries.");
    }
    paths.add(object.path);
    encryptedFiles.add(object.encryptedFile);
  }
}

async function restoreObjects(
  backupDirectory: string,
  restoreRoot: string,
  manifest: BackupManifest,
  secret: string,
): Promise<void> {
  for (const object of manifest.objects) {
    const encryptedPath = assertSafeChildPath(
      backupDirectory,
      join(backupDirectory, ...object.encryptedFile.split("/")),
    );
    const restoredPath = assertSafeChildPath(
      restoreRoot,
      join(restoreRoot, ...object.path.split("/")),
    );
    await ensureParentDirectory(restoredPath);
    await decryptFile(encryptedPath, restoredPath, secret);
    const metadata = await stat(restoredPath);
    if (metadata.size !== object.size || (await sha256File(restoredPath)) !== object.sha256) {
      throw new Error(`Restored immutable object failed integrity verification: ${object.path}`);
    }
  }
}

async function deleteVerificationIndexes(
  client: ReturnType<typeof createMeilisearchClient>,
  names: KnowledgeIndexNames,
): Promise<void> {
  for (const uid of Object.values(names)) {
    try {
      const task = await client.deleteIndex(uid);
      const completed = await client.tasks.waitForTask(task.taskUid, {
        interval: 50,
        timeout: 60_000,
      });
      if (completed.status !== "succeeded") {
        throw new Error(`Failed to remove temporary Meilisearch index: ${uid}`);
      }
    } catch (error) {
      if (error instanceof MeilisearchApiError && error.cause?.code === "index_not_found") {
        continue;
      }
      throw error;
    }
  }
}

async function rebuildVerificationIndexes(
  config: BackupConfig,
  restoredDatabaseClient: DatabaseClient,
  restoredObjectRoot: string,
  suffix: string,
): Promise<RestoreVerification["meilisearchDocumentCounts"]> {
  const names: KnowledgeIndexNames = {
    cases: `restore_${suffix}_cases`,
    lectures: `restore_${suffix}_lectures`,
    transcriptSegments: `restore_${suffix}_transcripts`,
  };
  const client = createMeilisearchClient({
    host: config.meiliHost,
    apiKey: config.meiliAdminApiKey,
  });
  const manager = new KnowledgeIndexManager({ client, indexNames: names });
  const importer = new KnowledgeImporter({
    databaseClient: restoredDatabaseClient,
    indexPublisher: manager,
    manifestPath: config.knowledgeManifestPath,
    objectStore: new LocalImmutableObjectStore(restoredObjectRoot),
    sourceRoots: {
      analysis: config.knowledgeAnalysisRoot,
      transcripts_2025: config.knowledgeTranscript2025Root,
      transcripts_2026: config.knowledgeTranscript2026Root,
    },
  });
  try {
    await importer.reconcileCurrentPublication();
    const [caseStats, lectureStats, transcriptStats] = await Promise.all([
      client.index(names.cases).getStats(),
      client.index(names.lectures).getStats(),
      client.index(names.transcriptSegments).getStats(),
    ]);
    return {
      cases: caseStats.numberOfDocuments,
      lectures: lectureStats.numberOfDocuments,
      transcriptSegments: transcriptStats.numberOfDocuments,
    };
  } finally {
    await deleteVerificationIndexes(client, names);
  }
}

async function expectedKnowledgeCounts(
  connection: DatabaseConnection,
): Promise<RestoreVerification["meilisearchDocumentCounts"]> {
  const result = await connection.query<{
    case_count: number;
    lecture_count: number;
    transcript_segment_count: number;
  }>(`select case_count, lecture_count, transcript_segment_count
       from knowledge_import_batch
      where is_current = true and status = 'published'
      limit 1`);
  const row = result.rows[0];
  return {
    cases: row?.case_count ?? 0,
    lectures: row?.lecture_count ?? 0,
    transcriptSegments: row?.transcript_segment_count ?? 0,
  };
}

export async function verifyLocalBackupRestore(
  options: BackupServiceOptions & { readonly backupDirectory: string },
): Promise<RestoreVerification> {
  const config = options.config;
  const docker = options.docker ?? new DockerCommandRunner();
  const backupDirectory = assertSafeChildPath(config.backupRoot, resolve(options.backupDirectory));
  const receipt = await readReceipt(backupDirectory);
  const encryptedManifest = assertSafeChildPath(
    backupDirectory,
    join(backupDirectory, receipt.encryptedManifest),
  );
  if ((await sha256File(encryptedManifest)) !== receipt.encryptedManifestSha256) {
    throw new Error("Encrypted backup manifest digest does not match its receipt.");
  }

  const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
  const restoreRoot = assertSafeChildPath(
    config.backupRoot,
    join(config.backupRoot, `.restore-${suffix}`),
  );
  const restoredObjects = join(restoreRoot, "objects");
  const plaintextManifest = join(restoreRoot, "manifest.json");
  const plaintextDump = join(restoreRoot, "postgresql.dump");
  const restoredDatabaseName = `culiu_restore_${suffix}`;
  const containerDump = `/tmp/culiu-restore-${suffix}.dump`;
  await mkdir(restoredObjects, { recursive: true, mode: 0o700 });

  const liveDatabaseClient = createDatabaseClient({
    connectionString: config.databaseUrl,
    maxConnections: config.databasePoolMax,
  });
  let restoredDatabaseClient: DatabaseClient | undefined;
  let databaseCreated = false;
  try {
    await decryptFile(encryptedManifest, plaintextManifest, config.backupEncryptionKey);
    const manifest = BackupManifestSchema.parse(
      JSON.parse(await readFile(plaintextManifest, "utf8")) as unknown,
    );
    if (manifest.archiveId !== receipt.archiveId)
      throw new Error("Backup receipt and manifest disagree.");
    assertUniqueManifestEntries(manifest);
    await restoreObjects(backupDirectory, restoredObjects, manifest, config.backupEncryptionKey);

    const encryptedDump = assertSafeChildPath(
      backupDirectory,
      join(backupDirectory, manifest.database.encryptedFile),
    );
    await decryptFile(encryptedDump, plaintextDump, config.backupEncryptionKey);
    const dumpMetadata = await stat(plaintextDump);
    if (
      dumpMetadata.size !== manifest.database.size ||
      (await sha256File(plaintextDump)) !== manifest.database.sha256
    ) {
      throw new Error("Restored PostgreSQL dump failed integrity verification.");
    }

    await docker.run([
      "exec",
      config.postgresContainerName,
      "createdb",
      "--username",
      config.postgresUser,
      "--template=template0",
      restoredDatabaseName,
    ]);
    databaseCreated = true;
    await docker.run(["cp", plaintextDump, `${config.postgresContainerName}:${containerDump}`]);
    await docker.run([
      "exec",
      config.postgresContainerName,
      "pg_restore",
      "--username",
      config.postgresUser,
      "--dbname",
      restoredDatabaseName,
      "--exit-on-error",
      "--no-owner",
      "--no-privileges",
      containerDump,
    ]);

    restoredDatabaseClient = createDatabaseClient({
      connectionString: databaseUrlFor(config.databaseUrl, restoredDatabaseName),
      maxConnections: 2,
    });
    const restoredConnection = await restoredDatabaseClient.pool.connect();
    let tableCounts: Record<string, number>;
    let expectedCounts: RestoreVerification["meilisearchDocumentCounts"];
    try {
      tableCounts = await loadExactTableCounts(restoredConnection);
      expectedCounts = await expectedKnowledgeCounts(restoredConnection);
    } finally {
      restoredConnection.release();
    }
    if (JSON.stringify(tableCounts) !== JSON.stringify(manifest.database.tableCounts)) {
      throw new Error("Restored PostgreSQL table counts differ from the backup snapshot.");
    }
    const restoredEvidenceResult = await restoredDatabaseClient.pool.query<{
      content_hash: string;
      id: string;
      storage_key: string;
    }>(`select id, storage_key, content_hash from evidence_object order by storage_key`);
    const excludedRedactedFixtureEvidenceCount = validateEvidenceReferencesForBackup(
      restoredEvidenceResult.rows.map((row) => ({
        contentHash: row.content_hash,
        id: row.id,
        storageKey: row.storage_key,
      })),
      manifest.objects,
      config.nodeEnvironment !== "production",
    );
    if (
      excludedRedactedFixtureEvidenceCount !==
      manifest.database.excludedRedactedFixtureEvidenceCount
    ) {
      throw new Error("Restored redacted fixture gap count differs from the backup snapshot.");
    }

    const rebuiltCounts = await rebuildVerificationIndexes(
      config,
      restoredDatabaseClient,
      restoredObjects,
      suffix,
    );
    if (JSON.stringify(rebuiltCounts) !== JSON.stringify(expectedCounts)) {
      throw new Error("Temporary Meilisearch rebuild counts differ from restored PostgreSQL.");
    }
    const verification = RestoreVerificationSchema.parse({
      archiveId: manifest.archiveId,
      databaseTables: Object.keys(tableCounts).length,
      excludedRedactedFixtureEvidenceCount,
      meilisearchDocumentCounts: rebuiltCounts,
      objectCount: manifest.objects.length,
      status: "verified",
    });
    await restoredDatabaseClient.close();
    restoredDatabaseClient = undefined;
    await docker.run(["exec", config.postgresContainerName, "rm", "-f", containerDump]);
    await docker.run([
      "exec",
      config.postgresContainerName,
      "dropdb",
      "--username",
      config.postgresUser,
      "--if-exists",
      "--force",
      restoredDatabaseName,
    ]);
    databaseCreated = false;
    await rm(restoreRoot, { recursive: true, force: true });
    await writeServiceAudit(
      liveDatabaseClient,
      "system.backup.restore_verified",
      manifest.archiveId,
      "succeeded",
      {
        ...verification,
      },
    );
    return verification;
  } catch (error) {
    await writeServiceAudit(
      liveDatabaseClient,
      "system.backup.restore_verified",
      receipt.archiveId,
      "failed",
      { errorType: error instanceof Error ? error.name : "UnknownError" },
    ).catch(() => undefined);
    throw error;
  } finally {
    await restoredDatabaseClient?.close().catch(() => undefined);
    await docker
      .run(["exec", config.postgresContainerName, "rm", "-f", containerDump])
      .catch(() => undefined);
    if (databaseCreated) {
      await docker
        .run([
          "exec",
          config.postgresContainerName,
          "dropdb",
          "--username",
          config.postgresUser,
          "--if-exists",
          "--force",
          restoredDatabaseName,
        ])
        .catch(() => undefined);
    }
    await rm(restoreRoot, { recursive: true, force: true }).catch(() => undefined);
    await liveDatabaseClient.close();
  }
}

export async function findLatestBackup(backupRoot: string): Promise<string> {
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(backupRoot, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left, "en"));
  const latest = candidates[0];
  if (latest === undefined) throw new Error("No completed backup exists in BACKUP_ROOT.");
  return join(backupRoot, latest);
}

export function backupLabel(backupDirectory: string): string {
  return basename(backupDirectory);
}
