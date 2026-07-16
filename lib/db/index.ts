import { neon, Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { drizzle as drizzlePool } from "drizzle-orm/neon-serverless";
import * as schema from "./schema";

// Driver serverless de Neon (sobre 443, no TCP 5432). Cloudflare Workers no
// abre sockets TCP crudos, y 443 nunca lo bloquean las redes universitarias
// (desaparece el gotcha "usar WARP para Neon TCP en local").
//
// DOS clientes, por una limitación dura de Cloudflare Workers:
//
//   `db` (global, para TODAS las lecturas SSR/API) usa el driver HTTP
//   (`neon()` + drizzle/neon-http). Es SIN ESTADO: cada query es un fetch
//   independiente, sin socket persistente. Esto es OBLIGATORIO en Workers —
//   un `Pool` global mantiene un WebSocket que el runtime comparte entre
//   requests del mismo isolate, lo que dispara "Cannot perform I/O on behalf
//   of a different request" de forma intermitente (las páginas de ticker
//   daban 500 en ~1 de cada 2 cargas bajo concurrencia). El HTTP driver no
//   tiene sockets, así que no hay nada que compartir entre requests.
//
//   `createTxDb()` (on-demand, SOLO para transacciones interactivas) usa el
//   `Pool` WebSocket + drizzle/neon-serverless, porque el HTTP driver no
//   soporta transacciones interactivas (leer un resultado intermedio y
//   decidir el siguiente query). Lo usa insertNewsBatch, que corre SOLO en
//   Node (cron GH Actions, daemon, scripts) — nunca en el Worker — así que
//   el Pool efímero por-llamada no toca la limitación de Workers.
//
// El túnel WebSocket del Pool necesita un constructor global. Workers y
// Node ≥22 exponen `WebSocket`; solo Node <22 usa `ws` (require síncrono,
// nada de top-level await que tsx rechaza al compilar a CJS). El HTTP
// driver no usa WebSocket, así que este guard solo afecta a createTxDb().
if (typeof globalThis.WebSocket === "undefined") {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  neonConfig.webSocketConstructor = require("ws");
}

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

// Cliente HTTP sin estado — seguro de compartir a nivel módulo en Workers.
const httpClient = neon(connectionString);
export const db = drizzle(httpClient, { schema });
export { schema };

// Crea un cliente drizzle respaldado por un Pool WebSocket efímero, apto
// para transacciones interactivas. SOLO para código Node (cron/daemon/
// scripts). El caller DEBE llamar `close()` al terminar para liberar el
// socket — envuélvelo en try/finally.
export function createTxDb(): {
  db: ReturnType<typeof drizzlePool<typeof schema>>;
  close: () => Promise<void>;
} {
  const pool = new Pool({ connectionString });
  return {
    db: drizzlePool(pool, { schema }),
    close: () => pool.end(),
  };
}

// Extrae filas de un resultado de `db.execute(sql`...`)` de forma type-safe.
// Tanto el HTTP driver como el Pool devuelven `{ rows, ... }`; postgres-js
// (legacy) devolvía un RowList iterable como array. Cubre ambos shapes,
// nunca lanza — devuelve [] si el shape no se reconoce.
export function unwrapRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && "rows" in result) {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows as T[];
  }
  return [];
}
