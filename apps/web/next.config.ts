import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  serverExternalPackages: [
    "@culiu/authorization",
    "@culiu/database",
    "@culiu/storage",
    "@culiu/student-records",
    "@node-rs/argon2",
  ],
  transpilePackages: ["@culiu/search", "@culiu/shared"],
};

export default nextConfig;
