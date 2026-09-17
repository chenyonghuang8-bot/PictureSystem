import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@family-album/ui-tokens"],
};

export default nextConfig;
