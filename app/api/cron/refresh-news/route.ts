import { NextResponse } from "next/server";
import { runRefreshNewsCron } from "@/lib/cron/refresh-news";

// Vercel Cron envía `Authorization: Bearer ${CRON_SECRET}` automáticamente
// si configuras CRON_SECRET. En local invocamos con el mismo header.
export const runtime = "nodejs";
export const maxDuration = 60; // segundos (Hobby cap)
export const dynamic = "force-dynamic";

function authorized(req: Request): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return true; // dev mode sin secret
  const got = req.headers.get("authorization");
  return got === `Bearer ${expected}`;
}

async function handle(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const result = await runRefreshNewsCron();
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[cron/refresh-news] failed:", message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
