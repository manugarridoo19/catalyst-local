// Orquestador del detalle de artículo: extracción (lib/articles/extract) +
// resumen IA on-demand, cacheado en article_extracts. Una fila por noticia.
//
// Flujo (getArticleDetail):
//   1. Cache hit completo (status ok + aiSummary) → se sirve tal cual.
//   2. Fallo cacheado con <6h → se sirve el fallo (no re-golpeamos la
//      fuente en cada click sobre un paywall).
//   3. Miss/stale → extraer; si la fuente no da texto pero el body del
//      provider tiene sustancia (≥250 chars), se resume ese body.
//   4. LLM (prose-chain jsonMode) → {summary, take}; guards de longitud y
//      anti-scratchpad. Si el LLM falla, guardamos el texto igualmente —
//      el próximo click reintenta solo la parte IA.
//
// Workers-safe: el dedupe in-flight por newsId SOLO se activa en Node
// (cron/daemon) — compartir una Promise con I/O entre requests del mismo
// isolate está prohibido en Workers (bug class conocida del Pool).

import { db } from "@/lib/db";
import { articleExtracts, news, newsScores, newsTickers } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { proseCompletion } from "@/lib/ai/prose-chain";
import { looksLikeScratchpad } from "@/lib/ai/guards";
import { extractArticle } from "./extract";

export type ArticleDetail = {
  status: "ok" | "failed";
  text: string | null;
  aiSummary: string | null;
  aiTake: string | null;
  aiModel: string | null;
};

const FAILED_RETRY_MS = 6 * 3600 * 1000;
// 180: los snippets de finnhub rondan ~190 chars y son la única vía para
// sus artículos (finnhub.io/api/news?id= devuelve 404 — redirector roto).
const MIN_BODY_FALLBACK_CHARS = 180;
const LLM_TEXT_CAP = 6_000;

const SUMMARY_SYSTEM_PROMPT = `You are a buy-side equity analyst writing for a realtime trading dashboard. You receive the text of a news article (or SEC filing) plus the tickers it concerns and, when available, machine scores.

Output STRICT JSON only (no fences, no prose): {"summary":"...","take":"..."}

"summary" — 2 to 4 sentences. What actually happened, in plain English, with the CONCRETE numbers from the article (figures, percentages, price targets, dates, guidance). Decode jargon. No filler like "the article discusses". Do not speculate beyond the text.

"take" — 1 to 2 sentences. Why this matters for the listed tickers specifically: the mechanism, the expectation gap, or what to watch next. Grounded in the article; not investment advice; never say "investors should".

If the text is too thin to add anything beyond the headline, still summarize what is there — never return empty strings.`;

function buildSummaryUserPrompt(input: {
  headline: string;
  source: string;
  tickers: string[];
  impact: number | null;
  sentiment: number | null;
  text: string;
}): string {
  const scores =
    input.impact != null
      ? `Machine scores: impact ${input.impact}/5, sentiment ${input.sentiment ?? 0} (-5..+5)`
      : "Machine scores: (not yet scored)";
  return [
    `Tickers: ${input.tickers.join(", ") || "(none)"}`,
    `Source: ${input.source}`,
    scores,
    `Headline: ${input.headline}`,
    `Article text:\n${input.text.slice(0, LLM_TEXT_CAP)}`,
  ].join("\n");
}

async function generateSummary(input: {
  headline: string;
  source: string;
  tickers: string[];
  impact: number | null;
  sentiment: number | null;
  text: string;
}): Promise<{ summary: string; take: string; model: string } | null> {
  try {
    const result = await proseCompletion({
      messages: [
        { role: "system", content: SUMMARY_SYSTEM_PROMPT },
        { role: "user", content: buildSummaryUserPrompt(input) },
      ],
      temperature: 0.3,
      maxTokens: 450,
      jsonMode: true,
      tag: "article",
    });
    const parsed = JSON.parse(
      result.content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, ""),
    ) as { summary?: unknown; take?: unknown };
    const summary =
      typeof parsed.summary === "string" ? parsed.summary.trim() : "";
    const take = typeof parsed.take === "string" ? parsed.take.trim() : "";
    if (summary.length < 40 || looksLikeScratchpad(summary)) return null;
    return {
      summary: summary.slice(0, 900),
      take: take.length >= 20 && !looksLikeScratchpad(take) ? take.slice(0, 500) : "",
      model: result.model,
    };
  } catch (err) {
    console.warn(
      "[article] summary generation failed:",
      err instanceof Error ? err.message.slice(0, 140) : err,
    );
    return null;
  }
}

