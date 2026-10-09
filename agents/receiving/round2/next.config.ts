import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // sharp is a native module; keep it out of the server bundle.
  serverExternalPackages: ["sharp"],
  experimental: { serverActions: { bodySizeLimit: "25mb" } },
};

export default nextConfig;
