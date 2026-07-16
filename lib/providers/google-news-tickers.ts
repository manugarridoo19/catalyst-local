import Parser from "rss-parser";
import type { NormalizedNewsItem } from "@/lib/types";
import { hashUrl } from "@/lib/hash";

// Google News RSS por ticker — barre internet entero por menciones de un
// símbolo concreto. Para cada ticker hacemos una query con el símbolo y el
// nombre conocido (si lo tenemos) para mejorar recall.
//
// Format de URL: https://news.google.com/rss/search?q={query}&hl=en-US&gl=US&ceid=US:en
//
// La sintaxis de Google News soporta operadores como `OR`, `AND`, `"frase"`.

const parser = new Parser({
  timeout: 12_000,
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
    Accept:
      "application/rss+xml, application/xml;q=0.9, application/atom+xml;q=0.9, text/xml;q=0.8, */*;q=0.5",
  },
});

export type TickerQuery = { symbol: string; name?: string | null };

// Sufijos corporativos que quitamos del nombre para el matching (y para la
// query). "Gates Industrial Corporation plc" → "Gates Industrial".
const NAME_SUFFIX_RE =
  /\b(Inc\.?|Corp\.?|Corporation|Co\.?|Ltd\.?|PLC|N\.?V\.?|S\.?A\.?|Group|Holdings?)\b/gi;

function cleanedName(name?: string | null): string {
  if (!name) return "";
  return name.replace(NAME_SUFFIX_RE, "").replace(/\s+/g, " ").trim();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ¿La noticia menciona de verdad al ticker buscado? Google News devuelve
// resultados laxos (matching parcial, sinónimos), y antes etiquetábamos
// TODO resultado con el símbolo buscado como si fuera anotación de API.
// Caso real: query "Ammo stock OR $POWW" → artículo de cremas solares
// taggeado POWW; "BlackRock Income Trust" recortado a "BlackRock" → todas
// las noticias de BLK taggeadas BKT. Ahora exigimos evidencia en el texto:
//   - $SYM, (SYM) o (EXCH:SYM) explícito, o
//   - el símbolo suelto en mayúsculas (solo ≥3 chars — "GS" colisiona), o
//   - el nombre limpio COMPLETO de la empresa ("Gates Industrial", no "Gates").
export function mentionsTicker(
  text: string,
  symbol: string,
  name?: string | null,
): boolean {
  const sym = symbol.toUpperCase();
  const escSym = escapeRe(sym);
  if (new RegExp(`\\$${escSym}\\b`).test(text)) return true;
  if (new RegExp(`\\((?:[A-Z]+:)?${escSym}\\)`).test(text)) return true;
  if (sym.length >= 3 && new RegExp(`\\b${escSym}\\b`).test(text)) return true;
  const cleaned = cleanedName(name);
  if (cleaned.length >= 3) {
    if (new RegExp(`\\b${escapeRe(cleaned)}\\b`, "i").test(text)) return true;
  }
  return false;
}

// Construye query para Google News. Usa $TICKER + name si está disponible.
function buildQuery(t: TickerQuery): string {
  const sym = t.symbol.toUpperCase();
  const cleaned = cleanedName(t.name);
  if (cleaned.length > 2) {
    // "Apple stock" OR $AAPL → buena cobertura sin demasiados falsos positivos.
    return `("${cleaned} stock" OR $${sym})`;
  }
  return `$${sym} stock`;
}

async function fetchOne(t: TickerQuery): Promise<NormalizedNewsItem[]> {
  const url = new URL("https://news.google.com/rss/search");
  url.searchParams.set("q", buildQuery(t));
  url.searchParams.set("hl", "en-US");
  url.searchParams.set("gl", "US");
  url.searchParams.set("ceid", "US:en");

  try {
    const feed = await parser.parseURL(url.toString());
    return (feed.items || [])
      .filter((it) => it.link && it.title)
      .slice(0, 25) // limita por ticker para no inflar
      .map<NormalizedNewsItem>((it) => {
        const headline = cleanTitle(it.title!);
        const body = it.contentSnippet || it.content || undefined;
        // El hint del ticker buscado solo se acepta si el texto lo menciona
        // de verdad — Google News hace matching laxo y antes esto producía
        // mislinks masivos (ver mentionsTicker). Sin hint confirmado, la
        // noticia sigue entrando y el extractor (regex/dict) decide.
        const confirmed = mentionsTicker(
          `${headline}\n${body ?? ""}`,
          t.symbol,
          t.name,
        );
        return {
          url: it.link!,
          hash: hashUrl(it.link!),
          headline,
          source: `gnews:${t.symbol}`,
          publishedAt: it.isoDate
            ? new Date(it.isoDate)
            : it.pubDate
              ? new Date(it.pubDate)
              : new Date(),
          body,
          apiTickers: confirmed ? [t.symbol.toUpperCase()] : [],
        };
      });
  } catch {
    return [];
  }
}

function cleanTitle(t: string): string {
  return t.replace(/\s+-\s+[A-Za-z0-9.\s&,]+$/, "").trim();
}

// Fetch en paralelo con concurrencia limitada (Google News no documenta
// rate-limits pero es prudente no abusar).
export async function fetchGoogleNewsByTicker(
  tickers: TickerQuery[],
  concurrency = 6,
): Promise<NormalizedNewsItem[]> {
  const out: NormalizedNewsItem[] = [];
  const queue = [...tickers];
  const workers = Array.from({ length: concurrency }, async () => {
    while (queue.length) {
      const t = queue.shift();
      if (!t) break;
      const items = await fetchOne(t);
      out.push(...items);
    }
  });
  await Promise.all(workers);
  return out;
}
