import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@uno/game-engine", "@uno/protocol"],
};

export default nextConfig;
