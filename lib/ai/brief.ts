import { sql, desc } from "drizzle-orm";
import { db, unwrapRows } from "@/lib/db";
import { aiBriefs } from "@/lib/db/schema";
import { getQuotesMap } from "@/lib/providers/finnhub";
import { proseCompletion } from "@/lib/ai/prose-chain";
import { cleanModelProse, looksLikeScratchpad } from "@/lib/ai/guards";

// AI Brief — resumen accionable del día para el dashboard. Junta las
// noticias mejor puntuadas de las últimas 24h + la watchlist y pide a un
// modelo instruction-tuned (task="brief", NUNCA reasoning models — sueltan
// scratchpad en prosa user-facing) un briefing de 5-8 bullets estilo
// trading desk. Coste: 1 llamada cada ≥4h → ~4-6 calls/día del pool.

const BRIEF_MAX_AGE_HOURS = 4;
// Pedimos más filas de las que mandamos: el dedupe por titular normalizado
// (la misma historia entra 3-4 veces vía fuentes RSS distintas) recorta
// hasta el cap final sin desperdiciar contexto en repeticiones.
const BRIEF_NEWS_FETCH = 45;
const BRIEF_NEWS_LIMIT = 35;
const BRIEF_KEEP_LAST = 20;

// Prompt v2 (2026-07-16): el v1 solo veía titulares sueltos y lo único que
// podía hacer era parafrasearlos. Ahora recibe precios de watchlist,
// agregados por ticker y pulso de mercado, y se le pide tesis (qué pasó Y
// por qué importa), tema dominante primero y catalizadores concretos.
const BRIEF_SYSTEM_PROMPT = `You write the daily trading-desk brief for an equities investor. You receive: the investor's watchlist (with today's price moves when available), the top scored headlines of the last 24h, per-ticker tape aggregates, and a market-pulse count of high-impact items.
Rules:
- Output ONLY plain markdown bullets ("- " lines). No title, no preamble, no code fences, no closing remarks.
- First bullet: "**Top story:** ..." — the single most market-moving theme of the day and why it matters.
- Then 4-6 bullets, each at most 2 lines. Group related items into one theme (e.g. several bank earnings = one bullet). For each: what happened AND why it matters for positioning — never just restate headlines.
- Bold ticker symbols like **NVDA**. State direction plainly (beat/miss/upgrade/M&A/selloff).
- Start any bullet involving a WATCHLIST ticker with "⭐ " and, when a price move is provided, connect the news to it (e.g. "explaining today's -4%").
- Use the aggregates for breadth: call out when one name dominates the tape or a sector moves together. Only when meaningful.
- Be strictly factual: use ONLY the provided data. Never invent numbers, prices or events.
- If the data does not explain a move, do NOT speculate — omit vague filler like "concerns about the company's direction" or "broader market weakness" unless an item states it.
- Maximum 8 bullets TOTAL including Top story and Watch. Skip low-signal names rather than exceeding the cap.
- Final bullet: "**Watch:** ..." — ONE single line with 2-4 concrete upcoming catalysts drawn from the items (earnings dates, regulatory/legal decisions, pending follow-ups). No sub-bullets.`;

export type BriefRow = {
  id: number;
  content: string;
  model: string;
  generatedAt: Date;
};

export async function getLatestBrief(): Promise<BriefRow | null> {
  const rows = await db
    .select()
    .from(aiBriefs)
    .orderBy(desc(aiBriefs.generatedAt))
    .limit(1);
  const r = rows[0];
  return r
    ? { id: r.id, content: r.content, model: r.model, generatedAt: r.generatedAt }
    : null;
}

type BriefNewsRow = {
  headline: string;
  impact: number;
  sentiment: number;
  category: string | null;
  published_at: Date;
  tickers: string[];
};

// Dedupe barato de titulares casi idénticos (misma historia vía varias
// fuentes RSS): clave = primeros 60 chars alfanuméricos en minúscula.
function headlineKey(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 60);
}

