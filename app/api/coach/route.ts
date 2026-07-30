import { NextResponse } from "next/server";
import { ensureSessionCookie } from "@/lib/session";
import {
  loadContrasts,
  sortContrasts,
  type PositionContrast,
} from "@/lib/coach/build";

// GET /api/coach → el contraste de cada posición: lo que escribiste frente
// a lo que se ha movido, leído contra el marco que declaraste.
//
// SIN GATE DE LLM y sin rate limit, a diferencia de /api/ask y
// /api/portfolio-review: esta ruta no llama a ningún proveedor. Todo lo que
// devuelve ya está en la base de datos y la única transformación es una
// tabla de consulta en código. No hay cuota que proteger.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type CoachResponse = {
  positions: PositionContrast[];
  /** Cuántas posiciones no se pueden leer todavía y por qué falta. Va
   *  agregado para que la UI pueda pedir lo que falta UNA vez en vez de
   *  repetir el mismo aviso en cada fila. */
  gaps: { marco: number; tesis: number; comunicado: number };
};

export async function GET() {
  const session = await ensureSessionCookie();
  try {
    const positions = sortContrasts(await loadContrasts(session));
    const gaps = { marco: 0, tesis: 0, comunicado: 0 };
    for (const p of positions) for (const m of p.missing) gaps[m]++;
    return NextResponse.json(
      { positions, gaps } satisfies CoachResponse,
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    console.warn(
      "[api/coach] failed:",
      err instanceof Error ? err.message.slice(0, 160) : err,
    );
    return NextResponse.json(
      { error: "coach_failed" },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
