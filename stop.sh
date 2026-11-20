#!/usr/bin/env bash
# Stop a Review Desk server started by start.sh (pid file in the data directory).
DIR="$(cd "$(dirname "$0")" && pwd)"
DATA="${RD_DATA_DIR:-$DIR/data}"
PIDFILE="$DATA/server.pid"
if [ -f "$PIDFILE" ] && kill "$(cat "$PIDFILE")" 2>/dev/null; then
    rm -f "$PIDFILE"
    echo "reviewdesk: stopped"
else
    rm -f "$PIDFILE"
    echo "reviewdesk: was not running (no live pid in $PIDFILE)"
fi
