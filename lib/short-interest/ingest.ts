// Ingesta del short interest de FINRA. Node-only (corre en el cron y en el
// refresher local); el Worker sólo LEE la tabla.
//
// Cadencia: como mucho una pasada al día, y aun así casi siempre sale sin
// hacer nada. El dato se publica DOS VECES AL MES, así que preguntar más a
// menudo no puede traer nada nuevo — el guard mira nuestra propia tabla
// (mismo criterio que el job de outcomes: la cadencia se deduce de los datos,
// sin tabla de "últimas ejecuciones").

import { sql } from "drizzle-orm";
import { db, unwrapRows } from "@/lib/db";
import { loadKnownSymbols } from "@/lib/db/queries";
import {
  candidateSettlementDates,
  fetchShortInterestSnapshot,
  settlementDateHasData,
  type ShortInterestRecord,
} from "@/lib/providers/finra";

export type ShortInterestResult = {
  settlementDate: string | null;
  fetched: number;
  stored: number;
  skipped: "recent" | "up-to-date" | "no-data" | "disabled" | null;
  durationMs: number;
};

/** Horas mínimas entre pasadas. */
const RETRY_HOURS = 20;

async function latestStoredDate(): Promise<string | null> {
  return (
    unwrapRows<{ d: string | null }>(
      await db.execute(
        sql`SELECT MAX(settlement_date) AS d FROM short_interest`,
      ),
    )[0]?.d ?? null
  );
}

async function ranRecently(): Promise<boolean> {
  return (
    unwrapRows<{ recent: boolean | null }>(
      await db.execute(sql`
        SELECT (MAX(fetched_at) > now() - (${RETRY_HOURS} || ' hours')::interval)
          AS recent
        FROM short_interest
      `),
    )[0]?.recent === true
  );
}

/** Filas por sentencia. Un INSERT por fila serían ~2.000 round-trips HTTP a
 *  Neon (el driver global no es un pool) = minutos enteros del presupuesto de
 *  10min del cron. Multi-fila lo deja en un puñado de sentencias. */
const INSERT_CHUNK = 500;

async function storeRecords(rows: ShortInterestRecord[]): Promise<number> {
  let stored = 0;
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    const chunk = rows.slice(i, i + INSERT_CHUNK);
    const values = sql.join(
      chunk.map(
        (r) =>
          sql`(${r.symbol}, ${r.settlementDate}, ${r.currentShortQty},
               ${r.previousShortQty}, ${r.avgDailyVolume}, ${r.daysToCover},
               ${r.changePercent}, ${r.marketClass}, ${r.issueName})`,
      ),
      sql`, `,
    );
    try {
      await db.execute(sql`
        INSERT INTO short_interest
          (symbol, settlement_date, current_short_qty, previous_short_qty,
           avg_daily_volume, days_to_cover, change_percent, market_class,
           issue_name)
        VALUES ${values}
        ON CONFLICT (symbol, settlement_date) DO UPDATE SET
          current_short_qty = EXCLUDED.current_short_qty,
          previous_short_qty = EXCLUDED.previous_short_qty,
          avg_daily_volume = EXCLUDED.avg_daily_volume,
          days_to_cover = EXCLUDED.days_to_cover,
          change_percent = EXCLUDED.change_percent,
          fetched_at = now()
      `);
      stored += chunk.length;
    } catch (err) {
      console.warn(
        `[short-interest] insert chunk ${i}-${i + chunk.length} falló:`,
        err instanceof Error ? err.message.slice(0, 140) : err,
      );
    }
  }
  return stored;
}

export async function runShortInterestIngest(
  opts: { force?: boolean } = {},
): Promise<ShortInterestResult> {
  const t0 = Date.now();
  const done = (r: Partial<ShortInterestResult>): ShortInterestResult => ({
    settlementDate: null,
    fetched: 0,
    stored: 0,
    skipped: null,
    durationMs: Date.now() - t0,
    ...r,
  });

  if (process.env.SHORT_INTEREST_ENABLED === "0") {
    return done({ skipped: "disabled" });
  }
  if (!opts.force && (await ranRecently())) return done({ skipped: "recent" });

  const stored = await latestStoredDate();

  // Se prueban las fechas candidatas de la más nueva a la más vieja y se para
  // en la primera PUBLICADA. FINRA lleva ~2 semanas de retraso, así que las
  // primeras candidatas suelen venir vacías y eso es lo normal, no un error.
  let target: string | null = null;
  for (const date of candidateSettlementDates(new Date())) {
    // `force` re-descarga también la quincena que ya tenemos: es la vía para
    // re-normalizar filas viejas cuando cambia el parseo (p.ej. el centinela
    // 999.99 de days-to-cover).
    if (!opts.force && stored && date <= stored) break; // ya la tenemos
    if (await settlementDateHasData(date)) {
      target = date;
      break;
    }
  }
  if (!target) {
    return done({ skipped: stored ? "up-to-date" : "no-data" });
  }

  const universe = await loadKnownSymbols();
  const records = await fetchShortInterestSnapshot(target, (s) =>
    universe.has(s),
  );
  const storedCount = await storeRecords(records);
  return done({
    settlementDate: target,
    fetched: records.length,
    stored: storedCount,
  });
}
