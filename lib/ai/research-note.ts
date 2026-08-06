import { sql, desc } from "drizzle-orm";
import { db, unwrapRows } from "@/lib/db";
import { researchNotes } from "@/lib/db/schema";
import { proseCompletion } from "@/lib/ai/prose-chain";
import { cleanModelProse, looksLikeScratchpad } from "@/lib/ai/guards";
import {
  getSignalStats,
  getLabTotals,
  type SignalStatRow,
} from "@/lib/signals/queries";
import { kindLabel, MIN_SAMPLE } from "@/lib/signals/kinds";

// Research note matinal — la Fase 4 del roadmap 2.0, la única que quedaba:
// una nota AUTOCRÍTICA sobre el track record del propio dashboard. No
// resume noticias ni predice nada: lee el scoreboard del Lab y dice qué
// secciones se han ganado peso y cuáles no.
//
// Reglas heredadas del proyecto, no negociables:
// - NINGÚN número sale del modelo: recibe la tabla ya calculada y la cita
//   literal. La nota archiva el snapshot exacto que recibió (procedencia).
// - Prohibido presentarlo como pronóstico — es calibración, igual que los
//   priors que ya se inyectan en picks/digest/review.
// - 1 llamada/día (guard 20h), tag "brief" (instruction-tuned, nunca
//   reasoning models en prosa user-facing).

const NOTE_MAX_AGE_HOURS = 20;
const NOTE_KEEP_LAST = 30;
/** Sin un mínimo de outcomes medidos la nota sería opinión sobre ruido. */
const MIN_MEASURED_EVENTS = 20;

const NOTE_SYSTEM_PROMPT = `You write a short morning research note reviewing the track record of YOUR OWN dashboard's signals — a self-audit, not a market commentary.

You receive a scoreboard: for each signal type and horizon, the number of measured outcomes (n), average return, average excess vs SPY, hit rate, and the recent-window figures. Every number you may use is in that table.

Rules:
- Output ONLY plain markdown bullets ("- " lines). No title, no preamble, no code fences.
- First bullet: "**Bottom line:** ..." — which signal types have EARNED weight so far and which have not, in one honest sentence.
- Then 3-5 bullets. Each must cite the table's numbers VERBATIM (kind, horizon, n, excess vs SPY). Point out: types beating SPY consistently, types underperforming, and any divergence between recent window and all-time.
- Treat n below ${MIN_SAMPLE} as anecdote: say "small n" explicitly and do not praise or condemn those types.
- Excess vs SPY is the figure that matters; raw return alone is beta, not signal.
- NEVER compute, extrapolate or forecast. NEVER recommend buying or selling anything. This is calibration of how much to trust each dashboard section, nothing else.
- Final bullet: "**Honest gaps:** ..." — what the record cannot say yet (immature horizons, thin samples, missing benchmark data), drawn from the table.`;

export type ResearchNoteRow = {
  id: number;
  content: string;
  model: string;
  generatedAt: Date;
};

export async function getLatestResearchNote(): Promise<ResearchNoteRow | null> {
  const rows = await db
    .select()
    .from(researchNotes)
    .orderBy(desc(researchNotes.generatedAt))
    .limit(1);
  const r = rows[0];
  return r
    ? { id: r.id, content: r.content, model: r.model, generatedAt: r.generatedAt }
    : null;
}

type RecentKindRow = {
  kind: string;
  n_recent: number;
  excess_recent: number | null;
};

function fmt(n: number | null | undefined): string {
  if (n == null) return "—";
  return `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
}

function statLine(s: SignalStatRow, recent: RecentKindRow | undefined): string {
  const base =
    `- ${kindLabel(s.kind)} @${s.horizon}d: n=${s.n}, avg ${fmt(s.avg_return)}, ` +
    `excess vs SPY ${fmt(s.avg_excess)}, hit ${s.hit_rate.toFixed(0)}%` +
    (s.n < MIN_SAMPLE ? " [small n]" : "");
  return recent && recent.n_recent > 0
    ? `${base} · last 7d: n=${recent.n_recent}, excess ${fmt(recent.excess_recent)}`
    : base;
}

/** Genera y persiste una nota nueva. Lanza si el Lab aún no da para una
 *  autocrítica con sustancia o si todos los modelos fallan. */
export async function generateResearchNote(): Promise<ResearchNoteRow> {
  const [stats, totals, recentRows] = await Promise.all([
    getSignalStats(),
    getLabTotals(),
    db
      .execute(
        sql`
        SELECT e.kind, COUNT(*)::int AS n_recent,
               ROUND(AVG(o.return_pct - o.benchmark_return_pct)::numeric, 2)::float
                 AS excess_recent
        FROM signal_events e
        JOIN signal_outcomes o ON o.event_id = e.id
        WHERE o.benchmark_return_pct IS NOT NULL
          AND o.filled_at >= now() - interval '7 days'
        GROUP BY e.kind
      `,
      )
      .then(unwrapRows<RecentKindRow>)
      .catch(() => [] as RecentKindRow[]),
  ]);

  if (totals.measured_events < MIN_MEASURED_EVENTS) {
    throw new Error(
      `lab too thin for a research note (${totals.measured_events} measured events)`,
    );
  }

  const recentByKind = new Map(recentRows.map((r) => [r.kind, r]));
  const lines = stats.map((s) => statLine(s, recentByKind.get(s.kind)));
  const userPrompt = [
    `Lab totals: ${totals.events} signals recorded since ${
      totals.first_detected_at
        ? new Date(totals.first_detected_at).toISOString().slice(0, 10)
        : "—"
    }, ${totals.measured_events} measured, ${totals.pending_events} awaiting price.`,
    ``,
    `Scoreboard (all-time per kind × horizon, with last-7d window where it exists):`,
    ...lines,
  ].join("\n");

  const result = await proseCompletion({
    messages: [
      { role: "system", content: NOTE_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.4,
    maxTokens: 700,
    tag: "brief",
  });

  const content = cleanModelProse(result.content);
  if (!content || content.length < 40) {
    throw new Error(`research note too short: "${content.slice(0, 80)}"`);
  }
  if (looksLikeScratchpad(content)) {
    throw new Error("research note looks like model scratchpad — discarded");
  }

  const inserted = await db
    .insert(researchNotes)
    .values({ content, statsSnapshot: userPrompt, model: result.model })
    .returning();

  await db.execute(sql`
    DELETE FROM research_notes WHERE id NOT IN (
      SELECT id FROM research_notes ORDER BY generated_at DESC LIMIT ${NOTE_KEEP_LAST}
    )
  `);

  const r = inserted[0];
  return { id: r.id, content: r.content, model: r.model, generatedAt: r.generatedAt };
}

/** Age check 20h → cadencia real 1/día por muchos ticks que lo intenten. */
export async function maybeGenerateResearchNote(
  maxAgeHours = NOTE_MAX_AGE_HOURS,
): Promise<{ generated: boolean; note: ResearchNoteRow | null }> {
  const latest = await getLatestResearchNote();
  if (
    latest &&
    Date.now() - latest.generatedAt.getTime() < maxAgeHours * 3600_000
  ) {
    return { generated: false, note: latest };
  }
  const note = await generateResearchNote();
  return { generated: true, note };
}
