import { NextResponse } from "next/server";
import { runRefreshNewsCron } from "@/lib/cron/refresh-news";
import { runScoreOrphansCron } from "@/lib/cron/score-orphans";

// Cron unificado: ingest + scoring en una sola invocación. Antes había
// dos endpoints (refresh-news, score-orphans) golpeados por dos crons
// distintos (cron-job.org + GitHub Actions). Cada invocación pagaba
// cold-start de Node (~1-2s), así que 4 invocs / 5min × 24h × 30d
// reventaba el cap de Active CPU de Vercel Hobby.
//
// Ahora: un único tick cada 15min. ~6x menos invocs + ingest y scoring
// comparten el mismo runtime warm. Si refresh tarda 30s y score tarda
// 15s, total ~45s — cabe holgado en el maxDuration de 60s.

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

function authorized(req: Request): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return true;
  const got = req.headers.get("authorization");
  return got === `Bearer ${expected}`;
}

async function handle(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const t0 = Date.now();
  try {
    const refresh = await runRefreshNewsCron();
    const score = await runScoreOrphansCron();
    return NextResponse.json({
      ok: true,
      refresh,
      score,
      totalMs: Date.now() - t0,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[cron/tick] failed:", message);
    return NextResponse.json(
      { ok: false, error: message, totalMs: Date.now() - t0 },
      { status: 500 },
    );
  }
}

export const GET = handle;
export const POST = handle;
