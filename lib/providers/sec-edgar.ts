import Parser from "rss-parser";
import type { NormalizedNewsItem } from "@/lib/types";
import { hashUrl } from "@/lib/hash";
import { db, unwrapRows } from "@/lib/db";
import { sql } from "drizzle-orm";
import { startOfTodayUtc } from "@/lib/time-windows";

// SEC EDGAR — filings directos de la fuente primaria (señal pura, sin
// clickbait). Ingerimos los más recientes de dos tipos de alta señal:
//   8-K   → evento material (resultados, M&A, cambio de directivos, etc.)
//   4     → insider trade (Form 4: compra/venta de directivos)
//
// EDGAR indexa por CIK, no por ticker. Mapeamos CIK→ticker con el fichero
// oficial `company_tickers.json` (cache módulo, cambia raro). Solo emitimos
// filings de empresas presentes en ese mapa (cotizadas US) — el resto se
// descarta. El apiTicker resultante es alta confianza (viene del regulador).
//
// El título críptico del filing ("8-K - APPLE INC (0000320193) (Filer)") no
// dice mucho, pero el resumen IA por item (impact>=4) lo decodifica en el
// scoring. Y el scoring puntúa bajo los Form 4 rutinarios, así que el ruido
// insider se auto-filtra del live feed.
//
// SEC exige un User-Agent identificable con contacto real (si no → 403) y
// limita a 10 req/seg. Hacemos 2 requests por tick, de sobra.

const SEC_UA = "Catalyst News Dashboard manubisbal19@gmail.com";
const TICKERS_MAP_URL = "https://www.sec.gov/files/company_tickers.json";
const FILING_COUNT = 40; // por tipo y tick

const parser = new Parser({
  timeout: 12_000,
  headers: { "User-Agent": SEC_UA, Accept: "application/atom+xml, application/xml" },
});

// CIK (10 dígitos, zero-padded) → ticker. Cache módulo con TTL largo.
let cikMap: Map<string, string> | null = null;
let cikMapAt = 0;
const CIK_MAP_TTL = 24 * 3600_000;

