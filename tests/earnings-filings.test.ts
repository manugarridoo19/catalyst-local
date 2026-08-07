import { describe, expect, it } from "vitest";
import { looksLikeEarningsRelease } from "@/lib/earnings/filings";

// Reconocer el comunicado de resultados de un EMISOR EXTRANJERO.
//
// Un 6-K no declara ítems (el 8-K sí: el 2.02 es "Results of Operations") y a
// menudo no lleva exhibits, así que la única señal disponible es el TEXTO. El
// emisor presenta 3-4 documentos el mismo día y sólo uno es el comunicado; el
// orden natural de EDGAR devuelve el que NO es.
//
// Un falso positivo aquí no deja un hueco: paga una llamada al LLM para
// resumir el informe de auditoría, lo guarda como si fuera el trimestre y
// `earningsReportExists` bloquea el bueno durante 60 días. De ahí que estos
// tests lleven tantos negativos como positivos.
//
// Todos los textos de abajo son EXTRACTOS REALES, medidos contra EDGAR el
// 2026-08-07 (Nu Holdings CIK 1691493, ASML 937966, TSMC 1046179).

const COVER =
  "SECURITIES AND EXCHANGE COMMISSION Washington, D.C. 20549 FORM 6-K Report of " +
  "Foreign Private Issuer Pursuant to Rule 13a-16 or 15d-16 of the Securities " +
  "Exchange Act of 1934 For the month of May, 2026 Commission File Number " +
  "001-41129 Nu Holdings Ltd. Yes No ( X ) ";

describe("looksLikeEarningsRelease", () => {
  it("reconoce el comunicado de los tres emisores medidos", () => {
    // Nu Holdings: el título dice "Results" explícitamente.
    expect(
      looksLikeEarningsRelease(
        COVER +
          "Nu Holdings Ltd. Reports First Quarter 2026 Financial Results São Paulo, " +
          "Brazil, May 14, 2026 — Nu Holdings Ltd. (NYSE: NU) today released its " +
          "financial results for the first quarter ended March 31, 2026",
      ),
    ).toBe(true);

    // ASML: NO dice "results" ni "earnings" en el titular. Exigirlas —como
    // hacía la primera versión— dejaba fuera a dos de los tres emisores.
    expect(
      looksLikeEarningsRelease(
        "Exhibit 99.1 ASML reports €9.3 billion total net sales and €2.9 billion " +
          "net income in Q2 2026 ASML increases outlook, expects 2026 total net sales",
      ),
    ).toBe(true);

    // TSMC: tampoco. Su magnitud es el BPA.
    expect(
      looksLikeEarningsRelease(
        "TSMC Reports Second Quarter EPS of NT$27.25 HSINCHU, Taiwan, R.O.C., " +
          "Jul. 16, 2026 -- TSMC (TWSE: 2330, NYSE: TSM) today announced consolidated",
      ),
    ).toBe(true);
  });

  it("NO reconoce a los compañeros que el emisor presenta el MISMO día", () => {
    // Los tres conviven con el comunicado de NU en la misma fecha y periodo,
    // así que el filtro por `reportDate` no los separa: los separa esto.
    expect(
      looksLikeEarningsRelease(
        COVER +
          "02 Independent Assurance Report - Limited Assurance 04 Managerial P&L " +
          "ABCD Independent Limited Assurance Report to Nu Holdings Ltd on the Process " +
          "for Compiling and Presenting Supplementary Consolidated Financial Information",
      ),
    ).toBe(false);

    expect(
      looksLikeEarningsRelease(
        COVER +
          "Q1 2026 Earnings Presentation May 14, 2026 Welcome Guilherme Souto Investor " +
          "Relations Officer David Vélez Founder, Chief Executive Officer Disclaimer " +
          "This presentation speaks at the date hereof",
      ),
    ).toBe(false);

    expect(
      looksLikeEarningsRelease(
        COVER +
          "Contents Page Unaudited Interim Condensed Consolidated Statements of Income 5 " +
          "Notes to the Unaudited Interim Condensed Consolidated Financial Statements 13 " +
          "Conclusion Based on our review, nothing has come to our attention",
      ),
    ).toBe(false);
  });

  it("NO reconoce los 6-K rutinarios, que son la mayoría", () => {
    // 93 de los 159 6-K de NU. El filtro por `reportDate` ya los descarta,
    // pero el detector tiene que sostenerse solo: es la segunda red.
    expect(looksLikeEarningsRelease(COVER + "NOTICE TO THE MARKET Nubank informs")).toBe(
      false,
    );
    expect(
      looksLikeEarningsRelease(COVER + "Nubank appoints Roberto as Chief Technology Officer"),
    ).toBe(false);
    expect(
      looksLikeEarningsRelease(
        COVER + "Nubank to Add a Banking License to its Financial Conglomerate in Brazil",
      ),
    ).toBe(false);
    // La junta de accionistas: un detector sólo-positivo mal calibrado la
    // confundió con un comunicado durante la verificación del 2026-08-07.
    expect(
      looksLikeEarningsRelease(
        COVER +
          "NU HOLDINGS LTD. Annual General Meeting of Shareholders a. Anita Mary Sands " +
          "b. election of directors form of proxy voting instruction",
      ),
    ).toBe(false);
  });

  it("exige que la MAGNITUD esté junto al verbo, no en cualquier parte", () => {
    // Cualquier filing financiero nombra "revenue" en algún sitio. Si la
    // magnitud valiera en todo el documento, la convocatoria de junta de una
    // empresa que más abajo cita sus ingresos entraría como comunicado.
    expect(
      looksLikeEarningsRelease(
        COVER +
          "Nu Holdings announces its Annual General Meeting for the fiscal year. " +
          "A".repeat(400) +
          " total revenue of $5,315.5 million",
      ),
    ).toBe(false);
  });
});
