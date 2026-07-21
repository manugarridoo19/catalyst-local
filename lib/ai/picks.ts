import { sql, desc } from "drizzle-orm";
import { db, unwrapRows } from "@/lib/db";
import { aiPicks } from "@/lib/db/schema";
import { proseCompletion } from "@/lib/ai/prose-chain";
import { getInsiderNetBySymbols } from "@/lib/insider/queries";
import { getEmpiricalPriors } from "@/lib/signals/priors";
import { getQuotesMap, type CompactQuote } from "@/lib/providers/finnhub";

// AI Picks v2 — "qué stocks están CONSTRUYENDO momentum en el tape".
//
// v1 miraba solo las 24h → seleccionaba lo que YA explotó hoy (victory
// lap). v2 busca candidatos de watchlist A FUTURO: (1) SQL agrega la
// cobertura en dos ventanas — señal 72h vs baseline días 3-7 — y calcula
// la ACELERACIÓN de cobertura; (2) se enriquece cada candidato con insider
// net buying 7d (insider_trades), próximo earnings (si está cacheado) y el
// % del día (quote); (3) el LLM selecciona 3-6 historias en construcción y
// PENALIZA lo que ya hizo su movimiento hoy. JSON validado por código.
// Cadencia: maybeGeneratePicks(4h) desde cron-runner + refresh-once.
//
// Framing: "momentum building en el tape según lo publicado" — nunca
// consejo de inversión propio. El prompt prohíbe opinar más allá de los
// datos provistos.

const PICKS_MAX_AGE_HOURS = 4;
const MAX_CANDIDATES = 10;
const HEADLINES_PER_CANDIDATE = 6;
const PICKS_KEEP_LAST = 20;
// Horizonte de earnings que mostramos como catalizador (días).
const EARNINGS_HORIZON_DAYS = 21;

const PICKS_SYSTEM_PROMPT = `You are an equities desk analyst hunting for stocks where positive news flow is BUILDING momentum — coverage accelerating, catalysts stacking up — where the move may not have fully played out yet. These are WATCHLIST candidates for the days ahead, not victory laps on today's winners.
You receive, for each candidate: coverage stats for the last 72h vs the prior 4 days (acceleration), today's price change, insider net buying (7d, open market, when available), the next earnings date (when known), and the recent headlines.
Output ONLY a JSON object: {"picks": [{"symbol": "...", "thesis": "...", "momentum": "...", "catalysts": ["..."], "watch_for": "...", "caution": "..."}]}
Rules:
- Select 3-6. Prefer BUILDING stories: mention rate accelerating vs the prior week, sentiment improving, upgrades stacking, insider buying alongside positive coverage.
- PENALIZE already-exploded moves: a stock up a lot TODAY (>+6%) has likely played its near-term hand — skip it unless the data shows the story still developing, and if you keep it, say why in "caution".
- "thesis": 1-2 sentences — why this is a watchlist candidate for the days ahead. Grounded ONLY in the provided items; never invent numbers, ratings or events.
- "momentum": 1 sentence naming WHAT is accelerating, with the numbers provided (e.g. "coverage 3× the prior week's rate, avg sentiment +0.4 → +1.8").
- "catalysts": 1-3 short phrases naming concrete drivers from the headlines.
- "watch_for": include ONLY if the data names a concrete upcoming trigger (earnings date given, pending regulatory decision, announced event); one short phrase. Omit the field otherwise — never invent a date.
- "caution": include ONLY if same-window negative coverage, heavy insider selling, or an already-large move argues for care; one short sentence. Omit otherwise.
- Rank by strength of the building case. Fewer, stronger picks beat a padded list; an empty-ish list is acceptable if nothing is genuinely building.`;

export type TickerPick = {
  symbol: string;
  thesis: string;
  momentum?: string;
  catalysts: string[];
  watchFor?: string;
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
    console.warn(`[picks] corrupt row id=${r.id} — skipping`);
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
  mentions_recent: number;
  mentions_base: number;
  bullish_recent: number;
  bearish_recent: number;
  avg_sent_recent: number;
  avg_sent_base: number | null;
  max_impact_recent: number;
};

type HeadlineRow = {
  ticker: string;
  headline: string;
  category: string | null;
  impact: number;
  sentiment: number;
  published_at: string | Date;
};

