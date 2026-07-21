// Localiza y parsea el information table de un 13F-HR — Fase 3.
//
// ⚠️ Mismo gotcha que los Form 4: el índice del filing lista el information
// table DOS veces, una bajo `xslForm13F_X02/` (render HTML para el navegador)
// y otra cruda. Hay que coger la CRUDA; la otra devuelve HTML y el parser no
// encuentra un solo `<infoTable>`.

import { SEC_USER_AGENT } from "@/lib/providers/sec-edgar";

const SUBMISSIONS = "https://data.sec.gov/submissions";
const ARCHIVES = "https://www.sec.gov/Archives/edgar/data";
const TIMEOUT_MS = 25_000;

export type Fund = { cik: string; name: string };

/**
 * Fondos curados. CIKs VERIFICADOS uno a uno contra la API de submissions el
 * 2026-07-21 (no fiarse de la memoria: dos de los que di por buenos estaban
 * mal — el CIK "Duquesne" 1008925 es el hedge fund cerrado en 2011, y el
 * bueno es el family office 1536411).
 *
 * Greenlight (Einhorn) queda FUERA a propósito: su último 13F es de
 * 2024-02-14 y es el único Greenlight que EDGAR indexa. Scion (Burry) se
 * queda pese a llevar desde 2025-11 sin declarar — si vuelve, lo cogemos.
 *
 * FUERA TAMBIÉN los cuantitativos y creadores de mercado (Renaissance,
 * Bridgewater, Citadel, Millennium). No es un juicio sobre su calidad: su 13F
 * no expresa convicción. Medido al cargarlos: **Renaissance declara 6.398
 * posiciones y Bridgewater 2.033**, así que cada trimestre "abrirían"
 * cientos de posiciones por puro rebalanceo estadístico. Como el registro del
 * Lab no se reescribe nunca, esas aperturas ahogarían la señal para siempre.
 * El criterio de la lista es: gestoras discrecionales cuya cartera concentrada
 * sí es una declaración de intenciones.
 */
export const CURATED_FUNDS: Fund[] = [
  { cik: "0001067983", name: "Berkshire Hathaway" },
  { cik: "0001336528", name: "Pershing Square" },
  { cik: "0001167483", name: "Tiger Global" },
  { cik: "0001061768", name: "Baupost Group" },
  { cik: "0001656456", name: "Appaloosa" },
  { cik: "0001040273", name: "Third Point" },
  { cik: "0001536411", name: "Duquesne Family Office" },
  { cik: "0001135730", name: "Coatue Management" },
  { cik: "0001061165", name: "Lone Pine Capital" },
  { cik: "0001103804", name: "Viking Global" },
  { cik: "0001029160", name: "Soros Fund Management" },
  { cik: "0000921669", name: "Icahn Carl C" },
  { cik: "0001791786", name: "Elliott Investment Management" },
  { cik: "0001697748", name: "ARK Investment Management" },
  { cik: "0001649339", name: "Scion Asset Management" },
];

/** CIKs que estuvieron en la lista y se retiraron: la ingesta los purga para
 *  que no queden datos huérfanos falseando las consultas de coincidencia. */
export const RETIRED_FUND_CIKS = [
  "0001350694", // Bridgewater — 2.033 posiciones
  "0001037389", // Renaissance — 6.398 posiciones
  "0001423053", // Citadel (creador de mercado)
  "0001273087", // Millennium (multiestrategia)
];

export type Holding = {
  cusip: string;
  issuerName: string;
  value: number;
  shares: number | null;
};

export type FundFiling = {
  cik: string;
  accession: string;
  periodOfReport: string;
  filingDate: string;
  holdings: Holding[];
};

async function getText(url: string): Promise<string | null> {
  const res = await fetch(url, {
    headers: { "User-Agent": SEC_USER_AGENT },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return res.ok ? res.text() : null;
}

function tag(xml: string, name: string): string | null {
  // Los 13F vienen con y sin prefijo de namespace (`<ns1:cusip>`).
  const m = xml.match(new RegExp(`<(?:\\w+:)?${name}>([\\s\\S]*?)</(?:\\w+:)?${name}>`, "i"));
  return m ? m[1].trim() : null;
}

/** Parsea el XML del information table. Sólo posiciones en ACCIONES (SH):
 *  las PRN son deuda y no tienen ticker que casar. */
export function parseInfoTable(xml: string): Holding[] {
  const blocks = xml.match(/<(?:\w+:)?infoTable>[\s\S]*?<\/(?:\w+:)?infoTable>/gi) ?? [];
  const out: Holding[] = [];
  for (const b of blocks) {
    const cusip = tag(b, "cusip")?.toUpperCase();
    const issuerName = tag(b, "nameOfIssuer");
    const value = Number(tag(b, "value") ?? "");
    if (!cusip || !issuerName || !Number.isFinite(value)) continue;
    const type = tag(b, "sshPrnamtType");
    if (type && type.toUpperCase() !== "SH") continue;
    const sharesRaw = Number(tag(b, "sshPrnamt") ?? "");
    out.push({
      cusip,
      issuerName: issuerName.slice(0, 120),
      value,
      shares: Number.isFinite(sharesRaw) ? sharesRaw : null,
    });
  }
  return out;
}

/** Los N 13F-HR más recientes del fondo, ya parseados. */
export async function fetchFundFilings(
  cik: string,
  count = 1,
): Promise<FundFiling[]> {
  const body = await getText(`${SUBMISSIONS}/CIK${cik}.json`);
  if (!body) return [];
  let recent: Record<string, unknown[]>;
  try {
    recent =
      (JSON.parse(body) as { filings?: { recent?: Record<string, unknown[]> } })
        .filings?.recent ?? {};
  } catch {
    return [];
  }
  const forms = (recent.form ?? []) as string[];
  const accs = (recent.accessionNumber ?? []) as string[];
  const dates = (recent.filingDate ?? []) as string[];
  const periods = (recent.reportDate ?? []) as string[];

  const out: FundFiling[] = [];
  for (let i = 0; i < forms.length && out.length < count; i++) {
    // 13F-HR y 13F-HR/A (enmienda); las 13F-NT son "no holdings".
    if (!forms[i].startsWith("13F-HR")) continue;
    const accession = accs[i];
    const accNoDashes = accession.replace(/-/g, "");
    const cikNum = String(Number(cik));
    const base = `${ARCHIVES}/${cikNum}/${accNoDashes}`;
    const index = await getText(`${base}/${accession}-index.html`);
    if (!index) continue;

    // El href CRUDO del information table: se descartan los que llevan
    // `xslForm13F` porque son el render HTML, no el XML.
    const hrefs = [...index.matchAll(/href="([^"]+\.xml)"/gi)]
      .map((m) => m[1])
      .filter((h) => !/xslForm13F/i.test(h) && !/primary_doc/i.test(h));
    if (hrefs.length === 0) continue;

    const xml = await getText(`https://www.sec.gov${hrefs[0]}`);
    if (!xml) continue;
    const holdings = parseInfoTable(xml);
    if (holdings.length === 0) continue;

    out.push({
      cik,
      accession,
      periodOfReport: periods[i] || dates[i],
      filingDate: dates[i],
      holdings,
    });
  }
  return out;
}
