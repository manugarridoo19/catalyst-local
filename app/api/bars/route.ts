import { NextResponse } from "next/server";
import { getBars, type Period } from "@/lib/providers/yahoo";

// Edge runtime: solo fetch a Yahoo + parse JSON. Sin DB.
export const runtime = "edge";
export const dynamic = "force-dynamic";

const VALID: Period[] = ["1d", "1w", "1m", "3m", "1y"];

export async function GET(req: Request) {
  const url = new URL(req.url);
  const symbol = (url.searchParams.get("symbol") ?? "").toUpperCase().trim();
  const period = (url.searchParams.get("period") ?? "1d") as Period;
  if (!/^[A-Z0-9.\-]{1,10}$/.test(symbol)) {
    return NextResponse.json({ error: "invalid_symbol" }, { status: 400 });
  }
  if (!VALID.includes(period)) {
    return NextResponse.json({ error: "invalid_period" }, { status: 400 });
  }
  try {
    const bars = await getBars(symbol, period);
    return NextResponse.json({ bars });
  } catch (err) {
    return NextResponse.json(
      { bars: [], error: err instanceof Error ? err.message : String(err) },
      { status: 200 }, // devolvemos 200 con array vacío para no romper la UI
    );
  }
}
