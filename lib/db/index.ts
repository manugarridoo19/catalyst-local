import { Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import * as schema from "./schema";

// Driver serverless de Neon (WebSocket sobre 443) en vez de postgres-js
// (TCP 5432). Motivos:
//   1. Cloudflare Workers no puede abrir sockets TCP crudos — el driver
//      serverless es el camino soportado para Neon en Workers.
//   2. Bonus: 443 nunca lo bloquean las redes universitarias, así que
//      desaparece el gotcha "usar WARP para local dev" con Neon TCP.
// El túnel WebSocket del driver necesita un constructor. Tanto Cloudflare
// Workers como Node ≥22 (cron de GH Actions, daemon `next start`, scripts
// tsx) exponen `WebSocket` como global, así que el driver lo toma solo. Solo
// si faltara (Node <22) inyectamos `ws` de forma síncrona — nada de
// top-level await, que tsx rechaza al compilar los scripts a CJS.
if (typeof globalThis.WebSocket === "undefined") {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  neonConfig.webSocketConstructor = require("ws");
}

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

// Pool reutilizable. El Pool (no el cliente HTTP `neon()`) es obligatorio
// para `db.transaction()` — lo usa insertNewsBatch. Apunta al endpoint
// pooled de Neon igual que antes; el driver no usa prepared statements, así
// que el requisito PgBouncer de `prepare:false` deja de aplicar.
const pool = new Pool({ connectionString });

export const db = drizzle(pool, { schema });
export { schema };

// Extrae filas de un resultado de `db.execute(sql`...`)` de forma type-safe.
// El driver de Neon devuelve `{ rows, rowCount, ... }`; postgres-js devolvía
// un RowList iterable como array. Este helper cubre ambos shapes (por si
// algún script viejo aún usa el otro driver) — nunca lanza, devuelve [] si
// el shape no se reconoce.
export function unwrapRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && "rows" in result) {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows as T[];
  }
  return [];
}
