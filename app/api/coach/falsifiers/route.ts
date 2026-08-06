import { NextResponse } from "next/server";
import { z } from "zod";
import { ensureSessionCookie } from "@/lib/session";
import {
  addWrittenFalsifier,
  decideFalsifier,
  getFalsifiers,
  saveProposals,
} from "@/lib/coach/falsifiers";
import { proposeFalsifiers } from "@/lib/ai/falsifiers";
import { loadContrasts } from "@/lib/coach/build";
import { isWorkersRuntime, llmAllowed, rateLimited } from "@/lib/ask/gate";

// Falsadores: proponer (LLM), decidir y escribir a mano.
//
// A diferencia de `/api/coach`, esta ruta SÍ gasta cuota en la rama de
// propuesta, así que reutiliza el gate y el cubo de rate limit de /ask —
// mismo patrón que `/api/portfolio-review`. Decidir y escribir a mano no
// llaman a nadie y no pasan por el gate.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const proposeSchema = z.object({
  propose: z.object({
    symbol: z.string().min(1).max(10).regex(/^[A-Z0-9.\-]+$/i),
  }),
});

const decideSchema = z.object({
  decide: z.object({
    id: z.number().int().positive(),
    status: z.enum(["aprobado", "rechazado"]),
  }),
});

const writeSchema = z.object({
  write: z.object({
    symbol: z.string().min(1).max(10).regex(/^[A-Z0-9.\-]+$/i),
    text: z.string().trim().min(10).max(180),
  }),
});

export async function GET() {
  const session = await ensureSessionCookie();
  return NextResponse.json(
    { falsifiers: await getFalsifiers(session) },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(req: Request) {
  // Las ramas de decidir y escribir a mano no gastan proveedor, pero SÍ
  // escriben filas sin techo desde un endpoint anónimo — el mismo depósito
  // de 512 MB de Neon que pausa la ingesta de embeddings a 380. El freno va
  // antes de ramificar; la de proponer añade además el gate de cuota.
  if (isWorkersRuntime && rateLimited(req)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const session = await ensureSessionCookie();
  const body = await req.json().catch(() => ({}));

  const decide = decideSchema.safeParse(body);
  if (decide.success) {
    const ok = await decideFalsifier(
      session,
      decide.data.decide.id,
      decide.data.decide.status,
    );
    if (!ok) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json({ falsifiers: await getFalsifiers(session) });
  }

  const write = writeSchema.safeParse(body);
  if (write.success) {
    await addWrittenFalsifier(
      session,
      write.data.write.symbol.toUpperCase(),
      write.data.write.text,
    );
    return NextResponse.json({ falsifiers: await getFalsifiers(session) });
  }

  const prop = proposeSchema.safeParse(body);
  if (prop.success) {
    if (isWorkersRuntime && rateLimited(req)) {
      return NextResponse.json({ error: "rate_limited" }, { status: 429 });
    }
    if (!(await llmAllowed())) {
      return NextResponse.json({ error: "llm_not_allowed" }, { status: 403 });
    }
    const symbol = prop.data.propose.symbol.toUpperCase();
    const target = (await loadContrasts(session)).find(
      (c) => c.symbol === symbol,
    );
    // Sin marco o sin tesis no se puede proponer nada útil: los falsadores
    // salen DE la tesis y su severidad depende del marco. Es un 422 y no un
    // 400 — la petición está bien formada, lo que falta es el material.
    // La del diario manda sobre la creencia declarada cuando existen las
    // dos: los falsadores se comprueban contra el futuro, y lo que dijiste
    // ANTES de saber el resultado es la afirmación más exigente que hay
    // sobre la mesa. La creencia de hoy es el respaldo de las posiciones
    // anteriores al diario, que nunca tendrán la otra.
    const claim = target?.thesis ?? target?.belief ?? null;
    if (!target || !target.axes || !claim) {
      return NextResponse.json(
        {
          error: "sin_material",
          missing: target?.missing ?? ["marco", "tesis"],
        },
        { status: 422 },
      );
    }
    const texts = await proposeFalsifiers({
      symbol,
      axes: target.axes,
      thesis: claim,
      attributions: target.readings.map((r) => r.attribution),
    });
    if (!texts.length) {
      return NextResponse.json({ error: "sin_propuestas" }, { status: 502 });
    }
    await saveProposals(session, symbol, texts);
    return NextResponse.json({ falsifiers: await getFalsifiers(session) });
  }

  return NextResponse.json({ error: "bad_request" }, { status: 400 });
}
