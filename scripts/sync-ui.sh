#!/bin/sh
# Синхронізує custom_components/oddinvest/www/shared/ з репозиторієм
# oddinvest — джерелом спільного UI.
#
# Панель і веб-UI бекенда — один і той самий компонент. Живе він там, бо
# Go віддає його через go:embed; сюди приїжджає вендором, щоб інтеграція
# лишалась самодостатньою: HACS ставить її окремо, і панель зобов'язана
# працювати без доступу до GitHub.
#
#   sh scripts/sync-ui.sh                 — стягнути з main репозиторію oddinvest
#   sh scripts/sync-ui.sh --check         — нічого не писати, лише звірити
#   sh scripts/sync-ui.sh --from ../oddinvest   — узяти з локальної копії
#
# Той самий механізм, яким CI уже тягне contract/fixtures/*: джерело
# правди одне, а розбіжність має падати гучно, а не жити тихо.
set -eu

RAW=https://raw.githubusercontent.com/ODDsama/oddinvest/main
DEST=custom_components/oddinvest/www/shared
FROM=""
CHECK=0

while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK=1 ;;
    --from) FROM="${2:?--from потребує шляху}"; shift ;;
    *) echo "невідомий аргумент: $1" >&2; exit 2 ;;
  esac
  shift
done

[ -d custom_components/oddinvest ] || {
  echo "запускати з кореня репозиторію ha-oddinvest" >&2; exit 2; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# --- манiфест ---
if [ -n "$FROM" ]; then
  cp "$FROM/contract/ui-manifest.json" "$work/manifest.json"
else
  curl -fsSL -o "$work/manifest.json" "$RAW/contract/ui-manifest.json"
fi

# Розбираємо без jq: він є не всюди, а формат ми ж і генеруємо.
paths=$(sed -n 's/.*"path": "\([^"]*\)".*/\1/p' "$work/manifest.json")
[ -n "$paths" ] || { echo "манiфест порожній або не розібрався" >&2; exit 1; }

# --- вивантаження у тимчасовий каталог ---
for p in $paths; do
  mkdir -p "$work/new/$(dirname "$p")"
  if [ -n "$FROM" ]; then
    cp "$FROM/internal/api/web/$p" "$work/new/$p"
  else
    curl -fsSL -o "$work/new/$p" "$RAW/internal/api/web/$p"
  fi
  want=$(sed -n "s|.*\"path\": \"$p\", \"sha256\": \"\([^\"]*\)\".*|\1|p" "$work/manifest.json")
  got=$(sha256sum "$work/new/$p" | cut -d' ' -f1)
  [ "$want" = "$got" ] || {
    echo "!! $p: sha256 не збігається з манiфестом" >&2
    echo "   очікували $want" >&2
    echo "   отримали  $got" >&2
    exit 1
  }
done

# --- звірка або запис ---
n=$(echo "$paths" | wc -l | tr -d ' ')
if [ "$CHECK" = "1" ]; then
  if diff -r -q "$work/new" "$DEST" >/dev/null 2>&1; then
    echo "shared/ збігається з oddinvest ($n файлів)"
  else
    echo "!! shared/ розійшовся з oddinvest — перезапусти: sh scripts/sync-ui.sh" >&2
    diff -r -u "$DEST" "$work/new" || true
    exit 1
  fi
else
  # Каталог перезаписуємо ЦІЛКОМ: файл, який зник у джерелі, має зникнути
  # і тут, інакше вендор поволі обростає модулями, яких уже немає.
  rm -rf "$DEST"
  mkdir -p "$(dirname "$DEST")"
  cp -r "$work/new" "$DEST"
  echo "синхронізовано $n файлів у $DEST"
fi
