import { NextResponse } from "next/server";
import { getArticleDetail } from "@/lib/articles/enrich";

// GET /api/article/123 → ArticleDetail (texto extraído + resumen IA),
// cacheado en article_extracts. Primera llamada de una noticia: extrae la
// fuente + 1 call LLM (~2-8s); siguientes: lectura de BD. no-store: el
// caché real vive en la tabla (los fallos cachean su propio cooldown).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
    const detail = await getArticleDetail(id);
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
