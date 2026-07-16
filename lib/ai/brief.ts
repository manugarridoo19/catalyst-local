import { sql, desc } from "drizzle-orm";
import { db, unwrapRows } from "@/lib/db";
import { aiBriefs } from "@/lib/db/schema";
import { chatCompletion } from "@/lib/providers/openrouter";
import { groqChatCompletion } from "@/lib/providers/groq";

// AI Brief — resumen accionable del día para el dashboard. Junta las
// noticias mejor puntuadas de las últimas 24h + la watchlist y pide a un
// modelo instruction-tuned (task="brief", NUNCA reasoning models — sueltan
// scratchpad en prosa user-facing) un briefing de 5-8 bullets estilo
// trading desk. Coste: 1 llamada cada ≥4h → ~4-6 calls/día del pool.

const BRIEF_MAX_AGE_HOURS = 4;
const BRIEF_NEWS_LIMIT = 30;
const BRIEF_KEEP_LAST = 20;

const BRIEF_SYSTEM_PROMPT = `You write a concise trading-desk brief for an equities investor. Rules:
- Output ONLY plain markdown bullets ("- " lines). No title, no preamble, no code fences, no closing remarks.
- 5-8 bullets, each at most 2 lines. Most market-moving stories first.
- Bold ticker symbols like **NVDA**. Mention impact direction plainly (beat/miss/upgrade/M&A/etc.).
- If a bullet involves a WATCHLIST ticker, start it with "⭐ ".
- Group related items (e.g. several bank earnings) into one bullet when sensible.
- Be strictly factual: only use the provided items. Never invent numbers, prices or events.
- Final bullet: "Watch: ..." with 2-4 things to monitor next (from the items themselves — pending earnings, regulatory decisions, follow-ups).`;

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

// Filtro defensivo anti-scratchpad (lección sueño-de-elvira): si el modelo
// coló razonamiento interno en la respuesta, mejor NO publicar y conservar
// el brief anterior.
function looksLikeScratchpad(content: string): boolean {
  return /\b(the user|I need to|I should|As an AI|let me|make sure to)\b/i.test(
    content.slice(0, 300),
  );
}

function cleanBrief(raw: string): string {
  return raw
    .replace(/^```(?:markdown|md)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
}

// Genera y persiste un brief nuevo. Lanza si no hay señal suficiente (<5
// noticias puntuadas en 24h) o si todos los modelos fallan.
export async function generateBrief(): Promise<BriefRow> {
  const newsRows = unwrapRows<BriefNewsRow>(
    await db.execute(sql`
      SELECT n.headline, s.impact, s.sentiment, n.category, n.published_at,
        ARRAY(SELECT ticker FROM news_tickers WHERE news_id = n.id) AS tickers
      FROM news n
      JOIN news_scores s ON s.news_id = n.id
      WHERE n.published_at >= now() - interval '24 hours' AND s.impact >= 3
      ORDER BY s.impact DESC, n.published_at DESC
      LIMIT ${BRIEF_NEWS_LIMIT}
    `),
  );
  if (newsRows.length < 5) {
    throw new Error(`not enough scored signal for a brief (${newsRows.length} items)`);
  }

  const watchRows = unwrapRows<{ symbol: string }>(
    await db.execute(sql`SELECT DISTINCT symbol FROM watchlist ORDER BY symbol`),
  );
  const watchlist = watchRows.map((w) => w.symbol);

  const lines = newsRows.map((r) => {
    const t = new Date(r.published_at).toISOString().slice(11, 16);
    const sent = r.sentiment > 0 ? `+${r.sentiment}` : `${r.sentiment}`;
    return `- [imp=${r.impact} sent=${sent} ${r.category ?? "?"}] (${(r.tickers ?? []).join(",") || "—"}) ${r.headline} (${t}Z)`;
  });
  const userPrompt = [
    `Watchlist: ${watchlist.length ? watchlist.join(", ") : "(empty)"}`,
    ``,
    `Top scored news, last 24h (impact 1-5, sentiment -5..+5, times UTC):`,
    ...lines,
  ].join("\n");

  const messages = [
    { role: "system" as const, content: BRIEF_SYSTEM_PROMPT },
    { role: "user" as const, content: userPrompt },
  ];
  let result: { content: string; model: string };
  try {
    result = await chatCompletion({
      messages,
      task: "brief",
      temperature: 0.4,
      maxTokens: 700,
      timeoutMs: 30_000,
    });
  } catch (err) {
    // Pool OpenRouter agotado o proveedores free saturados (pico horario).
    // Groq llama-3.3-70b es instruction-tuned y sirve prosa digna — mejor
    // un brief de Groq que ninguno.
    console.warn(
      "[brief] openrouter chain failed, falling back to groq:",
      err instanceof Error ? err.message.slice(0, 120) : err,
    );
    result = await groqChatCompletion({
      messages,
      model: "llama-3.3-70b-versatile",
      temperature: 0.4,
      maxTokens: 700,
      timeoutMs: 25_000,
      retries: 1,
    });
  }

  const content = cleanBrief(result.content);
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