// Genera y persiste un brief nuevo. Lanza si no hay señal suficiente (<5
// noticias puntuadas en 24h) o si todos los modelos fallan.
export async function generateBrief(): Promise<BriefRow> {
  const fetched = unwrapRows<BriefNewsRow>(
    await db.execute(sql`
      SELECT n.headline, s.impact, s.sentiment, n.category, n.published_at,
        ARRAY(SELECT ticker FROM news_tickers WHERE news_id = n.id) AS tickers
      FROM news n
      JOIN news_scores s ON s.news_id = n.id
      WHERE n.published_at >= now() - interval '24 hours' AND s.impact >= 3
      ORDER BY s.impact DESC, n.published_at DESC
      LIMIT ${BRIEF_NEWS_FETCH}
    `),
  );
  const seen = new Set<string>();
  const newsRows = fetched
    .filter((r) => {
      const k = headlineKey(r.headline);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, BRIEF_NEWS_LIMIT);
  if (newsRows.length < 5) {
    throw new Error(`not enough scored signal for a brief (${newsRows.length} items)`);
  }

  const watchRows = unwrapRows<{ symbol: string }>(
    await db.execute(sql`SELECT DISTINCT symbol FROM watchlist ORDER BY symbol`),
  );
  const watchlist = watchRows.map((w) => w.symbol);

  // Contexto extra v2 (todo best-effort — el brief nunca debe caerse por
  // una pata de contexto):
  //   quotes  → % del día de la watchlist, para conectar noticia↔precio.
  //   aggs    → concentración del tape por ticker (menciones + sesgo).
  //   pulse   → breadth de los high-impact (risk-on/risk-off del día).
  const [quotes, aggRows, pulseRows] = await Promise.all([
    watchlist.length
      ? getQuotesMap(watchlist).catch(() => ({}) as Record<string, never>)
      : Promise.resolve({} as Record<string, never>),
    db
      .execute(
        sql`
        SELECT nt.ticker, COUNT(*)::int AS mentions,
               ROUND(AVG(s.sentiment)::numeric, 1)::float AS avg_sent,
               MAX(s.impact)::int AS max_impact
        FROM news_tickers nt
        JOIN news n ON n.id = nt.news_id
        JOIN news_scores s ON s.news_id = n.id
        WHERE n.published_at >= now() - interval '24 hours'
        GROUP BY nt.ticker
        ORDER BY COUNT(*) DESC, MAX(s.impact) DESC
        LIMIT 10
      `,
      )
      .then(unwrapRows<{ ticker: string; mentions: number; avg_sent: number; max_impact: number }>)
      .catch(() => []),
    db
      .execute(
        sql`
        SELECT COUNT(*) FILTER (WHERE s.sentiment > 0)::int AS pos,
               COUNT(*) FILTER (WHERE s.sentiment < 0)::int AS neg,
               COUNT(*)::int AS total
        FROM news n
        JOIN news_scores s ON s.news_id = n.id
        WHERE n.published_at >= now() - interval '24 hours' AND s.impact >= 4
      `,
      )
      .then(unwrapRows<{ pos: number; neg: number; total: number }>)
      .catch(() => []),
  ]);

  const watchlistLine = watchlist.length
    ? watchlist
        .map((s) => {
          const q = (quotes as Record<string, { changePercent: number } | null>)[s];
          return q
            ? `${s} (${q.changePercent >= 0 ? "+" : ""}${q.changePercent.toFixed(1)}% today)`
            : s;
        })
        .join(", ")
    : "(empty)";

  const aggLines = aggRows.map(
    (a) =>
      `- ${a.ticker}: ${a.mentions} mentions, avg sentiment ${a.avg_sent >= 0 ? "+" : ""}${a.avg_sent}, max impact ${a.max_impact}`,
  );
  const pulse = pulseRows[0];

  const lines = newsRows.map((r) => {
    const t = new Date(r.published_at).toISOString().slice(11, 16);
    const sent = r.sentiment > 0 ? `+${r.sentiment}` : `${r.sentiment}`;
    return `- [imp=${r.impact} sent=${sent} ${r.category ?? "?"}] (${(r.tickers ?? []).join(",") || "—"}) ${r.headline} (${t}Z)`;
  });
  const userPrompt = [
    `Watchlist: ${watchlistLine}`,
    ``,
    ...(pulse && pulse.total > 0
      ? [
          `Market pulse: ${pulse.total} high-impact items in 24h — ${pulse.pos} positive / ${pulse.neg} negative.`,
          ``,
        ]
      : []),
    ...(aggLines.length
      ? [`Most-covered tickers, last 24h:`, ...aggLines, ``]
      : []),
    `Top scored news, last 24h (impact 1-5, sentiment -5..+5, times UTC):`,
    ...lines,
  ].join("\n");

  const messages = [
    { role: "system" as const, content: BRIEF_SYSTEM_PROMPT },
    { role: "user" as const, content: userPrompt },
  ];
  // Cadena completa (openrouter → gemini → groq 70b → 8b) en prose-chain.
  const result = await proseCompletion({
    messages,
    temperature: 0.4,
    maxTokens: 800,
    tag: "brief",
  });

  const content = cleanModelProse(result.content);
  if (!content || content.length < 40) {
    throw new Error(`brief too short: "${content.slice(0, 80)}"`);
  }
  if (looksLikeScratchpad(content)) {
    throw new Error("brief looks like model scratchpad — discarded");
  }

  const inserted = await db
    .insert(aiBriefs)
    .values({ content, model: result.model })
    .returning();

  // Retención: conservar solo los últimos N briefs.
  await db.execute(sql`
    DELETE FROM ai_briefs WHERE id NOT IN (
      SELECT id FROM ai_briefs ORDER BY generated_at DESC LIMIT ${BRIEF_KEEP_LAST}
    )
  `);

  const r = inserted[0];
  return { id: r.id, content: r.content, model: r.model, generatedAt: r.generatedAt };
}

// Regenera solo si el último brief tiene más de maxAgeHours. Pensado para
// llamarse desde el cron (GH Actions) y el refresher local — con el age
// check, la cadencia real de generación es ~4-6/día independientemente de
// cuántos ticks lo intenten.
export async function maybeGenerateBrief(
  maxAgeHours = BRIEF_MAX_AGE_HOURS,
): Promise<{ generated: boolean; brief: BriefRow | null }> {
  const latest = await getLatestBrief();
  if (
    latest &&
    Date.now() - latest.generatedAt.getTime() < maxAgeHours * 3600_000
  ) {
    return { generated: false, brief: latest };
  }
  const brief = await generateBrief();
  return { generated: true, brief };
}
