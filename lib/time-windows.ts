// Ventanas temporales del feed. Centralizadas para que UI y retención se
// queden alineadas. UTC porque la cabecera ya muestra UTC y evita
// edge-cases timezone server↔cliente.

const MS_PER_DAY = 86_400_000;

// Inicio del día UTC actual (00:00:00.000 UTC). El live feed muestra solo
// noticias publishedAt >= este momento.
export function startOfTodayUtc(): Date {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

// 15 días atrás desde ahora. Las páginas de ticker muestran noticias en
// esta ventana, así un trader ve el contexto reciente sin overload.
export function fifteenDaysAgo(): Date {
  return new Date(Date.now() - 15 * MS_PER_DAY);
}

// Retención: ≥20 días se purga del DB en cada tick de refresh-news.
export const RETENTION_DAYS = 20;

// Retención agresiva para noticias SIN puntuar: pasados estos días ya no
// vale la pena puntuarlas (el feed muestra lo de hoy) — se descartan. Baja
// el backlog de scoring a lo realmente accionable. Las noticias CON score
// se conservan hasta RETENTION_DAYS. (Decisión del usuario 2026-07-16.)
export const UNSCORED_RETENTION_DAYS = 5;
