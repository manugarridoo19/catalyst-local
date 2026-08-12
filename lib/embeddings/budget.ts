// El presupuesto de disco del archivo consultable, en código y no en un
// comentario.
//
// POR QUÉ EXISTE ESTE MÓDULO. La configuración anterior (impacto ≥3, ventana
// de 60 días) NO CABÍA en Neon free, y nada lo decía: no hay error, no hay
// guard que salte, solo un `EMBED_MAX_DB_MB` que pausa la ingesta en seco
// cuando la base llega a 380 MB. Medido el 2026-08-12 con la base real a 352
// de 512 MB: la ventana prometida de 60 días a ~1.060 filas/día pedía ~535 MB
// solo de embeddings más ~193 MB del resto de tablas. La promesa de la
// configuración era imposible desde el primer día y la forma de enterarse
// habría sido que /ask dejara de encontrar lo nuevo, en silencio, dentro de
// unos días.
//
// La aritmética que decide si una configuración cabe es de tres líneas, así
// que vive aquí y la comprueba un test. Cambiar la retención o el umbral sin
// que quepa rompe el test en vez de romper el archivo tres semanas después.

/**
 * Impacto mínimo para entrar en el archivo consultable.
 *
 * **4, no 3.** El 65% de lo embebido era impacto 3 (18.707 filas de 28.883,
 * ~100 MB) y es justo el material que menos decide: cobertura de fondo. El
 * corte a ≥4 baja el flujo de ~1.060 a ~400 filas/día, que es lo que hace que
 * la ventana quepa. Lo que se pierde NO desaparece de la base: `news` sigue
 * teniendo esas noticias 20 días y /ask las alcanza por el canal léxico y por
 * los agregados SQL — deja de encontrarlas por SIGNIFICADO, que es un recorte
 * real pero acotado, y la alternativa medida era un archivo congelado.
 *
 * Efecto colateral que conviene tener presente: a ~400/día el consumo entero
 * de embeddings cabe en la cuota de UNA cuenta (1.000/día), así que este
 * corte también quita la dependencia del pool multi-cuenta.
 */
export const DEFAULT_MIN_IMPACT = 4;

/**
 * Ventana consultable, en días.
 *
 * **45, y el número sale de una fecha, no de una preferencia.** La purga va
 * por `published_at` y la fila más antigua del archivo es del 3 de julio, así
 * que una retención de R días empieza a liberar el 3-jul + R. Con 28 MB de
 * hueco hasta la pausa y hasta ~3,1 MB/día de entrada en un día fuerte, la
 * pausa llegaría hacia el 21 de agosto: la purga tiene que haber arrancado
 * ANTES de esa fecha o la ingesta se para igual. 3-jul + 45d = 17 de agosto,
 * cuatro días de margen. Con 60 no arrancaba hasta el 1 de septiembre y había
 * pausa segura por medio.
 *
 * Al régimen ya no la ata esta fecha: en estado estacionario con ≥4 caben
 * hasta ~85 días. Si dentro de unos meses se quiere alargar la ventana, el
 * test de este módulo dice si cabe.
 */
export const DEFAULT_RETENTION_DAYS = 45;

/** Umbral de pausa de la ingesta. 380 de los 512 de Neon free: los 132 de
 *  diferencia son para que el FEED (el producto principal) siga escribiendo
 *  aunque el archivo se pare. */
export const DEFAULT_MAX_DB_MB = 380;

/** Coste real por fila, medido el 2026-08-12 sobre la tabla viva: 159 MB /
 *  28.862 filas. Es el vector de 768 dimensiones más el índice HNSW más el
 *  snapshot desnormalizado (titular, resumen, url, símbolos) — el snapshot no
 *  es opcional, es lo que mantiene la cita verificable cuando `news` se purga
 *  a los 20 días. */
export const KB_PER_ROW = 5.5;

/**
 * Cuánto ocupará la base cuando el archivo llegue a su tamaño de régimen.
 *
 * `otherTablesMb` es todo lo que no son embeddings (`news`, `news_tickers`,
 * scores, extractos…). Va como parámetro y no como constante porque es lo
 * único de aquí que no controlamos: crece con el volumen de noticias.
 */
export function steadyStateMb(p: {
  retentionDays: number;
  rowsPerDay: number;
  otherTablesMb: number;
  kbPerRow?: number;
}): number {
  const embeddingsMb =
    (p.retentionDays * p.rowsPerDay * (p.kbPerRow ?? KB_PER_ROW)) / 1024;
  return Math.round(embeddingsMb + p.otherTablesMb);
}

/** ¿Cabe esta configuración por debajo del umbral de pausa? Si no cabe, la
 *  ingesta acabará parándose sola: no es una advertencia de estilo. */
export function fitsUnderPause(p: {
  retentionDays: number;
  rowsPerDay: number;
  otherTablesMb: number;
  maxDbMb?: number;
}): boolean {
  return steadyStateMb(p) < (p.maxDbMb ?? DEFAULT_MAX_DB_MB);
}
