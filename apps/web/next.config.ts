import { join } from "node:path";

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: join(import.meta.dirname, "../.."),
  poweredByHeader: false,
  serverExternalPackages: [
    "@culiu/ai",
    "@culiu/authorization",
    "@culiu/database",
    "@culiu/storage",
    "@culiu/student-profiles",
    "@culiu/student-records",
    "@culiu/tasks",
    "@node-rs/argon2",
    "bullmq",
    "ioredis",
  ],
  transpilePackages: ["@culiu/search", "@culiu/shared"],
};

export default nextConfig;
