// Ingesta de embeddings del archivo (Ask Catalyst, Fase 2 2026-07-21).
//
// Corre DENTRO del tick de scoring (score-orphans) y del cron: lo que
// acaba de puntuarse con impact>=3 se embebe en la misma pasada, así el
// archivo consultable va sólo unos minutos por detrás del feed. Node-only
// (el Worker público jamás gasta cuota de embeddings).
//
// Tres frenos, en este orden:
//   1. Kill-switch por env (EMBED_ENABLED=0) — apagar sin desplegar código.
//   2. Guard de almacenamiento: Neon free son 0.5 GB para TODA la base. Si
//      la BD supera EMBED_MAX_DB_MB dejamos de embeber en vez de reventar
//      la cuota y tumbar también el feed, que es el producto principal.
//   3. Cuota de la API: EmbedQuotaError sale en silencio y reintenta en el
//      siguiente tick (mismo patrón que score-orphans con la cuota LLM).
//
// El texto embebido es EXACTAMENTE el que se cita después: titular +
// (resumen IA si existe, si no las primeras líneas del cuerpo). Nunca el
// artículo entero — el research daba ~2× de accuracy troceando por
// unidades semánticas naturales frente a chunks de tamaño fijo, y además
// el free tier no aguantaría el volumen.

import { sql } from "drizzle-orm";
import { db, unwrapRows } from "@/lib/db";
import {
  embedBatch,
  EmbedQuotaError,
  EMBED_DIMS,
  EMBED_MAX_BATCH,
  EMBED_MODEL,
} from "@/lib/providers/gemini-embed";

/** Impacto mínimo para entrar en el archivo consultable. Bajarlo multiplica
 *  el gasto de disco por ~7 (el 85-90% de las noticias son impact<3). */
const MIN_IMPACT = 3;
/** Longitud del acompañamiento al titular cuando no hay resumen IA. */
const BODY_SNIPPET = 400;

const MODEL_TAG = `${EMBED_MODEL}/${EMBED_DIMS}`;

function envInt(name: string, fallback: number): number {
  const n = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
}

export type EmbedResult = {
  picked: number;
  embedded: number;
  purged: number;
  skipped: "disabled" | "storage" | "quota" | null;
  dbMb: number;
  durationMs: number;
};

type Candidate = {
  id: number;
  headline: string;
  body: string | null;
  url: string;
  source: string;
  published_at: Date;
  impact: number;
  sentiment: number;
  summary: string | null;
  symbols: string[];
};

/** Texto que se embebe y que después se cita. Mantenerlos iguales es lo
 *  que hace que una cita sea verificable: el usuario lee lo mismo que
 *  encontró el retrieval. */
function embedText(c: Candidate): { text: string; snapshotSummary: string | null } {
  const extra =
    c.summary?.trim() ||
    c.body?.replace(/\s+/g, " ").trim().slice(0, BODY_SNIPPET) ||
    null;
  const symbols = c.symbols.length ? `[${c.symbols.join(", ")}] ` : "";
  return {
    text: `${symbols}${c.headline}${extra ? `\n${extra}` : ""}`.slice(0, 4000),
    snapshotSummary: extra,
  };
}

async function dbSizeMb(): Promise<number> {
  const rows = unwrapRows<{ mb: number }>(
    await db.execute(
      sql`SELECT (pg_database_size(current_database()) / 1048576.0)::float8 AS mb`,
    ),
  );
  return rows[0]?.mb ?? 0;
}

/**
 * Retención: la fila de news muere a los 20 días pero el snapshot vive
 * EMBED_RETENTION_DAYS (90 por defecto) — ésa es la ventana consultable.
 * Excepción: lo que dio origen a una señal del Lab no se purga nunca; es
 * la evidencia de un track record que sí es permanente.
 */
async function purgeExpired(): Promise<number> {
  // 60d y no 90: medido 2026-07-21 con 1.820 filas reales, ~4,5 kB/fila con
  // HNSW. A 90d × ~919 impact≥3/día serían ~353 MB solo de embeddings sobre
  // ~95 MB del resto — cruzaría EMBED_MAX_DB_MB (380) hacia el día ~65 y la
  // ventana dejaría de crecer igual. 60d ≈ 235 MB → cabe con margen.
  const days = envInt("EMBED_RETENTION_DAYS", 60);
  const res = await db.execute(sql`
    DELETE FROM news_embeddings e
    WHERE e.published_at < now() - make_interval(days => ${days})
      AND NOT EXISTS (
        SELECT 1 FROM signal_events se
        WHERE se.kind = 'analyst_upgrade'
          AND se.ref_id = e.news_id::text
      )
  `);
  return (res as { rowCount?: number }).rowCount ?? 0;
}