async function getCikMap(): Promise<Map<string, string>> {
  if (cikMap && Date.now() - cikMapAt < CIK_MAP_TTL) return cikMap;
  const res = await fetch(TICKERS_MAP_URL, {
    headers: { "User-Agent": SEC_UA },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`company_tickers ${res.status}`);
  const raw = (await res.json()) as Record<
    string,
    { cik_str: number; ticker: string; title: string }
  >;
  const m = new Map<string, string>();
  for (const v of Object.values(raw)) {
    const cik = String(v.cik_str).padStart(10, "0");
    // Un CIK puede tener varias clases; nos quedamos con el primer ticker.
    if (!m.has(cik)) m.set(cik, v.ticker.toUpperCase());
  }
  cikMap = m;
  cikMapAt = Date.now();
  return m;
}

const FILING_TYPES: Array<{ type: string; label: string }> = [
  { type: "8-K", label: "8-K filing" },
  { type: "4", label: "Form 4 (insider)" },
];

// Tope de Form 4 por emisor y día. Los grandes bancos presentan decenas de
// Form 4/día (Goldman 58×, JPMorgan 48×, Citi 44×… — concesiones rutinarias
// de acciones al consejo, ruido puro) con TITULAR IDÉNTICO. Se ven como la
// misma noticia repetida e inundan el chip Insider, y encima cada uno gasta
// una llamada de scoring. Capamos a N por emisor/día en la ingesta: ves que
// "hubo actividad insider en Goldman" sin 58 filas. Configurable por env.
const FORM4_PER_ISSUER_CAP = Number(process.env.SEC_FORM4_PER_ISSUER_CAP ?? 3);

// Cuántos Form 4 ya hay HOY por emisor (headline). El titular es 1:1 con el
// emisor ("GOLDMAN SACHS GROUP INC files Form 4 (insider)"), así que agrupar
// por headline = agrupar por empresa. Una query por tick.
async function getTodayForm4Counts(): Promise<Map<string, number>> {
  try {
    const res = await db.execute(sql`
      SELECT headline, count(*)::int AS n
      FROM news
      WHERE source = 'sec-edgar'
        AND headline LIKE '% files Form 4 (insider)'
        AND published_at >= ${startOfTodayUtc()}
      GROUP BY headline`);
    const rows = unwrapRows<{ headline: string; n: number }>(res);
    return new Map(rows.map((r) => [r.headline, Number(r.n)]));
  } catch (e) {
    // Si la cuenta falla, seguimos sin cap (mejor algo de ruido que perder
    // la fuente entera). El hash dedup evita reinsertar los ya vistos.
    console.warn(
      "[sec-edgar] form4 count failed, skipping cap:",
      e instanceof Error ? e.message : e,
    );
    return new Map();
  }
}

function feedUrl(type: string): string {
  const params = new URLSearchParams({
    action: "getcurrent",
    type,
    company: "",
    dateb: "",
    owner: "include",
    count: String(FILING_COUNT),
    output: "atom",
  });
  return `https://www.sec.gov/cgi-bin/browse-edgar?${params}`;
}

// Extrae el CIK de 10 dígitos del título del entry EDGAR.
function cikFromTitle(title: string): string | null {
  const m = title.match(/\((\d{10})\)/);
  return m ? m[1] : null;
}

// Extrae el nombre de empresa: "8-K - APPLE INC (000...) (Filer)" → "APPLE INC".
function companyFromTitle(title: string): string {
  const m = title.match(/^[\w-]+\s*-\s*(.+?)\s*\(\d{10}\)/);
  return m ? m[1].trim() : title;
}

// `allowed` = universo de tickers que ya seguimos (conocidos + watchlist).
// Solo emitimos filings de esas empresas — así SEC aporta señal de los
// valores relevantes, no un firehose de 8-K de micro-caps que nadie sigue
// (que además gastarían capacidad de scoring). Si `allowed` viene vacío,
// emitimos todos (modo test / primer arranque sin universo).
export async function fetchSecFilings(
  allowed?: Set<string>,
): Promise<NormalizedNewsItem[]> {
  let map: Map<string, string>;
  try {
    map = await getCikMap();
  } catch (e) {
    console.warn("[sec-edgar] cik map failed:", e instanceof Error ? e.message : e);
    return [];
  }
  const filter = allowed && allowed.size > 0 ? allowed : null;

  // Cuenta de Form 4 ya ingeridos hoy por emisor + los que emitimos en este
  // tick — para no pasarnos del cap sumando ambos.
  const form4Today = await getTodayForm4Counts();
  let cappedForm4 = 0;

  const out: NormalizedNewsItem[] = [];
  for (const { type, label } of FILING_TYPES) {
    try {
      const feed = await parser.parseURL(feedUrl(type));
      for (const item of feed.items) {
        const title = item.title ?? "";
        const link = item.link;
        if (!link) continue;
        // getcurrent&type=4 hace PREFIX match: devuelve también 424B2,
        // 425, etc. (Citigroup emite decenas de folletos 424B2/día que
        // salían como "files Form 4 (insider)"). Exigimos el tipo EXACTO
        // (con /A de amendment) al inicio del título del entry.
        const formType = title.split(" - ")[0]?.trim().toUpperCase();
        if (formType !== type.toUpperCase() && formType !== `${type.toUpperCase()}/A`) {
          continue;
        }
        const cik = cikFromTitle(title);
        if (!cik) continue;
        const ticker = map.get(cik);
        if (!ticker) continue; // no cotizada / no en el mapa → descartar
        if (filter && !filter.has(ticker)) continue; // fuera de nuestro universo
        const company = companyFromTitle(title);
        const when = item.isoDate ? new Date(item.isoDate) : new Date();
        // Headline legible con el nombre de empresa (el extractor y el
        // resumen IA trabajan mejor con el nombre que con el CIK).
        const headline = `${company} files ${label}`;

        // Cap por emisor/día SOLO para Form 4 (los 8-K no llegan en ráfaga
        // y cada uno es un evento material distinto). Cuenta existente en BD
        // + emitidos en este tick.
        if (type === "4" && FORM4_PER_ISSUER_CAP > 0) {
          const seen = form4Today.get(headline) ?? 0;
          if (seen >= FORM4_PER_ISSUER_CAP) {
            cappedForm4++;
            continue;
          }
          form4Today.set(headline, seen + 1);
        }

        out.push({
          url: link,
          hash: hashUrl(link),
          headline,
          source: "sec-edgar",
          publishedAt: when,
          body: title,
          apiTickers: [ticker],
        });
      }
    } catch (e) {
      console.warn(
        `[sec-edgar] ${type} feed failed:`,
        e instanceof Error ? e.message : e,
      );
    }
  }
  if (cappedForm4 > 0) {
    console.log(
      `[sec-edgar] capped ${cappedForm4} Form 4 (>${FORM4_PER_ISSUER_CAP}/issuer today)`,
    );
  }
  return out;
}
