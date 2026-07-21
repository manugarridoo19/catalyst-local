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
  method: "article-html" | "sec-form4" | "sec-doc" | "wayback";
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

/**
 * Texto de un exhibit de la SEC (comunicado de resultados, EX-99.1).
 *
 * Necesita su propio camino porque el extractor genérico devuelve VACÍO con
 * ellos: los redacta Workiva/Wdesk y el contenido va en
 * `<div><font style="…">…</font></div>`, sin un solo `<p>`, así que el filtro
 * "junta los <p> con sustancia" no encuentra nada. Verificado con AAPL, NVDA,
 * TSLA y JPM: 0 caracteres con el genérico.
 *
 * Aquí no se filtra por párrafo: se convierten los límites de bloque en
 * saltos de línea y se conserva TODO, tablas de resultados incluidas — los
 * números (ingresos, BPA, márgenes) son justo lo que el resumen necesita, y
 * en un documento registrado ante el regulador no hay chrome que quitar.
 */
export function extractSecExhibitText(
  html: string,
  maxChars = 14_000,
): string | null {
  let doc = html;

  // 0. Un exhibit puede ser un binario (la SEC admite PDFs como 99.1). Los
  // regex de abajo convertirían los bytes en pseudo-texto >200 chars y el
  // LLM resumiría basura con números inventados-verosímiles: mejor null.
  if (doc.startsWith("%PDF") || doc.slice(0, 2000).includes("%PDF-")) {
    return null;
  }

  // 1. Sobre SGML de EDGAR: el documento real va dentro de <TEXT>.
  const start = doc.search(/<TEXT>/i);
  if (start >= 0) doc = doc.slice(start + "<TEXT>".length);
  const end = doc.search(/<\/TEXT>/i);
  if (end >= 0) doc = doc.slice(0, end);

  for (const tag of ["script", "style", "noscript", "head", "svg", "iframe"]) {
    doc = removeBlocks(doc, tag);
  }
  doc = doc.replace(/<!--[\s\S]*?-->/g, " ");

  // 2. Los límites de bloque son la ÚNICA pista de estructura que queda:
  // sin esto todo el comunicado colapsa en una línea ilegible.
  doc = doc
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(div|p|tr|h[1-6]|li|table)\s*>/gi, "\n")
    .replace(/<\/(td|th)\s*>/gi, " ");

  const lines = decodeEntities(doc.replace(/<[^>]*>/g, ""))
    .split("\n")
    .map((l) => l.replace(/[\s ]+/g, " ").trim())
    .filter(Boolean);

  const text = lines.join("\n").slice(0, maxChars);
  return text.length >= 200 ? text : null;
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

// Parseo ESTRUCTURADO del ownership XML — la fuente de verdad tanto del
// texto legible (parseForm4Xml) como de las filas de insider_trades.
export type Form4Transaction = {
  code: string; // P S A M F G D C J X
  shares: number;
  price: number | null; // null en grants sin precio
  value: number | null; // shares × price
  date: string | null; // yyyy-mm-dd
  sharesAfter: number | null;
};

export type Form4Parsed = {
  ownerName: string;
  ownerTitle: string | null;
  isDirector: boolean;
  isOfficer: boolean;
  isTenPercent: boolean;
  issuerName: string | null;
  symbol: string | null;
  footnote: string | null;
  transactions: Form4Transaction[];
};

export function parseForm4Structured(xml: string): Form4Parsed | null {
  const ownerName = xmlValue(xml, "rptOwnerName");
  if (!ownerName) return null;
  const flag = (tag: string) =>
    new RegExp(`<${tag}>\\s*(1|true)\\s*</${tag}>`, "i").test(xml);

  const transactions: Form4Transaction[] = [];
  const txBlocks = [
    ...xml.matchAll(/<nonDerivativeTransaction>[\s\S]*?<\/nonDerivativeTransaction>/gi),
  ];
  for (const b of txBlocks.slice(0, 8)) {
    const block = b[0];
    const code = block.match(/<transactionCode>([A-Z])<\/transactionCode>/i)?.[1]?.toUpperCase();
    const shares = Number(xmlValue(block, "transactionShares") ?? NaN);
    if (!code || !Number.isFinite(shares)) continue;
    const priceRaw = Number(xmlValue(block, "transactionPricePerShare") ?? NaN);
    const price = Number.isFinite(priceRaw) && priceRaw > 0 ? priceRaw : null;
    const afterRaw = Number(xmlValue(block, "sharesOwnedFollowingTransaction") ?? NaN);
    transactions.push({
      code,
      shares,
      price,
      value: price !== null ? shares * price : null,
      date: xmlValue(block, "transactionDate"),
      sharesAfter: Number.isFinite(afterRaw) ? afterRaw : null,
    });
  }

  return {
    ownerName,
    ownerTitle:
      xmlValue(xml, "officerTitle") ?? (flag("isDirector") ? "Director" : null),
    isDirector: flag("isDirector"),
    isOfficer: flag("isOfficer"),
    isTenPercent: flag("isTenPercentOwner"),
    issuerName: xmlValue(xml, "issuerName"),
    symbol: xmlValue(xml, "issuerTradingSymbol"),
    footnote: xmlValue(xml, "footnote"),
    transactions,
  };
}

