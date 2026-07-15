import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// Config mínima: sin incremental cache (R2) ni tag cache. Catalyst no usa
// ISR — todo es SSR dinámico o estático puro, y los caches de datos viven
// a nivel de módulo (getTopTickers, /api/search LRU) + Cache-Control en las
// respuestas. Si más adelante añadimos ISR, aquí se enchufa un R2 bucket.
export default defineCloudflareConfig({});
