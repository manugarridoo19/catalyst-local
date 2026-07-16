#!/usr/bin/env bash
# Catalyst local daemon — keep the dashboard reachable on localhost even
# when Vercel is suspended, and (optionally) keep the news feed graded
# in the background via a second LaunchAgent. Wraps macOS LaunchAgents
# with auto-restart, bounded resources, and TCC workarounds so we don't
# reproduce the dev-mode RAM-leak incident.
#
# Three agents managed here:
#   com.catalyst.local     Production `next start` on port 3030, always on
#   com.catalyst.scorer    `drain-scoring.ts 30` every 15 min (auto-grader)
#   com.catalyst.refresher `refresh-once.ts` every 10 min (news fetch —
#                          GH Actions cron is throttled to 1-4h real cadence)
#
# Usage (main daemon):
#   scripts/local-daemon.sh install   First-time setup: build + load
#   scripts/local-daemon.sh start     Load the agent
#   scripts/local-daemon.sh stop      Unload the agent
#   scripts/local-daemon.sh restart   Stop, rebuild if needed, start
#   scripts/local-daemon.sh status    Both agents' state + port listener
#   scripts/local-daemon.sh logs      Tail daemon stdout + stderr
#   scripts/local-daemon.sh build     Force-rebuild .next
#   scripts/local-daemon.sh uninstall Remove plist + unload
#   scripts/local-daemon.sh open      Open dashboard in default browser
#
# Usage (auto-scorer):
#   scripts/local-daemon.sh scorer-install   Install the scorer plist
#   scripts/local-daemon.sh scorer-start     Load (runs every 15 min)
#   scripts/local-daemon.sh scorer-stop      Unload
#   scripts/local-daemon.sh scorer-logs      Tail scorer stdout + stderr
#   scripts/local-daemon.sh scorer-run       Run one drain tick now (foreground)
#   scripts/local-daemon.sh scorer-uninstall Remove plist + unload
#
# Usage (refresher):
#   scripts/local-daemon.sh refresher-install   Install the refresher plist
#   scripts/local-daemon.sh refresher-start     Load (runs every 10 min)
#   scripts/local-daemon.sh refresher-stop      Unload
#   scripts/local-daemon.sh refresher-logs      Tail refresher stdout + stderr
#   scripts/local-daemon.sh refresher-run       Run one refresh tick now (foreground)
#   scripts/local-daemon.sh refresher-uninstall Remove plist + unload

set -euo pipefail

# --- Config ------------------------------------------------------------------

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${CATALYST_LOCAL_PORT:-3030}"

# Main daemon (next start)
PLIST_LABEL="com.catalyst.local"
PLIST_TARGET="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"
PLIST_SOURCE="$REPO_DIR/scripts/${PLIST_LABEL}.plist"

# Auto-scorer (drain-scoring on a 15-min interval)
SCORER_LABEL="com.catalyst.scorer"
SCORER_TARGET="$HOME/Library/LaunchAgents/${SCORER_LABEL}.plist"
SCORER_SOURCE="$REPO_DIR/scripts/${SCORER_LABEL}.plist"

# Refresher (news fetch on a 10-min interval)
REFRESHER_LABEL="com.catalyst.refresher"
REFRESHER_TARGET="$HOME/Library/LaunchAgents/${REFRESHER_LABEL}.plist"
REFRESHER_SOURCE="$REPO_DIR/scripts/${REFRESHER_LABEL}.plist"

LOG_DIR="$REPO_DIR/.next/daemon-logs"
LOG_OUT="$LOG_DIR/stdout.log"
LOG_ERR="$LOG_DIR/stderr.log"
SCORER_LOG_OUT="$LOG_DIR/scorer-stdout.log"
SCORER_LOG_ERR="$LOG_DIR/scorer-stderr.log"
REFRESHER_LOG_OUT="$LOG_DIR/refresher-stdout.log"
REFRESHER_LOG_ERR="$LOG_DIR/refresher-stderr.log"
BUILD_MARKER="$REPO_DIR/.next/BUILD_ID"

# --- Helpers -----------------------------------------------------------------