// Sintetiza texto legible desde el ownership XML de un Form 4.
export function parseForm4Xml(xml: string): string | null {
  const p = parseForm4Structured(xml);
  if (!p || !p.transactions.length) return null;

  const lines = p.transactions.map((t) => {
    const verb = FORM4_TX_CODES[t.code] ?? `transacted (code ${t.code})`;
    let line = `${verb} ${fmtNum(t.shares)} shares`;
    if (t.price !== null) {
      line += ` at $${fmtNum(t.price)} (~$${fmtNum(t.shares * t.price)})`;
    }
    if (t.date) line += ` on ${t.date}`;
    if (t.sharesAfter !== null) {
      line += `; owns ${fmtNum(t.sharesAfter)} shares after the transaction`;
    }
    return line + ".";
  });

  const who = p.ownerTitle ? `${p.ownerName} (${p.ownerTitle})` : p.ownerName;
  const of = p.issuerName
    ? ` of ${p.issuerName}${p.symbol ? ` (${p.symbol})` : ""}`
    : "";
  return [
    `SEC Form 4 — insider transaction. ${who}${of}:`,
    ...lines,
    p.footnote ? `Footnote: ${stripTags(p.footnote).slice(0, 400)}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

// hrefs de la tabla de documentos de un -index.htm, resueltos contra el host.
function secDocLinks(index: string): string[] {
  return [...index.matchAll(/href="(\/Archives\/edgar\/data\/[^"]+)"/gi)].map(
    (m) => `https://www.sec.gov${m[1]}`,
  );
}

// Fetch + parseo estructurado del ownership XML de un Form 4 desde su
// -index.htm. Lo usa la ingesta insider del cron (Node) — 2 requests SEC.
export async function fetchForm4Structured(
  indexUrl: string,
): Promise<Form4Parsed | null> {
  const index = await fetchSec(indexUrl);
  if (!index) return null;
  const xmlUrl = secDocLinks(index).find(
    (h) => /\.xml$/i.test(h) && !/xsl|index/i.test(h),
  );
  if (!xmlUrl) return null;
  const xml = await fetchSec(xmlUrl);
  return xml ? parseForm4Structured(xml) : null;
}

// Cover de un Schedule 13D/13G: quién declara la participación y qué % del
// float. Desde dic-2024 la SEC exige XML estructurado para 13D/G, así que
// primero probamos el XML del filing; si no está (filings viejos/raros),
// regex best-effort sobre el cover page HTML. Ambos campos son nullable —
// la fila vale aunque solo sepamos "hay stake nueva en X".
export type StakeCover = {
  filerName: string | null;
  percentOfClass: number | null;
};

function stakeFromXml(xml: string): StakeCover | null {
  // Tags observados en el XML real de SCHEDULE 13D/G (2026):
  // <filingPersonName> + <classPercent>. Los alternativos cubren variantes.
  // Ambos campos pueden traer texto libre (classPercent: "(1) Fondo X:
  // 4.90%..."; filingPersonName: párrafos legales enteros) — un nombre
  // válido debe caber en 80 chars tras colapsar espacios; si no, se
  // descarta ese candidato.
  const nameCandidates = [
    xmlValue(xml, "filingPersonName"),
    xmlValue(xml, "reportingPersonName"),
    xmlValue(xml, "rptOwnerName"),
    xmlValue(xml, "filingManagerName"),
  ];
  let filerName: string | null = null;
  for (const c of nameCandidates) {
    const clean = c?.replace(/\s+/g, " ").trim() ?? "";
    if (clean.length >= 2 && clean.length <= 80) {
      filerName = clean;
      break;
    }
  }
  const pctRaw = Number(
    xmlValue(xml, "classPercent") ??
      xmlValue(xml, "percentOfClass") ??
      xmlValue(xml, "percentageOfClass") ??
      NaN,
  );
  const percentOfClass =
    Number.isFinite(pctRaw) && pctRaw > 0 && pctRaw <= 100 ? pctRaw : null;
  if (!filerName && percentOfClass === null) return null;
  return { filerName, percentOfClass };
}

