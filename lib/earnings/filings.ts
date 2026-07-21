// Localiza el comunicado de resultados de una empresa en EDGAR — Fase 3.
//
// Es el FALLBACK PRE-COMPROMETIDO del design doc para los transcripts: los
// transcripts de terceros tienen copyright y scrapear Motley Fool está
// PROHIBIDO por la premisa 4, así que la fuente es el press release que la
// propia empresa registra en la SEC. Gratis, estable y autoritativo.
//
// La detección NO adivina por fechas: EDGAR expone los ÍTEMS del 8-K y el
// **ítem 2.02 es literalmente "Results of Operations and Financial
// Condition"**, o sea el 8-K de resultados y ninguno más (verificado con
// Apple: sus dos 8-K de resultados traen items "2.02,9.01", mientras que los
// de cambios en el consejo traen "5.02" y los de junta "5.07").
//
// Dentro del filing, el comunicado es el **exhibit 99.1**, que se identifica
// por el TIPO en el índice del filing (~10 kB), nunca por el nombre del
// fichero: cada empresa lo llama de una forma
// (`a8-kex991q2202603282026.htm`...).

import { getCikForSymbol, SEC_USER_AGENT } from "@/lib/providers/sec-edgar";

const SUBMISSIONS = "https://data.sec.gov/submissions";
const ARCHIVES = "https://www.sec.gov/Archives/edgar/data";
const TIMEOUT_MS = 15_000;
/** Ítem del 8-K que identifica un comunicado de resultados. */
const EARNINGS_ITEM = "2.02";

export type EarningsFiling = {
  symbol: string;
  cik: string;
  accession: string;
  filingDate: string;
  reportDate: string | null;
  /** URL del exhibit 99.1 (el comunicado). */
  exhibitUrl: string;
};

async function getText(url: string): Promise<string | null> {
  const res = await fetch(url, {
    headers: { "User-Agent": SEC_USER_AGENT },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) return null;
  return res.text();
}

/**
 * Último 8-K de resultados (ítem 2.02) del símbolo dentro de la ventana.
 * Devuelve null si no hay ninguno o si el filing no trae exhibit 99.1
 * (algunas empresas meten el comunicado en el propio cuerpo del 8-K).
 */
export async function findLatestEarningsFiling(
  symbol: string,
  withinDays = 14,
): Promise<EarningsFiling | null> {
  const cik = await getCikForSymbol(symbol);
  if (!cik) return null;

  const body = await getText(`${SUBMISSIONS}/CIK${cik}.json`);
  if (!body) return null;
  let recent: Record<string, unknown[]>;
  try {
    const parsed = JSON.parse(body) as {
      filings?: { recent?: Record<string, unknown[]> };
    };
    recent = parsed.filings?.recent ?? {};
  } catch {
    return null;
  }

  const forms = (recent.form ?? []) as string[];
  const items = (recent.items ?? []) as string[];
  const accs = (recent.accessionNumber ?? []) as string[];
  const dates = (recent.filingDate ?? []) as string[];
  const reports = (recent.reportDate ?? []) as string[];
  const cutoff = new Date(Date.now() - withinDays * 86_400_000);

  for (let i = 0; i < forms.length; i++) {
    // Solo "8-K" exacto, A PROPÓSITO sin "8-K/A": una enmienda del mismo
    // trimestre chocaría con la ventana anti-duplicado de
    // earningsReportExists (60d) y, si se la saltara, pisaría el resumen
    // bueno. Soportar correcciones exige tratar el 8-K/A como reemplazo
    // explícito — está en el backlog, no se añade "gratis" aquí.
    if (forms[i] !== "8-K") continue;
    // Coincidencia por ítem EXACTO: `items` es una lista separada por comas
    // ("2.02,9.01"). Un `includes("2.02")` casaría también con un hipotético
    // "12.02"; el split evita el falso positivo.
    const itemList = (items[i] ?? "").split(",").map((s) => s.trim());
    if (!itemList.includes(EARNINGS_ITEM)) continue;
    if (!dates[i] || new Date(`${dates[i]}T00:00:00Z`) < cutoff) break; // ya fuera de ventana (van en orden DESC)

    const accession = accs[i];
    const accNoDashes = accession.replace(/-/g, "");
    const cikNum = String(Number(cik)); // las rutas de Archives usan el CIK SIN ceros
    const indexUrl = `${ARCHIVES}/${cikNum}/${accNoDashes}/${accession}-index.html`;
    const index = await getText(indexUrl);
    if (!index) continue;

    const exhibitUrl = findExhibit991(index);
    if (!exhibitUrl) continue;

    return {
      symbol: symbol.toUpperCase(),
      cik,
      accession,
      filingDate: dates[i],
      reportDate: reports[i] || null,
      exhibitUrl: exhibitUrl.startsWith("http")
        ? exhibitUrl
        : `https://www.sec.gov${exhibitUrl}`,
    };
  }
  return null;
}

/**
 * Saca el href del documento cuyo TIPO es EX-99.1 en la tabla del índice.
 * Se busca por tipo y no por nombre de fichero porque el nombre lo elige
 * cada empresa. La fila tiene la forma
 * `<td>…<a href="/Archives/…">doc.htm</a></td>…<td scope="row">EX-99.1</td>`,
 * así que se localiza la celda del tipo y se retrocede al href de esa fila.
 */
export function findExhibit991(indexHtml: string): string | null {
  const rows = indexHtml.split(/<tr[^>]*>/i);
  for (const row of rows) {
    if (!/>\s*EX-99\.1\s*</i.test(row)) continue;
    const href = row.match(/href="([^"]+)"/i)?.[1];
    if (href) return href;
  }
  return null;
}
