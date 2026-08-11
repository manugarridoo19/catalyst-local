import { describe, it, expect } from "vitest";
import { parseForm4Structured, parseForm4Xml } from "@/lib/articles/extract";

// EL PLAN 10b5-1 TIENE TRES ESTADOS, NO DOS.
//
// La SEC hizo obligatoria la casilla en las enmiendas de dic-2022 (vigentes
// desde abr-2023), y desde entonces `<aff10b5One>` viene explícito en el
// ownership XML. Antes sólo se podía inferir del patrón repetido de ventas,
// que es lo que documentaba el CLAUDE.md de este repo y lo que decía la nota
// de `systematicSellers`.
//
// El estado que hay que defender con un test es el TERCERO. `flag()` —el
// helper que usan isDirector/isOfficer/isTenPercent— colapsa "ausente" y
// "0" en el mismo `false`, y aquí esos dos casos piden reacciones opuestas:
// un filing de 2019 sin el elemento se convertiría en "el directivo declaró
// que vendía por decisión propia", que es una afirmación que nadie hizo.
//
// Los fragmentos están calcados de filings reales (NVDA 0001197647-26-000007
// con la casilla a 1, TSLA 0001104659-26-075213 con la casilla a 0).

const OWNER = `
    <reportingOwner>
        <reportingOwnerId><rptOwnerName>Huang Jen-Hsun</rptOwnerName></reportingOwnerId>
        <reportingOwnerRelationship>
            <isDirector>1</isDirector>
            <isOfficer>1</isOfficer>
            <officerTitle>President and CEO</officerTitle>
        </reportingOwnerRelationship>
    </reportingOwner>`;

const TX = `
    <nonDerivativeTable>
      <nonDerivativeTransaction>
        <transactionDate><value>2026-08-04</value></transactionDate>
        <transactionCoding><transactionCode>S</transactionCode></transactionCoding>
        <transactionAmounts>
          <transactionShares><value>75000</value></transactionShares>
          <transactionPricePerShare><value>182.50</value></transactionPricePerShare>
        </transactionAmounts>
        <postTransactionAmounts>
          <sharesOwnedFollowingTransaction><value>75450000</value></sharesOwnedFollowingTransaction>
        </postTransactionAmounts>
      </nonDerivativeTransaction>
    </nonDerivativeTable>`;

function doc(aff: string): string {
  return `<?xml version="1.0"?>
<ownershipDocument>
  <issuer>
    <issuerName>NVIDIA CORP</issuerName>
    <issuerTradingSymbol>NVDA</issuerTradingSymbol>
  </issuer>
  ${OWNER}
  ${aff}
  ${TX}
</ownershipDocument>`;
}

describe("Form 4: <aff10b5One> distingue plan programado de venta discrecional", () => {
  it("casilla a 1 → plan 10b5-1 declarado", () => {
    const p = parseForm4Structured(doc("<aff10b5One>1</aff10b5One>"));
    expect(p?.plannedSale).toBe(true);
  });

  it("casilla a 0 → el filer declaró que NO había plan", () => {
    // Esto es una AFIRMACIÓN del filer, no una ausencia de dato: la venta se
    // decidió con la información de esa semana. Es la única de las tres
    // ramas que autoriza a leer convicción.
    const p = parseForm4Structured(doc("<aff10b5One>0</aff10b5One>"));
    expect(p?.plannedSale).toBe(false);
  });

  it("SIN el elemento → null, jamás false", () => {
    // La aserción que sostiene todo lo demás. Un Form 4 anterior a abr-2023
    // no trae la casilla, y tratarlo como "declaró que no había plan"
    // fabricaría una señal de convicción sobre un silencio.
    const p = parseForm4Structured(doc(""));
    expect(p?.plannedSale).toBeNull();
    expect(p?.plannedSale).not.toBe(false);
  });

  it("valor presente pero ilegible tampoco es false", () => {
    const p = parseForm4Structured(doc("<aff10b5One>Y</aff10b5One>"));
    expect(p?.plannedSale).toBeNull();
  });

  it("no contamina los otros tres flags, que sí son booleanos de dos estados", () => {
    const p = parseForm4Structured(doc("<aff10b5One>1</aff10b5One>"));
    expect(p?.isDirector).toBe(true);
    expect(p?.isOfficer).toBe(true);
    expect(p?.isTenPercent).toBe(false); // ausente = false, y aquí está BIEN
  });
});

describe("Form 4: el texto legible dice el plan sólo cuando el filing lo declara", () => {
  it("con plan, lo nombra — es lo que /ask acaba citando", () => {
    const t = parseForm4Xml(doc("<aff10b5One>1</aff10b5One>")) ?? "";
    expect(t).toContain("10b5-1");
    expect(t).toContain("adopted in advance");
  });

  it("sin plan declarado, lo dice como discrecional", () => {
    const t = parseForm4Xml(doc("<aff10b5One>0</aff10b5One>")) ?? "";
    expect(t).toContain("NOT made under a Rule 10b5-1 plan");
  });

  it("sin el elemento, CALLA — no menciona 10b5-1 en ninguna dirección", () => {
    // Callar es la respuesta correcta. La versión anterior de este dato
    // vivía en `systematicSellers`, que escribía "venta programada en
    // curso" en TODOS los casos porque el patrón repetido era lo único
    // observable; el cuerpo que se cita no puede heredar esa inferencia.
    const t = parseForm4Xml(doc("")) ?? "";
    expect(t).not.toContain("10b5-1");
    // Pero la transacción sigue estando entera.
    expect(t).toContain("75,000 shares");
    expect(t).toContain("owns 75,450,000 shares after");
  });
});
