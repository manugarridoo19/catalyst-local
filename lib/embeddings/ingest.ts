// Ingesta de embeddings del archivo (Ask Catalyst, Fase 2 2026-07-21).
//
// Corre DENTRO del tick de scoring (score-orphans) y del cron: lo que
// acaba de puntuarse por encima del umbral de impacto se embebe en la misma
// pasada, así el archivo consultable va sólo unos minutos por detrás del
// feed. Node-only (el Worker público jamás gasta cuota de embeddings).
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
import {
  DEFAULT_MAX_DB_MB,
  DEFAULT_MIN_IMPACT,
  DEFAULT_RETENTION_DAYS,
} from "@/lib/embeddings/budget";

/** Impacto mínimo para entrar en el archivo consultable. El porqué del 4 y
 *  la aritmética de si la configuración cabe → `lib/embeddings/budget.ts`.
 *  Bajarlo a 3 multiplica el flujo por ~2,7 y la ventana deja de caber. */
function minImpact(): number {
  return envInt("EMBED_MIN_IMPACT", DEFAULT_MIN_IMPACT);
}
/** Longitud del acompañamiento al titular cuando no hay resumen IA. */
const BODY_SNIPPET = 400;
/** Techo del troceado. Deliberadamente POR DEBAJO de `EMBED_MAX_BATCH` (el
 *  máximo que acepta la API, que coincide con el límite por minuto): un lote
 *  igual al límite sólo entra con el cubo del minuto intacto. */
const EMBED_CHUNK_CEILING = 50;

const MODEL_TAG = `${EMBED_MODEL}/${EMBED_DIMS}`;

function envInt(name: string, fallback: number): number {
  const n = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
}

