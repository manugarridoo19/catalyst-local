// Marcas de "última vez que se INTENTÓ" para los jobs del cron. La
// alternativa (MAX(created_at) de la tabla del propio job) sólo se activa
// cuando hay datos nuevos, y con datos trimestrales eso es casi nunca: el
// guard "cada 12h" de 13F corría en realidad en cada tick de 10 min
// (auditoría 2026-07-21). Las keys también sirven de memoria de fallos por
// filing (`earnings-fail:SYM:accession`) para no re-gastar LLM en un filing
// roto en cada barrido.

import { sql } from "drizzle-orm";
import { db, unwrapRows } from "@/lib/db";

export async function jobRanWithin(key: string, hours: number): Promise<boolean> {
  return (
    unwrapRows<{ recent: boolean | null }>(
      await db.execute(sql`
        SELECT ran_at > now() - (${hours} || ' hours')::interval AS recent
        FROM job_state WHERE key = ${key}
      `),
    )[0]?.recent === true
  );
}

export async function markJobRun(key: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO job_state (key, ran_at) VALUES (${key}, now())
    ON CONFLICT (key) DO UPDATE SET ran_at = now()
  `);
}
