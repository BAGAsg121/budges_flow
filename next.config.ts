import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Pin the workspace root so Next does not walk up past the project and pick up a
  // stray package-lock.json elsewhere on the machine.
  turbopack: {
    root: process.cwd(),
  },
  // Type errors must fail the build — the app sends real messages.
  typescript: {
    ignoreBuildErrors: false,
  },
  reactStrictMode: false,
};

export default nextConfig;
