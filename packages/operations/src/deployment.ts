import { access, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { z } from "zod";

const PlaceholderPattern = /(change|example|replace|placeholder|your[-_])/iu;
const ShaPattern = /^[a-f\d]{40}$/u;
const HostnamePattern =
  /^(?=.{1,253}$)(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+[a-z](?:[a-z\d-]{0,61}[a-z\d])?$/iu;

const StrongSecretSchema = z
  .string()
  .min(32)
  .refine((value) => !PlaceholderPattern.test(value), "secret must not be a placeholder");

const DeploymentHostnameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(HostnamePattern)
  .refine(
    (value) =>
      value !== "localhost" &&
      !value.endsWith(".localhost") &&
      !value.endsWith(".example.com") &&
      !value.endsWith(".example.invalid"),
    "deployment hostname must be real",
  );

export const DeploymentEnvironmentSchema = z
  .object({
    KNOWLEDGE_APP_DOMAIN: DeploymentHostnameSchema,
    OPERATIONS_APP_DOMAIN: DeploymentHostnameSchema,
    BACKUP_ENCRYPTION_KEY: StrongSecretSchema,
    BACKUP_HOST_PATH: z.string().min(1).refine(isAbsolute),
    CULIU_GIT_COMMIT_SHA: z
      .string()
      .regex(ShaPattern)
      .refine((value) => value !== "0".repeat(40), "commit SHA must not be all zeroes"),
    CULIU_IMAGE_TAG: z.string().regex(ShaPattern),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
    DATABASE_URL: z.url(),
    KNOWLEDGE_DATABASE_URL: z.url(),
    OPERATIONS_DATABASE_URL: z.url(),
    DEEPSEEK_API_KEY: z
      .string()
      .min(20)
      .refine((value) => !PlaceholderPattern.test(value), "DeepSeek key must not be a placeholder"),
    KNOWLEDGE_ANALYSIS_HOST_PATH: z.string().min(1).refine(isAbsolute),
    KNOWLEDGE_EXTRACTION_MODEL_PROVIDER: z.literal("deepseek"),
    KNOWLEDGE_TRANSCRIPT_2025_HOST_PATH: z.string().min(1).refine(isAbsolute),
    KNOWLEDGE_TRANSCRIPT_2026_HOST_PATH: z.string().min(1).refine(isAbsolute),
    LOCAL_STORAGE_HOST_PATH: z.string().min(1).refine(isAbsolute),
    MEILI_HOST: z.url(),
    MEILI_MAINTENANCE_PORT: z.coerce.number().int().min(1).max(65_535),
    MEILI_MASTER_KEY: StrongSecretSchema,
    KNOWLEDGE_NEXTAUTH_SECRET: StrongSecretSchema,
    OPERATIONS_NEXTAUTH_SECRET: StrongSecretSchema,
    POSTGRES_DB: z.string().regex(/^[a-z][a-z\d_]{0,62}$/u),
    POSTGRES_CONTAINER_NAME: z.string().regex(/^[a-z\d][a-z\d_.-]+$/iu),
    POSTGRES_MAINTENANCE_PORT: z.coerce.number().int().min(1).max(65_535),
    POSTGRES_PASSWORD: StrongSecretSchema,
    POSTGRES_USER: z.string().regex(/^[a-z][a-z\d_]{0,62}$/u),
    PROFILE_MODEL_PROVIDER: z.literal("deepseek"),
    PUBLIC_HTTP_PORT: z.coerce.number().int().min(1).max(65_535),
    PUBLIC_HTTPS_PORT: z.coerce.number().int().min(1).max(65_535),
    REDIS_PASSWORD: StrongSecretSchema,
    REDIS_URL: z.url(),
    TLS_CERT_HOST_PATH: z.string().min(1).refine(isAbsolute),
    TLS_KEY_HOST_PATH: z.string().min(1).refine(isAbsolute),
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(4).default(1),
  })
  .loose()
  .superRefine((value, context) => {
    if (value.PUBLIC_HTTP_PORT === value.PUBLIC_HTTPS_PORT) {
      context.addIssue({
        code: "custom",
        message: "HTTP and HTTPS ports must be different",
        path: ["PUBLIC_HTTPS_PORT"],
      });
    }
    const ports = [
      value.PUBLIC_HTTP_PORT,
      value.PUBLIC_HTTPS_PORT,
      value.POSTGRES_MAINTENANCE_PORT,
      value.MEILI_MAINTENANCE_PORT,
    ];
    if (new Set(ports).size !== ports.length) {
      context.addIssue({
        code: "custom",
        message: "public and loopback maintenance ports must all be different",
        path: ["POSTGRES_MAINTENANCE_PORT"],
      });
    }
    if (value.CULIU_IMAGE_TAG !== value.CULIU_GIT_COMMIT_SHA) {
      context.addIssue({
        code: "custom",
        message: "image tag must equal the deployed commit SHA",
        path: ["CULIU_IMAGE_TAG"],
      });
    }
    if (value.KNOWLEDGE_APP_DOMAIN === value.OPERATIONS_APP_DOMAIN) {
      context.addIssue({
        code: "custom",
        message: "knowledge and operations domains must be different",
        path: ["OPERATIONS_APP_DOMAIN"],
      });
    }
    if (value.KNOWLEDGE_NEXTAUTH_SECRET === value.OPERATIONS_NEXTAUTH_SECRET) {
      context.addIssue({
        code: "custom",
        message: "knowledge and operations session secrets must be different",
        path: ["OPERATIONS_NEXTAUTH_SECRET"],
      });
    }

    validateServiceUrl(value.DATABASE_URL, "postgresql:", "postgres", "DATABASE_URL", context);
    validateServiceUrl(
      value.KNOWLEDGE_DATABASE_URL,
      "postgresql:",
      "postgres",
      "KNOWLEDGE_DATABASE_URL",
      context,
    );
    validateServiceUrl(
      value.OPERATIONS_DATABASE_URL,
      "postgresql:",
      "postgres",
      "OPERATIONS_DATABASE_URL",
      context,
    );
    validateServiceUrl(value.REDIS_URL, "redis:", "redis", "REDIS_URL", context);
    validateServiceUrl(value.MEILI_HOST, "http:", "meilisearch", "MEILI_HOST", context);

    const databaseUrl = safeUrl(value.DATABASE_URL);
    if (databaseUrl !== undefined) {
      if (decodeUrlPart(databaseUrl.username) !== value.POSTGRES_USER) {
        context.addIssue({
          code: "custom",
          message: "DATABASE_URL user must match POSTGRES_USER",
          path: ["DATABASE_URL"],
        });
      }
      if (decodeUrlPart(databaseUrl.password) !== value.POSTGRES_PASSWORD) {
        context.addIssue({
          code: "custom",
          message: "DATABASE_URL password must match POSTGRES_PASSWORD",
          path: ["DATABASE_URL"],
        });
      }
      if (databaseUrl.pathname.slice(1) !== value.POSTGRES_DB) {
        context.addIssue({
          code: "custom",
          message: "DATABASE_URL database must match POSTGRES_DB",
          path: ["DATABASE_URL"],
        });
      }
    }
    const redisUrl = safeUrl(value.REDIS_URL);
    if (redisUrl !== undefined && decodeUrlPart(redisUrl.password) !== value.REDIS_PASSWORD) {
      context.addIssue({
        code: "custom",
        message: "REDIS_URL password must match REDIS_PASSWORD",
        path: ["REDIS_URL"],
      });
    }
  });

type DeploymentEnvironment = z.infer<typeof DeploymentEnvironmentSchema>;

export interface DeploymentCheckReceipt {
  readonly commitSha: string;
  readonly domains: {
    readonly knowledge: string;
    readonly operations: string;
  };
  readonly httpsPort: number;
  readonly pathsChecked: number;
  readonly status: "valid";
}

function safeUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function decodeUrlPart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function validateServiceUrl(
  value: string,
  protocol: string,
  hostname: string,
  field: string,
  context: z.RefinementCtx,
): void {
  const url = safeUrl(value);
  if (url === undefined || url.protocol !== protocol || url.hostname !== hostname) {
    context.addIssue({
      code: "custom",
      message: `${field} must use ${protocol}//${hostname} inside the Compose network`,
      path: [field],
    });
  }
}

function overlaps(first: string, second: string): boolean {
  const relativePath = relative(first, second);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

async function requireDirectory(path: string): Promise<string> {
  await access(path);
  const information = await stat(path);
  if (!information.isDirectory()) throw new Error(`Deployment path is not a directory: ${path}`);
  return realpath(path);
}

async function requirePemFile(path: string, marker: RegExp): Promise<string> {
  await access(path);
  const information = await stat(path);
  if (!information.isFile()) throw new Error(`TLS path is not a file: ${path}`);
  const content = await readFile(path, "utf8");
  if (!marker.test(content)) throw new Error(`TLS file has an invalid PEM header: ${path}`);
  return realpath(path);
}

export async function checkProductionDeployment(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<DeploymentCheckReceipt> {
  const parsed = DeploymentEnvironmentSchema.parse(environment);
  const directoryEntries = await Promise.all(
    deploymentDirectoryPaths(parsed).map(
      async ([name, path]) => [name, await requireDirectory(path)] as const,
    ),
  );
  const certificatePath = await requirePemFile(
    parsed.TLS_CERT_HOST_PATH,
    /-----BEGIN CERTIFICATE-----/u,
  );
  const keyPath = await requirePemFile(
    parsed.TLS_KEY_HOST_PATH,
    /-----BEGIN (?:EC |RSA )?PRIVATE KEY-----/u,
  );
  if (resolve(certificatePath).toLowerCase() === resolve(keyPath).toLowerCase()) {
    throw new Error("TLS certificate and private key must be separate files.");
  }

  for (let first = 0; first < directoryEntries.length; first += 1) {
    for (let second = first + 1; second < directoryEntries.length; second += 1) {
      const [firstName, firstPath] = directoryEntries[first] ?? [];
      const [secondName, secondPath] = directoryEntries[second] ?? [];
      if (
        firstName !== undefined &&
        secondName !== undefined &&
        firstPath !== undefined &&
        secondPath !== undefined &&
        (overlaps(firstPath, secondPath) || overlaps(secondPath, firstPath))
      ) {
        throw new Error(`${firstName} and ${secondName} must not overlap.`);
      }
    }
  }

  return {
    commitSha: parsed.CULIU_GIT_COMMIT_SHA,
    domains: {
      knowledge: parsed.KNOWLEDGE_APP_DOMAIN,
      operations: parsed.OPERATIONS_APP_DOMAIN,
    },
    httpsPort: parsed.PUBLIC_HTTPS_PORT,
    pathsChecked: directoryEntries.length + 2,
    status: "valid",
  };
}

function deploymentDirectoryPaths(
  environment: DeploymentEnvironment,
): ReadonlyArray<readonly [string, string]> {
  return [
    ["BACKUP_HOST_PATH", environment.BACKUP_HOST_PATH],
    ["LOCAL_STORAGE_HOST_PATH", environment.LOCAL_STORAGE_HOST_PATH],
    ["KNOWLEDGE_ANALYSIS_HOST_PATH", environment.KNOWLEDGE_ANALYSIS_HOST_PATH],
    ["KNOWLEDGE_TRANSCRIPT_2025_HOST_PATH", environment.KNOWLEDGE_TRANSCRIPT_2025_HOST_PATH],
    ["KNOWLEDGE_TRANSCRIPT_2026_HOST_PATH", environment.KNOWLEDGE_TRANSCRIPT_2026_HOST_PATH],
  ];
}
