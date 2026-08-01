import { NextResponse } from "next/server";
import { getArticleDetail } from "@/lib/articles/enrich";
import { guardSpend, llmAllowed } from "@/lib/ask/gate";

// GET /api/article/123 → ArticleDetail (texto extraído + resumen IA),
// cacheado en article_extracts. Primera llamada de una noticia: extrae la
// fuente + 1 call LLM (~2-8s); siguientes: lectura de BD. no-store: el
// caché real vive en la tabla (los fallos cachean su propio cooldown).
//
// Gate del LLM en el Worker público: los ids son enumerables y sin gate un
// bot podría drenar la cuota LLM a base de cache-misses. Solo la sesión
// del dueño (allowlist de claim) genera resúmenes IA on-click en el
// Worker; los anónimos reciben el texto extraído (y los impact>=4 ya
// vienen pre-enriquecidos por el cron). En el daemon/Node no cambia nada.
// El gate era una copia local de `llmAllowed`; ahora se comparte con el
// resto de rutas que gastan (lib/ask/gate.ts). Además pasa por el cubo de
// rate limit: extraer un artículo es un fetch saliente aunque no gaste LLM,
// y los ids son enumerables.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: raw } = await ctx.params;
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  // `degrade`: el anónimo sigue recibiendo el texto extraído, que es el
  // comportamiento documentado — lo que no obtiene es el resumen IA.
  const denied = await guardSpend(req, { mode: "degrade" });
  if (denied) return denied;
  try {
    const detail = await getArticleDetail(id, { allowLlm: await llmAllowed() });
    if (!detail) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json(detail, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    console.warn(
      `[api/article] ${id} failed:`,
      err instanceof Error ? err.message.slice(0, 160) : err,
    );
    // 200 con estado explícito — el cliente pinta el fallo, no un error de
    // red genérico.
    return NextResponse.json(
      { status: "failed", text: null, aiSummary: null, aiTake: null, aiModel: null },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
}
