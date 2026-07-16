import { sql, desc } from "drizzle-orm";
import { db, unwrapRows } from "@/lib/db";
import { aiPicks } from "@/lib/db/schema";
import { proseCompletion } from "@/lib/ai/prose-chain";

// AI Picks — "qué stocks comenta hoy el tape como buenas inversiones".
// Pipeline: (1) SQL agrega la cobertura bullish de 24h por ticker
// (candidatos = ≥2 items alto-impacto positivos y sesgo medio positivo);
// (2) el LLM lee los titulares bullish de cada candidato y SELECCIONA 3-6
// con una tesis redactada + catalizadores + caution si hay cobertura
// negativa el mismo día. JSON validado por código antes de persistir.
// Cadencia: maybeGeneratePicks(4h) desde cron-runner + refresh-once.
//
// Framing: "lo que dice la calle HOY según el tape" — nunca consejo de
// inversión propio. El prompt prohíbe opinar más allá de los items.

const PICKS_MAX_AGE_HOURS = 4;
const MAX_CANDIDATES = 8;
const HEADLINES_PER_CANDIDATE = 6;
const PICKS_KEEP_LAST = 20;

const PICKS_SYSTEM_PROMPT = `You are an equities desk analyst. You receive, for each candidate stock, today's bullish coverage (analyst upgrades, earnings beats, positive catalysts) plus aggregate stats. Select the 3-6 stocks the STREET is most clearly talking up as good investments TODAY, and explain why.
Output ONLY a JSON object: {"picks": [{"symbol": "...", "thesis": "...", "catalysts": ["..."], "caution": "..."}]}
Rules:
- "thesis": 1-2 sentences — why analysts/news favor it today. Grounded ONLY in the provided items; never invent numbers, ratings or events.
- "catalysts": 1-3 short phrases naming the concrete drivers (e.g. "Evercore PT hike to $520", "Q2 beat, raised FY guidance").
- "caution": include ONLY if the provided data shows same-day negative coverage or the aggregates show mixed sentiment; one short sentence. Omit the field otherwise.
- Rank picks by strength of today's bullish case. Fewer, stronger picks beat a padded list.
- Skip candidates whose coverage is stale, promotional, or thin — an empty-ish list is acceptable if the day is quiet.`;

export type TickerPick = {
  symbol: string;
  thesis: string;
  catalysts: string[];
  caution?: string;
};

export type PicksRow = {
  id: number;
  picks: TickerPick[];
  model: string;
  newsCount: number;
  generatedAt: Date;
};

function parseRow(r: {
  id: number;
  content: string;
  model: string;
  newsCount: number;
  generatedAt: Date;
}): PicksRow | null {
  try {
    const picks = JSON.parse(r.content) as TickerPick[];
    if (!Array.isArray(picks)) return null;
    return {
      id: r.id,
      picks,
      model: r.model,
      newsCount: r.newsCount,
      generatedAt: r.generatedAt,
    };
  } catch {
    return null;
  }
}

export async function getLatestPicks(): Promise<PicksRow | null> {
  const rows = await db
    .select()
    .from(aiPicks)
    .orderBy(desc(aiPicks.generatedAt))
    .limit(1);
  return rows[0] ? parseRow(rows[0]) : null;
}

type CandidateRow = {
  ticker: string;
  name: string | null;
  mentions: number;
  bullish_hits: number;
  bearish_hits: number;
  avg_sent: number;
  max_impact: number;
};

type HeadlineRow = {
  ticker: string;
  headline: string;
  category: string | null;
  impact: number;
  sentiment: number;
  published_at: string | Date;
};

// Valida la salida del modelo: solo símbolos que estaban entre los
// candidatos (nada inventado), shapes correctos, strings recortados.
function sanitizePicks(
  raw: unknown,
  allowed: Set<string>,
): TickerPick[] {
  const arr = Array.isArray(raw)
    ? raw
    : typeof raw === "object" && raw !== null && Array.isArray((raw as { picks?: unknown }).picks)
      ? (raw as { picks: unknown[] }).picks
      : [];
  const out: TickerPick[] = [];
  for (const p of arr) {
    if (typeof p !== "object" || p === null) continue;
    const o = p as Record<string, unknown>;
    const symbol = String(o.symbol ?? "").toUpperCase().trim();
    const thesis = String(o.thesis ?? "").trim();
    if (!allowed.has(symbol) || thesis.length < 20) continue;
    const catalysts = Array.isArray(o.catalysts)
      ? o.catalysts.map((c) => String(c).trim()).filter(Boolean).slice(0, 3)
      : [];
    const caution =
      typeof o.caution === "string" && o.caution.trim().length > 0
        ? o.caution.trim()
        : undefined;
    out.push({ symbol, thesis: thesis.slice(0, 400), catalysts, ...(caution ? { caution: caution.slice(0, 200) } : {}) });
    if (out.length >= 6) break;
  }
  return out;
}