c_dim()   { printf "\033[2m%s\033[0m\n" "$*"; }
c_ok()    { printf "\033[32m%s\033[0m\n" "$*"; }
c_warn()  { printf "\033[33m%s\033[0m\n" "$*"; }
c_err()   { printf "\033[31m%s\033[0m\n" "$*" >&2; }

ensure_dirs() {
  mkdir -p "$LOG_DIR"
  mkdir -p "$(dirname "$PLIST_TARGET")"
}

is_loaded() {
  launchctl list 2>/dev/null | grep -q "$PLIST_LABEL"
}

scorer_loaded() {
  launchctl list 2>/dev/null | grep -q "$SCORER_LABEL"
}

refresher_loaded() {
  launchctl list 2>/dev/null | grep -q "$REFRESHER_LABEL"
}

is_port_busy() {
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | head -1
}

need_build() {
  if [ ! -f "$BUILD_MARKER" ]; then
    return 0
  fi
  # If any source file is newer than BUILD_ID, rebuild.
  if find "$REPO_DIR" \
      -path "$REPO_DIR/node_modules" -prune -o \
      -path "$REPO_DIR/.next" -prune -o \
      -path "$REPO_DIR/.git" -prune -o \
      \( -name "*.ts" -o -name "*.tsx" -o -name "*.css" -o -name "*.json" -o -name "*.mjs" \) \
      -newer "$BUILD_MARKER" -print 2>/dev/null | head -1 | grep -q .; then
    return 0
  fi
  return 1
}

# --- Commands ----------------------------------------------------------------

cmd_install() {
  ensure_dirs

  if [ ! -f "$PLIST_SOURCE" ]; then
    c_err "Source plist not found at $PLIST_SOURCE"
    c_err "Re-run after restoring scripts/${PLIST_LABEL}.plist"
    exit 1
  fi

  # Generate the per-user plist by substituting HOME-relative paths.
  cp "$PLIST_SOURCE" "$PLIST_TARGET"
  c_ok "Installed $PLIST_TARGET"

  if need_build; then
    c_dim "Source newer than build — running pnpm build…"
    (cd "$REPO_DIR" && pnpm build)
  fi

  cmd_start
}

cmd_start() {
  ensure_dirs
  if [ ! -f "$PLIST_TARGET" ]; then
    c_warn "No plist installed yet — running install first."
    cmd_install
    return
  fi
  if is_loaded; then
    c_dim "Daemon already loaded."
  else
    launchctl load -w "$PLIST_TARGET"
    c_ok "Daemon loaded."
  fi
  sleep 1
  cmd_status
}

cmd_stop() {
  if [ -f "$PLIST_TARGET" ] && is_loaded; then
    launchctl unload -w "$PLIST_TARGET"
    c_ok "Daemon unloaded."
  else
    c_dim "Daemon was not loaded."
  fi
  # Belt-and-suspenders: kill any next-server bound to our port.
  PID="$(is_port_busy || true)"
  if [ -n "${PID:-}" ]; then
    c_dim "Killing lingering listener PID $PID on port $PORT"
    kill "$PID" 2>/dev/null || true
  fi
}

cmd_restart() {
  cmd_stop
  if need_build; then
    c_dim "Source newer than build — running pnpm build…"
    (cd "$REPO_DIR" && pnpm build)
  fi
  cmd_start
}

cmd_build() {
  (cd "$REPO_DIR" && pnpm build)
  c_ok "Build complete."
}

