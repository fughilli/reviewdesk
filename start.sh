#!/usr/bin/env bash
# Start the Review Desk server in the background, unless it is already answering.
# Idempotent: safe to call from a login script or a container entrypoint.
#
# Env: RD_HOST (default 127.0.0.1), RD_PORT (default 8471), RD_DATA_DIR (default ./data),
# plus the optional reference-linking settings described in README.md.
# The log and pid file go in the data directory.
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
HOST="${RD_HOST:-127.0.0.1}"
PORT="${RD_PORT:-8471}"
DATA="${RD_DATA_DIR:-$DIR/data}"
CHECK_HOST="$HOST"
case "$HOST" in 0.0.0.0|::|"") CHECK_HOST=127.0.0.1 ;; esac
up() { curl -fsS -m 2 "http://${CHECK_HOST}:${PORT}/healthz" >/dev/null 2>&1; }

if up; then
    echo "reviewdesk: already running on http://${HOST}:${PORT}/"
    exit 0
fi
mkdir -p "$DATA"
RD_DATA_DIR="$DATA" nohup python3 "$DIR/server.py" --host "$HOST" --port "$PORT" \
    >>"$DATA/server.log" 2>&1 < /dev/null &
echo $! > "$DATA/server.pid"
for _ in $(seq 1 25); do up && break; sleep 0.2; done
if ! up; then
    echo "reviewdesk: did not come up; see $DATA/server.log" >&2
    exit 1
fi
echo "reviewdesk: started on http://${HOST}:${PORT}/ (pid $(cat "$DATA/server.pid"), log $DATA/server.log)"
