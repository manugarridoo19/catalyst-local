import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  // Evita que Next infiera el workspace root del package-lock.json del HOME.
  turbopack: {
    root: path.resolve(__dirname),
  },
};

export default nextConfig;
