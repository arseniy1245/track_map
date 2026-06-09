#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js not found. Run ./install.sh first."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "node_modules not found. Run ./install.sh first."
  exit 1
fi

mkdir -p storage/logs

export PORT="${PORT:-3000}"

PID_FILE="$PROJECT_DIR/storage/map-routes.pid"
STDOUT_LOG="$PROJECT_DIR/storage/logs/stdout.log"
STDERR_LOG="$PROJECT_DIR/storage/logs/stderr.log"
APP_LOG="$PROJECT_DIR/storage/logs/server.log"

if [ -f "$PID_FILE" ]; then
  existing_pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -n "$existing_pid" ] && kill -0 "$existing_pid" >/dev/null 2>&1; then
    echo "Map Routes is already running."
    echo "PID: $existing_pid"
    echo "URL: http://localhost:$PORT"
    echo "App log: $APP_LOG"
    echo "stderr: $STDERR_LOG"
    exit 0
  fi

  rm -f "$PID_FILE"
fi

echo "Starting Map Routes in background..."
echo "PORT: $PORT"

nohup node server.js >"$STDOUT_LOG" 2>"$STDERR_LOG" &
server_pid="$!"
echo "$server_pid" > "$PID_FILE"

sleep 1

if ! kill -0 "$server_pid" >/dev/null 2>&1; then
  echo "Server failed to start."
  echo "stderr:"
  tail -n 30 "$STDERR_LOG" 2>/dev/null || true
  rm -f "$PID_FILE"
  exit 1
fi

echo "Server started."
echo "PID: $server_pid"
echo "URL: http://localhost:$PORT"
echo "App log: $APP_LOG"
echo "stdout: $STDOUT_LOG"
echo "stderr: $STDERR_LOG"
echo
echo "Follow logs:"
echo "tail -f \"$APP_LOG\""
echo "tail -f \"$STDERR_LOG\""
