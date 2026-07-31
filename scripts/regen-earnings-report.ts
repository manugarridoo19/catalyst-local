import { config } from "dotenv";
config({ path: ".env.local" });

// Re-extrae el último comunicado YA LEÍDO de uno o más símbolos con el
// prompt vigente, pisando la fila (`overwrite`). Existe para cuando el
// vocabulario de atribución evoluciona (2026-07-31: señales positivas y
// núcleo = negocio PRINCIPAL) y los filings ya pagados quedaron leídos con
// el vocabulario viejo — un trimestre por empresa, así que el coste es una
// llamada LLM por símbolo, deliberada y a mano.
//
//   pnpm exec tsx scripts/regen-earnings-report.ts MSFT META
async function main() {
  const symbols = process.argv.slice(2).map((s) => s.toUpperCase());
  if (!symbols.length) {
    console.error("uso: pnpm exec tsx scripts/regen-earnings-report.ts SYM [SYM…]");
    process.exit(1);
  }
  const { sql } = await import("drizzle-orm");
  const { db, unwrapRows } = await import("../lib/db");
  const { generateEarningsReport } = await import("../lib/ai/earnings-report");

  for (const symbol of symbols) {
    const rows = unwrapRows<{
      accession: string;
      filing_date: string;
      report_date: string | null;
      exhibit_url: string;
    }>(
      await db.execute(sql`
        SELECT DISTINCT ON (symbol)
               accession, filing_date, report_date, exhibit_url
          FROM earnings_reports
         WHERE symbol = ${symbol}
         ORDER BY symbol, filing_date DESC
      `),
    );
    if (!rows.length) {
      console.log(`[${symbol}] sin comunicado leído — nada que regenerar`);
      continue;
    }
    const r = rows[0];
    const out = await generateEarningsReport(
      {
        symbol,
        cik: "",
        accession: r.accession,
        filingDate: r.filing_date,
        reportDate: r.report_date,
        exhibitUrl: r.exhibit_url,
      },
      { overwrite: true },
    );
    if (!out) {
      console.log(`[${symbol}] el exhibit no dio texto suficiente`);
      continue;
    }
    console.log(
      `[${symbol}] ${out.attribution.length} atribuciones: ` +
        out.attribution
          .map((a) => `${a.signal}/${a.layer}${a.quote ? "" : " (sin cita)"}`)
          .join(" · "),
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
