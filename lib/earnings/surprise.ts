// La aritmética de "batió o falló". TS puro, sin BD.
//
// Vivía en `lib/ask/retrieve.ts` y se movió aquí el 2026-08-07 por una razón
// mecánica: `lib/earnings/queries.ts` la importaba desde allí, así que /ask no
// podía llamar a `getSurpriseHistory` sin cerrar un ciclo de imports. Con la
// función en un módulo hoja los dos lados la usan y no se apuntan entre sí.
// `retrieve.ts` la RE-EXPORTA para no romper a quien ya la importaba de ahí.

/** Real contra consenso de una métrica, con la base contable declarada.
 *  `pct` sale de `surprisePct`, nunca de un modelo. */
export type EarningsSurprise = {
  metric: "revenue" | "eps";
  label: string;
  actual: number;
  estimate: number;
  basis: string;
  pct: number;
};

/**
 * Desviación porcentual de lo reportado contra el consenso.
 *
 * Existe en CÓDIGO por la regla dura del proyecto: si el número va a salir en
 * pantalla, no lo calcula el LLM. En la primera prueba de la revisión de
 * cartera el modelo estimaba a ojo y acertaba por poco — el modo de fallo que
 * nadie audita porque el resultado parece razonable.
 *
 * Devuelve null —y esto es la mitad del valor de la función— cuando comparar
 * sería mentir:
 *
 *  1. **Sin base contable declarada.** Una empresa publica ingresos GAAP Y
 *     ajustados con puntos de diferencia (SoFi Q2-26: 1,22B GAAP vs 1,2B
 *     ajustado). Comparar la base equivocada da un beat con pinta de exacto.
 *  2. **Desajuste de ESCALA.** El extractor puede devolver 1,22 en vez de
 *     1.220.000.000 (el comunicado imprime "$1.2 billion" y las tablas van
 *     "in thousands"), y 1,22 es un número perfectamente válido que ningún
 *     saneado local puede rechazar. Aquí sí se ve: si real y consenso no
 *     están en el mismo orden de magnitud, uno de los dos tiene otra unidad.
 *     Un factor 10 de tolerancia deja pasar cualquier sorpresa real —nadie
 *     bate el consenso por 10×— y ataja los errores de unidad, que son de
 *     1.000× para arriba.
 *  3. **Consenso cero o ausente**, que no admite división.
 */
export function surprisePct(
  actual: number | null,
  estimate: number | null,
  basis: string | null,
): number | null {
  if (actual === null || estimate === null || !basis) return null;
  if (!Number.isFinite(actual) || !Number.isFinite(estimate) || estimate === 0) return null;
  const ratio = Math.abs(actual) / Math.abs(estimate);
  if (ratio === 0 || Math.abs(Math.log10(ratio)) > 1) return null;
  return ((actual - estimate) / Math.abs(estimate)) * 100;
}
