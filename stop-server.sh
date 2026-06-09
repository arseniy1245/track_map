#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"

PID_FILE="$PROJECT_DIR/storage/map-routes.pid"

if [ ! -f "$PID_FILE" ]; then
  echo "PID file not found. Server is probably not running."
  exit 0
fi

server_pid="$(cat "$PID_FILE" 2>/dev/null || true)"

if [ -z "$server_pid" ]; then
  echo "PID file is empty. Removing it."
  rm -f "$PID_FILE"
  exit 0
fi

if ! kill -0 "$server_pid" >/dev/null 2>&1; then
  echo "Process $server_pid is not running. Removing stale PID file."
  rm -f "$PID_FILE"
  exit 0
fi

echo "Stopping Map Routes..."
echo "PID: $server_pid"

kill "$server_pid"

for _ in $(seq 1 10); do
  if ! kill -0 "$server_pid" >/dev/null 2>&1; then
    rm -f "$PID_FILE"
    echo "Server stopped."
    exit 0
  fi

  sleep 1
done

echo "Server did not stop after 10 seconds. Sending SIGKILL..."
kill -9 "$server_pid" >/dev/null 2>&1 || true
rm -f "$PID_FILE"
echo "Server stopped."
