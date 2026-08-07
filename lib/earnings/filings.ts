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
//
// ── EMISORES EXTRANJEROS (2026-08-07) ────────────────────────────────────
//
// Todo lo de arriba describe a un emisor DOMÉSTICO, y hasta hoy era lo único
// que este módulo sabía leer. Un *foreign private issuer* no presenta 8-K:
// presenta **6-K**. Nu Holdings (CIK 1691493) tiene **0 filings 8-K y 159
// 6-K** — verificado contra EDGAR —, así que su comunicado de resultados era
// invisible para todo el sistema y `/ask` respondía a "¿cómo se espera que
// salga el trimestre?" sin haber leído nunca uno. No es una posición: son 34
// de los 390 símbolos más cubiertos (ASML, TSM, ARM, BABA, NVO, SPOT…).
//
// Los DOS asideros del 8-K desaparecen a la vez, y por eso el arreglo no es
// añadir "6-K" al filtro:
//
//  1. **Un 6-K no declara ítems.** No hay "2.02" ni equivalente: el
//     formulario es un sobre para "lo que el emisor publica en su país".
//  2. **No hay exhibit 99.1.** Medido sobre los cuatro 6-K del 2026-05-14 de
//     NU: sus índices sólo contienen el documento `6-K` y ficheros GRAPHIC.
//     El comunicado ES el documento primario. Un fix "6-K + EX-99.1" habría
//     devuelto null exactamente igual que el código viejo.
//
// Lo que sí funciona son dos filtros encadenados, ambos medidos:
//
//  A. **`reportDate` anterior a `filingDate`** = el periodo ya está cerrado,
//     o sea que el filing informa SOBRE un trimestre. Los 6-K rutinarios
//     llevan el trimestre EN CURSO (futuro). Sobre los 159 de NU separa 66
//     candidatos que caen exactamente en las cinco fechas trimestrales de
//     resultados, y deja fuera los 93 restantes.
//  B. **Un selector por CONTENIDO entre los del mismo día**, porque el
//     emisor presenta 3-4 a la vez y el orden natural de EDGAR devuelve el
//     que NO es. El 2026-05-14 de NU: `_6k1` es el informe de aseguramiento
//     de KPMG, `_6k` la presentación de resultados, `nufs1q26_6k` los estados
//     financieros (1,4 MB) y `_6k2` —el segundo del array— el comunicado.
//
// El extractor (`extractSecExhibitText`) sirve tal cual para estos
// documentos: no hubo que tocarlo.

import { getCikForSymbol, SEC_USER_AGENT } from "@/lib/providers/sec-edgar";
import { extractSecExhibitText } from "@/lib/articles/extract";

const SUBMISSIONS = "https://data.sec.gov/submissions";
const ARCHIVES = "https://www.sec.gov/Archives/edgar/data";
const TIMEOUT_MS = 15_000;
/** Ítem del 8-K que identifica un comunicado de resultados. */
const EARNINGS_ITEM = "2.02";

/** Cuántos 6-K de un mismo periodo se abren buscando el comunicado. El
 *  emisor presenta 3-4 a la vez y el bueno estaba el segundo; 6 da margen
 *  sin convertir un barrido trimestral en una descarga masiva. */
const SIX_K_MAX_CANDIDATES = 6;

/** Techo de descarga de un candidato 6-K. Los estados financieros de NU son
 *  1,4 MB de los que el extractor tira el 90%: no se bajan para descartarlos
 *  después. El comunicado real ocupa ~32 kB. */
const SIX_K_MAX_BYTES = 500_000;

/** Por debajo de esto, el documento primario de un 6-K es la PORTADA que
 *  remite a sus exhibits, no el comunicado. Ver `pickSixKDocument`. */
const WRAPPER_MAX_CHARS = 6_000;

