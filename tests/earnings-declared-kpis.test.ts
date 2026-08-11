import { describe, it, expect } from "vitest";
import { parseDeclaredKpis } from "@/lib/ai/earnings-report";
import { EARNINGS_SYSTEM_PROMPT } from "@/lib/ai/earnings-report";

// LA VARA QUE LA EMPRESA DECLARA.
//
// Para media cartera el ingreso NO es la cifra por la que su dirección se
// juzga: Rubrik dice que la señal de topline es el ARR y no los ingresos,
// dLocal se lee por TPV y take rate, un prestamista por su morosidad, una
// nube de GPU por backlog y megavatios contratados. El extractor leía el
// comunicado entero y no tenía dónde ponerlo, así que se perdía cada
// trimestre.
//
// El campo se sostiene sobre DOS cortes, y sin ninguno de los dos se
// convierte en un duplicado del resumen.

describe("parseDeclaredKpis: el corte que evita el resumen duplicado", () => {
  const kpi = (name: string, value = "100") => [{ name, value }];

  it("acepta la métrica específica del negocio", () => {
    const r = parseDeclaredKpis([
      { name: "ARR", value: "$1.28 billion", change: "up 34% year-over-year", quote: null },
    ]);
    expect(r).toHaveLength(1);
    expect(r[0].name).toBe("ARR");
    expect(r[0].value).toBe("$1.28 billion");
  });

  it.each([
    "revenue",
    "Revenue",
    "total revenue",
    "net revenue",
    "GAAP revenue",
    "non-GAAP revenue",
    "adjusted revenue",
    "EPS",
    "earnings per share",
    "net income",
    "gross margin",
    "operating margin",
    "net profit margin",
    "free cash flow",
    "EBITDA",
    "adjusted EBITDA",
    "operating cash flow",
  ])("descarta el financiero estándar '%s'", (name) => {
    // El prompt YA pide excluirlos, pero pedirlo no es comprobarlo — y este
    // repo tiene escrito que un arreglo que vive sólo en el prompt no llega
    // al gate. Sin este corte el modelo rellena el campo con las métricas
    // que más veces aparecen en cualquier comunicado (que son justo éstas) y
    // el hueco abierto para el ARR se lo come un resumen repetido.
    expect(parseDeclaredKpis(kpi(name))).toEqual([]);
  });

  it("NO descarta métricas que sólo CONTIENEN una palabra financiera", () => {
    // El corte es por lo que la métrica ES, no por lo que su nombre incluye:
    // "revenue backlog" y "net revenue retention rate" son exactamente las
    // varas que este campo existe para capturar. Ancla la regex a la cadena
    // entera por esto.
    const nombres = [
      "revenue backlog",
      "net revenue retention rate",
      "annual recurring revenue",
      "revenue per user",
      "free cash flow conversion rate",
      "EBITDA margin ex-SBC",
    ];
    for (const n of nombres) {
      expect(parseDeclaredKpis(kpi(n)), `${n} no debería descartarse`).toHaveLength(1);
    }
  });

  it("sin cifra no entra: un KPI nombrado y vacío ocupa sitio y no dice nada", () => {
    expect(parseDeclaredKpis([{ name: "TPV", value: "" }])).toEqual([]);
    expect(parseDeclaredKpis([{ name: "", value: "$10.3 billion" }])).toEqual([]);
  });

  it("la unidad se conserva: sin ella un 0,99 y un 99% son el mismo número", () => {
    const r = parseDeclaredKpis([
      { name: "take rate", value: "0.99%", change: "down from 1.07% in Q2" },
    ]);
    expect(r[0].value).toBe("0.99%");
    expect(r[0].change).toBe("down from 1.07% in Q2");
  });

  it("deduplica la misma métrica troceada por el modelo", () => {
    const r = parseDeclaredKpis([
      { name: "TPV", value: "$10.3 billion" },
      { name: "tpv", value: "$10,300 million" },
    ]);
    expect(r).toHaveLength(1);
  });

  it("tope de 4: una empresa no se gestiona por ocho varas", () => {
    const muchas = Array.from({ length: 9 }, (_, i) => ({
      name: `metrica ${i}`,
      value: "1",
    }));
    expect(parseDeclaredKpis(muchas)).toHaveLength(4);
  });

  it("basura y no-arrays devuelven vacío en vez de reventar", () => {
    expect(parseDeclaredKpis(null)).toEqual([]);
    expect(parseDeclaredKpis("ARR")).toEqual([]);
    expect(parseDeclaredKpis([null, 3, "x", {}])).toEqual([]);
  });
});

describe("parseDeclaredKpis: la cita es la que separa la vara del número suelto", () => {
  it("sin cita se acepta la cifra, pero no se afirma primacía", () => {
    // `null` es la respuesta COMÚN y legítima: la empresa publica la métrica
    // sin reclamar que sea la principal. El panel pinta la cifra y calla.
    const r = parseDeclaredKpis([{ name: "TPV", value: "$10.3 billion", quote: null }]);
    expect(r[0].quote).toBeNull();
  });

  it("con cita, la conserva literal", () => {
    const frase =
      "we continue to view subscription ARR, not revenue, as the best indicator of our business momentum";
    const r = parseDeclaredKpis([{ name: "ARR", value: "$1.28B", quote: frase }]);
    expect(r[0].quote).toBe(frase);
  });

  it("una cita en blanco es null, no cadena vacía", () => {
    // Cadena vacía se colaría como valor verdadero en cualquier `if (quote)`
    // del render y pintaría unas comillas huecas.
    const r = parseDeclaredKpis([{ name: "ARR", value: "$1.28B", quote: "   " }]);
    expect(r[0].quote).toBeNull();
  });
});

describe("contrato prompt ↔ validador", () => {
  it("el prompt ofrece el campo y nombra sus cuatro claves", () => {
    for (const k of ["declaredKpis", '"name"', '"value"', '"change"', '"quote"']) {
      expect(EARNINGS_SYSTEM_PROMPT).toContain(k);
    }
  });

  it("el prompt prohíbe explícitamente los financieros estándar", () => {
    // Si alguien quita el párrafo del prompt, el validador seguiría cortando
    // pero el modelo gastaría cuota generando lo que se va a tirar.
    expect(EARNINGS_SYSTEM_PROMPT).toContain("Exclude revenue, EPS");
  });
});
