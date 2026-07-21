import { Header } from "@/components/header";
import {
  ScoreboardSection,
  RecentSignalsSection,
  LabTotalsStrip,
} from "@/components/lab/sections";
import {
  getSignalStats,
  getLabTotals,
  getRecentSignals,
  type SignalStatRow,
  type RecentSignalRow,
  type LabTotals,
} from "@/lib/signals/queries";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// Signal Lab — el track record de Catalyst sobre SUS PROPIAS señales.
//
// No predice: mide. Cada señal se registró en el momento en que Catalyst la
// habría enseñado, y el precio posterior decidió. Server component puro:
// cero LLM, cero llamadas externas, solo agregados de BD (Workers-safe).

async function loadData(): Promise<{
  stats: SignalStatRow[];
  totals: LabTotals;
  recent: RecentSignalRow[];
  error?: string;
}> {
  try {
    const [stats, totals, recent] = await Promise.all([
      getSignalStats(),
      getLabTotals(),
      getRecentSignals(16),
    ]);
    return { stats, totals, recent };
  } catch (err) {
    return {
      stats: [],
      totals: {
        events: 0,
        outcomes: 0,
        measured_events: 0,
        pending_events: 0,
        first_detected_at: null,
        last_filled_at: null,
      },
      recent: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export default async function LabPage() {
  const { stats, totals, recent, error } = await loadData();

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <Header />
      {error ? (
        <div className="border-b border-rose-500/40 bg-rose-500/10 px-6 py-3 font-mono text-xs text-rose-700 dark:text-rose-200">
          {error}
        </div>
      ) : null}
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-6xl flex-col gap-8 px-6 py-6">
          <div>
            <h1 className="eyebrow text-[11px] text-foreground">Signal Lab</h1>
            <p className="mt-1 max-w-3xl font-editorial text-[12.5px] leading-relaxed text-muted-foreground">
              What Catalyst&apos;s own signals actually did next. Every signal is
              recorded the moment it fires and never revised; the return is
              measured close-to-close on split- and dividend-adjusted prices,
              from the first session the call was actionable, over 1, 7 and 30{" "}
              <em>trading</em> days, against SPY over the exact same sessions.
              This is calibration, not prediction — it tells you how much weight
              each section of the dashboard has earned.
            </p>
          </div>

          <LabTotalsStrip
            events={totals.events}
            measured={totals.measured_events}
            pending={totals.pending_events}
            since={totals.first_detected_at}
            lastFilled={totals.last_filled_at}
          />

          {!stats.length ? (
            <div className="rounded-sm border border-border/60 bg-card/40 px-4 py-6 text-center">
              <p className="font-mono text-[12px] text-muted-foreground">
                {totals.events > 0
                  ? `${totals.events} signals recorded — outcomes appear as each horizon completes.`
                  : "No signals recorded yet — the cron registers them as they fire."}
              </p>
            </div>
          ) : (
            <>
              <ScoreboardSection stats={stats} />
              <RecentSignalsSection rows={recent} />
            </>
          )}

          <p className="max-w-3xl font-editorial text-[11.5px] leading-relaxed text-muted-foreground/60">
            Past behaviour of a signal type is not a forecast for any individual
            name, and sample sizes here are small by the standards of real
            research. Marked &ldquo;small n&rdquo; below {20} observations.
            Nothing here is investment advice.
          </p>
        </div>
      </main>
    </div>
  );
}
