// Backfill one-shot de `insider_trades.planned_sale` (<aff10b5One> del Form 4).
//
//   pnpm exec tsx scripts/backfill-planned-sale.ts [--limit N] [--dry-run]
//
// POR QUÉ NO SIRVE `backfill-insider.ts`: aquél sólo mira filings con
// `news.insider_parsed_at IS NULL` y escribe con `onConflictDoNothing`, así
// que un filing YA parseado no se vuelve a tocar y sus filas se quedarían sin
// el campo para siempre. Esto va por el otro lado: filas existentes sin dato.
//
// POR QUÉ MERECE LA PENA: la retención de `insider_trades` es de 90 días, así
// que TODO lo vivo es posterior a abril de 2023 — la fecha en que la casilla
// pasó a ser obligatoria. No es un backfill parcial: debería llenarlos todos.
// Medido al escribirlo: 3.324 filings distintos, 6.594 filas.
//
// FRENO: el cron usa 150 ms entre filings, pero cada filing son DOS peticiones
// a SEC (index + xml) → ~13 req/s, por encima de la guía de 10/s de la SEC.
// Para 25 filings en un tick da igual; para un barrido continuo de 3.300 no.
// Aquí el hueco es de 250 ms → ~8 req/s.
//
// RESIDUO: `planned_sale` sigue siendo NULL tanto si el filing no trae el
// elemento como si aún no se ha intentado, así que un filing sin casilla se
// re-consultaría en la siguiente ejecución. Se acepta a propósito en vez de
// montar tombstones en `job_state` para 3.300 filings: siendo todos
// posteriores a 2023 el residuo tiene que ser mínimo, y el script lo IMPRIME
// — si sale grande, la hipótesis de arriba era falsa y hay que mirarla.

import { config } from "dotenv";
config({ path: ".env.local" });

const GAP_MS = 250;

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const limit = Number(arg("--limit") ?? 100_000);

  const { sql } = await import("drizzle-orm");
  const { db, unwrapRows } = await import("../lib/db");
  const { fetchForm4Structured } = await import("../lib/articles/extract");

  const pendientes = unwrapRows<{ filing_url: string; filas: number }>(
    await db.execute(sql`
      SELECT filing_url, COUNT(*)::int AS filas
      FROM insider_trades
      WHERE planned_sale IS NULL
      GROUP BY filing_url
      ORDER BY MAX(filed_at) DESC
      LIMIT ${limit}
    `),
  );

  console.log(
    `[planned-sale] ${pendientes.length} filings sin dato ` +
      `(${pendientes.reduce((a, p) => a + p.filas, 0)} filas)` +
      (dryRun ? " — DRY RUN" : ""),
  );
  if (dryRun || pendientes.length === 0) return;

  let programadas = 0;
  let discrecionales = 0;
  let sinCasilla = 0;
  let ilegibles = 0;
  let filasTocadas = 0;

  for (const [i, p] of pendientes.entries()) {
    const parsed = await fetchForm4Structured(p.filing_url);
    if (!parsed) {
      // El filing no se pudo bajar o parsear. No se escribe nada: dejarlo en
      // NULL es correcto, y marcarlo como "sin plan" sería inventárselo.
      ilegibles++;
    } else if (parsed.plannedSale === null) {
      sinCasilla++;
    } else {
      const v = parsed.plannedSale ? 1 : 0;
      const r = await db.execute(sql`
        UPDATE insider_trades SET planned_sale = ${v}
        WHERE filing_url = ${p.filing_url} AND planned_sale IS NULL
      `);
      filasTocadas += r.rowCount ?? 0;
      if (v === 1) programadas++;
      else discrecionales++;
    }

    if ((i + 1) % 100 === 0) {
      console.log(
        `[planned-sale] ${i + 1}/${pendientes.length} · ` +
          `${programadas} en plan · ${discrecionales} discrecionales · ` +
          `${sinCasilla} sin casilla · ${ilegibles} ilegibles`,
      );
    }
    await new Promise((r) => setTimeout(r, GAP_MS));
  }

  console.log(
    `[planned-sale] DONE: ${filasTocadas} filas actualizadas · ` +
      `${programadas} filings en plan 10b5-1 · ${discrecionales} discrecionales · ` +
      `${sinCasilla} sin la casilla · ${ilegibles} ilegibles`,
  );
  if (sinCasilla > pendientes.length * 0.1) {
    console.warn(
      `[planned-sale] ⚠️ ${sinCasilla} filings sin casilla es MUCHO para datos ` +
        `posteriores a abr-2023: revisar si el parser la está encontrando.`,
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("[planned-sale] FATAL:", e);
    process.exit(1);
  });
