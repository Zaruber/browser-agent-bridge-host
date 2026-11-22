#!/bin/sh
# Browser Agent Bridge: установка native-хоста одной командой, без папки проекта.
#
#   curl -fsSL https://raw.githubusercontent.com/Zaruber/browser-agent-bridge-host/main/install.sh | sh -s -- --agent claude
#
# Что делает:
#   1. Определяет ОС и архитектуру (macOS, Linux; x64, arm64).
#   2. Ищет Node.js 18+ с npm. Если нет — скачивает официальный Node.js LTS с nodejs.org
#      в ~/.browser-agent/node (без sudo, проверяет SHA-256).
#   3. Скачивает хост с GitHub в ~/.browser-agent/app и ставит зависимости.
#   4. Регистрирует native-хост в Chrome и подключает агентов (setup.js setup "$@").
# Повторный запуск обновляет всё до последней версии.
#
# Аргументы передаются в setup: --agent claude,codex | auto | none, --trust.
# Другие команды: ... | sh -s -- status | uninstall

set -eu

REPO="Zaruber/browser-agent-bridge-host"
BRANCH="main"
NODE_MAJOR=22
MIN_NODE=18
BASE="$HOME/.browser-agent"
APP="$BASE/app"
NODE_DIR="$BASE/node"

say()  { printf '%s\n' "$*"; }
step() { printf '\n→ %s\n' "$*"; }
die()  { printf '\n✗ %s\n' "$*" >&2; exit 1; }

fetch() { # fetch URL FILE
  if command -v curl >/dev/null 2>&1; then curl -fsSL --retry 3 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then wget -q -O "$2" "$1"
  else die "Нужен curl или wget."; fi
}

sha256() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  elif command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else die "Нет shasum/sha256sum для проверки загрузки."; fi
}

detect_platform() {
  case "$(uname -s)" in
    Darwin) OS=darwin; OS_NAME=macOS ;;
    Linux)  OS=linux;  OS_NAME=Linux ;;
    MINGW*|MSYS*|CYGWIN*) die "Windows пока не поддерживается. Нужны macOS или Linux." ;;
    *) die "Неизвестная ОС: $(uname -s). Поддерживаются macOS и Linux." ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64) ARCH=x64 ;;
    arm64|aarch64) ARCH=arm64 ;;
    *) die "Архитектура $(uname -m) не поддерживается." ;;
  esac
  # Rosetta: терминал под x86_64 на Apple Silicon — берём родной arm64
  if [ "$OS" = darwin ] && [ "$ARCH" = x64 ] && [ "$(sysctl -in hw.optional.arm64 2>/dev/null || echo 0)" = 1 ]; then
    ARCH=arm64
  fi
  say "Система: $OS_NAME ($ARCH)"
}

node_ok() { # node_ok /path/to/node
  [ -x "$1" ] || return 1
  major=$("$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null) || return 1
  [ "${major:-0}" -ge "$MIN_NODE" ] 2>/dev/null || return 1
  [ -x "$(dirname "$1")/npm" ] || command -v npm >/dev/null 2>&1
}

find_node() {
  NODE=""
  for cand in "$NODE_DIR/bin/node" "$(command -v node 2>/dev/null || true)" \
              /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    [ -n "$cand" ] || continue
    if node_ok "$cand"; then NODE="$cand"; return 0; fi
  done
  return 1
}

install_node() {
  step "Node.js $MIN_NODE+ не найден. Ставлю Node.js $NODE_MAJOR LTS в ${NODE_DIR#"$HOME"/}"
  say "  (только для Browser Agent, без sudo; системный Node не трогаю)"
  tmp=$(mktemp -d)
  dist="https://nodejs.org/dist/latest-v$NODE_MAJOR.x"
  fetch "$dist/SHASUMS256.txt" "$tmp/SHASUMS256.txt" || die "Не удалось скачать список версий с nodejs.org."
  line=$(grep " node-v[0-9.]*-$OS-$ARCH\.tar\.gz\$" "$tmp/SHASUMS256.txt" | head -1)
  [ -n "$line" ] || die "На nodejs.org нет сборки для $OS-$ARCH."
  sum=${line%% *}
  file=${line##* }
  say "  скачиваю $file"
  fetch "$dist/$file" "$tmp/$file" || die "Не удалось скачать $file."
  [ "$(sha256 "$tmp/$file")" = "$sum" ] || die "Контрольная сумма $file не совпала. Повтори позже."
  mkdir -p "$tmp/x"
  tar -xzf "$tmp/$file" -C "$tmp/x"
  rm -rf "$NODE_DIR"
  mkdir -p "$BASE"
  mv "$tmp/x/${file%.tar.gz}" "$NODE_DIR"
  rm -rf "$tmp"
  NODE="$NODE_DIR/bin/node"
  node_ok "$NODE" || die "Node.js установился, но не запускается."
}

install_app() {
  step "Скачиваю Browser Agent Bridge с github.com/$REPO"
  tmp=$(mktemp -d)
  fetch "https://codeload.github.com/$REPO/tar.gz/refs/heads/$BRANCH" "$tmp/app.tar.gz" \
    || die "Не удалось скачать хост с GitHub."
  mkdir -p "$tmp/x"
  tar -xzf "$tmp/app.tar.gz" -C "$tmp/x"
  src=$(find "$tmp/x" -mindepth 1 -maxdepth 1 -type d | head -1)
  [ -f "$src/setup.js" ] || die "В архиве нет setup.js."
  rm -rf "$APP.new"
  mv "$src" "$APP.new"
  rm -rf "$tmp"

  step "Ставлю зависимости"
  NPM="$(dirname "$NODE")/npm"
  [ -x "$NPM" ] || NPM=$(command -v npm)
  (cd "$APP.new" && PATH="$(dirname "$NODE"):$PATH" "$NPM" install --omit=dev --no-audit --no-fund --loglevel=error >/dev/null) \
    || die "npm install не удался."
  rm -rf "$APP.old"
  [ -d "$APP" ] && mv "$APP" "$APP.old"
  mv "$APP.new" "$APP"
  rm -rf "$APP.old"
  say "  версия $("$NODE" -p 'require(process.argv[1]).version' "$APP/package.json")"
}

main() {
  say "Browser Agent Bridge: установка"
  detect_platform
  mkdir -p "$BASE"
  chmod 700 "$BASE"
  if find_node; then say "Node.js: $NODE ($("$NODE" -v))"; else install_node; say "Node.js: $NODE ($("$NODE" -v))"; fi
  install_app
  step "Регистрирую хост в браузерах и подключаю агентов"
  [ $# -gt 0 ] || set -- setup
  case "$1" in setup|status|uninstall|add|remove|-h|--help) ;; *) set -- setup "$@" ;; esac
  exec "$NODE" "$APP/setup.js" "$@"
}

# всё в функции: если загрузка оборвётся на середине, sh не выполнит половину скрипта
main "$@"
