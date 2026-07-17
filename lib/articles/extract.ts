// Extracción de contenido de artículos — dependency-free (Workers-safe).
//
// La mayoría de fuentes solo dan titular o boilerplate ("Titular  SiteName"),
// así que al expandir una card traemos el artículo real. Sin jsdom/linkedom:
// un readability-lite por regex sobre <article>/<main>/<p> cubre la prensa
// financiera típica y no infla el bundle del Worker. Fuentes especiales:
//   - news.google.com: la URL del RSS es un redirect — se resuelve primero.
//   - sec.gov (Form 4): parseamos el XML de ownership y sintetizamos un
//     texto legible (quién, compró/vendió, cuántas, a qué precio) — el
//     body original era solo "4 - Company (CIK) (Issuer)".
//   - sec.gov (8-K y demás -index.htm): saltamos al documento primario.
// Todo fetch lleva AbortSignal.timeout — nada puede colgar el request.

const FETCH_TIMEOUT_MS = 12_000;
const MAX_HTML_BYTES = 1_500_000;
const MAX_TEXT_CHARS = 20_000;
const MIN_TEXT_CHARS = 300;

// UA de navegador real: muchos sites financieros devuelven 403/shell vacío
// a UAs de bot. No evadimos paywalls — si el HTML no trae el texto, se
// devuelve null y la UI manda al lector a la fuente.
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// SEC exige identificarse — mismo UA que lib/providers/sec-edgar.ts.
const SEC_UA = "Catalyst News Dashboard manubisbal19@gmail.com";

export type ExtractResult = {
  text: string;
  // Método usado — para logs/depuración de calidad.
  method: "article-html" | "sec-form4" | "sec-doc";
};

async function fetchText(
  url: string,
  headers: Record<string, string>,
): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = await res.text();
    return body.slice(0, MAX_HTML_BYTES);
  } catch {
    return null;
  }
}

function fetchHtml(url: string): Promise<string | null> {
  return fetchText(url, {
    "User-Agent": BROWSER_UA,
    Accept: "text/html,application/xhtml+xml",
    "Accept-Language": "en-US,en;q=0.9",
  });
}

function fetchSec(url: string): Promise<string | null> {
  return fetchText(url, { "User-Agent": SEC_UA, Accept: "*/*" });
}

