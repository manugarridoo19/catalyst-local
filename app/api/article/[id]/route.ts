import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getArticleDetail, isWorkersRuntime } from "@/lib/articles/enrich";
import { SESSION_COOKIE, claimableSessionIds } from "@/lib/session";

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
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function llmAllowed(): Promise<boolean> {
  if (!isWorkersRuntime) return true;
  const jar = await cookies();
  const sid = jar.get(SESSION_COOKIE)?.value?.trim().toLowerCase() ?? "";
  return sid !== "" && claimableSessionIds().has(sid);
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: raw } = await ctx.params;
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
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