export type EarningsFiling = {
  symbol: string;
  cik: string;
  accession: string;
  filingDate: string;
  reportDate: string | null;
  /** URL del documento con el comunicado: el exhibit 99.1 en un 8-K, el
   *  documento PRIMARIO en un 6-K (un 6-K no lleva exhibits). */
  exhibitUrl: string;
  /** Qué formulario lo trajo. Viaja para que quien lo cite pueda decir la
   *  verdad sobre su procedencia en vez de rotular todo como "8-K". */
  form: "8-K" | "6-K";
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
  const primaryDocs = (recent.primaryDocument ?? []) as string[];
  const cutoff = new Date(Date.now() - withinDays * 86_400_000);
  const cikNumStr = String(Number(cik));

  // ── Emisor EXTRANJERO ────────────────────────────────────────────────
  // Si no presenta 8-K en absoluto, no tiene sentido recorrer el array
  // buscando uno. El régimen se deduce del propio JSON que ya está
  // descargado: cero peticiones extra.
  if (!forms.includes("8-K") && forms.includes("6-K")) {
    return findLatestSixKEarnings({
      symbol,
      cik,
      cikNumStr,
      forms,
      accs,
      dates,
      reports,
      primaryDocs,
      cutoff,
    });
  }

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
    const indexUrl = `${ARCHIVES}/${cikNumStr}/${accNoDashes}/${accession}-index.html`;
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
      form: "8-K",
    };
  }
  return null;
}

/**
 * El comunicado suena a comunicado, y hay que reconocerlo por el texto porque
 * el 6-K no trae ninguna etiqueta que lo diga.
 *
 * Es DELIBERADAMENTE exigente: la frase de titular de un comunicado de
 * resultados ("Reports First Quarter 2026 Financial Results", "Announces
 * Fourth Quarter and Full Year Results"). Un falso positivo aquí no es un
 * hueco vacío — es pagar una llamada al LLM para que resuma el informe de
 * auditoría, guardarlo como si fuera el trimestre y que `earningsReportExists`
 * bloquee el bueno durante 60 días.
 */
export function looksLikeEarningsRelease(text: string): boolean {
  const t = text.slice(0, 6000).replace(/\s+/g, " ");
  // Verbo de publicación + PERIODO, en una misma frase. La proximidad es lo
  // que separa "Reports First Quarter 2026 Financial Results" de una nota que
  // mencione "first quarter" de pasada tres párrafos más abajo.
  // `.{0,90}` y NO `[^.]{0,90}`: la clase negada excluye el PUNTO, y el
  // titular real de ASML es "ASML reports €9.3 billion total net sales …in Q2
  // 2026" — el decimal de "9.3" cortaba la coincidencia. El texto llega ya
  // normalizado a espacios simples, así que `.` no puede cruzar líneas, y la
  // magnitud de abajo acota la vecindad.
  const verbPeriod =
    /\b(reports?|reported|announces?|announced|posts?|releases?|released|publishes?|published)\b.{0,90}?\b(first|second|third|fourth|1st|2nd|3rd|4th|q[1-4]|[1-4]q|half[-\s]year|full[-\s]?year|fiscal|annual)\b/i;
  // Y una MAGNITUD financiera cerca. Sin esto, "announces its Annual General
  // Meeting" entraría. Con sólo "results|earnings" NO bastaba: los titulares
  // reales de dos de los tres emisores medidos no llevan ninguna de las dos
  // palabras — "ASML reports €9.3 billion total net sales and €2.9 billion
  // net income in Q2 2026" y "TSMC Reports Second Quarter EPS of NT$27.25".
  const magnitude =
    /\b(results|earnings|net\s+sales|net\s+revenue|revenues?|net\s+income|net\s+profit|net\s+loss|operating\s+income|eps|earnings\s+per\s+share|financial\s+statements)\b/i;
  if (!verbPeriod.test(t)) return false;
  // La magnitud se busca en la MISMA vecindad que el verbo, no en todo el
  // documento: cualquier filing financiero nombra "revenue" en alguna parte.
  const m = t.match(verbPeriod);
  if (!m || m.index === undefined) return false;
  return magnitude.test(t.slice(m.index, m.index + 260));
}

