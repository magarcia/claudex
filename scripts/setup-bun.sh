#!/bin/sh
set -eu

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
runtime="$HOME/.local/bin/bun-canary"
IFS= read -r revision < "$project_root/.bun-aot-version"

if [ -x "$runtime" ] && [ "$("$runtime" --revision)" = "$revision" ]; then
  printf 'bun-canary %s is ready at %s.\n' "$revision" "$runtime"
  exit 0
fi

if [ -e "$runtime" ]; then
  printf 'Existing %s differs from .bun-aot-version; it has not been replaced.\n' "$runtime" >&2
  exit 1
fi

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64)
    platform=darwin-aarch64
    checksum=9878f8609a02b7b23dcbb9a1b592aa8ab820ed8652975814c5646b36957e1680 ;;
  Darwin-x86_64)
    platform=darwin-x64
    checksum=fdb26147aac4cc8ce719cede03dbe89f26c73e411ca49c0f4da0ccc9d1139497 ;;
  Linux-aarch64)
    platform=linux-aarch64
    checksum=d05f60ba50dfb733974b4acd6135acf0a628cac9a966af6324c1a12f99883340 ;;
  Linux-x86_64)
    platform=linux-x64
    checksum=43e54d1d6ff2924454ee523a40a6d862ba5ec4e5a8796329e61d22fea67f25c2 ;;
  *) printf 'No pinned Bun download for this platform.\n' >&2; exit 1 ;;
esac

archive=$(mktemp "${TMPDIR:-/tmp}/claudex-bun.XXXXXX")
binary_temp=
cleanup() {
  unlink "$archive"
  if [ -n "$binary_temp" ] && [ -e "$binary_temp" ]; then unlink "$binary_temp"; fi
}
trap cleanup EXIT

curl --fail --location --silent --show-error \
  "https://github.com/oven-sh/bun/releases/download/canary/bun-$platform.zip" --output "$archive"
printf '%s  %s\n' "$checksum" "$archive" | shasum -a 256 --check --status
mkdir -p "$(dirname -- "$runtime")"
binary_temp=$(mktemp "${runtime}.XXXXXX")
unzip -p "$archive" "bun-$platform/bun" > "$binary_temp"
chmod 755 "$binary_temp"
if [ "$("$binary_temp" --revision)" != "$revision" ]; then
  printf 'The downloaded Bun does not match .bun-aot-version.\n' >&2
  exit 1
fi
mv "$binary_temp" "$runtime"
printf 'bun-canary %s installed at %s.\n' "$revision" "$runtime"
