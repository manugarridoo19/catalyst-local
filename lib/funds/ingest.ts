// Ingesta de 13F de los fondos curados. Node-only (cron); el Worker sólo lee.
//
// Ritmo: el dato es TRIMESTRAL, así que casi todas las pasadas terminan sin
// tocar nada. Barrido cada 12h; dentro del barrido cada fondo cuesta 1
// petición (su lista de filings) y sólo los que traen un 13F NUEVO pagan el
// índice + el XML del information table.
//
// Se guardan DOS trimestres por fondo la primera vez. Sin el trimestre
// anterior, "posición nueva" no significa nada: la primera ingesta declararía
// nuevas las ~100 posiciones de cada fondo y el Lab se llenaría de basura que
// jamás se reescribe.

import { sql } from "drizzle-orm";
import { db, unwrapRows } from "@/lib/db";
import {
  CURATED_FUNDS,
  RETIRED_FUND_CIKS,
  fetchFundFilings,
  type FundFiling,
} from "@/lib/funds/filings";
import { resolveCusips } from "@/lib/providers/openfigi";

export type FundsIngestResult = {
  fundsChecked: number;
  filingsStored: number;
  holdingsStored: number;
  skipped: "disabled" | "recent" | null;
  durationMs: number;
};

const SWEEP_HOURS = 12;
/** Fondos con filing NUEVO procesados por pasada (los demás esperan a la
 *  siguiente). Acota el trabajo pesado cuando 19 fondos declaran la misma
 *  semana, que es exactamente lo que pasa al vencer el plazo de 45 días. */
const MAX_NEW_FUNDS_PER_SWEEP = 6;
const GAP_MS = 250;

async function sweptRecently(): Promise<boolean> {
  return (
    unwrapRows<{ recent: boolean | null }>(
      await db.execute(sql`
        SELECT (MAX(created_at) > now() - (${SWEEP_HOURS} || ' hours')::interval)
          AS recent
        FROM fund_holdings
      `),
    )[0]?.recent === true
  );
}

/**
 * Accessions ya ingestados Y COMPLETOS. Un filing al que le falte
 * `filing_date` NO cuenta como conocido, así que se vuelve a bajar y el
 * ON CONFLICT lo completa: es autocurativo ante columnas añadidas después
 * (pasó con filing_date, que se añadió tras cargar Berkshire). Sin esto la
 * fila se quedaría incompleta para siempre, porque el fondo no se revisita.
 */
async function knownAccessions(cik: string): Promise<Set<string>> {
  return new Set(
    unwrapRows<{ accession: string }>(
      await db.execute(sql`
        SELECT accession FROM fund_holdings
        WHERE fund_cik = ${cik}
        GROUP BY accession
        HAVING count(*) FILTER (WHERE filing_date IS NULL) = 0
      `),
    ).map((r) => r.accession),
  );
}

/** Agrega por CUSIP: el information table repite el mismo valor en varias
 *  filas cuando lo gestionan managers distintos (visto en Icahn). Sin esto,
 *  el ON CONFLICT se quedaría con una fila arbitraria y el tamaño de la
 *  posición saldría MENOR que el declarado. */
function aggregate(filing: FundFiling) {
  const byCusip = new Map<
    string,
    { cusip: string; issuerName: string; value: number; shares: number }
  >();
  for (const h of filing.holdings) {
    const prev = byCusip.get(h.cusip);
    if (prev) {
      prev.value += h.value;
      prev.shares += h.shares ?? 0;
    } else {
      byCusip.set(h.cusip, {
        cusip: h.cusip,
        issuerName: h.issuerName,
        value: h.value,
        shares: h.shares ?? 0,
      });
    }
  }
  return [...byCusip.values()];
}

async function storeFiling(
  fund: { cik: string; name: string },
  filing: FundFiling,
): Promise<number> {
  const rows = aggregate(filing);
  if (rows.length === 0) return 0;
  const symbols = await resolveCusips(rows.map((r) => r.cusip));

  let stored = 0;
  const CHUNK = 300;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const values = sql.join(
      chunk.map(
        (r) =>
          sql`(${fund.cik}, ${fund.name}, ${filing.periodOfReport},
               ${filing.filingDate}, ${r.cusip},
               ${symbols.get(r.cusip) ?? null}, ${r.issuerName}, ${r.value},
               ${r.shares}, ${filing.accession})`,
      ),
      sql`, `,
    );
    try {
      await db.execute(sql`
        INSERT INTO fund_holdings
          (fund_cik, fund_name, period_of_report, filing_date, cusip, symbol,
           issuer_name, value, shares, accession)
        VALUES ${values}
        ON CONFLICT (fund_cik, period_of_report, cusip) DO UPDATE SET
          value = EXCLUDED.value,
          filing_date = EXCLUDED.filing_date,
          shares = EXCLUDED.shares,
          symbol = COALESCE(EXCLUDED.symbol, fund_holdings.symbol),
          accession = EXCLUDED.accession
      `);
      stored += chunk.length;
    } catch (err) {
      console.warn(
        `[funds] insert ${fund.name} falló:`,
        err instanceof Error ? err.message.slice(0, 140) : err,
      );
    }
  }
  return stored;
}

