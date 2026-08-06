# Traspaso de sesión — 2026-08-06 (batería "sacar partido a los datos")

Estado al cerrar. Se **sobrescribe** cada sesión: no acumular ficheros por
fecha. El histórico vive en el log de git y en la memoria del agente.

Repo **público**: aquí nunca van keys ni valores de secretos, solo rutas.

---

## Lo hecho (12 items, commits `abc9864..5cdadca`)

Tema de la sesión: **poner lector a lo que ya se escribía**. El inventario
previo encontró tablas write-only y series leídas solo en su última fila.

1. **/portfolio · Tu track record** — `trade_outcomes` era 100% write-only.
   `lib/coach/track-record.ts` juzga en TS con `judgeTrade` (nunca en SQL:
   una sola convención de signo), veredicto al horizonte más maduro, lo no
   juzgable se dice con su motivo. Columna «La mesa decía» (cruce con
   `portfolio_reviews` por fecha de operación) y referencia del Lab.
2. **Earnings: snapshot de consenso** (migr 0036) — `earnings_events` borra
   fechas pasadas ⇒ la sorpresa moría a los días EN SILENCIO (los 6
   comunicados en BD ya no tenían consenso casable). Ahora se snapshotea al
   generar el report; backfill EJECUTADO vía Finnhub histórico (SOFI
   reproduce el +6.6%/+6.9% de julio). `/ticker` estrena "vs consensus —
   quarter by quarter". Regen con overwrite NO pisa snapshots (COALESCE).
3. **/ticker · DTC trend** — serie quincenal FINRA (texto a 2-3 puntos,
   sparkline SVG a ≥4). `getShortInterest` retirado (se quedó sin
   lectores). Vigilancia del cooldown quincenal: el ciclo del 15-07 disparó
   a 16 días de las del 30-06, sin supresión — seguir vigilando.
4. **/insider · Position changes QoQ** — 13F: ampliaciones/recortes/salidas
   por ACCIONES (el valor se mueve con el precio, no con el gestor), umbral
   de materialidad 25%, agregado por (fondo, símbolo) por el multi-CUSIP.
   Hereda el bug conocido de enmiendas 13F-HR/A (backlog Fase 3).
5. **Coach con memoria** — cadena completa de `frame_changes` («la vara se
   ha movido N veces» desde 2 reclasificaciones) + `getDeskCalls`.
6. **Author Watch · track record** — strip con los calls medidos por el Lab
   (primer render: −5.3% a 7d, vs SPY −4.8%, n=8 small n). El peso que se
   ha ganado, en el sitio donde se le lee.
7. **/insider · Exercises kept/cashed** — tx M emparejado con S/F del mismo
   filing; «KEPT ALL» exige CERO disposiciones (un 98% redondeado a "todo"
   contradiría la cifra de la misma fila).
8. **/news · New names strip** — `first_seen_at` + titular de más impacto;
   filtrado impacto≥3 (134 altas/semana → ~37 con historia).
9. **ai_take en el feed** — YA ESTABA (`news-shared.tsx:108`); el
   inventario inicial se equivocó en este punto. Sin cambios.
10. **/lab · Research note matinal (Fase 4 ✅ — roadmap 2.0 COMPLETO)** —
    tabla `research_notes` (migr 0037) con `stats_snapshot` como
    procedencia (las cifras exactas que vio el modelo se archivan con la
    nota); `maybeGenerateResearchNote` (guard 20h) en cron-runner; 1ª nota
    generada en vivo. Cifras precalculadas, prohibido pronosticar.
11. **/lab · Confluence** — sin lookahead (compañía = 14 días ANTERIORES a
    la detección). Hallazgo: la confluencia RESTA en este archivo (1d
    −1.1% acompañadas vs +0.8% solas; 7d −3.5% vs −0.5%). La intuición
    "dos señales valen más que una" queda medida y desmentida.
12. **/ask multi-turno** — historial acotado (3 turnos, 300/700 chars),
    herencia de símbolos SOLO si la pregunta nueva no nombra ninguno,
    embedding con la pregunta anterior incluida (mismo coste),
    CONVERSATION SO FAR como contexto-no-fuente (el material de hoy manda).
    Verificado en vivo: SOFI → "¿y qué han hecho los insiders?".

## Pendiente / vigilancia

- **Migraciones 0036 y 0037 YA APLICADAS en Neon** (no re-aplicar).
- La research note del cron corre desde el repo pusheado (GH Actions);
  la 1ª nota de hoy ya está en BD, la próxima a las ~20h.
- Sigue vigente: divisa en `watchlist.avg_cost` (un valor no-USD rompería
  agregados) y la regla «reportar no es motivo de postura» solo en prompt.
- Los "Con veredicto" del track record se llenan solos cuando maduren los
  horizontes 30/90 de las operaciones a plazo medio (finales de agosto).
