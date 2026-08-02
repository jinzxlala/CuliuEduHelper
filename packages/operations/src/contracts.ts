import { isAbsolute } from "node:path";

import { z } from "zod";

export const BACKUP_FORMAT = "culiu-encrypted-backup-v1" as const;

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const SafeRelativePathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => !isAbsolute(value), "Backup paths must be relative.")
  .refine(
    (value) => !value.split("/").some((part) => part === "" || part === "." || part === ".."),
    "Backup paths must not contain empty, current, or parent segments.",
  )
  .refine((value) => !value.includes("\\"), "Backup paths must use forward slashes.");

export const BackupEnvironmentSchema = z
  .object({
    BACKUP_ENCRYPTION_KEY: z.string().min(32),
    BACKUP_ROOT: z.string().min(1).refine(isAbsolute, "BACKUP_ROOT must be absolute."),
    CULIU_GIT_COMMIT_SHA: z.string().regex(/^[0-9a-f]{40}$/u),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
    DATABASE_URL: z.url().refine((value) => value.startsWith("postgresql://"), {
      message: "DATABASE_URL must use postgresql://.",
    }),
    KNOWLEDGE_ANALYSIS_ROOT: z.string().min(1).refine(isAbsolute),
    KNOWLEDGE_MANIFEST_PATH: z.string().min(1).refine(isAbsolute),
    KNOWLEDGE_TRANSCRIPT_2025_ROOT: z.string().min(1).refine(isAbsolute),
    KNOWLEDGE_TRANSCRIPT_2026_ROOT: z.string().min(1).refine(isAbsolute),
    LOCAL_STORAGE_ROOT: z.string().min(1).refine(isAbsolute),
    MEILI_ADMIN_API_KEY: z.string().min(1).optional(),
    MEILI_HOST: z
      .url()
      .refine((value) => value.startsWith("http://") || value.startsWith("https://")),
    MEILI_MASTER_KEY: z.string().min(1).optional(),
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    POSTGRES_CONTAINER_NAME: z
      .string()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u)
      .default("culiu-edu-helper-postgres"),
    POSTGRES_DB: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/u),
    POSTGRES_USER: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/u),
  })
  .superRefine((value, context) => {
    if (value.MEILI_ADMIN_API_KEY === undefined && value.MEILI_MASTER_KEY === undefined) {
      context.addIssue({
        code: "custom",
        message: "MEILI_ADMIN_API_KEY or MEILI_MASTER_KEY is required.",
        path: ["MEILI_ADMIN_API_KEY"],
      });
    }
  });

export interface BackupConfig {
  readonly backupEncryptionKey: string;
  readonly backupRoot: string;
  readonly databasePoolMax: number;
  readonly databaseUrl: string;
  readonly gitCommitSha: string;
  readonly knowledgeAnalysisRoot: string;
  readonly knowledgeManifestPath: string;
  readonly knowledgeTranscript2025Root: string;
  readonly knowledgeTranscript2026Root: string;
  readonly localStorageRoot: string;
  readonly meiliAdminApiKey: string;
  readonly meiliHost: string;
  readonly nodeEnvironment: "development" | "production" | "test";
  readonly postgresContainerName: string;
  readonly postgresDatabase: string;
  readonly postgresUser: string;
}

export function parseBackupConfig(environment: NodeJS.ProcessEnv = process.env): BackupConfig {
  const parsed = BackupEnvironmentSchema.parse(environment);
  return {
    backupEncryptionKey: parsed.BACKUP_ENCRYPTION_KEY,
    backupRoot: parsed.BACKUP_ROOT,
    databasePoolMax: parsed.DATABASE_POOL_MAX,
    databaseUrl: parsed.DATABASE_URL,
    gitCommitSha: parsed.CULIU_GIT_COMMIT_SHA,
    knowledgeAnalysisRoot: parsed.KNOWLEDGE_ANALYSIS_ROOT,
    knowledgeManifestPath: parsed.KNOWLEDGE_MANIFEST_PATH,
    knowledgeTranscript2025Root: parsed.KNOWLEDGE_TRANSCRIPT_2025_ROOT,
    knowledgeTranscript2026Root: parsed.KNOWLEDGE_TRANSCRIPT_2026_ROOT,
    localStorageRoot: parsed.LOCAL_STORAGE_ROOT,
    meiliAdminApiKey: parsed.MEILI_ADMIN_API_KEY ?? parsed.MEILI_MASTER_KEY ?? "",
    meiliHost: parsed.MEILI_HOST,
    nodeEnvironment: parsed.NODE_ENV,
    postgresContainerName: parsed.POSTGRES_CONTAINER_NAME,
    postgresDatabase: parsed.POSTGRES_DB,
    postgresUser: parsed.POSTGRES_USER,
  };
}

export const BackupObjectSchema = z
  .object({
    encryptedFile: SafeRelativePathSchema,
    path: SafeRelativePathSchema,
    sha256: Sha256Schema,
    size: z.number().int().nonnegative(),
  })
  .strict();

export const BackupManifestSchema = z
  .object({
    archiveId: z.uuid(),
    createdAt: z.iso.datetime(),
    database: z
      .object({
        encryptedFile: SafeRelativePathSchema,
        excludedRedactedFixtureEvidenceCount: z.number().int().min(0).max(1),
        sha256: Sha256Schema,
        size: z.number().int().positive(),
        tableCounts: z.record(
          z.string().regex(/^[a-z_][a-z0-9_]*$/u),
          z.number().int().nonnegative(),
        ),
      })
      .strict(),
    format: z.literal(BACKUP_FORMAT),
    gitCommitSha: z.string().regex(/^[0-9a-f]{40}$/u),
    objects: z.array(BackupObjectSchema),
  })
  .strict();

export type BackupManifest = z.infer<typeof BackupManifestSchema>;

export const BackupReceiptSchema = z
  .object({
    archiveId: z.uuid(),
    createdAt: z.iso.datetime(),
    encryptedManifest: z.literal("manifest.json.enc"),
    encryptedManifestSha256: Sha256Schema,
    format: z.literal(BACKUP_FORMAT),
  })
  .strict();

export type BackupReceipt = z.infer<typeof BackupReceiptSchema>;

export const RestoreVerificationSchema = z
  .object({
    archiveId: z.uuid(),
    databaseTables: z.number().int().nonnegative(),
    meilisearchDocumentCounts: z
      .object({
        cases: z.number().int().nonnegative(),
        lectures: z.number().int().nonnegative(),
        transcriptSegments: z.number().int().nonnegative(),
      })
      .strict(),
    excludedRedactedFixtureEvidenceCount: z.number().int().min(0).max(1),
    objectCount: z.number().int().nonnegative(),
    status: z.literal("verified"),
  })
  .strict();

export type RestoreVerification = z.infer<typeof RestoreVerificationSchema>;
