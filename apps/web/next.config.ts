import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  serverExternalPackages: ["@culiu/authorization", "@culiu/database", "@node-rs/argon2"],
  transpilePackages: ["@culiu/search", "@culiu/shared"],
};

export default nextConfig;