/**
 * Rellena los `symbol` que quedaron a NULL. Es IMPRESCINDIBLE, no un extra:
 * el presupuesto de OpenFIGI por pasada (10 CUSIPs/petición anónima) casi
 * nunca alcanza para resolver un fondo entero de golpe, y como la ingesta ya
 * ha marcado ese accession como conocido, el fondo no se vuelve a visitar
 * jamás — sin esta pasada los tickers se quedarían a null PARA SIEMPRE.
 *
 * Dos partes: (1) resolver contra OpenFIGI los CUSIPs que aún no están en la
 * caché, y (2) volcar la caché sobre las filas, que es un simple JOIN y
 * arregla también las que otro fondo ya resolvió.
 */
export async function fillMissingSymbols(
  maxRequests = 40,
): Promise<{ resolved: number; updated: number }> {
  const pending = unwrapRows<{ cusip: string }>(
    await db.execute(sql`
      SELECT DISTINCT h.cusip
      FROM fund_holdings h
      LEFT JOIN cusip_map m ON m.cusip = h.cusip
      WHERE h.symbol IS NULL AND m.cusip IS NULL
      LIMIT ${maxRequests * 10}
    `),
  ).map((r) => r.cusip);

  if (pending.length > 0) await resolveCusips(pending, { maxRequests });

  const res = await db.execute(sql`
    UPDATE fund_holdings h
    SET symbol = m.symbol
    FROM cusip_map m
    WHERE h.cusip = m.cusip
      AND h.symbol IS NULL
      AND m.symbol IS NOT NULL
  `);
  return {
    resolved: pending.length,
    updated: (res as { rowCount?: number }).rowCount ?? 0,
  };
}

export async function runFundHoldingsIngest(
  opts: { force?: boolean; onlyCik?: string } = {},
): Promise<FundsIngestResult> {
  const t0 = Date.now();
  const done = (r: Partial<FundsIngestResult>): FundsIngestResult => ({
    fundsChecked: 0,
    filingsStored: 0,
    holdingsStored: 0,
    skipped: null,
    durationMs: Date.now() - t0,
    ...r,
  });

  if (process.env.FUND_HOLDINGS_ENABLED === "0") {
    return done({ skipped: "disabled" });
  }
  if (!opts.force && (await sweptRecently())) return done({ skipped: "recent" });

  // Purga de fondos retirados de la lista: sin esto sus posiciones seguirían
  // contando en "dónde coinciden los fondos" y en la comparación entre
  // trimestres, con datos que ya no mantenemos.
  try {
    const res = await db.execute(sql`
      DELETE FROM fund_holdings WHERE fund_cik IN (${sql.join(
        RETIRED_FUND_CIKS.map((c) => sql`${c}`),
        sql`, `,
      )})
    `);
    const n = (res as { rowCount?: number }).rowCount ?? 0;
    if (n > 0) console.log(`[funds] purgadas ${n} filas de fondos retirados`);
  } catch (err) {
    console.warn(
      "[funds] purga falló:",
      err instanceof Error ? err.message.slice(0, 120) : err,
    );
  }

  const funds = opts.onlyCik
    ? CURATED_FUNDS.filter((f) => f.cik === opts.onlyCik)
    : CURATED_FUNDS;

  let fundsChecked = 0;
  let filingsStored = 0;
  let holdingsStored = 0;
  let processed = 0;

  for (const fund of funds) {
    if (processed >= MAX_NEW_FUNDS_PER_SWEEP) {
      console.log(
        `[funds] tope de ${MAX_NEW_FUNDS_PER_SWEEP} fondos nuevos por pasada — el resto en la siguiente`,
      );
      break;
    }
    try {
      const known = await knownAccessions(fund.cik);
      // Primera vez: 2 trimestres para tener con qué comparar. Después basta
      // el último, porque el anterior ya está guardado.
      const want = known.size === 0 ? 2 : 1;
      const filings = await fetchFundFilings(fund.cik, want);
      fundsChecked++;
      const fresh = filings.filter((f) => !known.has(f.accession));
      if (fresh.length === 0) continue;

      for (const filing of fresh) {
        holdingsStored += await storeFiling(fund, filing);
        filingsStored++;
        console.log(
          `[funds] ${fund.name} ${filing.periodOfReport}: ${filing.holdings.length} posiciones`,
        );
      }
      processed++;
    } catch (err) {
      console.warn(
        `[funds] ${fund.name} falló:`,
        err instanceof Error ? err.message.slice(0, 140) : err,
      );
    }
    await new Promise((r) => setTimeout(r, GAP_MS));
  }

  // Siempre, aunque no haya entrado ningún filing nuevo: es lo que va
  // cerrando el hueco de tickers que el presupuesto de OpenFIGI dejó abierto
  // en pasadas anteriores.
  try {
    const filled = await fillMissingSymbols();
    if (filled.updated > 0) {
      console.log(
        `[funds] tickers rellenados: ${filled.updated} filas (${filled.resolved} CUSIPs consultados)`,
      );
    }
  } catch (err) {
    console.warn(
      "[funds] fillMissingSymbols falló:",
      err instanceof Error ? err.message.slice(0, 140) : err,
    );
  }

  return done({ fundsChecked, filingsStored, holdingsStored });
}
