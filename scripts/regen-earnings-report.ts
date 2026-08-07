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
//
// Con `--find[=DÍAS]` BUSCA el filing en EDGAR en vez de exigir que ya haya
// una fila. Es la vía para el símbolo que nunca ha tenido comunicado leído:
// el barrido sólo mira 14 días atrás a propósito (es un barrido de lo
// FRESCO), así que un emisor cuyo último trimestre salió hace tres meses
// —el caso de NU al arreglarse la lectura de 6-K el 2026-08-07— no se
// recupera solo hasta que vuelve a reportar. Sigue siendo 1 llamada LLM por
// símbolo y sigue siendo a mano.
//
//   pnpm exec tsx scripts/regen-earnings-report.ts --find=120 NU
async function main() {
  const argv = process.argv.slice(2);
  const findArg = argv.find((a) => a.startsWith("--find"));
  const findDays = findArg
    ? Number(findArg.split("=")[1] ?? 30) || 30
    : null;
  const symbols = argv
    .filter((a) => !a.startsWith("--"))
    .map((s) => s.toUpperCase());
  if (!symbols.length) {
    console.error(
      "uso: pnpm exec tsx scripts/regen-earnings-report.ts [--find=DÍAS] SYM [SYM…]",
    );
    process.exit(1);
  }
  const { sql } = await import("drizzle-orm");
  const { db, unwrapRows } = await import("../lib/db");
  const { generateEarningsReport } = await import("../lib/ai/earnings-report");
  const { findLatestEarningsFiling } = await import("../lib/earnings/filings");

  for (const symbol of symbols) {
    if (findDays !== null) {
      const filing = await findLatestEarningsFiling(symbol, findDays);
      if (!filing) {
        console.log(`[${symbol}] EDGAR no devuelve comunicado en ${findDays} días`);
        continue;
      }
      console.log(
        `[${symbol}] ${filing.form} ${filing.filingDate} (periodo ${filing.reportDate}) → ${filing.exhibitUrl}`,
      );
      const out = await generateEarningsReport(filing, { overwrite: true });
      console.log(
        out
          ? `[${symbol}] ${out.summary.length} bullets · ${out.attribution.length} atribuciones`
          : `[${symbol}] el documento no dio texto suficiente`,
      );
      continue;
    }
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
        // `earnings_reports` no guarda el formulario, así que se deduce de la
        // URL. `generateEarningsReport` no lo lee (sólo usa exhibitUrl y
        // accession), pero el tipo lo exige y rellenarlo con "8-K" a ciegas
        // sería mentir sobre un 6-K. Ojo: `scripts/**` está EXCLUIDO del
        // tsconfig, así que aquí el compilador no avisa de nada.
        form: /_?6-?k/i.test(r.exhibit_url) ? "6-K" : "8-K",
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
