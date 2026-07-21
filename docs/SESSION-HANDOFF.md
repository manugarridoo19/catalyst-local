# Traspaso de sesión — 2026-07-21

Estado al cerrar. Se **sobrescribe** cada sesión: no acumular ficheros por
fecha. El histórico vive en el log de git y en la memoria del agente.

Repo **público**: aquí nunca van keys ni valores de secretos, solo rutas.

---

## Qué se hizo: Fase 1 del roadmap Catalyst 2.0 — Signal Lab

8 commits (`1dde0cc` → `36c295b`), deploy Cloudflare `a616f503`, working tree
limpio, todo pusheado. Design doc de referencia:
`~/.gstack/projects/manugarridoo19-catalyst-local/manuelgarrido-main-design-20260720-190637.md`

`/lab` mide el track record de Catalyst sobre **sus propias** señales: cada una
se registra al nacer y un job la contrasta después contra los precios. Es
calibración de confianza, no predicción. Convenciones y gotchas del subsistema
están en `CLAUDE.md` (sección "Signal Lab") — **leer esa sección antes de
tocar `lib/signals/`**.

### Estado de los datos al cierre

| kind | eventos | outcomes |
|---|---|---|
| analyst_upgrade | 49 | 19 |
| ai_pick | 31 | 0 |
| stake_13d | 11 | 0 |
| insider_net_buy | 8 | 0 |
| author_call | 7 | 7 |
| cluster_buy | 3 | 0 |

109 eventos, 26 outcomes, **26/26 con benchmark SPY**, 0 abandonados, 0
violaciones de integridad (verificado por SQL: ningún `target_date <=
baseline_date`, ningún retorno absurdo, ningún cierre <= 0).

Los kinds con 0 outcomes **no son un fallo**: todos sus eventos son del 17-jul
en adelante y aún no maduran ni el horizonte de 1 día hábil. Se rellenan solos.

### Dos desviaciones conscientes del design doc

Ambas caen justo en lo que el propio doc marcaba como "re-verificar al bajar a
implementación". Si alguien las revisa, éste es el porqué:

1. **Cooldown por kind ADEMÁS del `UNIQUE(kind,symbol,ref_id)`.** El doc
   asumía que el UNIQUE bastaba, pero AI Picks se regenera cada 4h y acuña un
   `ref_id` nuevo cada vez: el mismo valor habría entrado ~6 veces al día como
   si fueran observaciones independientes, inflando N y dando medias
   falsamente precisas. Cooldowns en `lib/signals/kinds.ts`.
2. **`price_at_detection` se guarda `null`** cuando no hay quote fresca, en vez
   de "diferir el evento al siguiente tick" como decía el doc. Es un campo
   informativo que nunca es denominador de un retorno; diferir añadía un modo
   de fallo atascable a cambio de nada.

---

## Lo que hay que mirar en la próxima sesión

1. **Verificar el job de outcomes en el cron de GitHub** (lo único no
   ejercitado en producción). Corre **1×/día** y esa sesión consumió la
   ventana ejecutándolo a mano, así que el proxy aún no se ha probado desde el
   runner. Comprobar en el log del último run:
   ```
   gh run list -R manugarridoo19/catalyst-local -w cron-runner.yml -L 5
   gh run view <id> -R manugarridoo19/catalyst-local --log | grep -E "outcomes|prices"
   ```
   Esperado: `outcomes filled N over M events`. Si aparece
   `Yahoo vacío ... proxy falló`, revisar `LAB_PRICE_PROXY_URL` en
   `.github/workflows/cron-runner.yml`.
2. **Los priors empíricos aún no se inyectan**: sólo entran con n≥20 por kind y
   horizonte. Hoy el máximo es n=19. Cuando la muestra crezca aparecerán solos
   en el prompt de AI Picks y en el digest insider — conviene leer un pick
   generado después para confirmar que el bloque entra bien y que el modelo no
   se pone a citar las cifras (el prompt se lo prohíbe explícitamente).
3. **Siguiente hito del roadmap**: spike de 30-45 min sobre la cuota real del
   free tier de embeddings de Gemini, y después Fase 2 (Ask Catalyst). El doc
   deja pre-comprometido el fallback si la cuota es corta: embeber sólo
   watchlist + picks.

---

## Yahoo: el asunto que consumió media sesión (ya resuelto, pero conviene entenderlo)

**Yahoo limita por IP y de forma asimétrica.** Verificado el 2026-07-21:

| origen | Yahoo directo |
|---|---|
| Mac del usuario | 429 a **toda** la API (`chart` y `feeds.finance`) |
| runners de GitHub Actions | 429 |
| Workers de Cloudflare | **funciona con normalidad** |

La solución es un rodeo por nuestra propia infra, gratis y sin cuentas nuevas:
- `/api/adj-closes` (ruta nueva) sirve cierres ajustados → lo consume el job
  del Lab desde el cron de GitHub.
- `getBars` cae al `/api/bars` del Worker → arregla el daemon local.
- Ambos son **fallback, no sustituto**: se intenta Yahoo directo primero, así
  que el día que la IP se desbloquee el rodeo se apaga solo, sin tocar nada.
- Doble guard anti-recursión: `LAB_PRICE_PROXY_URL` **nunca** se sube al
  Worker, y además el código detecta el runtime workerd.

**Dos bugs distintos con el mismo síntoma — la trampa de este diagnóstico:**
`/api/bars` era la única ruta que conservaba `export const runtime = "edge"`,
que `@opennextjs/cloudflare` **no soporta**: devolvía 500 *antes de entrar en
el handler*, incluso en el camino que responde 400 sin tocar la red. Los
gráficos de ticker llevaban **muertos en producción desde la migración a
Cloudflare del 2026-07-15** y la oleada de 429 de Yahoo lo camuflaba (en local
el mismo endpoint degradaba a `{"bars":[]}`, síntoma idéntico). Regla añadida a
`CLAUDE.md`: ninguna ruta en `runtime = "edge"`.

**Lo único que puede hacer el usuario**: comprobar si su IP concreta se
desbloquea (reiniciar router o tirar de datos del móvil) con
`curl -s -o /dev/null -w "%{http_code}\n" -A "Mozilla/5.0" "https://query2.finance.yahoo.com/v8/finance/chart/AAPL?range=1mo&interval=1d"`.
No es urgente: funcionalmente no falta nada, el rodeo cuesta ~100 ms y no gasta
cuota de ningún proveedor.

**FMP como 3ª opción**: su plan free **no cubre todo el universo** — 402 "not
available under your current subscription" en RKLB/ASML/GOOG mientras sirve
AAPL/TSM/GOOGL/SPY. Va apagado por defecto (`LAB_FMP_MAX_CALLS=0`) porque su
presupuesto es por proceso y el cron corre ~144×/día contra una cuota de
250/día compartida con los fundamentales.

---

## Comandos del subsistema

```bash
pnpm signals:backfill                 # reconstruye señales del archivo (--dry-run / --no-outcomes)
pnpm signals:outcomes                 # mide a mano; [n] símbolos, --reset re-encola lo no medido
pnpm daemon:restart                   # tras tocar el plist: recarga env del daemon
```

Si Yahoo bloquea la IP desde la que se lanza algo manual, acompañarlo del
proxy: `LAB_PRICE_PROXY_URL=https://catalyst-local.manubisbal19.workers.dev`.