// NO HAY LISTA DE EXCLUSIÓN, y la hubo durante media hora.
//
// La idea era descartar a los compañeros del comunicado por lo que dicen
// ("independent assurance report", "earnings presentation", "unaudited
// interim condensed consolidated statements"). Medida contra los cuatro
// documentos reales, excluía LOS CUATRO — incluido el bueno. Motivo: el
// comunicado es precisamente el documento que HABLA de los otros ("The
// financial statements and earnings presentation are available on the
// Company's Investor Relations website"). Excluir por subcadena en cualquier
// parte del texto elimina justo al que menciona a sus hermanos.
//
// Y no hacía falta: medido sobre los 26 6-K más recientes de NU, el detector
// positivo de arriba acierta 4 de 4 trimestres con **0 falsos positivos** —
// ni la convocatoria de junta, ni la elección de consejeros, ni las notas al
// mercado, ni el nombramiento del nuevo directivo. Añadir una red que no
// atrapa nada y sí tira lo bueno es peor que no tenerla.

/**
 * El comunicado de un emisor extranjero: 6-K de un periodo ya cerrado cuyo
 * documento primario se lee como un comunicado de resultados.
 *
 * El filtro por `reportDate` va primero porque es GRATIS (ya está en el JSON
 * descargado) y quita el 60% de los 6-K sin abrir ninguno. Sólo los que lo
 * pasan se descargan, y como mucho `SIX_K_MAX_CANDIDATES`.
 */
async function findLatestSixKEarnings(a: {
  symbol: string;
  cik: string;
  cikNumStr: string;
  forms: string[];
  accs: string[];
  dates: string[];
  reports: string[];
  primaryDocs: string[];
  cutoff: Date;
}): Promise<EarningsFiling | null> {
  const candidates: Array<{ i: number; filingDate: string; reportDate: string }> = [];
  for (let i = 0; i < a.forms.length; i++) {
    if (a.forms[i] !== "6-K") continue;
    const filingDate = a.dates[i];
    const reportDate = a.reports[i];
    if (!filingDate) continue;
    // El array viene en orden DESC, así que en cuanto uno cae fuera de la
    // ventana los siguientes también.
    if (new Date(`${filingDate}T00:00:00Z`) < a.cutoff) break;
    // EL FILTRO. `reportDate` posterior o igual a la fecha de presentación =
    // el periodo sigue abierto: es un 6-K rutinario (un hecho relevante, una
    // convocatoria), no el informe de un trimestre.
    if (!reportDate || reportDate >= filingDate) continue;
    if (!a.primaryDocs[i]) continue;
    candidates.push({ i, filingDate, reportDate });
    if (candidates.length >= SIX_K_MAX_CANDIDATES) break;
  }

  for (const c of candidates) {
    const accession = a.accs[c.i];
    const base = `${ARCHIVES}/${a.cikNumStr}/${accession.replace(/-/g, "")}`;
    const found = await pickSixKDocument(base, accession, a.primaryDocs[c.i]);
    if (!found) continue;
    return {
      symbol: a.symbol.toUpperCase(),
      cik: a.cik,
      accession,
      filingDate: c.filingDate,
      reportDate: c.reportDate,
      exhibitUrl: found,
      form: "6-K",
    };
  }
  // Que un emisor extranjero no dé comunicado se DICE. Antes de hoy este
  // caso no existía como concepto —el símbolo simplemente no aparecía nunca
  // en `earnings_reports`— y esa ausencia era indistinguible de "todavía no
  // ha reportado". Con candidatos de periodo cerrado y ninguno reconocido, lo
  // que hay es un emisor que coloca su comunicado de otra forma: medido, ARM,
  // SPOT y NVO presentan primero los estados financieros y su release vive en
  // otra accession o en otro sitio. Es una cola larga por emisor, no un bug.
  if (candidates.length) {
    console.warn(
      `[earnings] ${a.symbol}: ${candidates.length} 6-K de periodo cerrado y ninguno se lee como comunicado — emisor extranjero con otra convención`,
    );
  }
  return null;
}

