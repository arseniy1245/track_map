#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"

need_node_install=false

if ! command -v node >/dev/null 2>&1; then
  need_node_install=true
elif ! node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 18 ? 0 : 1)" >/dev/null 2>&1; then
  need_node_install=true
fi

if [ "$need_node_install" = true ]; then
  if ! command -v apt-get >/dev/null 2>&1; then
    echo "Node.js 18+ не найден. Установите Node.js вручную для вашей ОС."
    exit 1
  fi

  SUDO=""
  if [ "$(id -u)" -ne 0 ]; then
    SUDO="sudo"
  fi

  echo "Устанавливаю Node.js 20..."
  $SUDO apt-get update
  $SUDO apt-get install -y curl ca-certificates gnupg
  curl -fsSL https://deb.nodesource.com/setup_20.x | $SUDO bash -
  $SUDO apt-get install -y nodejs
fi

echo "Node: $(node -v)"
echo "npm: $(npm -v)"

if [ -f package-lock.json ]; then
  npm ci
else
  npm install
fi

mkdir -p storage

echo "Готово. Для запуска используйте:"
echo "./start-server.sh"
