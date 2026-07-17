import { sql, desc, eq } from "drizzle-orm";
import { db, unwrapRows } from "@/lib/db";
import { tickerBriefs } from "@/lib/db/schema";
import { getQuote } from "@/lib/providers/finnhub";
import { proseCompletion } from "@/lib/ai/prose-chain";
import { cleanModelProse, looksLikeScratchpad } from "@/lib/ai/guards";

// Ticker Day Brief — "qué está pasando HOY con este stock". Al entrar en
// /ticker/[symbol], el endpoint pide aquí un resumen que lee TODA la
// cobertura de las últimas 24h del símbolo (incluidas noticias aún sin
// score) + el movimiento intradía de Finnhub, y se lo pasa a la cadena
// task="brief" (nemotron-ultra primero). Se cachea en ticker_briefs y solo
// se regenera cuando hay cobertura nueva — visitar la página en bucle no
// quema cuota del pool.

const WINDOW_HOURS = 24;
const NEWS_CAP = 80;
// Suelo duro: dentro de esta ventana servimos caché aunque haya noticias
// nuevas (protege el pool de refresh-spam en un día de firehose).
const MIN_AGE_MINUTES = 15;
// Sin cobertura nueva el brief sigue válido hasta este tope; pasado, se
// regenera igualmente para que el precio/encuadre no quede rancio.
const MAX_AGE_HOURS = 6;
const KEEP_PER_SYMBOL = 2;

const TICKER_BRIEF_SYSTEM_PROMPT = `You are a sharp equities desk analyst. Given today's full news tape for ONE stock (and its intraday price move), explain what is happening with this stock TODAY.
Rules:
- Output plain markdown only: ONE short lead paragraph (2-3 sentences) telling the story of the day — what is driving the stock and in which direction. Then 2-4 "- " bullets with the key items behind it, most market-moving first. Optional final bullet "Watch: ..." with what to monitor next (only from the provided items).
- No title, no preamble, no code fences, no closing remarks. At most ~140 words total.
- Bold ticker symbols like **MSFT**. Reference the price move when provided (e.g. "shares -4.2%").
- Be strictly factual: use ONLY the provided items and quote. Never invent numbers, prices, events or causes.
- If the tape does not explain the price move, say so plainly ("no clear catalyst in today's coverage").
- If coverage is thin or routine, say that in one sentence instead of inflating it.`;

export type TickerBriefRow = {
  id: number;
  symbol: string;
  content: string;
  model: string;
  newsCount: number;
  generatedAt: Date;
};

export type TickerBriefResult = {
  brief: TickerBriefRow | null;
  /** cached = servido de BD; generated = llamada LLM nueva; no_news = sin
   *  cobertura en 24h; stale = la generación falló y servimos el anterior. */
  status: "cached" | "generated" | "no_news" | "stale";
};

type TapeRow = {
  headline: string;
  source: string;
  category: string | null;
  published_at: Date;
  impact: number | null;
  sentiment: number | null;
};

export async function getLatestTickerBrief(
  symbol: string,
): Promise<(TickerBriefRow & { newestNewsAt: Date | null }) | null> {
  const rows = await db
    .select()
    .from(tickerBriefs)
    .where(eq(tickerBriefs.symbol, symbol))
    .orderBy(desc(tickerBriefs.generatedAt))
    .limit(1);
  const r = rows[0];
  return r
    ? {
        id: r.id,
        symbol: r.symbol,
        content: r.content,
        model: r.model,
        newsCount: r.newsCount,
        generatedAt: r.generatedAt,
        newestNewsAt: r.newestNewsAt,
      }
    : null;
}

async function fetchTape(symbol: string): Promise<TapeRow[]> {
  // db.execute crudo devuelve published_at como string (el driver de Neon
  // no mapea tipos fuera del query builder) — normalizamos a Date aquí
  // para que el resto del módulo pueda tratarlo como tal.
  const rows = unwrapRows<Omit<TapeRow, "published_at"> & { published_at: string | Date }>(
    await db.execute(sql`
      SELECT n.headline, n.source, n.category, n.published_at,
             s.impact, s.sentiment
      FROM news n
      JOIN news_tickers nt ON nt.news_id = n.id AND nt.ticker = ${symbol}
      LEFT JOIN news_scores s ON s.news_id = n.id
      WHERE n.published_at >= now() - make_interval(hours => ${WINDOW_HOURS})
      ORDER BY n.published_at DESC
      LIMIT ${NEWS_CAP}
    `),
  );
  return rows.map((r) => ({ ...r, published_at: new Date(r.published_at) }));
}