/**
 * Dónde vive el comunicado dentro de un 6-K. Hay DOS convenciones y ambas
 * están medidas contra filings reales (2026-08-07):
 *
 *  - **En el documento primario** (Nu Holdings). Su 6-K no lleva exhibits:
 *    el índice sólo tiene el documento `6-K` y ficheros GRAPHIC.
 *  - **En el exhibit 99.1** (ASML, TSMC). Ahí el primario son dos páginas de
 *    portada que dicen "EXHIBITS 99.1 … ARE INCORPORATED BY REFERENCE" y el
 *    comunicado está aparte.
 *
 * Se prueba el primario PRIMERO porque es el caso que resuelve con UNA
 * petición; el índice y el exhibit sólo se piden cuando el primario no se lee
 * como un comunicado. Al revés serían 2 peticiones siempre.
 */
async function pickSixKDocument(
  base: string,
  accession: string,
  primaryDoc: string,
): Promise<string | null> {
  const primaryUrl = `${base}/${primaryDoc}`;
  const primaryHtml = await getBoundedText(primaryUrl, SIX_K_MAX_BYTES);
  const primaryText = primaryHtml ? extractSecExhibitText(primaryHtml, 24_000) : null;
  const primaryIsRelease = Boolean(primaryText && looksLikeEarningsRelease(primaryText));
  // Un primario que CASA pero es corto es una PORTADA, no el comunicado. La
  // portada del 6-K de ASML lista los títulos de sus propios exhibits ("99.1
  // Press release ASML reports €9.3 billion…"), así que satisface al detector
  // sin contener una sola cifra del trimestre. Medido: portada de ASML 2.213
  // chars y de TSMC 1.571, contra 20.697 del comunicado real de NU.
  if (primaryIsRelease && primaryText!.length >= WRAPPER_MAX_CHARS) return primaryUrl;

  const index = await getText(`${base}/${accession}-index.html`);
  const href = index ? findExhibit991(index) : null;
  if (href) {
    const exhibitUrl = href.startsWith("http") ? href : `https://www.sec.gov${href}`;
    const exhibitHtml = await getBoundedText(exhibitUrl, SIX_K_MAX_BYTES);
    const exhibitText = exhibitHtml ? extractSecExhibitText(exhibitHtml, 24_000) : null;
    // Al exhibit NO se le exige longitud: el comunicado de TSMC son 3.817
    // chars y es el documento correcto. La longitud sólo sirve para detectar
    // que el PRIMARIO era un envoltorio.
    if (exhibitText && looksLikeEarningsRelease(exhibitText)) return exhibitUrl;
  }

  // Sin exhibit utilizable, un primario que casaba aunque fuera corto es
  // mejor que nada: hay emisores con comunicados escuetos.
  return primaryIsRelease ? primaryUrl : null;
}

/**
 * Descarga con techo de tamaño. Existe porque entre los candidatos de un
 * emisor extranjero están sus estados financieros completos —1,4 MB en el Q1
 * de NU y 2,2 MB en el Q4—, de los que el extractor tiraría el 98% para
 * acabar descartándolos.
 *
 * ⚠️ El techo se aplica al HTML YA DESCOMPRIMIDO y NO a `Content-Length`.
 * Medido el 2026-08-07: la SEC sirve gzip y declara el tamaño COMPRIMIDO, así
 * que el documento de 1.473.347 bytes anuncia `content-length: 100530`.
 * Filtrar por la cabecera dejaba pasar un fichero treinta veces mayor que el
 * techo, y la comprobación parecía estar funcionando.
 *
 * Coste asumido: el cuerpo comprimido sí se descarga (~100-200 kB) antes de
 * poder medirlo. Es una vez por trimestre y símbolo extranjero.
 */
async function getBoundedText(url: string, maxBytes: number): Promise<string | null> {
  const res = await fetch(url, {
    headers: { "User-Agent": SEC_USER_AGENT },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const body = await res.text();
  return body.length > maxBytes ? null : body;
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
