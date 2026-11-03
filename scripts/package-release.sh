#!/bin/sh
set -eu

case "${1:-}" in
  darwin-arm64|darwin-x64|linux-arm64|linux-x64) platform=$1 ;;
  *) printf 'Usage: sh scripts/package-release.sh <darwin-arm64|darwin-x64|linux-arm64|linux-x64>\n' >&2; exit 2 ;;
esac
if [ "$#" -ne 1 ]; then
  printf 'Expected exactly one release platform.\n' >&2
  exit 2
fi

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$project_root"
test -x dist/claudex
test -s LICENSE
test -s licenses/valibot.txt
mkdir -p release
tar -czf "release/claudex-$platform.tar.gz" LICENSE licenses -C dist claudex