// ---------------------------------------------------------------------------
// HTML → texto
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  copy: "©",
  reg: "®",
  trade: "™",
  dollar: "$",
  eacute: "é",
};

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      const code = parseInt(h, 16);
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
    })
    .replace(/&#(\d+);/g, (_, d) => {
      const code = parseInt(d, 10);
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
    })
    .replace(/&([a-z]+);/gi, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

// Párrafos que son chrome del site, no artículo.
const BOILERPLATE_RE =
  /\b(cookies?|subscribe|newsletter|sign\s?(in|up)|log\s?in|all rights reserved|terms of (use|service)|privacy policy|advertisement|read more:|click here|download the app|follow us)\b/i;

function removeBlocks(html: string, tag: string): string {
  return html.replace(
    new RegExp(`<${tag}[\\s>][\\s\\S]*?<\\/${tag}>`, "gi"),
    " ",
  );
}

// Extractor genérico: prioriza <article>, luego <main>, luego el body
// entero; junta los <p> con sustancia.
export function extractFromHtml(
  html: string,
  headline?: string,
): string | null {
  let doc = html;
  // SOLO bloques inequívocamente no-contenido. NO quitar form/nav/footer/
  // aside/header como bloque: los sites ASP.NET (MarketBeat) envuelven la
  // página ENTERA en un <form> y el regex lazy se comía todo el artículo.
  // El ruido de nav/footer casi nunca sobrevive el filtro por párrafo
  // (len>=60 + boilerplate).
  for (const tag of ["script", "style", "noscript", "svg", "iframe", "template"]) {
    doc = removeBlocks(doc, tag);
  }
  doc = doc.replace(/<!--[\s\S]*?-->/g, " ");

  const headlineNorm = headline?.toLowerCase().replace(/\s+/g, " ").trim();
  const collect = (scope: string): string => {
    const paras: string[] = [];
    const seen = new Set<string>();
    // \b[^>]*> consume el resto del tag de apertura — sin eso, los
    // atributos de un `<P STYLE="…">` acababan dentro del texto extraído.
    for (const m of scope.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)) {
      const t = stripTags(m[1]);
      if (t.length < 60) continue;
      if (BOILERPLATE_RE.test(t) && t.length < 200) continue;
      const norm = t.toLowerCase();
      if (seen.has(norm)) continue; // párrafos duplicados (AMP + web)
      if (headlineNorm && norm === headlineNorm) continue;
      seen.add(norm);
      paras.push(t);
      if (paras.join("\n\n").length > MAX_TEXT_CHARS) break;
    }
    return paras.join("\n\n").slice(0, MAX_TEXT_CHARS).trim();
  };

  // Scopes candidatos de más específico a más amplio. No basta con coger
  // el <article> más largo: muchos sites lo usan para cards laterales y el
  // cuerpo real vive fuera — probamos cada scope y nos quedamos con el
  // primero que produce texto suficiente.
  const articles = [...doc.matchAll(/<article[\s>][\s\S]*?<\/article>/gi)]
    .map((m) => m[0])
    .sort((a, b) => b.length - a.length);
  const main = doc.match(/<main[\s>][\s\S]*?<\/main>/i)?.[0];
  for (const scope of [articles[0], main, doc]) {
    if (!scope) continue;
    const text = collect(scope);
    if (text.length >= MIN_TEXT_CHARS) return text;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Google News: la URL del RSS es un redirect opaco
// ---------------------------------------------------------------------------

// Formato viejo (CBMi… con URL embebida): decodable offline desde el id
// base64url. Formato nuevo (el id envuelve un token AU_yqL…): la página
// shell trae una firma (data-n-a-sg + data-n-a-ts) con la que el endpoint
// interno batchexecute devuelve la URL real ("garturlres"). Es la técnica
// estándar de los decoders de Google News — sin dependencias. Si nada
// funciona, devolvemos la original (el extractor fallará limpio).
//
// CRÍTICO para nosotros: rss:marketbeat (~700 news/día) y todo gnews:*
// apuntan a news.google.com — sin este resolver no hay artículo.
async function resolveGoogleNewsUrl(url: string): Promise<string> {
  try {
    const u = new URL(url);
    if (!u.hostname.endsWith("news.google.com")) return url;
    const id = u.pathname.split("/articles/")[1]?.split("?")[0];
    if (!id) return url;

    // 1) Formato viejo: URL directamente embebida en el id.
    try {
      const b64 = id.replace(/-/g, "+").replace(/_/g, "/");
      const decoded = atob(b64);
      const m = decoded.match(/https?:\/\/[^\x00-\x20"\\]+/);
      if (m && !/google\.com/.test(m[0])) return m[0];
    } catch {
      // id no-base64 — seguimos.
    }

    // 2) Formato nuevo: firma de la página shell + batchexecute.
    const page = await fetchHtml(url);
    if (!page) return url;
    const au = page.match(/data-n-au="(https?:\/\/[^"]+)"/)?.[1];
    if (au) return decodeEntities(au);
    const sg = page.match(/data-n-a-sg="([^"]+)"/)?.[1];
    const ts = page.match(/data-n-a-ts="(\d+)"/)?.[1];
    if (sg && ts) {
      const inner = JSON.stringify([
        "garturlreq",
        [
          ["X", "X", ["en-US", "US"], null, null, 1, 1, "US:en", null, 180,
            null, null, null, null, null, 0, null, null, [1608992183, 723341000]],
          "en-US", "US", 1, [2, 3, 4, 8], 1, 0, "655000234", 0, 0, null, 0,
        ],
        id,
        Number(ts),
        sg,
      ]);
      const fReq = JSON.stringify([[["Fbv4je", inner, null, "generic"]]]);
      const res = await fetch(
        "https://news.google.com/_/DotsSplashUi/data/batchexecute",
        {
          method: "POST",
          headers: {
            "User-Agent": BROWSER_UA,
            "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
          },
          body: `f.req=${encodeURIComponent(fReq)}`,
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        },
      );
      if (res.ok) {
        const text = await res.text();
        // La respuesta escapa la URL dentro de un string JSON anidado.
        const m = text.match(/garturlres[\\"]*,[\\"]*(https?:[^"\\]+)/);
        if (m) return m[1];
      }
    }
  } catch {
    // caemos a la URL original
  }
  return url;
}

// ---------------------------------------------------------------------------
// SEC EDGAR
// ---------------------------------------------------------------------------

const FORM4_TX_CODES: Record<string, string> = {
  P: "bought (open market)",
  S: "sold (open market)",
  A: "was granted",
  M: "acquired via option exercise",
  F: "surrendered to cover taxes",
  G: "gifted",
  D: "disposed to the issuer",
  C: "converted",
  J: "transferred (other)",
  X: "exercised an option for",
};

function xmlValue(block: string, tag: string): string | null {
  // Los campos numéricos del ownership XML vienen como
  // <tag><value>x</value></tag> — el <value> debe ser HIJO DIRECTO
  // ([^<]* entre medias): con [\s\S]*? lazy el patrón cruzaba límites de
  // elemento y <rptOwnerName> capturaba el primer <value> del documento.
  const m =
    block.match(
      new RegExp(`<${tag}>\\s*<value>([^<]*)</value>`, "i"),
    ) ?? block.match(new RegExp(`<${tag}>([^<]+)</${tag}>`, "i"));
  return m ? m[1].trim() : null;
}

function fmtNum(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

// Sintetiza texto legible desde el ownership XML de un Form 4.
export function parseForm4Xml(xml: string): string | null {
  const owner = xmlValue(xml, "rptOwnerName");
  if (!owner) return null;
  const title =
    xmlValue(xml, "officerTitle") ??
    (/<isDirector>(1|true)<\/isDirector>/i.test(xml) ? "Director" : null);
  const issuer = xmlValue(xml, "issuerName");
  const symbol = xmlValue(xml, "issuerTradingSymbol");

  const lines: string[] = [];
  const txBlocks = [
    ...xml.matchAll(/<nonDerivativeTransaction>[\s\S]*?<\/nonDerivativeTransaction>/gi),
  ];
  for (const b of txBlocks.slice(0, 8)) {
    const block = b[0];
    const code = block.match(/<transactionCode>([A-Z])<\/transactionCode>/i)?.[1]?.toUpperCase();
    const shares = Number(xmlValue(block, "transactionShares") ?? NaN);
    const price = Number(xmlValue(block, "transactionPricePerShare") ?? NaN);
    const date = xmlValue(block, "transactionDate");
    const after = Number(xmlValue(block, "sharesOwnedFollowingTransaction") ?? NaN);
    if (!code || !Number.isFinite(shares)) continue;
    const verb = FORM4_TX_CODES[code] ?? `transacted (code ${code})`;
    let line = `${verb} ${fmtNum(shares)} shares`;
    if (Number.isFinite(price) && price > 0) {
      line += ` at $${fmtNum(price)} (~$${fmtNum(shares * price)})`;
    }
    if (date) line += ` on ${date}`;
    if (Number.isFinite(after)) line += `; owns ${fmtNum(after)} shares after the transaction`;
    lines.push(line + ".");
  }
  if (!lines.length) return null;

  const who = title ? `${owner} (${title})` : owner;
  const of = issuer ? ` of ${issuer}${symbol ? ` (${symbol})` : ""}` : "";
  const footnote = xmlValue(xml, "footnote");
  return [
    `SEC Form 4 — insider transaction. ${who}${of}:`,
    ...lines,
    footnote ? `Footnote: ${stripTags(footnote).slice(0, 400)}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

// Desde la página índice del filing (…-index.htm), localiza los documentos.
async function extractSecFiling(url: string): Promise<ExtractResult | null> {
  const index = await fetchSec(url);
  if (!index) return null;

  // hrefs de la tabla de documentos, resueltos contra el host.
  const hrefs = [...index.matchAll(/href="(\/Archives\/edgar\/data\/[^"]+)"/gi)]
    .map((m) => `https://www.sec.gov${m[1]}`);

  // Form 3/4/5 → ownership XML CRUDO. El índice también lista la versión
  // /xslF345X…/ (render HTML del mismo doc) — hay que excluirla o el
  // parser XML recibe HTML. Si es un ownership filing y el XML no parsea,
  // fallamos: el .htm estilizado de un Form 4 extrae basura de tablas.
  const isOwnership = hrefs.some((h) => /xslF345/i.test(h));
  const xmlUrl = hrefs.find((h) => /\.xml$/i.test(h) && !/xsl|index/i.test(h));
  if (xmlUrl) {
    const xml = await fetchSec(xmlUrl);
    if (xml) {
      const text = parseForm4Xml(xml);
      if (text) return { text, method: "sec-form4" };
    }
  }
  if (isOwnership) return null;

  // 8-K y demás → primer .htm que no sea el propio índice.
  const docUrl = hrefs.find(
    (h) => /\.html?$/i.test(h) && !/-index/i.test(h),
  );
  if (docUrl) {
    // Los viewers "/ix?doc=" son shells JS — el documento crudo está en el
    // mismo path sin el prefijo.
    const doc = await fetchSec(docUrl.replace("/ix?doc=", ""));
    if (doc) {
      const text = extractFromHtml(doc);
      if (text) return { text: text.slice(0, MAX_TEXT_CHARS), method: "sec-doc" };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function extractArticle(input: {
  url: string;
  source: string;
  headline?: string;
}): Promise<ExtractResult | null> {
  let { url } = input;
  try {
    const host = new URL(url).hostname;
    if (host.endsWith("sec.gov")) {
      return await extractSecFiling(url);
    }
    if (host.endsWith("news.google.com")) {
      url = await resolveGoogleNewsUrl(url);
      if (new URL(url).hostname.endsWith("news.google.com")) return null;
    }
  } catch {
    return null;
  }

  const html = await fetchHtml(url);
  if (!html) return null;
  const text = extractFromHtml(html, input.headline);
  return text ? { text, method: "article-html" } : null;
}
