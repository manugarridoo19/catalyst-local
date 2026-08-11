import { sql } from "drizzle-orm";
import { db, unwrapRows } from "@/lib/db";
import { insiderTrades, fundStakes } from "@/lib/db/schema";
import {
  fetchForm4Structured,
  fetchStakeCover,
} from "@/lib/articles/extract";

// Ingesta estructurada insider — Node-only (cron/refresher/scripts): pega a
// SEC (2 requests por filing), NUNCA desde el Worker.
//
// Diseño autocurativo: en vez de procesar la lista in-memory del tick (que
// perdería los filings que exceden el cap si el proceso muere), cada pasada
// pregunta a la BD "¿qué filings sec-edgar de las últimas 72h no se han
// intentado parsear aún?" (news.insider_parsed_at IS NULL) y procesa hasta
// `limit`. La marca se pone SIEMPRE al intentar — un filing sin
// transacciones (amendment vacío, holding-only) no se re-fetchea eternamente.
// El mismo camino sirve para el backfill (limit alto vía script).
//
// La selección es a la vez un CLAIM (2026-08-01): marcar y elegir van en la
// MISMA sentencia `UPDATE … RETURNING`, igual que el picker de scoring. Este
// job corre dentro de refresh-news, y refresh-news corre en DOS escritores a
// la vez —el cron de GH Actions y el refresher local, con relojes
// independientes—, así que con un SELECT que sólo marcaba al terminar los dos
// elegían los mismos 16 filings y hacían los mismos ~32 fetches a SEC. Las
// escrituras convergían por `onConflictDoNothing`, pero el `GAP_MS` está
// calculado para un solo escritor.

const PARSE_CAP = Number(process.env.INSIDER_PARSE_CAP ?? 16);
const LOOKBACK_HOURS = 72;
// SEC limita a 10 req/s — gap entre filings para quedar lejísimos del techo.
const GAP_MS = 150;

// Retención propia (independiente de la purga de news a 20d — por eso
// news_id es SET NULL y no CASCADE). Stakes se guardan más: son raras y
// el "quién está posicionado en X" vale meses.
const TRADES_RETENTION_DAYS = 90;
const STAKES_RETENTION_DAYS = 180;

export type InsiderIngestResult = {
  scanned: number;
  trades: number;
  stakes: number;
  failed: number;
};

type PendingFiling = {
  id: number;
  url: string;
  headline: string;
  symbol: string | null;
  published_at: string | Date;
};

/**
 * Elige y RECLAMA en una sola sentencia: al devolver la fila ya queda con
 * `insider_parsed_at` puesto, así que el otro escritor no la vuelve a coger.
 *
 * Reclamar por delante también es lo que ya hacía la semántica anterior en la
 * práctica (se marcaba pase lo que pase, incluso en fallo: «mejor perderlo que
 * loopear»), sólo que ahora la marca llega antes de gastar los fetches en vez
 * de después.
 */
async function claimPendingFilings(
  limit: number,
  lookbackHours: number,
): Promise<PendingFiling[]> {
  return unwrapRows<PendingFiling>(
    await db.execute(sql`
      WITH pendientes AS (
        SELECT n.id FROM news n
        WHERE n.source = 'sec-edgar'
          AND n.insider_parsed_at IS NULL
          AND n.published_at >= now() - (${lookbackHours} || ' hours')::interval
          AND (
            n.headline LIKE '% files Form 4 (insider)'
            OR n.headline LIKE '% files SC 13D%'
            OR n.headline LIKE '% files SC 13G%'
          )
        ORDER BY n.published_at DESC
        LIMIT ${limit}
      )
      UPDATE news SET insider_parsed_at = now()
      WHERE news.id IN (SELECT id FROM pendientes)
        AND news.insider_parsed_at IS NULL
      RETURNING news.id, news.url, news.headline, news.published_at,
        (SELECT nt.ticker FROM news_tickers nt WHERE nt.news_id = news.id
          ORDER BY (nt.extraction_method = 'api') DESC LIMIT 1) AS symbol
    `),
  );
}

