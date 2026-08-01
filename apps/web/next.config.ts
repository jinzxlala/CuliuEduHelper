import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  transpilePackages: ["@culiu/search", "@culiu/shared"],
};

export default nextConfig;
