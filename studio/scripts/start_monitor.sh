#!/usr/bin/env bash
# Arranca o monitor HTTP em background (sobrevive a fechar o terminal).
# Uso:  ./scripts/start_monitor.sh  [porta]  [bind]
#       ou: bash scripts/start_monitor.sh 8765 127.0.0.1
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PORT="${1:-${STUDIO_MONITOR_PORT:-8765}}"
BIND="${2:-${STUDIO_MONITOR_BIND:-127.0.0.1}}"
LOG="${STUDIO_MONITOR_OUT:-/tmp/pfv-monitor.log}"
PIDFILE="${STUDIO_MONITOR_PID:-/tmp/pfv-monitor.pid}"

# Mata instância anterior se houver (idempotente)
if [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  kill "$(cat "$PIDFILE")" 2>/dev/null || true
  sleep 1
fi

# Lança detachado
cd "$HERE/.."
nohup setsid bash -c "exec python3 \"$HERE/monitor_server.py\" \
  --port '$PORT' --bind '$BIND' \
  > '$LOG' 2>&1" < /dev/null &
PID=$!
echo "$PID" > "$PIDFILE"

# Esperar até o servidor estar pronto (até 5s)
for i in 1 2 3 4 5; do
  if curl -fs "http://$BIND:$PORT/api/ping" >/dev/null 2>&1; then
    echo "studio-monitor: pronto em http://$BIND:$PORT/   pid=$PID   log=$LOG"
    echo "Abre no browser: http://$BIND:$PORT/"
    exit 0
  fi
  sleep 1
done

# Se falhou, mostrar erro
echo "studio-monitor: falhou a arrancar. Log:" >&2
tail -20 "$LOG" >&2 || true
exit 1