async function ingestForm4(f: PendingFiling): Promise<number> {
  const parsed = await fetchForm4Structured(f.url);
  if (!parsed || parsed.transactions.length === 0) return 0;
  // El símbolo AUTORITATIVO es el issuerTradingSymbol del propio XML — la
  // subquery de news_tickers puede traer un ticker vecino cuando la noticia
  // tiene varios links (caso real: "Honeywell Aerospace files Form 4" con
  // HONA api + HON dict → LIMIT 1 devolvía HON y las trades del spinoff se
  // atribuían a Honeywell International). El fallback al link de la noticia
  // queda para XMLs sin símbolo.
  const xmlSymbol = parsed.symbol?.toUpperCase().trim();
  const symbol =
    xmlSymbol && /^[A-Z0-9.\-]{1,10}$/.test(xmlSymbol) ? xmlSymbol : f.symbol;
  if (!symbol) return 0;
  if (symbol !== f.symbol) {
    // FK a tickers — el símbolo del XML puede no existir aún en el universo.
    await db.execute(sql`
      INSERT INTO tickers (symbol, source) VALUES (${symbol}, 'sec-form4')
      ON CONFLICT DO NOTHING`);
  }
  const filedAt = new Date(f.published_at);
  const rows = parsed.transactions.map((t, seq) => ({
    newsId: f.id,
    symbol,
    filingUrl: f.url,
    seq,
    ownerName: parsed.ownerName,
    ownerTitle: parsed.ownerTitle,
    isDirector: parsed.isDirector ? 1 : 0,
    isOfficer: parsed.isOfficer ? 1 : 0,
    isTenPercent: parsed.isTenPercent ? 1 : 0,
    txCode: t.code,
    shares: t.shares,
    price: t.price,
    value: t.value,
    txDate: t.date,
    sharesAfter: t.sharesAfter,
    // Campo de DOCUMENTO, no de transacción: se desnormaliza en cada fila
    // igual que ownerName. `null` se conserva como `null` — el `?:` de un
    // booleano lo habría convertido en 0 sin que nadie lo notara.
    plannedSale: parsed.plannedSale === null ? null : parsed.plannedSale ? 1 : 0,
    filedAt,
  }));
  // returning() = filas REALMENTE insertadas (onConflictDoNothing puede
  // saltarse todas si el filing ya estaba — contar rows.length mentía).
  const inserted = await db
    .insert(insiderTrades)
    .values(rows)
    .onConflictDoNothing()
    .returning({ id: insiderTrades.id });
  return inserted.length;
}

async function ingestStake(f: PendingFiling): Promise<number> {
  if (!f.symbol) return 0;
  const formType = f.headline.includes("SC 13D") ? "SC 13D" : "SC 13G";
  // Cover best-effort: si no sale nombre ni %, la fila igualmente registra
  // "stake nueva declarada en X" — eso ya es señal.
  const cover = await fetchStakeCover(f.url).catch(() => null);
  // returning() = filas REALMENTE insertadas, mismo motivo que en
  // `ingestForm4`: con `onConflictDoNothing` un 13D ya ingerido no entra, y
  // devolver 1 a pelo hacía que el cron logueara "+1 stakes" sin que hubiera
  // entrado nada — justo el número que se mira para saber si esto sigue vivo.
  const inserted = await db
    .insert(fundStakes)
    .values({
      newsId: f.id,
      symbol: f.symbol,
      filingUrl: f.url,
      formType,
      filerName: cover?.filerName ?? null,
      percentOfClass: cover?.percentOfClass ?? null,
      filedAt: new Date(f.published_at),
    })
    .onConflictDoNothing()
    .returning({ id: fundStakes.id });
  return inserted.length;
}

export async function ingestInsiderData(
  opts: { limit?: number; lookbackHours?: number } = {},
): Promise<InsiderIngestResult> {
  const limit = opts.limit ?? PARSE_CAP;
  const pending = await claimPendingFilings(
    limit,
    opts.lookbackHours ?? LOOKBACK_HOURS,
  );
  const result: InsiderIngestResult = {
    scanned: pending.length,
    trades: 0,
    stakes: 0,
    failed: 0,
  };

  for (const f of pending) {
    try {
      if (f.headline.endsWith("files Form 4 (insider)")) {
        result.trades += await ingestForm4(f);
      } else {
        result.stakes += await ingestStake(f);
      }
    } catch (e) {
      // La marca ya está puesta por el claim, también para los que fallan: un
      // filing que revienta el parser lo haría igual en el próximo tick.
      result.failed++;
      console.warn(
        `[insider] parse failed news=${f.id}:`,
        e instanceof Error ? e.message : e,
      );
    }
    await new Promise((r) => setTimeout(r, GAP_MS));
  }
  return result;
}

export async function deleteOldInsiderData(): Promise<void> {
  await db.execute(sql`
    DELETE FROM insider_trades
    WHERE filed_at < now() - (${TRADES_RETENTION_DAYS} || ' days')::interval
  `);
  await db.execute(sql`
    DELETE FROM fund_stakes
    WHERE filed_at < now() - (${STAKES_RETENTION_DAYS} || ' days')::interval
  `);
}
