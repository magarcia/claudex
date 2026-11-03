#!/bin/sh
set -eu

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
runtime="$HOME/.local/bin/bun-canary"
revision=
IFS= read -r revision < "$project_root/.bun-aot-version" || :
if [ -z "$revision" ]; then
  printf '.bun-aot-version is empty.\n' >&2
  exit 1
fi
package_version=1.4.4-canary.20261101.1

if [ -x "$runtime" ] && installed_revision=$("$runtime" --revision) && [ "$installed_revision" = "$revision" ]; then
  printf 'bun-canary %s is ready at %s.\n' "$revision" "$runtime"
  exit 0
fi

if [ -e "$runtime" ] || [ -L "$runtime" ]; then
  printf 'Existing %s differs from .bun-aot-version; it has not been replaced.\n' "$runtime" >&2
  exit 1
fi

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64)
    platform=darwin-aarch64
    checksum=ac6f96498c8e514366f3e1713064211c068faadff60e7d7238dd17313ee09519 ;;
  Darwin-x86_64)
    platform=darwin-x64
    checksum=444f95088a711b148e5f74a67b9500d1e9dc4df2f9dc477fe97d038895c639f8 ;;
  Linux-aarch64)
    platform=linux-aarch64
    checksum=b9b779eaa1f80cf5935e3ae5669e52b78efa12b5f57dfb1b6bc321248e1def2a ;;
  Linux-x86_64)
    platform=linux-x64
    checksum=a451026236522d11b59794609f837766d8dc16eede99d93b3c1843b887b249b4 ;;
  *) printf 'No pinned Bun download for this platform.\n' >&2; exit 1 ;;
esac

archive=$(mktemp "${TMPDIR:-/tmp}/claudex-bun.XXXXXX")
binary_temp=
cleanup() {
  if [ -e "$archive" ]; then unlink "$archive"; fi
  if [ -n "$binary_temp" ] && [ -e "$binary_temp" ]; then unlink "$binary_temp"; fi
}
trap cleanup EXIT

url="https://registry.npmjs.org/@oven/bun-$platform/-/bun-$platform-$package_version.tgz"
if ! curl --fail --location --silent --show-error --connect-timeout 15 --max-time 180 \
  "$url" --output "$archive"; then
  printf 'Could not download pinned Bun package %s for %s.\n' "$package_version" "$platform" >&2
  exit 1
fi
if ! printf '%s  %s\n' "$checksum" "$archive" | shasum -a 256 --check --status; then
  printf 'Pinned Bun package checksum mismatch for %s.\n' "$platform" >&2
  exit 1
fi
mkdir -p "$(dirname -- "$runtime")"
binary_temp=$(mktemp "${runtime}.XXXXXX")
if ! tar -xOzf "$archive" package/bin/bun > "$binary_temp"; then
  printf 'Could not extract the pinned Bun executable for %s.\n' "$platform" >&2
  exit 1
fi
chmod 755 "$binary_temp"
if ! downloaded_revision=$("$binary_temp" --revision); then
  printf 'Could not read the downloaded Bun revision.\n' >&2
  exit 1
fi
if [ "$downloaded_revision" != "$revision" ]; then
  printf 'The downloaded Bun does not match .bun-aot-version (expected %s, got %s).\n' "$revision" "$downloaded_revision" >&2
  exit 1
fi
mv "$binary_temp" "$runtime"
printf 'bun-canary %s installed at %s.\n' "$revision" "$runtime"