// Aceleración de cobertura: ritmo diario 72h vs ritmo diario del baseline
// (días 3-7). Baseline 0 → se compara contra un suelo de 0.5 items/día
// para que un valor sin historia previa no dé ratios infinitos.
function coverageAccel(c: CandidateRow): number {
  const recentRate = c.mentions_recent / 3;
  const baseRate = Math.max(c.mentions_base / 4, 0.5);
  return recentRate / baseRate;
}

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
    const momentum =
      typeof o.momentum === "string" && o.momentum.trim().length > 0
        ? o.momentum.trim().slice(0, 260)
        : undefined;
    const watchFor =
      typeof o.watch_for === "string" && o.watch_for.trim().length > 0
        ? o.watch_for.trim().slice(0, 160)
        : typeof o.watchFor === "string" && o.watchFor.trim().length > 0
          ? o.watchFor.trim().slice(0, 160)
          : undefined;
    const caution =
      typeof o.caution === "string" && o.caution.trim().length > 0
        ? o.caution.trim().slice(0, 200)
        : undefined;
    out.push({
      symbol,
      thesis: thesis.slice(0, 400),
      catalysts,
      ...(momentum ? { momentum } : {}),
      ...(watchFor ? { watchFor } : {}),
      ...(caution ? { caution } : {}),
    });
    if (out.length >= 6) break;
  }
  return out;
}

// Próximo earnings por símbolo (solo lo ya cacheado en earnings_events —
// hoy se refresca para la watchlist, así que para muchos candidatos no
// habrá fila; es señal best-effort, no se fetchea nada aquí).
async function getNextEarnings(
  symbols: string[],
): Promise<Map<string, string>> {
  if (!symbols.length) return new Map();
  const list = sql.join(
    symbols.map((s) => sql`${s}`),
    sql`, `,
  );
  const rows = unwrapRows<{ symbol: string; date: string }>(
    await db.execute(sql`
      SELECT symbol, MIN(date) AS date
      FROM earnings_events
      WHERE symbol IN (${list})
        AND date >= to_char(now(), 'YYYY-MM-DD')
        AND date <= to_char(now() + (${EARNINGS_HORIZON_DAYS} || ' days')::interval, 'YYYY-MM-DD')
      GROUP BY symbol
    `),
  );
  return new Map(rows.map((r) => [r.symbol, r.date]));
}