async function generateFromTape(
  symbol: string,
  tape: TapeRow[],
): Promise<TickerBriefRow> {
  const [quote, nameRows] = await Promise.all([
    getQuote(symbol).catch(() => null),
    db.execute(sql`SELECT name FROM tickers WHERE symbol = ${symbol}`),
  ]);
  const name = unwrapRows<{ name: string | null }>(nameRows)[0]?.name ?? null;

  const quoteLine =
    quote && quote.c > 0
      ? `$${quote.c.toFixed(2)}, ${quote.dp >= 0 ? "+" : ""}${quote.dp.toFixed(2)}% vs prev close (day range $${quote.l.toFixed(2)}–$${quote.h.toFixed(2)})`
      : "unavailable";

  const lines = tape.map((r) => {
    const t = new Date(r.published_at).toISOString().slice(11, 16);
    const score =
      r.impact != null
        ? `imp=${r.impact} sent=${r.sentiment != null && r.sentiment > 0 ? "+" : ""}${r.sentiment}`
        : "unscored";
    return `- [${t}Z ${score} ${r.category ?? "?"}] (${r.source}) ${r.headline}`;
  });

  const userPrompt = [
    `Stock: ${symbol}${name ? ` (${name})` : ""}`,
    `Intraday quote: ${quoteLine}`,
    ``,
    `News tape, last ${WINDOW_HOURS}h, newest first (impact 1-5, sentiment -5..+5, "unscored" = not graded yet):`,
    ...lines,
  ].join("\n");

  const messages = [
    { role: "system" as const, content: TICKER_BRIEF_SYSTEM_PROMPT },
    { role: "user" as const, content: userPrompt },
  ];

  // Cadena completa (openrouter → gemini → groq 70b → 8b) en prose-chain.
  const result = await proseCompletion({
    messages,
    temperature: 0.35,
    maxTokens: 450,
    tag: `ticker-brief:${symbol}`,
  });

  const content = cleanModelProse(result.content);
  if (!content || content.length < 30) {
    throw new Error(`ticker brief too short: "${content.slice(0, 80)}"`);
  }
  if (looksLikeScratchpad(content)) {
    throw new Error("ticker brief looks like model scratchpad — discarded");
  }

  const newestNewsAt = tape[0]?.published_at ?? null;
  const inserted = await db
    .insert(tickerBriefs)
    .values({
      symbol,
      content,
      model: result.model,
      newsCount: tape.length,
      newestNewsAt,
    })
    .returning();

  await db.execute(sql`
    DELETE FROM ticker_briefs
    WHERE symbol = ${symbol} AND id NOT IN (
      SELECT id FROM ticker_briefs WHERE symbol = ${symbol}
      ORDER BY generated_at DESC LIMIT ${KEEP_PER_SYMBOL}
    )
  `);

  const r = inserted[0];
  return {
    id: r.id,
    symbol: r.symbol,
    content: r.content,
    model: r.model,
    newsCount: r.newsCount,
    generatedAt: r.generatedAt,
  };
}

// Dedupe de llamadas concurrentes en el mismo proceso (dos pestañas abren
// el mismo ticker a la vez → una sola llamada LLM). Map módulo-level, se
// limpia al resolver. En Cloudflare Workers NO se dedupe: compartir una
// Promise con I/O en vuelo entre requests del mismo isolate es la clase de
// bug "Cannot perform I/O on behalf of a different request" del Pool
// module-level. El caché por-símbolo en BD ya acota el coste extra.
const inflight = new Map<string, Promise<TickerBriefResult>>();
const IS_WORKERS =
  typeof (globalThis as { WebSocketPair?: unknown }).WebSocketPair !==
  "undefined";

export async function maybeGenerateTickerBrief(
  symbol: string,
): Promise<TickerBriefResult> {
  if (IS_WORKERS) return maybeGenerateTickerBriefInner(symbol);
  const existing = inflight.get(symbol);
  if (existing) return existing;
  const p = maybeGenerateTickerBriefInner(symbol).finally(() =>
    inflight.delete(symbol),
  );
  inflight.set(symbol, p);
  return p;
}

async function maybeGenerateTickerBriefInner(
  symbol: string,
): Promise<TickerBriefResult> {
  const [tape, latest] = await Promise.all([
    fetchTape(symbol),
    getLatestTickerBrief(symbol),
  ]);

  if (tape.length === 0) return { brief: null, status: "no_news" };

  if (latest) {
    const ageMs = Date.now() - latest.generatedAt.getTime();
    const newestTapeAt = tape[0].published_at.getTime();
    const hasNewCoverage =
      latest.newestNewsAt == null ||
      newestTapeAt > latest.newestNewsAt.getTime();
    const withinFloor = ageMs < MIN_AGE_MINUTES * 60_000;
    const withinMax = ageMs < MAX_AGE_HOURS * 3600_000;
    if (withinFloor || (!hasNewCoverage && withinMax)) {
      return { brief: latest, status: "cached" };
    }
  }

  try {
    const brief = await generateFromTape(symbol, tape);
    return { brief, status: "generated" };
  } catch (err) {
    if (latest) {
      console.warn(
        `[ticker-brief] ${symbol} generation failed, serving stale:`,
        err instanceof Error ? err.message.slice(0, 120) : err,
      );
      return { brief: latest, status: "stale" };
    }
    throw err;
  }
}