cmd_status() {
  printf "\n"
  c_dim "─── catalyst main daemon (next start, port $PORT) ──"
  if [ -f "$PLIST_TARGET" ]; then
    c_ok "plist:     installed at $PLIST_TARGET"
  else
    c_warn "plist:     NOT installed (run: scripts/local-daemon.sh install)"
  fi
  if is_loaded; then
    PID="$(launchctl list | awk -v lbl="$PLIST_LABEL" '$3 == lbl {print $1}')"
    c_ok "agent:     loaded (PID=${PID:-?})"
  else
    c_warn "agent:     not loaded"
  fi
  PORT_PID="$(is_port_busy || true)"
  if [ -n "${PORT_PID:-}" ]; then
    c_ok "port $PORT:  listening (PID=$PORT_PID)"
    c_ok "url:       http://localhost:$PORT"
  else
    c_warn "port $PORT:  free (server not responding)"
  fi
  printf "\n"
  c_dim "─── catalyst auto-scorer (drain every 15 min) ──────"
  if [ -f "$SCORER_TARGET" ]; then
    c_ok "plist:     installed at $SCORER_TARGET"
  else
    c_warn "plist:     NOT installed (run: scripts/local-daemon.sh scorer-install)"
  fi
  if scorer_loaded; then
    SCORER_PID="$(launchctl list | awk -v lbl="$SCORER_LABEL" '$3 == lbl {print $1}')"
    c_ok "agent:     loaded (PID=${SCORER_PID:-—} when running)"
    if [ -f "$SCORER_LOG_OUT" ]; then
      LAST="$(tail -n 1 "$SCORER_LOG_OUT" 2>/dev/null | sed 's/^/             /')"
      [ -n "$LAST" ] && c_dim "last log:  $(echo "$LAST" | sed 's/^[[:space:]]*//')"
    fi
  else
    c_warn "agent:     not loaded"
  fi
  printf "\n"
  c_dim "─── catalyst refresher (news fetch every 10 min) ───"
  if [ -f "$REFRESHER_TARGET" ]; then
    c_ok "plist:     installed at $REFRESHER_TARGET"
  else
    c_warn "plist:     NOT installed (run: scripts/local-daemon.sh refresher-install)"
  fi
  if refresher_loaded; then
    c_ok "agent:     loaded"
    if [ -f "$REFRESHER_LOG_OUT" ]; then
      LASTR="$(tail -n 1 "$REFRESHER_LOG_OUT" 2>/dev/null)"
      [ -n "$LASTR" ] && c_dim "last log:  $LASTR"
    fi
  else
    c_warn "agent:     not loaded"
  fi
  printf "\n"
  c_dim "logs:      $LOG_OUT, $SCORER_LOG_OUT, $REFRESHER_LOG_OUT"
  c_dim "errors:    $LOG_ERR, $SCORER_LOG_ERR, $REFRESHER_LOG_ERR"
  printf "\n"
}

cmd_logs() {
  ensure_dirs
  if [ ! -f "$LOG_OUT" ] && [ ! -f "$LOG_ERR" ]; then
    c_warn "No logs yet. Start the daemon first."
    exit 1
  fi
  tail -F "$LOG_OUT" "$LOG_ERR"
}

cmd_uninstall() {
  cmd_stop
  if [ -f "$PLIST_TARGET" ]; then
    rm "$PLIST_TARGET"
    c_ok "Removed $PLIST_TARGET"
  fi
}

cmd_open() {
  open "http://localhost:$PORT"
}

# --- Scorer agent commands ---------------------------------------------------

cmd_scorer_install() {
  ensure_dirs
  if [ ! -f "$SCORER_SOURCE" ]; then
    c_err "Source plist not found at $SCORER_SOURCE"
    exit 1
  fi
  cp "$SCORER_SOURCE" "$SCORER_TARGET"
  c_ok "Installed $SCORER_TARGET"
  cmd_scorer_start
}

cmd_scorer_start() {
  ensure_dirs
  if [ ! -f "$SCORER_TARGET" ]; then
    c_warn "No scorer plist installed yet — running scorer-install first."
    cmd_scorer_install
    return
  fi
  if scorer_loaded; then
    c_dim "Scorer already loaded."
  else
    launchctl load -w "$SCORER_TARGET"
    c_ok "Scorer loaded. Will run drain-scoring.ts 30 every 15 minutes."
  fi
  sleep 1
  cmd_status
}

cmd_scorer_stop() {
  if [ -f "$SCORER_TARGET" ] && scorer_loaded; then
    launchctl unload -w "$SCORER_TARGET"
    c_ok "Scorer unloaded."
  else
    c_dim "Scorer was not loaded."
  fi
  # Belt-and-suspenders: kill any in-flight drain run from this agent.
  for p in $(pgrep -f "scripts/drain-scoring.ts" 2>/dev/null); do
    c_dim "Killing in-flight drain PID $p"
    kill "$p" 2>/dev/null || true
  done
}

cmd_scorer_uninstall() {
  cmd_scorer_stop
  if [ -f "$SCORER_TARGET" ]; then
    rm "$SCORER_TARGET"
    c_ok "Removed $SCORER_TARGET"
  fi
}

