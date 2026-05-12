import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

// Conexión única reutilizable en serverless. `prepare: false` es requisito
// de Neon (PgBouncer en transaction mode no soporta prepared statements).
const queryClient = postgres(connectionString, { prepare: false });

export const db = drizzle(queryClient, { schema });
export { schema };

// Extrae filas de un resultado de `db.execute(sql`...`)` de forma type-safe.
// El driver postgres-js devuelve un RowList que es iterable como array y
// además expone `.count/.command/...`. Casts previos hacían
// `(r.rows ?? r) as Array<T>` lo cual no validaba T y producía warnings
// cuando r no era array. Este helper centraliza la coerción en un único
// punto tipado y nunca lanza — devuelve [] si el shape no se reconoce.
export function unwrapRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && "rows" in result) {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows as T[];
  }
  return [];
}
