#!/bin/zsh
# Author Watch — pasada diaria. Scrapea el timeline de X del autor con la
# sesión de Brave del usuario y genera el brief fusionado. Lo dispara el
# LaunchAgent com.catalyst.author a las 00:00 (recoge el día anterior de
# golpe). Diseñado para no reventar nunca (exit 0): un fallo conserva el
# brief anterior.
#
# Anti-ban: 1 sola pasada/día, cookies reales del usuario, cero paralelismo.
# NO correr en loop ni acortar la cadencia.

set -u
REPO="/Users/manuelgarrido/dev/catalyst-local"
HANDLE="${AUTHOR_HANDLE:-Couch_Investor}"
OUT="/tmp/catalyst-author-tweets.json"

# Guard 1×/día. launchd NO recupera StartCalendarInterval perdidos tras un
# APAGADO (solo tras sleep): con el Mac apagado a las 00:00 la pasada se
# perdía el día entero (visto 2026-07-18). El plist ahora también dispara
# RunAtLoad y este stamp garantiza como máximo UNA pasada por día natural.
STAMP="$HOME/.catalyst-author-last-run"
TODAY="$(date +%F)"
if [ -f "$STAMP" ] && [ "$(cat "$STAMP" 2>/dev/null)" = "$TODAY" ]; then
  echo "[author-run] already ran today ($TODAY) — skip"
  exit 0
fi
# python3 del framework (tiene browser_cookie3 + requests instalados).
PY="/Library/Frameworks/Python.framework/Versions/3.13/bin/python3"
[ -x "$PY" ] || PY="$(command -v python3)"

echo "[author-run] $(date '+%Y-%m-%d %H:%M:%S') start handle=$HANDLE"

# 1) Scrape (Python + cookies Brave). Ventana 36h para cubrir el día anterior
#    completo aunque la pasada se retrase.
if "$PY" "$REPO/scripts/scrape-author.py" "$HANDLE" "$OUT" 36; then
  # Solo estampamos si el scrape completó — un fallo (red caída al arrancar)
  # deja el stamp sin tocar y la siguiente carga/medianoche reintenta.
  echo "$TODAY" > "$STAMP"
fi

# 2) Ingesta + brief (TS). pnpm exec tsx, mismo patrón que los otros agentes.
/opt/homebrew/bin/pnpm --dir "$REPO" exec tsx scripts/author-daily.ts "$HANDLE" "$OUT" || true

echo "[author-run] $(date '+%Y-%m-%d %H:%M:%S') done"
exit 0
