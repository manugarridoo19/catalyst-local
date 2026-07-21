// Ventanas temporales del feed. Centralizadas para que UI y retención se
// queden alineadas. UTC porque la cabecera ya muestra UTC y evita
// edge-cases timezone server↔cliente.

const MS_PER_DAY = 86_400_000;

// Inicio del día UTC actual (00:00:00.000 UTC). Lo usa el cap diario de
// Form 4 por emisor (sec-edgar) — "por día" calendario tiene sentido ahí.
export function startOfTodayUtc(): Date {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

// Ventana del live feed: ROLLING 24h, no "hoy UTC". Con el corte de día
// calendario el feed se VACIABA de golpe a las 00:00Z — 18:00 para el
// usuario (Mac en UTC-6), en pleno after-market — y se rellenaba gota a
// gota (bug reportado 2026-07-20: "live feed roto, 0 noticias"). La
// ventana deslizante mantiene el feed siempre lleno y el orden sigue
// siendo estricto publishedAt DESC (regla recency-first intacta).
export function liveFeedWindowStart(): Date {
  return new Date(Date.now() - MS_PER_DAY);
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