export async function runEmbedIngest(
  opts: { limit?: number } = {},
): Promise<EmbedResult> {
  const t0 = Date.now();
  const base: EmbedResult = {
    picked: 0,
    embedded: 0,
    purged: 0,
    skipped: null,
    dbMb: 0,
    durationMs: 0,
  };
  const done = (r: Partial<EmbedResult>): EmbedResult => ({
    ...base,
    ...r,
    durationMs: Date.now() - t0,
  });

  if (process.env.EMBED_ENABLED === "0") return done({ skipped: "disabled" });

  const dbMb = await dbSizeMb();
  const maxMb = envInt("EMBED_MAX_DB_MB", 380);
  if (dbMb > maxMb) {
    console.warn(
      `[embed] BD en ${dbMb.toFixed(0)}MB > ${maxMb}MB — pausado (Neon free = 512MB para todo)`,
    );
    return done({ skipped: "storage", dbMb });
  }

  // Recency-first, como todo en Catalyst: lo nuevo entra primero y la cola
  // vieja la libera la purga, no el picker.
  const limit = Math.min(
    Math.max(opts.limit ?? envInt("EMBED_BATCH", 100), 1),
    EMBED_MAX_BATCH,
  );
  const candidates = unwrapRows<Candidate>(
    await db.execute(sql`
      SELECT n.id, n.headline, n.body, n.url, n.source, n.published_at,
             s.impact, s.sentiment, s.summary,
             ARRAY(SELECT ticker FROM news_tickers WHERE news_id = n.id) AS symbols
      FROM news n
      JOIN news_scores s ON s.news_id = n.id
      LEFT JOIN news_embeddings e ON e.news_id = n.id
      WHERE s.impact >= ${MIN_IMPACT} AND e.id IS NULL
      ORDER BY n.published_at DESC
      LIMIT ${limit}
    `),
  );

  const purged = await purgeExpired();
  if (candidates.length === 0) return done({ purged, dbMb });

  const prepared = candidates.map((c) => ({ c, ...embedText(c) }));
  let vectors: number[][];
  try {
    vectors = await embedBatch(prepared.map((p) => p.text));
  } catch (err) {
    if (err instanceof EmbedQuotaError) {
      return done({ picked: candidates.length, purged, dbMb, skipped: "quota" });
    }
    throw err;
  }

  // Un INSERT por fila: son <=100 y el driver HTTP no soporta transacción
  // interactiva. ON CONFLICT hace idempotente el reintento si el tick muere
  // a mitad (dos scorers pueden solaparse igual que en el pick de scoring).
  let embedded = 0;
  for (let i = 0; i < prepared.length; i++) {
    const { c, snapshotSummary } = prepared[i];
    const vec = `[${vectors[i].join(",")}]`;
    // ARRAY[...] explícito: un array JS como parámetro suelto lo aplana el
    // driver a "AAPL" y Postgres responde `malformed array literal`.
    const symbols = sql`ARRAY[${sql.join(
      c.symbols.map((s) => sql`${s}`),
      sql`, `,
    )}]::text[]`;
    try {
      await db.execute(sql`
        INSERT INTO news_embeddings
          (news_id, headline, summary, url, source, symbols, impact, sentiment,
           published_at, embedding, model)
        VALUES (${c.id}, ${c.headline}, ${snapshotSummary}, ${c.url}, ${c.source},
                ${symbols}, ${c.impact}, ${c.sentiment},
                ${c.published_at}, ${vec}::halfvec, ${MODEL_TAG})
        ON CONFLICT (news_id) DO NOTHING
      `);
      embedded++;
    } catch (err) {
      console.warn(
        `[embed] insert ${c.id} falló:`,
        err instanceof Error ? err.message.slice(0, 140) : err,
      );
    }
  }

  return done({ picked: candidates.length, embedded, purged, dbMb });
}
