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
// ALCANCE AMPLIADO (2026-07-30), y el porqué está medido:
//
// Nació sirviendo sólo a la revisión de cartera, así que miraba únicamente
// los símbolos con posición viva (`shares > 0`). Desde que /ask tiene modo
// decisión, el mismo caché alimenta también su libro de futuros — y ahí las
// preguntas legítimas incluyen nombres que se SIGUEN sin tener ("¿entro en
// $X?"), que el filtro anterior excluía por definición. Ahora entra toda la
// watchlist, con las posiciones vivas primero.
//
// Por qué NO se subió `ENRICH_BATCH` en su lugar, que era lo obvio: ese
// camino llama a `getArticleDetail` SIN `allowLlm:false`, así que cada
// artículo cuesta una llamada de prosa. Multiplicarlo por 5 habría
// multiplicado por 5 el gasto del recurso escaso del proyecto para obtener
// un subproducto —el resumen IA de la tarjeta— que la decisión ni usa: lo
// que lee es `text`. Esta pasada extrae CUERPOS y cuesta CERO cuota.
//
// Coste medido el 2026-07-30 antes de tocar nada:
//   - BD 216,8 MB de los 512 del plan free (news 87,8 · embeddings 68,7 ·
//     article_extracts 5,7).
//   - ~4 kB por fila extraída (3.510 chars de media).
//   - 1.167 noticias impact>=3 de la watchlist en 20d SIN cuerpo ≈ 4,7 MB
//     para ponerse al día, y ~58/día en régimen estacionario ≈ 0,2 MB/día.
//     La tabla cascadea con la purga de news a 20d, así que se estabiliza
//     sola en torno a 5 MB y no crece sin fin.
// Es decir: el freno de este job sigue siendo los fetches a medios, no el
// disco. Aun así lleva guard de almacenamiento, porque escribir más sin
// freno es justo lo que la ingesta de embeddings ya aprendió a no hacer.

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
 *  medios externos, no CPU ni BD: es lo único que hay que acotar.
 *
 *  24/hora = ~576/día de techo, contra un régimen estacionario medido de
 *  ~58 noticias/día de la watchlist con impact>=3. El margen no es
 *  desperdicio: es lo que vacía el atraso de 1.167 en unos días y absorbe
 *  las fuentes bloqueadas, que consumen intento sin dejar cuerpo. Cuando se
 *  pone al día el filtro `!hasExtract` deja la lista vacía y la pasada sale
 *  por "al día" sin gastar nada. */
const MAX_FETCHES = 24;
const BUDGET_MS = 40_000;
/**
 * Artículos por símbolo que se ponen a tiro. ERA 4, y ése —no `MAX_FETCHES`—
 * era el cuello de botella real: medido el 2026-07-30 sobre la watchlist de
 * 7 nombres, `perSymbol=4` da 28 candidatos de los que sólo 5 estaban sin
 * cuerpo, así que la pasada se quedaba sin trabajo que hacer mientras había
 * 2.084 noticias de esos mismos símbolos, con categoría útil y menos de 20
 * días, sin una sola fila en `article_extracts`. Subirlo a 20 pone 163 a
 * tiro (124 sin cuerpo) y deja que `MAX_FETCHES` haga de freno de verdad.
 *
 * Ampliar esto NO multiplica el coste por pasada: el techo sigue siendo
 * `MAX_FETCHES`. Sólo ensancha de dónde elegir.
 */
const PER_SYMBOL = 20;
/** Por encima de esto no se escriben más cuerpos. Neon free son 512 MB para
 *  TODA la base y `article_extracts` no tenía freno propio; los embeddings
 *  ya pausan solos en 380 (`EMBED_MAX_DB_MB`) y este job se para antes, para
 *  que si un día hay que elegir gane la ventana consultable de /ask sobre
 *  la comodidad de tener el cuerpo precargado. */
const MAX_DB_MB = 360;

async function dbSizeMb(): Promise<number> {
  const rows = unwrapRows<{ mb: number }>(
    await db.execute(
      sql`SELECT (pg_database_size(current_database()) / 1048576.0)::float8 AS mb`,
    ),
  );
  return rows[0]?.mb ?? 0;
}

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
  const dbMb = await dbSizeMb();
  if (dbMb > MAX_DB_MB) {
    console.warn(
      `[prewarm] BD en ${dbMb.toFixed(0)} MB (tope ${MAX_DB_MB}): no se precargan más cuerpos`,
    );
    return { skipped: `bd ${dbMb.toFixed(0)}MB` };
  }

  await markJobRun(JOB_KEY);

  // Toda la watchlist, con las posiciones VIVAS primero. El orden importa
  // porque `MAX_FETCHES` recorta por la cola: si el presupuesto no llega
  // para todos, quien se queda fuera tiene que ser el nombre que sólo se
  // sigue, no aquél en el que hay dinero puesto.
  const symbols = unwrapRows<{ symbol: string }>(
    await db.execute(sql`
      SELECT symbol FROM (
        SELECT DISTINCT ON (symbol) symbol,
               (shares IS NOT NULL AND shares > 0) AS viva
        FROM watchlist ORDER BY symbol, viva DESC
      ) t ORDER BY viva DESC, symbol
    `),
  ).map((r) => r.symbol);
  if (!symbols.length) return { skipped: "watchlist vacía", symbols: 0 };

  // La prioridad hay que REIMPONERLA aquí. `selectForwardCandidates` hace
  // el ranking por categoría DENTRO de cada símbolo (PARTITION BY) pero su
  // consulta externa no lleva ORDER BY, así que el orden entre símbolos que
  // devuelve Postgres es arbitrario: sin esto, el `slice` de abajo recorta
  // al azar y "las vivas primero" no significaría nada.
  const rank = new Map(symbols.map((s, i) => [s, i]));

  // Los que YA fallaron van al final. `hasExtract` sólo mira `status='ok'`,
  // así que "nunca se intentó" y "se intentó y la fuente bloquea" entran
  // indistinguibles — y hay 78 de los segundos (29% de los intentos: 403 de
  // seekingalpha, investing.com, tipranks…). Sin esta separación, esos 78
  // reocupan los 24 huecos de cada pasada en cuanto vence su enfriamiento y
  // el precalentado se pasa el día reintentando lo que no va a ceder nunca,
  // con `harvested: 0` y sin tocar lo que sí está disponible. Es justo lo
  // que se midió en la primera ejecución real: 0 de 5.
  const fallidos = new Set(
    unwrapRows<{ newsId: number }>(
      await db.execute(
        sql`SELECT news_id AS "newsId" FROM article_extracts WHERE status <> 'ok'`,
      ),
    ).map((r) => Number(r.newsId)),
  );

  const candidates = await selectForwardCandidates(symbols, PER_SYMBOL);
  const pendientes = candidates
    .filter((c) => !c.hasExtract)
    .sort(
      (a, b) =>
        Number(fallidos.has(a.newsId)) - Number(fallidos.has(b.newsId)) ||
        (rank.get(a.symbol) ?? 1e9) - (rank.get(b.symbol) ?? 1e9),
    )
    .slice(0, MAX_FETCHES);
  if (!pendientes.length) {
    return { skipped: "al día", symbols: symbols.length, harvested: 0, attempted: 0 };
  }

  const { harvested, attempted } = await harvestBodies(pendientes, {
    budgetMs: BUDGET_MS,
    concurrency: 4,
  });
  return { symbols: symbols.length, harvested, attempted };
}
