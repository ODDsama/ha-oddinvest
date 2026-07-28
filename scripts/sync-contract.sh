#!/bin/sh
# Синхронізує tests/fixtures/ з репозиторієм oddinvest — джерелом контракту.
#
# CI стягує ці три файли перед кожним запуском (див. .github/workflows/ci.yml),
# і саме тому їхня локальна копія тихо старіла: тести на машині розробника
# бігали проти вчорашньої схеми й проходили, а справжня перевірка була лише
# на CI. Різниця доростала до тисяч байтів.
#
#   sh scripts/sync-contract.sh                    — стягнути з main
#   sh scripts/sync-contract.sh --check            — лише звірити
#   sh scripts/sync-contract.sh --from ../oddinvest — узяти з локальної копії
#
# Той самий інтерфейс, що й у sync-ui.sh: різні речі, але звичка одна.
set -eu

RAW=https://raw.githubusercontent.com/ODDsama/oddinvest/main
DEST=tests/fixtures
FROM=""
CHECK=0

# Що саме тягнемо: шлях у джерелі → ім'я тут.
FILES="contract/fixtures/basic.json:basic.json
contract/fixtures/empty.json:empty.json
contract/oddinvest-state.schema.json:oddinvest-state.schema.json"

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

for pair in $FILES; do
  src=${pair%%:*}
  dst=${pair#*:}
  if [ -n "$FROM" ]; then
    cp "$FROM/$src" "$work/$dst"
  else
    curl -fsSL -o "$work/$dst" "$RAW/$src"
  fi
done

n=0
stale=0
for pair in $FILES; do
  dst=${pair#*:}
  n=$((n + 1))
  if [ "$CHECK" = "1" ]; then
    if ! diff -q "$work/$dst" "$DEST/$dst" >/dev/null 2>&1; then
      echo "!! $dst розійшовся з oddinvest" >&2
      stale=1
    fi
  else
    cp "$work/$dst" "$DEST/$dst"
  fi
done

if [ "$CHECK" = "1" ]; then
  [ "$stale" = "0" ] || {
    echo "перезапусти: sh scripts/sync-contract.sh" >&2; exit 1; }
  echo "фікстури контракту збігаються з oddinvest ($n файлів)"
else
  echo "оновлено $n файлів у $DEST"
fi