cmd_scorer_logs() {
  ensure_dirs
  if [ ! -f "$SCORER_LOG_OUT" ] && [ ! -f "$SCORER_LOG_ERR" ]; then
    c_warn "No scorer logs yet. Start the scorer first."
    exit 1
  fi
  tail -F "$SCORER_LOG_OUT" "$SCORER_LOG_ERR"
}

cmd_scorer_run() {
  # One-shot run, foreground. Useful to verify the path / env before
  # handing it to launchctl. Skips the StartInterval cadence.
  (cd "$REPO_DIR" && pnpm tsx scripts/drain-scoring.ts "${2:-30}")
}

# --- Refresher agent commands --------------------------------------------------

cmd_refresher_install() {
  ensure_dirs
  if [ ! -f "$REFRESHER_SOURCE" ]; then
    c_err "Source plist not found at $REFRESHER_SOURCE"
    exit 1
  fi
  cp "$REFRESHER_SOURCE" "$REFRESHER_TARGET"
  c_ok "Installed $REFRESHER_TARGET"
  cmd_refresher_start
}

cmd_refresher_start() {
  ensure_dirs
  if [ ! -f "$REFRESHER_TARGET" ]; then
    c_warn "No refresher plist installed yet — running refresher-install first."
    cmd_refresher_install
    return
  fi
  if refresher_loaded; then
    c_dim "Refresher already loaded."
  else
    launchctl load -w "$REFRESHER_TARGET"
    c_ok "Refresher loaded. Will run refresh-once.ts every 10 minutes."
  fi
  sleep 1
  cmd_status
}

cmd_refresher_stop() {
  if [ -f "$REFRESHER_TARGET" ] && refresher_loaded; then
    launchctl unload -w "$REFRESHER_TARGET"
    c_ok "Refresher unloaded."
  else
    c_dim "Refresher was not loaded."
  fi
  for p in $(pgrep -f "scripts/refresh-once.ts" 2>/dev/null); do
    c_dim "Killing in-flight refresh PID $p"
    kill "$p" 2>/dev/null || true
  done
}

cmd_refresher_uninstall() {
  cmd_refresher_stop
  if [ -f "$REFRESHER_TARGET" ]; then
    rm "$REFRESHER_TARGET"
    c_ok "Removed $REFRESHER_TARGET"
  fi
}

cmd_refresher_logs() {
  ensure_dirs
  if [ ! -f "$REFRESHER_LOG_OUT" ] && [ ! -f "$REFRESHER_LOG_ERR" ]; then
    c_warn "No refresher logs yet. Start the refresher first."
    exit 1
  fi
  tail -F "$REFRESHER_LOG_OUT" "$REFRESHER_LOG_ERR"
}

cmd_refresher_run() {
  # One-shot foreground tick (respeta SKIP_MARKETAUX solo si viene del env).
  (cd "$REPO_DIR" && SKIP_MARKETAUX=1 pnpm exec tsx scripts/refresh-once.ts)
}

# --- Dispatch ----------------------------------------------------------------

case "${1:-}" in
  install)           cmd_install ;;
  start)             cmd_start ;;
  stop)              cmd_stop ;;
  restart)           cmd_restart ;;
  status)            cmd_status ;;
  logs)              cmd_logs ;;
  build)             cmd_build ;;
  uninstall)         cmd_uninstall ;;
  open)              cmd_open ;;
  scorer-install)    cmd_scorer_install ;;
  scorer-start)      cmd_scorer_start ;;
  scorer-stop)       cmd_scorer_stop ;;
  scorer-uninstall)  cmd_scorer_uninstall ;;
  scorer-logs)       cmd_scorer_logs ;;
  scorer-run)        cmd_scorer_run "$@" ;;
  refresher-install)   cmd_refresher_install ;;
  refresher-start)     cmd_refresher_start ;;
  refresher-stop)      cmd_refresher_stop ;;
  refresher-uninstall) cmd_refresher_uninstall ;;
  refresher-logs)      cmd_refresher_logs ;;
  refresher-run)       cmd_refresher_run ;;
  ""|help|-h|--help)
    sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
    ;;
  *)
    c_err "Unknown command: $1"
    exit 2
    ;;
esac
