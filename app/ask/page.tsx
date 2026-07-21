import { Header } from "@/components/header";
import { AskPanel } from "@/components/ask/ask-panel";
import { sql } from "drizzle-orm";
import { db, unwrapRows } from "@/lib/db";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// Ask Catalyst — preguntarle al archivo, con citas verificables.
//
// El shell es server component y sólo lee dos contadores (cuánto archivo
// hay indexado y desde cuándo): sin eso, una respuesta pobre parece un
// fallo del modelo cuando en realidad es falta de cobertura, y el usuario
// no tiene forma de distinguirlo.

async function loadCoverage(): Promise<{ n: number; since: string | null }> {
  try {
    const [row] = unwrapRows<{ n: number; since: string | null }>(
      await db.execute(sql`
        SELECT count(*)::int AS n,
               to_char(min(published_at) at time zone 'UTC','YYYY-MM-DD') AS since
        FROM news_embeddings
      `),
    );
    return { n: row?.n ?? 0, since: row?.since ?? null };
  } catch {
    return { n: 0, since: null };
  }
}

export default async function AskPage() {
  const { n, since } = await loadCoverage();

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <Header />
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-4xl flex-col gap-6 px-6 py-6">
          <div>
            <h1 className="eyebrow text-[11px] text-foreground">Ask Catalyst</h1>
            <p className="mt-1 font-editorial text-[12.5px] leading-relaxed text-muted-foreground">
              Pregunta a tu propio archivo. Las respuestas se construyen sólo
              con lo que Catalyst ha ingerido y puntuado — noticias de impacto
              ≥3, más los agregados exactos de los filings (insider, 13D/G,
              earnings). Cada afirmación lleva su cita; si el archivo no lo
              cubre, lo dice en vez de rellenar con conocimiento del modelo.
            </p>
            <p className="mt-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground/50">
              {n.toLocaleString("en-US")} items indexados
              {since ? ` · desde ${since}` : ""}
            </p>
          </div>

          <AskPanel />
        </div>
      </main>
    </div>
  );
}
