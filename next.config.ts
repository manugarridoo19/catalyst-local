import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  // Evita que Next infiera el workspace root del package-lock.json del HOME.
  turbopack: {
    root: path.resolve(__dirname),
  },
  // El driver serverless de Neon trae su propio build con condición `workerd`.
  // Marcarlo external hace que opennextjs lo copie tal cual (usando ese build)
  // en vez de intentar bundlearlo — el camino soportado para Neon en Workers.
  serverExternalPackages: ["@neondatabase/serverless"],
};

export default nextConfig;

// Hook de dev del adaptador Cloudflare: permite que `next dev` acceda a los
// bindings del Worker (env, etc.) vía getCloudflareContext(). No afecta al
// build de producción ni al `next start` del daemon local.
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
void initOpenNextCloudflareForDev();
