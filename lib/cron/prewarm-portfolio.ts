// Precalentado de cuerpos para la revisión de cartera. Node-only.
//
// POR QUÉ EXISTE: la revisión extrae los cuerpos que le faltan en el
// momento de pedirla, y esa cosecha es lo que hace que la PRIMERA revisión
// del día tarde ~40s. Como `article_extracts` cachea de forma permanente,
// basta con que alguien haya extraído esos artículos antes — y el cron ya
// está corriendo cada 10 minutos.
//
// No sustituye a la cosecha bajo demanda, la vacía de trabajo: si algo
// entró en el archivo entre dos ticks, la revisión lo extrae igual. Esto
// sólo hace que ese "algo" sean dos artículos y no veinte.
//
// Alcance deliberadamente estrecho: SÓLO los símbolos con posición viva
// (`shares > 0`). Extraer los cuerpos de toda la watchlist sería pagar
// fetches por nombres que nadie va a revisar; los de seguimiento se
// cosechan en caliente el día que se conviertan en posición.

import { sql } from "drizzle-orm";
import { db, unwrapRows } from "@/lib/db";
import { harvestBodies, selectForwardCandidates } from "@/lib/ask/forward";
import { jobRanWithin, markJobRun } from "@/lib/cron/job-state";

const JOB_KEY = "portfolio-prewarm";
/** Cada cuánto. Una hora deja ~24 pasadas al día, de sobra para mantener
 *  al día una cartera de 20 nombres, y no convierte el cron en un
 *  rastreador de medios. */
const EVERY_HOURS = 1;
/** Techo de fetches por pasada. El coste real de este job son peticiones a
 *  medios externos, no CPU ni BD: es lo único que hay que acotar. */
const MAX_FETCHES = 10;
const BUDGET_MS = 25_000;

export async function prewarmPortfolioBodies(): Promise<{
  skipped?: string;
  symbols?: number;
  harvested?: number;
  attempted?: number;
}> {
  if (process.env.PORTFOLIO_PREWARM === "0") return { skipped: "disabled" };
  if (await jobRanWithin(JOB_KEY, EVERY_HOURS)) return { skipped: "recent" };

  // Se marca ANTES de trabajar, igual que el resto de barridos del proyecto:
  // si la pasada muere a mitad, la siguiente espera su hora en vez de
  // reintentar en el tick de dentro de 10 minutos con las mismas fuentes
  // lentas que acaban de fallar.
  await markJobRun(JOB_KEY);

  const symbols = unwrapRows<{ symbol: string }>(
    await db.execute(sql`
      SELECT DISTINCT symbol FROM watchlist WHERE shares IS NOT NULL AND shares > 0
    `),
  ).map((r) => r.symbol);
  if (!symbols.length) return { skipped: "sin posiciones", symbols: 0 };

  const candidates = await selectForwardCandidates(symbols, 4);
  const pendientes = candidates.filter((c) => !c.hasExtract).slice(0, MAX_FETCHES);
  if (!pendientes.length) {
    return { skipped: "al día", symbols: symbols.length, harvested: 0, attempted: 0 };
  }

  const { harvested, attempted } = await harvestBodies(pendientes, {
    budgetMs: BUDGET_MS,
    concurrency: 3,
  });
  return { symbols: symbols.length, harvested, attempted };
}
