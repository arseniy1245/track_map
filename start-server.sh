#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js не найден. Сначала запустите ./install.sh"
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "Папка node_modules не найдена. Сначала запустите ./install.sh"
  exit 1
fi

mkdir -p storage

export PORT="${PORT:-3000}"

echo "Запускаю сервер на порту $PORT..."
echo "Адрес: http://localhost:$PORT"

exec npm start
