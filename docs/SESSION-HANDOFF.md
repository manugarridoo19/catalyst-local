# Traspaso de sesión — 2026-07-21 (tarde)

Estado al cerrar. Se **sobrescribe** cada sesión: no acumular ficheros por
fecha. El histórico vive en el log de git y en la memoria del agente.

Repo **público**: aquí nunca van keys ni valores de secretos, solo rutas.

---

## Qué se hizo

Tres cosas, en este orden: un arreglo de UI, un bug de producción que apareció
al mirar la salud del sistema, y la primera sub-fase de la Fase 3.

### 1. Firma del header, en flujo (commit `1774c9c`, deploy `c944bc2e`)

Estaba centrada respecto al **viewport** (`absolute left-1/2`). Al añadir las
pestañas Lab y Ask la nav creció hasta los 690px y la frase se pintaba encima:
**158px de solape** sobre Insider/Lab/Ask a 1280px.

Ahora es la columna del medio del header (`flex-1`, en flujo), así que el
navegador la centra en el hueco QUE QUEDA: simétrica por construcción e
imposible de solapar por muchas pestañas que se añadan después.

**Dato que condicionó la solución**: la pantalla del usuario son **1440px
lógicos**, así que macOS recorta a ~1400 los bounds de 1600 que pide el
launcher por AppleScript. Un gate en `2xl` (1536) habría hecho desaparecer la
firma justo en su ventana → breakpoint a medida `min-[1380px]`.
Comprobarlo con `osascript -e 'tell application "Finder" to get bounds of
window of desktop'` antes de tocar breakpoints del header.

### 2. Embeddings parados 2h en silencio (commit `64fdf4f`, deploy `0b3e6f39`)

`/api/health` mostraba `embedAgeMin: 115` con el cron corriendo cada 10min.
**Dos fallos que se tapaban entre sí:**

1. El 429 del límite **diario** se clasificaba como ráfaga por minuto. La
   heurística miraba el TAMAÑO de `retryDelay` y Google manda ~2,35s también
   en el diario → enfriaba 2s una pared de 24h y el pool se pasó la tarde
   reintentando y logueando "RPM burst". Ahora se clasifica por
   `details[].violations[].quotaId`, que es el campo autoritativo.
2. El lote pedía exactamente **100 textos = el límite por minuto**, así que
   sólo entraba con el cubo del minuto intacto; una pregunta de `/ask` en esos
   60s lo tumbaba entero, y como el mismo lote se reenviaba a las 3 keys, las
   quemaba las tres. Ahora se trocea a `EMBED_CHUNK` (50) insertando por
   trozo → el tick es resumable.

**Cuota real MEDIDA** (el spike que la Fase 2 dejó a medias, con el
`EMBED_DAILY_NOTE` colgando sin escribir): **1.000 embeddings/día y key**,
reset a medianoche Pacific. Se midió contando filas por día Pacific:
exactamente **3.000** ese día (= 3 keys × 1.000) con parón en seco. Ese
3×1.000 confirma además que las 3 keys están en **proyectos distintos** y que
el round-robin sí suma capacidad. Régimen normal ~919 impact≥3/día → cabe con
holgura; lo que agotó el cupo fue la puesta al día inicial de Fase 2.

### 3. Fase 3, sub-fase 1: short interest (commit `d1aa28a`, deploy `50221fd4`)

`lib/providers/finra.ts` + `lib/short-interest/` + señal `short_squeeze_setup`
+ el dato en `/ticker/X`. Convenciones y gotchas → `CLAUDE.md`.

**Los tres spikes de la Fase 3 están hechos. No repetirlos:**

| Fuente | Veredicto | Lo que hay que saber |
|---|---|---|
| FINRA short interest | ✅ | Sin autenticación. `settlementDate` es clave de partición (pedir fecha exacta, no se puede ordenar). Publica con **~2 semanas de retraso**. Fecha no publicada = 200 con **cuerpo vacío**, no `[]`. Máx 5.000 filas/petición. |
| 8-K exhibit 99.1 | ✅ | El `<TYPE>EX-99.1` sale del `{acc}-index.html` (10 KB). El exhibit es HTML normal → lo lee `lib/articles/extract.ts`. |
| OpenFIGI CUSIP→ticker | ✅ | Sin key, por lotes. Filtrar `exchCode: "US"`, cachear para siempre. |

---

## Lo que hay que mirar en la próxima sesión

1. **Mañana (tras las 07:05Z) confirmar que los embeddings se reanudan solos**
   y drenan las ~1.900 pendientes. `curl .../api/health | grep embed`. Si
   `embedAgeMin` vuelve a dispararse, mirar el `quotaId` del 429 en el log del
   cron antes de tocar nada.
2. **Las 50 señales `short_squeeze_setup` aún no salen en `/lab`**: la página
   hace INNER JOIN con `signal_outcomes` (sólo enseña lo YA medido), así que
   aparecerán cuando el job de outcomes mida el horizonte de 1 día. No es un
   fallo; es la semántica que fijó la Fase 1.
3. **Seguir la Fase 3**: quedan transcripts post-earnings (vía 8-K 99.1) y
   13F con el gate CUSIP→ticker. Ambos spikes ya validados.
4. La key Gemini de **reserva sigue revocada (401)** por decisión del usuario:
   el tier reserva está muerto a propósito, no "arreglarlo".

---

## Comandos del subsistema nuevo

```bash
# La ingesta corre sola en el cron (guard: 1×/20h, y el dato es 2×/mes).
# Para forzarla a mano, p.ej. tras cambiar el parseo:
pnpm exec tsx -e 'import("./lib/short-interest/ingest").then(m=>m.runShortInterestIngest({force:true}).then(r=>console.log(r)))'
```

`force: true` re-descarga también la quincena que ya tenemos — es la vía para
re-normalizar filas viejas (así se limpiaron los 33 centinelas de 999.99).