export type EmbedResult = {
  picked: number;
  embedded: number;
  purged: number;
  skipped: "disabled" | "storage" | "quota" | "budget" | null;
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
 * EMBED_RETENTION_DAYS (60 por defecto) — ésa es la ventana consultable.
 * Excepción: lo que dio origen a una señal del Lab no se purga nunca; es
 * la evidencia de un track record que sí es permanente.
 *
 * LA EXCEPCIÓN SE COMPARA CONTRA `source_news_id`, NO CONTRA `news_id`, y
 * ésa es toda la diferencia entre que funcione y que sea decorativa:
 * `news_id` tiene FK `SET NULL` y las noticias se purgan a los 20 días, así
 * que cuando una fila cumple los 60 su `news_id` lleva 40 siendo NULL. Con
 * `se.ref_id = NULL::text` la comparación evalúa a NULL, el NOT EXISTS es
 * TRUE y la fila caía igual que cualquier otra — la evidencia del ÚNICO
 * kind al que se le prometió retención infinita se borraba sin excepción y
 * sin síntoma (la señal seguía en /lab con su titular, sólo dejaba de ser
 * verificable). `source_news_id` no tiene FK a propósito: sobrevive.
 *
 * El filtro por kind no es opcional: `ref_id` es polimórfico (un id de
 * `ai_picks` conservaría una noticia ajena que nunca originó nada).
 */
async function purgeExpired(): Promise<number> {
  // 45d, y el 60 anterior era el número que NO CABÍA: se calculó en jul-2026
  // con 1.820 filas reales y ~4,5 kB/fila, pero el coste medido sobre la
  // tabla llena es 5,5 kB y el flujo real fue ~1.060/día, no ~919 — a 60d
  // pedía ~535 MB de embeddings sobre 512 de base entera. El porqué del 45 y
  // la comprobación de que la configuración cabe → `lib/embeddings/budget.ts`.
  const days = envInt("EMBED_RETENTION_DAYS", DEFAULT_RETENTION_DAYS);
  const res = await db.execute(sql`
    DELETE FROM news_embeddings e
    WHERE e.published_at < now() - make_interval(days => ${days})
      AND NOT EXISTS (
        SELECT 1 FROM signal_events se
        WHERE se.kind = 'analyst_upgrade'
          AND se.ref_id = e.source_news_id::text
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

  // ─── LA PURGA VA PRIMERO, ANTES DE TODOS LOS FRENOS ────────────────────
  //
  // Estaba después del guard de almacenamiento, y eso convertía la pausa por
  // disco en un CALLEJÓN SIN SALIDA: al cruzar EMBED_MAX_DB_MB el tick salía
  // por el `return` de arriba, así que la purga —lo único que libera sitio—
  // dejaba de ejecutarse justo cuando hacía falta. La base no podía encoger
  // sola, la ventana consultable quedaba congelada para siempre y sólo lo
  // arreglaba una persona borrando a mano. El único síntoma habría sido /ask
  // dejando de encontrar lo nuevo, sin un error en ningún log.
  //
  // Purgar es barato (un DELETE indexado por published_at) y no depende de
  // cuota ni de red, así que no hay razón para condicionarlo a nada. Y el
  // tamaño se mide DESPUÉS: el guard tiene que decidir sobre la base ya
  // purgada, no sobre la de hace un segundo.
  const purged = await purgeExpired();

  const dbMb = await dbSizeMb();
  const maxMb = envInt("EMBED_MAX_DB_MB", DEFAULT_MAX_DB_MB);
  if (dbMb > maxMb) {
    console.warn(
      `[embed] BD en ${dbMb.toFixed(0)}MB > ${maxMb}MB — pausado (Neon free = 512MB para todo)`,
    );
    return done({ skipped: "storage", dbMb, purged });
  }

  // Presupuesto DIARIO propio, por debajo de la cuota real (3×1.000, reset
  // medianoche Pacific): la ingesta puede comerse el día entero (pasó el
  // 20 y el 21-jul con la puesta al día: parón a las 12:52Z y /ask del dueño
  // degradado a léxico el resto del día). Con techo 2.500 quedan ~500 para
  // preguntas de /ask y para el margen de ráfaga por minuto. Con el umbral
  // en 4 el régimen real son ~300-570 filas/día (medido 4-11 ago), así que
  // esto sólo muerde en catch-ups — que es exactamente cuando hay que
  // repartir. Ojo al leer la cuota: el techo son 3 proyectos × 1.000, y son
  // 3 y no 5 desde que g3 y la reserva murieron por identidad, no por gasto.
  const dailyBudget = envInt("EMBED_DAILY_BUDGET", 2500);
  const usedToday = unwrapRows<{ n: number }>(
    await db.execute(sql`
      SELECT count(*)::int AS n FROM news_embeddings
      WHERE (created_at AT TIME ZONE 'America/Los_Angeles')::date
            = (now() AT TIME ZONE 'America/Los_Angeles')::date
    `),
  )[0]?.n ?? 0;
  if (usedToday >= dailyBudget) {
    console.log(
      `[embed] presupuesto diario agotado (${usedToday}/${dailyBudget}) — el resto queda para /ask; se reanuda a medianoche Pacific`,
    );
    return done({ skipped: "budget", dbMb, purged });
  }

  // Recency-first, como todo en Catalyst: lo nuevo entra primero y la cola
  // vieja la libera la purga, no el picker.
  const limit = Math.min(
    Math.max(opts.limit ?? envInt("EMBED_BATCH", 100), 1),
    EMBED_MAX_BATCH,
    // No pedir más de lo que queda de presupuesto del día.
    Math.max(dailyBudget - usedToday, 1),
  );
  const candidates = unwrapRows<Candidate>(
    await db.execute(sql`
      SELECT n.id, n.headline, n.body, n.url, n.source, n.published_at,
             s.impact, s.sentiment, s.summary,
             ARRAY(SELECT ticker FROM news_tickers WHERE news_id = n.id) AS symbols
      FROM news n
      JOIN news_scores s ON s.news_id = n.id
      LEFT JOIN news_embeddings e ON e.news_id = n.id
      WHERE s.impact >= ${minImpact()} AND e.id IS NULL
      ORDER BY n.published_at DESC
      LIMIT ${limit}
    `),
  );

  if (candidates.length === 0) return done({ purged, dbMb });

  const prepared = candidates.map((c) => ({ c, ...embedText(c) }));

  // Se trocea en llamadas MÁS PEQUEÑAS que el límite por minuto (100/min/key),
  // nunca iguales. Un batch de exactamente 100 sólo entra si el cubo del minuto
  // está intacto: cualquier otro consumo en esos 60s (una pregunta de /ask, el
  // reintento anterior) lo hace imposible, y como el mismo lote se reenviaba a
  // las 3 keys, las quemaba las tres y el tick moría entero. Así se atascó la
  // ingesta 2h el 2026-07-21 (429 `EmbedContentRequestsPerMinute...`, limit 100).
  // Trocear además hace el tick RESUMABLE: lo ya embebido se guarda aunque el
  // trozo siguiente se quede sin cuota.
  // El tope duro es EMBED_CHUNK_CEILING (50), NO `EMBED_MAX_BATCH` (100):
  // acotar contra el máximo de la API permitía que `EMBED_CHUNK=100` pidiera
  // exactamente el límite por minuto, que es el lote que ya tumbó la ingesta
  // 2h el 2026-07-21. El techo tiene que quedar por DEBAJO del límite, no en
  // el límite.
  const chunkSize = Math.min(
    Math.max(envInt("EMBED_CHUNK", 50), 1),
    EMBED_CHUNK_CEILING,
  );
  let embedded = 0;
  let quotaHit = false;

  for (let start = 0; start < prepared.length; start += chunkSize) {
    const chunk = prepared.slice(start, start + chunkSize);
    let vectors: number[][];
    try {
      vectors = await embedBatch(chunk.map((p) => p.text));
    } catch (err) {
      if (err instanceof EmbedQuotaError) {
        quotaHit = true;
        break;
      }
      throw err;
    }
    embedded += await insertChunk(chunk, vectors);
  }

  return done({
    picked: candidates.length,
    embedded,
    purged,
    dbMb,
    // "quota" sólo si el tick se fue de vacío: si algo entró, es progreso
    // parcial y el resto lo coge el siguiente tick.
    skipped: quotaHit && embedded === 0 ? "quota" : null,
  });
}

/** Un INSERT por fila: el driver HTTP no soporta transacción interactiva.
 *  ON CONFLICT hace idempotente el reintento si el tick muere a mitad (dos
 *  scorers pueden solaparse igual que en el pick de scoring). */
async function insertChunk(
  chunk: Array<{ c: Candidate; snapshotSummary: string | null }>,
  vectors: number[][],
): Promise<number> {
  let embedded = 0;
  for (let i = 0; i < chunk.length; i++) {
    const { c, snapshotSummary } = chunk[i];
    const vec = `[${vectors[i].join(",")}]`;
    // ARRAY[...] explícito: un array JS como parámetro suelto lo aplana el
    // driver a "AAPL" y Postgres responde `malformed array literal`.
    const symbols = sql`ARRAY[${sql.join(
      c.symbols.map((s) => sql`${s}`),
      sql`, `,
    )}]::text[]`;
    try {
      // `source_news_id` duplica `news_id` al nacer y NO tiene FK: es lo que
      // sigue identificando el origen cuando la purga de news pone `news_id`
      // a NULL, y de lo que depende la excepción de retención del Lab.
      const res = await db.execute(sql`
        INSERT INTO news_embeddings
          (news_id, source_news_id, headline, summary, url, source, symbols,
           impact, sentiment, published_at, embedding, model)
        VALUES (${c.id}, ${c.id}, ${c.headline}, ${snapshotSummary}, ${c.url},
                ${c.source}, ${symbols}, ${c.impact}, ${c.sentiment},
                ${c.published_at}, ${vec}::halfvec, ${MODEL_TAG})
        ON CONFLICT (news_id) DO NOTHING
      `);
      // El contador va por filas REALMENTE escritas: con `DO NOTHING`, un
      // reintento sobre lo ya embebido devuelve rowCount 0 y contarlo como
      // éxito inflaba `embedded` — la misma cifra que decide si el tick se
      // marca como `quota` y la que se lee en los logs para saber si la
      // ingesta avanza.
      embedded += (res as { rowCount?: number }).rowCount ?? 0;
    } catch (err) {
      console.warn(
        `[embed] insert ${c.id} falló:`,
        err instanceof Error ? err.message.slice(0, 140) : err,
      );
    }
  }
  return embedded;
}
