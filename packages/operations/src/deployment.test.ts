import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { checkProductionDeployment, DeploymentEnvironmentSchema } from "./deployment.js";

const secret = "synthetic-only-secret-value-1234567890";
const commit = "1".repeat(40);

async function validEnvironment(): Promise<NodeJS.ProcessEnv> {
  const root = await mkdtemp(join(tmpdir(), "culiu-deployment-"));
  const paths = Object.fromEntries(
    await Promise.all(
      ["backup", "evidence", "analysis", "transcript-2025", "transcript-2026"].map(async (name) => {
        const path = join(root, name);
        await mkdir(path);
        return [name, path] as const;
      }),
    ),
  );
  const certificate = join(root, "fullchain.pem");
  const privateKey = join(root, "privkey.pem");
  await writeFile(
    certificate,
    "-----BEGIN CERTIFICATE-----\nsynthetic\n-----END CERTIFICATE-----\n",
  );
  await writeFile(
    privateKey,
    "-----BEGIN PRIVATE KEY-----\nsynthetic\n-----END PRIVATE KEY-----\n",
  );
  return {
    APP_DOMAIN: "advisor.internal-company.cn",
    BACKUP_ENCRYPTION_KEY: secret,
    BACKUP_HOST_PATH: paths.backup,
    CULIU_GIT_COMMIT_SHA: commit,
    CULIU_IMAGE_TAG: commit,
    DATABASE_POOL_MAX: "10",
    DATABASE_URL: `postgresql://culiu:${secret}@postgres:5432/culiu_edu_helper`,
    DEEPSEEK_API_KEY: "synthetic-deepseek-key-for-tests",
    KNOWLEDGE_ANALYSIS_HOST_PATH: paths.analysis,
    KNOWLEDGE_EXTRACTION_MODEL_PROVIDER: "deepseek",
    KNOWLEDGE_TRANSCRIPT_2025_HOST_PATH: paths["transcript-2025"],
    KNOWLEDGE_TRANSCRIPT_2026_HOST_PATH: paths["transcript-2026"],
    LOCAL_STORAGE_HOST_PATH: paths.evidence,
    MEILI_HOST: "http://meilisearch:7700",
    MEILI_MAINTENANCE_PORT: "17700",
    MEILI_MASTER_KEY: secret,
    NEXTAUTH_SECRET: secret,
    POSTGRES_DB: "culiu_edu_helper",
    POSTGRES_CONTAINER_NAME: "culiu-edu-helper-postgres",
    POSTGRES_MAINTENANCE_PORT: "15432",
    POSTGRES_PASSWORD: secret,
    POSTGRES_USER: "culiu",
    PROFILE_MODEL_PROVIDER: "deepseek",
    PUBLIC_HTTP_PORT: "80",
    PUBLIC_HTTPS_PORT: "443",
    REDIS_PASSWORD: secret,
    REDIS_URL: `redis://:${secret}@redis:6379`,
    TLS_CERT_HOST_PATH: certificate,
    TLS_KEY_HOST_PATH: privateKey,
    WORKER_CONCURRENCY: "1",
  };
}

describe("production deployment preflight", () => {
  it("checks configuration, directories, and separate PEM files without returning secrets", async () => {
    const environment = await validEnvironment();
    const receipt = await checkProductionDeployment(environment);

    expect(receipt).toEqual({
      commitSha: commit,
      domain: "advisor.internal-company.cn",
      httpsPort: 443,
      pathsChecked: 7,
      status: "valid",
    });
    expect(JSON.stringify(receipt)).not.toContain(secret);
  });

  it("rejects public loopback dependencies, placeholders, and mismatched image provenance", async () => {
    const environment = await validEnvironment();
    expect(() =>
      DeploymentEnvironmentSchema.parse({
        ...environment,
        CULIU_IMAGE_TAG: "2".repeat(40),
        MEILI_HOST: "http://127.0.0.1:7700",
        NEXTAUTH_SECRET: "replace-with-this-placeholder-secret",
      }),
    ).toThrow();
  });

  it("rejects overlapping persistent and source directories", async () => {
    const environment = await validEnvironment();
    const nested = join(environment.LOCAL_STORAGE_HOST_PATH ?? "", "nested");
    await mkdir(nested);

    await expect(
      checkProductionDeployment({ ...environment, BACKUP_HOST_PATH: nested }),
    ).rejects.toThrow(/must not overlap/iu);
  });

  it("rejects a malformed certificate before Compose starts", async () => {
    const environment = await validEnvironment();
    await writeFile(environment.TLS_CERT_HOST_PATH ?? "", "not a certificate");

    await expect(checkProductionDeployment(environment)).rejects.toThrow(/invalid PEM header/iu);
  });
});
