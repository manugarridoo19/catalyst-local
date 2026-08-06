import { config } from "dotenv";
config({ path: ".env.local" });

// Backfill ÚNICO de los snapshots de consenso en earnings_reports.
//
// Los comunicados leídos antes del snapshot (migr 0036) perdieron su
// consenso cuando el refresh del calendario borró las fechas pasadas de
// earnings_events. Finnhub sí sirve el calendario histórico con
// estimaciones, así que se recupera de ahí: una llamada por comunicado
// pendiente, solo UPDATE de filas con estimate NULL (nunca pisa un snapshot
// existente). Re-ejecutable: la segunda pasada no encuentra pendientes.
//
//   pnpm exec tsx scripts/backfill-earnings-estimates.ts [--dry-run]

async function main() {
  const dry = process.argv.includes("--dry-run");
  const { db, unwrapRows } = await import("@/lib/db");
  const { sql } = await import("drizzle-orm");
  const { getEarningsCalendarRange } = await import("@/lib/providers/finnhub");

  const pending = unwrapRows<{
    id: number;
    symbol: string;
    ref_date: string;
  }>(
    await db.execute(sql`
      SELECT id, symbol, COALESCE(report_date, filing_date) AS ref_date
      FROM earnings_reports
      WHERE revenue_estimate IS NULL AND eps_estimate IS NULL
      ORDER BY filing_date ASC
    `),
  );
  console.log(`${pending.length} comunicados sin consenso archivado`);

  for (const row of pending) {
    const ref = new Date(`${row.ref_date}T12:00:00Z`).getTime();
    const from = new Date(ref - 7 * 86400_000).toISOString().slice(0, 10);
    const to = new Date(ref + 7 * 86400_000).toISOString().slice(0, 10);
    const cal = await getEarningsCalendarRange(row.symbol, from, to);
    if (cal === null) {
      console.warn(`  ${row.symbol} ${row.ref_date}: fetch falló — se salta`);
      continue;
    }
    // El más cercano a la fecha del comunicado, mismo criterio ±5d que
    // consensusNear.
    const best = cal
      .map((e) => ({
        ...e,
        dist: Math.abs(new Date(`${e.date}T12:00:00Z`).getTime() - ref),
      }))
      .filter((e) => e.dist <= 5 * 86400_000)
      .sort((a, b) => a.dist - b.dist)[0];
    if (!best || (best.epsEstimate == null && best.revenueEstimate == null)) {
      console.warn(
        `  ${row.symbol} ${row.ref_date}: Finnhub no tiene consenso para esa fecha`,
      );
      continue;
    }
    console.log(
      `  ${row.symbol} ${row.ref_date}: rev est ${best.revenueEstimate ?? "—"}, eps est ${best.epsEstimate ?? "—"}${dry ? " (dry-run)" : ""}`,
    );
    if (dry) continue;
    await db.execute(sql`
      UPDATE earnings_reports
      SET revenue_estimate = COALESCE(revenue_estimate, ${best.revenueEstimate}),
          eps_estimate = COALESCE(eps_estimate, ${best.epsEstimate})
      WHERE id = ${row.id}
    `);
  }
  console.log("hecho");
}

main().then(() => process.exit(0));
