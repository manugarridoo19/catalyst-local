import { NextResponse } from "next/server";
import { addToWatchlist, getWatchlist, removeFromWatchlist } from "@/lib/db/queries";
import { ensureSessionCookie } from "@/lib/session";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const symbolSchema = z.object({
  symbol: z
    .string()
    .min(1)
    .max(10)
    .regex(/^[A-Z0-9.\-]+$/i, "invalid symbol")
    .transform((s) => s.toUpperCase()),
});

export async function GET() {
  const session = await ensureSessionCookie();
  const items = await getWatchlist(session);
  return NextResponse.json({ items });
}

export async function POST(req: Request) {
  const session = await ensureSessionCookie();
  const body = await req.json().catch(() => ({}));
  const parsed = symbolSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_symbol", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  await addToWatchlist(session, parsed.data.symbol);
  const items = await getWatchlist(session);
  return NextResponse.json({ items });
}

export async function DELETE(req: Request) {
  const session = await ensureSessionCookie();
  const url = new URL(req.url);
  const symbol = url.searchParams.get("symbol");
  const parsed = symbolSchema.safeParse({ symbol });
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_symbol" }, { status: 400 });
  }
  await removeFromWatchlist(session, parsed.data.symbol);
  const items = await getWatchlist(session);
  return NextResponse.json({ items });
}