// Genera y persiste picks nuevos. Lanza si no hay candidatos suficientes
// (día tranquilo) o si todos los modelos fallan.
export async function generatePicks(): Promise<PicksRow> {
  const candidates = unwrapRows<CandidateRow>(
    await db.execute(sql`
      SELECT nt.ticker, MAX(t.name) AS name,
        COUNT(*)::int AS mentions,
        COUNT(*) FILTER (WHERE s.sentiment >= 2 AND s.impact >= 3)::int AS bullish_hits,
        COUNT(*) FILTER (WHERE s.sentiment <= -2 AND s.impact >= 3)::int AS bearish_hits,
        ROUND(AVG(s.sentiment)::numeric, 1)::float AS avg_sent,
        MAX(s.impact)::int AS max_impact
      FROM news_tickers nt
      JOIN news n ON n.id = nt.news_id
      JOIN news_scores s ON s.news_id = n.id
      LEFT JOIN tickers t ON t.symbol = nt.ticker
      WHERE n.published_at >= now() - interval '24 hours'
      GROUP BY nt.ticker
      HAVING COUNT(*) FILTER (WHERE s.sentiment >= 2 AND s.impact >= 3) >= 2
        AND AVG(s.sentiment) > 0.5
      ORDER BY COUNT(*) FILTER (WHERE s.sentiment >= 2 AND s.impact >= 3) DESC,
        AVG(s.sentiment) DESC
      LIMIT ${MAX_CANDIDATES}
    `),
  );
  if (candidates.length < 2) {
    throw new Error(
      `not enough bullish candidates for picks (${candidates.length})`,
    );
  }

  const candidateList = sql.join(
    candidates.map((c) => sql`${c.ticker}`),
    sql`, `,
  );
  const headlines = unwrapRows<HeadlineRow>(
    await db.execute(sql`
      SELECT * FROM (
        SELECT nt.ticker, n.headline, n.category, s.impact, s.sentiment,
          n.published_at,
          ROW_NUMBER() OVER (
            PARTITION BY nt.ticker
            ORDER BY (s.sentiment >= 2 AND s.impact >= 3) DESC, s.impact DESC,
              n.published_at DESC
          ) AS rn
        FROM news_tickers nt
        JOIN news n ON n.id = nt.news_id
        JOIN news_scores s ON s.news_id = n.id
        WHERE n.published_at >= now() - interval '24 hours'
          AND nt.ticker IN (${candidateList})
      ) x WHERE rn <= ${HEADLINES_PER_CANDIDATE}
    `),
  );

  const byTicker = new Map<string, HeadlineRow[]>();
  for (const h of headlines) {
    const list = byTicker.get(h.ticker) ?? [];
    list.push(h);
    byTicker.set(h.ticker, list);
  }

  const blocks = candidates.map((c) => {
    const hs = (byTicker.get(c.ticker) ?? []).map((h) => {
      const sent = h.sentiment > 0 ? `+${h.sentiment}` : `${h.sentiment}`;
      return `  - [imp=${h.impact} sent=${sent} ${h.category ?? "?"}] ${h.headline}`;
    });
    return [
      `${c.ticker}${c.name ? ` (${c.name})` : ""} — ${c.mentions} mentions 24h, ${c.bullish_hits} bullish / ${c.bearish_hits} bearish high-impact, avg sentiment ${c.avg_sent >= 0 ? "+" : ""}${c.avg_sent}`,
      ...hs,
    ].join("\n");
  });

  const userPrompt = [
    `Candidates with today's coverage (impact 1-5, sentiment -5..+5):`,
    ``,
    ...blocks,
  ].join("\n");

  const result = await proseCompletion({
    messages: [
      { role: "system", content: PICKS_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.3,
    maxTokens: 900,
    jsonMode: true,
    tag: "picks",
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(
      result.content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, ""),
    );
  } catch {
    throw new Error(
      `picks output unparseable: "${result.content.slice(0, 120)}"`,
    );
  }
  const allowed = new Set(candidates.map((c) => c.ticker.toUpperCase()));
  const picks = sanitizePicks(parsed, allowed);
  if (picks.length === 0) {
    throw new Error("picks output had no valid entries — discarded");
  }

  const inserted = await db
    .insert(aiPicks)
    .values({
      content: JSON.stringify(picks),
      model: result.model,
      newsCount: headlines.length,
    })
    .returning();

  await db.execute(sql`
    DELETE FROM ai_picks WHERE id NOT IN (
      SELECT id FROM ai_picks ORDER BY generated_at DESC LIMIT ${PICKS_KEEP_LAST}
    )
  `);

  const r = inserted[0];
  return {
    id: r.id,
    picks,
    model: r.model,
    newsCount: r.newsCount,
    generatedAt: r.generatedAt,
  };
}

export async function maybeGeneratePicks(
  maxAgeHours = PICKS_MAX_AGE_HOURS,
): Promise<{ generated: boolean; picks: PicksRow | null }> {
  const latest = await getLatestPicks();
  if (
    latest &&
    Date.now() - latest.generatedAt.getTime() < maxAgeHours * 3600_000
  ) {
    return { generated: false, picks: latest };
  }
  const picks = await generatePicks();
  return { generated: true, picks };
}
