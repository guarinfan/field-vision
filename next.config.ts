import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Videos are uploaded directly to R2 via presigned URLs — Vercel never receives the video body.
  // The 4MB default limit applies only to API JSON payloads, which is fine.
  experimental: {
    serverActions: {
      bodySizeLimit: "4mb",
    },
  },
};

export default nextConfig;
