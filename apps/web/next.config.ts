import type { NextConfig } from "next";

const apiOrigin =
  process.env.FAMILY_ALBUM_API_ORIGIN ?? "http://127.0.0.1:4000";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@family-album/ui-tokens", "@family-album/contracts"],
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
  async rewrites() {
    return [
      {
        source: "/api/v1/:path*",
        destination: `${apiOrigin}/api/v1/:path*`,
      },
    ];
  },
};

export default nextConfig;