function stakeFromCoverHtml(doc: string): StakeCover {
  const text = stripTags(doc).slice(0, 60_000);
  // "1 NAMES OF REPORTING PERSONS Elliott Investment Management L.P. 2
  // CHECK THE APPROPRIATE BOX…" — capturamos hasta el siguiente rótulo de
  // fila del cover. Formatos muy variados entre filers → lazy + tolerante.
  const nameM = text.match(
    /NAMES? OF REPORTING PERSONS?(?:\s*\([^)]{0,60}\))?\s*[.:]?\s*(.{2,90}?)\s*(?:\d\s*)?(?:CHECK THE APPROPRIATE|I\.?R\.?S\.? IDENTIFICATION)/i,
  );
  const pctM = text.match(/PERCENT OF CLASS[^%]{0,200}?([\d.]{1,6})\s*%/i);
  const pct = pctM ? Number(pctM[1]) : NaN;
  return {
    filerName: nameM ? nameM[1].trim().replace(/\s{2,}/g, " ") : null,
    percentOfClass: Number.isFinite(pct) && pct > 0 && pct <= 100 ? pct : null,
  };
}

export async function fetchStakeCover(
  indexUrl: string,
): Promise<StakeCover | null> {
  const index = await fetchSec(indexUrl);
  if (!index) return null;
  const hrefs = secDocLinks(index);

  const xmlUrl = hrefs.find((h) => /\.xml$/i.test(h) && !/xsl|index/i.test(h));
  if (xmlUrl) {
    const xml = await fetchSec(xmlUrl);
    if (xml) {
      const fromXml = stakeFromXml(xml);
      if (fromXml) return fromXml;
    }
  }

  const docUrl = hrefs.find((h) => /\.html?$/i.test(h) && !/-index/i.test(h));
  if (!docUrl) return null;
  const doc = await fetchSec(docUrl.replace("/ix?doc=", ""));
  return doc ? stakeFromCoverHtml(doc) : null;
}

// Desde la página índice del filing (…-index.htm), localiza los documentos.
async function extractSecFiling(url: string): Promise<ExtractResult | null> {
  const index = await fetchSec(url);
  if (!index) return null;

  const hrefs = secDocLinks(index);

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

// Fallback vía Wayback Machine (archive.org). Legítimo y con API pública:
// si el artículo tiene un snapshot archivado, extraemos de ahí. Cubre las
// fuentes que nos bloquean con 403 (seekingalpha, investing.com, tipranks
// — marcadas "sin solución" incluso por la extensión Bypass Paywalls) y
// cualquier página caída. Límite real: los snapshots tardan en existir, así
// que rinde en items de horas, no en los recién publicados. `id_` sirve el
// HTML original sin el chrome de la toolbar de archive.org.
async function extractFromWayback(
  url: string,
  headline?: string,
): Promise<ExtractResult | null> {
  try {
    const api = `https://archive.org/wayback/available?url=${encodeURIComponent(url)}`;
    const res = await fetch(api, {
      headers: { "User-Agent": BROWSER_UA, Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      archived_snapshots?: { closest?: { available?: boolean; url?: string } };
    };
    const snap = data.archived_snapshots?.closest;
    if (!snap?.available || !snap.url) return null;
    // /<ts>id_/ = versión raw del snapshot (sin banner de archive.org).
    const rawUrl = snap.url.replace(/\/(\d{14})\//, "/$1id_/");
    const html = await fetchHtml(rawUrl);
    if (!html) return null;
    const text = extractFromHtml(html, headline);
    return text ? { text, method: "wayback" } : null;
  } catch {
    return null;
  }
}

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
  if (html) {
    const text = extractFromHtml(html, input.headline);
    if (text) return { text, method: "article-html" };
  }

  // Directo falló (403/paywall/página vacía) → probamos el archivo.
  return extractFromWayback(url, input.headline);
}
