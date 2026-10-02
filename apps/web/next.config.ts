import type { NextConfig } from "next";

const apiOrigin =
  process.env.FAMILY_ALBUM_API_ORIGIN ?? "http://127.0.0.1:4000";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Search URLs carry private calendar/album/favorite conditions and cursors.
  // Disable only raw incoming request logs; keep compilation/errors/warnings.
  logging: { incomingRequests: false },
  transpilePackages: ["@family-album/ui-tokens", "@family-album/contracts"],
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
  async rewrites() {
    // Let the exact search Route Handler own its safe error boundary; all
    // other API paths retain the existing external forwarding destination.
    return {
      fallback: [
        {
          source: "/api/v1/:path*",
          destination: `${apiOrigin}/api/v1/:path*`,
        },
      ],
    };
  },
};

export default nextConfig;
