import Parser from "rss-parser";
import type { NormalizedNewsItem } from "@/lib/types";
import { hashUrl } from "@/lib/hash";

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

  const out: NormalizedNewsItem[] = [];
  for (const { type, label } of FILING_TYPES) {
    try {
      const feed = await parser.parseURL(feedUrl(type));
      for (const item of feed.items) {
        const title = item.title ?? "";
        const link = item.link;
        if (!link) continue;
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
  return out;
}
