import { NextResponse } from "next/server";
import {
  addToWatchlist,
  getWatchlist,
  removeFromWatchlist,
  setPosition,
} from "@/lib/db/queries";
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

// Topes de cordura, no de negocio: atajan el dedo resbalado (un cero de
// más al teclear) antes de que contamine los pesos de TODA la cartera —
// una posición de 1e12 haría que el resto pesara 0,0% y la revisión
// hablaría de una concentración que no existe.
const MAX_SHARES = 1e9;
const MAX_COST = 1e7;

// `null` = borrar el dato (vuelve a solo seguimiento). `undefined` no se
// acepta: obliga al cliente a ser explícito sobre qué está cambiando.
const positionSchema = symbolSchema.extend({
  shares: z
    .number()
    .finite()
    .min(0)
    .max(MAX_SHARES)
    .nullable(),
  // Coste medio por acción. Se admite posición SIN coste (shares>0,
  // avgCost null): saber cuánto pesa un valor es útil aunque no quieras
  // registrar a cuánto entraste — simplemente esa fila no reporta P&L.
  avgCost: z
    .number()
    .finite()
    .positive()
    .max(MAX_COST)
    .nullable(),
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

// PATCH — fija la posición de un símbolo que YA está en la watchlist.
// 404 si no está: es una señal real (el cliente y el servidor discrepan
// sobre qué hay en la lista), no algo que deba crearse por el camino.
export async function PATCH(req: Request) {
  const session = await ensureSessionCookie();
  const body = await req.json().catch(() => ({}));
  const parsed = positionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_position", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const { symbol, shares, avgCost } = parsed.data;
  const ok = await setPosition(session, symbol, shares, avgCost);
  if (!ok) {
    return NextResponse.json({ error: "not_in_watchlist" }, { status: 404 });
  }
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