// Genera y persiste picks nuevos. Lanza si no hay candidatos suficientes
// (semana tranquila) o si todos los modelos fallan.
export async function generatePicks(): Promise<PicksRow> {
  const candidates = unwrapRows<CandidateRow>(
    await db.execute(sql`
      SELECT nt.ticker, MAX(t.name) AS name,
        COUNT(*) FILTER (WHERE n.published_at >= now() - interval '72 hours')::int AS mentions_recent,
        COUNT(*) FILTER (WHERE n.published_at < now() - interval '72 hours')::int AS mentions_base,
        COUNT(*) FILTER (WHERE s.sentiment >= 2 AND s.impact >= 3
          AND n.published_at >= now() - interval '72 hours')::int AS bullish_recent,
        COUNT(*) FILTER (WHERE s.sentiment <= -2 AND s.impact >= 3
          AND n.published_at >= now() - interval '72 hours')::int AS bearish_recent,
        COALESCE(ROUND((AVG(s.sentiment) FILTER (
          WHERE n.published_at >= now() - interval '72 hours'))::numeric, 1)::float, 0) AS avg_sent_recent,
        ROUND((AVG(s.sentiment) FILTER (
          WHERE n.published_at < now() - interval '72 hours'))::numeric, 1)::float AS avg_sent_base,
        COALESCE(MAX(s.impact) FILTER (
          WHERE n.published_at >= now() - interval '72 hours')::int, 0) AS max_impact_recent
      FROM news_tickers nt
      JOIN news n ON n.id = nt.news_id
      JOIN news_scores s ON s.news_id = n.id
      LEFT JOIN tickers t ON t.symbol = nt.ticker
      WHERE n.published_at >= now() - interval '7 days'
      GROUP BY nt.ticker
      HAVING COUNT(*) FILTER (WHERE s.sentiment >= 2 AND s.impact >= 3
          AND n.published_at >= now() - interval '72 hours') >= 2
        AND AVG(s.sentiment) FILTER (
          WHERE n.published_at >= now() - interval '72 hours') > 0.5
      ORDER BY COUNT(*) FILTER (WHERE s.sentiment >= 2 AND s.impact >= 3
          AND n.published_at >= now() - interval '72 hours') DESC,
        AVG(s.sentiment) FILTER (
          WHERE n.published_at >= now() - interval '72 hours') DESC
      LIMIT ${MAX_CANDIDATES}
    `),
  );
  if (candidates.length < 2) {
    throw new Error(
      `not enough momentum candidates for picks (${candidates.length})`,
    );
  }

  const symbols = candidates.map((c) => c.ticker);

  // Contexto extra por candidato — todo best-effort: una pata caída
  // degrada la calidad del prompt, no rompe la generación.
  const [insiderNet, nextEarnings, quotes] = await Promise.all([
    getInsiderNetBySymbols(symbols).catch(() => new Map<string, number>()),
    getNextEarnings(symbols).catch(() => new Map<string, string>()),
    getQuotesMap(symbols).catch(
      () => ({}) as Record<string, CompactQuote | null>,
    ),
  ]);

  const candidateList = sql.join(
    symbols.map((s) => sql`${s}`),
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
        WHERE n.published_at >= now() - interval '72 hours'
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

  // Los que ya se movieron fuerte HOY van al final del prompt — el orden
  // ancla al modelo, y el prompt además los penaliza explícitamente.
  const ordered = [...candidates].sort((a, b) => {
    const qa = Math.abs(quotes[a.ticker]?.changePercent ?? 0);
    const qb = Math.abs(quotes[b.ticker]?.changePercent ?? 0);
    const bigA = qa > 6 ? 1 : 0;
    const bigB = qb > 6 ? 1 : 0;
    if (bigA !== bigB) return bigA - bigB;
    return coverageAccel(b) - coverageAccel(a);
  });

  const blocks = ordered.map((c) => {
    const hs = (byTicker.get(c.ticker) ?? []).map((h) => {
      const sent = h.sentiment > 0 ? `+${h.sentiment}` : `${h.sentiment}`;
      return `  - [imp=${h.impact} sent=${sent} ${h.category ?? "?"}] ${h.headline}`;
    });
    const accel = coverageAccel(c);
    const q = quotes[c.ticker];
    const net = insiderNet.get(c.ticker);
    const earn = nextEarnings.get(c.ticker);
    const extras = [
      q
        ? `today ${q.changePercent >= 0 ? "+" : ""}${q.changePercent.toFixed(1)}%`
        : null,
      net !== undefined && Math.abs(net) >= 50_000
        ? `insider net 7d ${net >= 0 ? "+" : "-"}$${Math.abs(net / 1e6).toFixed(2)}M ${net >= 0 ? "bought" : "sold"} (open market)`
        : null,
      earn ? `next earnings ${earn}` : null,
    ].filter(Boolean);
    return [
      `${c.ticker}${c.name ? ` (${c.name})` : ""} — 72h: ${c.mentions_recent} items (${accel.toFixed(1)}× prior-week daily rate), ` +
        `${c.bullish_recent} bullish / ${c.bearish_recent} bearish high-impact, ` +
        `avg sent ${c.avg_sent_recent >= 0 ? "+" : ""}${c.avg_sent_recent}` +
        (c.avg_sent_base != null
          ? ` (prior ${c.avg_sent_base >= 0 ? "+" : ""}${c.avg_sent_base})`
          : " (no prior coverage)"),
      ...(extras.length ? [`  ${extras.join(" | ")}`] : []),
      ...hs,
    ].join("\n");
  });

  const userPrompt = [
    `Candidates (impact 1-5, sentiment -5..+5). Ordered strongest building case first; already-moved-today names last:`,
    ``,
    ...blocks,
  ].join("\n");

  // Priors del Signal Lab: cómo le ha ido HISTÓRICAMENTE a cada tipo de
  // señal de Catalyst. No es predicción, es calibración de exigencia — y si
  // aún no hay muestra suficiente, el prompt sale exactamente como antes.
  const priors = await getEmpiricalPriors([
    "ai_pick",
    "cluster_buy",
    "insider_net_buy",
    "analyst_upgrade",
  ]);

  const result = await proseCompletion({
    messages: [
      {
        role: "system",
        content: priors ? PICKS_SYSTEM_PROMPT + "\n" + priors : PICKS_SYSTEM_PROMPT,
      },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.3,
    maxTokens: 1100,
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
  const allowed = new Set(symbols.map((s) => s.toUpperCase()));
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
