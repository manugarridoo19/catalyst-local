#!/usr/bin/env bash
# Catalyst local daemon — keep the dashboard reachable on localhost even
# when Vercel is suspended. Wraps a macOS LaunchAgent that runs the
# production `next start` build on port 3030, with auto-restart and
# bounded resources so we don't reproduce the dev-mode RAM-leak incident.
#
# Usage:
#   scripts/local-daemon.sh install   First-time setup: copies the plist and loads it
#   scripts/local-daemon.sh start     Start (loads the agent)
#   scripts/local-daemon.sh stop      Stop (unloads the agent)
#   scripts/local-daemon.sh restart   Stop, build if needed, start
#   scripts/local-daemon.sh status    Show agent state + port listener
#   scripts/local-daemon.sh logs      Tail the daemon log
#   scripts/local-daemon.sh build     Force-rebuild .next (run after pulling code)
#   scripts/local-daemon.sh uninstall Remove plist + unload
#   scripts/local-daemon.sh open      Open the dashboard in default browser

set -euo pipefail

# --- Config ------------------------------------------------------------------

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${CATALYST_LOCAL_PORT:-3030}"
PLIST_LABEL="com.catalyst.local"
PLIST_TARGET="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"
PLIST_SOURCE="$REPO_DIR/scripts/${PLIST_LABEL}.plist"
LOG_DIR="$REPO_DIR/.next/daemon-logs"
LOG_OUT="$LOG_DIR/stdout.log"
LOG_ERR="$LOG_DIR/stderr.log"
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
  c_dim "─── catalyst local daemon ───────────────────────"
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
  c_dim "logs:      $LOG_OUT"
  c_dim "errors:    $LOG_ERR"
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

# --- Dispatch ----------------------------------------------------------------

case "${1:-}" in
  install)   cmd_install ;;
  start)     cmd_start ;;
  stop)      cmd_stop ;;
  restart)   cmd_restart ;;
  status)    cmd_status ;;
  logs)      cmd_logs ;;
  build)     cmd_build ;;
  uninstall) cmd_uninstall ;;
  open)      cmd_open ;;
  ""|help|-h|--help)
    sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'
    ;;
  *)
    c_err "Unknown command: $1"
    exit 2
    ;;
esac