async function loadNewsContext(newsId: number) {
  const rows = await db
    .select({
      id: news.id,
      url: news.url,
      headline: news.headline,
      body: news.body,
      source: news.source,
    })
    .from(news)
    .where(eq(news.id, newsId))
    .limit(1);
  if (!rows.length) return null;
  const [tickerRows, scoreRows] = await Promise.all([
    db
      .select({ ticker: newsTickers.ticker })
      .from(newsTickers)
      .where(eq(newsTickers.newsId, newsId)),
    db
      .select({ impact: newsScores.impact, sentiment: newsScores.sentiment })
      .from(newsScores)
      .where(eq(newsScores.newsId, newsId))
      .limit(1),
  ]);
  return {
    ...rows[0],
    tickers: tickerRows.map((t) => t.ticker),
    impact: scoreRows[0]?.impact ?? null,
    sentiment: scoreRows[0]?.sentiment ?? null,
  };
}

async function upsertExtract(row: {
  newsId: number;
  status: "ok" | "failed";
  text: string | null;
  aiSummary?: string | null;
  aiTake?: string | null;
  aiModel?: string | null;
}): Promise<void> {
  const values = {
    newsId: row.newsId,
    status: row.status,
    text: row.text,
    fetchedAt: new Date(),
    aiSummary: row.aiSummary ?? null,
    aiTake: row.aiTake ?? null,
    aiModel: row.aiModel ?? null,
    aiGeneratedAt: row.aiSummary ? new Date() : null,
  };
  await db
    .insert(articleExtracts)
    .values(values)
    .onConflictDoUpdate({ target: articleExtracts.newsId, set: values });
}

async function computeDetail(newsId: number): Promise<ArticleDetail | null> {
  const ctx = await loadNewsContext(newsId);
  if (!ctx) return null;

  const cached = await db
    .select()
    .from(articleExtracts)
    .where(eq(articleExtracts.newsId, newsId))
    .limit(1)
    .then((r) => r[0] ?? null);

  if (cached) {
    if (cached.status === "ok" && cached.aiSummary) {
      return {
        status: "ok",
        text: cached.text,
        aiSummary: cached.aiSummary,
        aiTake: cached.aiTake,
        aiModel: cached.aiModel,
      };
    }
    if (
      cached.status === "failed" &&
      Date.now() - cached.fetchedAt.getTime() < FAILED_RETRY_MS
    ) {
      return { status: "failed", text: null, aiSummary: null, aiTake: null, aiModel: null };
    }
  }

  // Texto: cache previo sin IA > extracción fresca > body con sustancia.
  let text = cached?.status === "ok" ? cached.text : null;
  if (!text) {
    const extracted = await extractArticle({
      url: ctx.url,
      source: ctx.source,
      headline: ctx.headline,
    });
    text = extracted?.text ?? null;
  }
  if (!text && ctx.body && ctx.body.trim().length >= MIN_BODY_FALLBACK_CHARS) {
    text = ctx.body.trim();
  }
  if (!text) {
    await upsertExtract({ newsId, status: "failed", text: null });
    return { status: "failed", text: null, aiSummary: null, aiTake: null, aiModel: null };
  }

  const ai = await generateSummary({
    headline: ctx.headline,
    source: ctx.source,
    tickers: ctx.tickers,
    impact: ctx.impact,
    sentiment: ctx.sentiment,
    text,
  });

  await upsertExtract({
    newsId,
    status: "ok",
    text,
    aiSummary: ai?.summary ?? null,
    aiTake: ai?.take || null,
    aiModel: ai?.model ?? null,
  });

  return {
    status: "ok",
    text,
    aiSummary: ai?.summary ?? null,
    aiTake: ai?.take || null,
    aiModel: ai?.model ?? null,
  };
}

// Dedupe in-flight por newsId — SOLO Node. En Workers cada request computa
// por su cuenta (el upsert es idempotente; el caso de dos clicks
// simultáneos sobre la misma card es raro y barato).
const inflight = new Map<number, Promise<ArticleDetail | null>>();
const isWorkers =
  typeof (globalThis as { WebSocketPair?: unknown }).WebSocketPair !==
  "undefined";

export async function getArticleDetail(
  newsId: number,
): Promise<ArticleDetail | null> {
  if (isWorkers) return computeDetail(newsId);
  const existing = inflight.get(newsId);
  if (existing) return existing;
  const p = computeDetail(newsId).finally(() => inflight.delete(newsId));
  inflight.set(newsId, p);
  return p;
}

// Pre-enrich para el cron (Node): tras el scoring, deja listos los
// impact>=4 más recientes para que el click del usuario sea instantáneo.
// Cap corto — es nice-to-have, el on-demand cubre el resto.
export async function enrichTopStories(newsIds: number[], cap = 4): Promise<number> {
  const targets = newsIds.slice(0, cap);
  if (!targets.length) return 0;
  const results = await Promise.allSettled(
    targets.map((id) => getArticleDetail(id)),
  );
  return results.filter(
    (r) => r.status === "fulfilled" && r.value?.status === "ok",
  ).length;
}
