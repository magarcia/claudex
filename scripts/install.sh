#!/bin/sh
set -eu

repository=magarcia/claudex
version=latest
install_dir=${CLAUDEX_INSTALL_DIR:-"$HOME/.local/bin"}

usage() {
  printf 'Usage: sh install.sh [--version vX.Y.Z] [--bin-dir PATH]\n'
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version|--bin-dir)
      if [ "$#" -lt 2 ] || [ -z "$2" ]; then usage >&2; exit 2; fi
      case "$1" in
        --version) version=$2 ;;
        --bin-dir) install_dir=$2 ;;
      esac
      shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done

case "$version" in
  latest) release=latest/download ;;
  v[0-9]*)
    case "$version" in *[!a-zA-Z0-9._-]*) usage >&2; exit 2 ;; esac
    release=download/$version ;;
  *) usage >&2; exit 2 ;;
esac

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) platform=darwin-arm64 ;;
  Darwin-x86_64) platform=darwin-x64 ;;
  Linux-aarch64|Linux-arm64) platform=linux-arm64 ;;
  Linux-x86_64) platform=linux-x64 ;;
  *) printf 'Supported systems: macOS and glibc Linux, arm64 or x64.\n' >&2; exit 1 ;;
esac
if command -v sha256sum >/dev/null 2>&1; then
  checksum_command=sha256sum
elif command -v shasum >/dev/null 2>&1; then
  checksum_command=shasum
else
  printf 'Install sha256sum or shasum before installing claudex.\n' >&2
  exit 1
fi

temporary=$(mktemp -d "${TMPDIR:-/tmp}/claudex-install.XXXXXX")
staged=
cleanup() {
  for file in claudex archive.tar.gz SHA256SUMS; do
    if [ -e "$temporary/$file" ]; then unlink "$temporary/$file"; fi
  done
  rmdir "$temporary"
  if [ -n "$staged" ] && [ -e "$staged" ]; then unlink "$staged"; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

asset=claudex-$platform.tar.gz
base_url=https://github.com/$repository/releases/$release
curl --proto '=https' --tlsv1.2 --fail --location --silent --show-error \
  "$base_url/$asset" --output "$temporary/archive.tar.gz"
curl --proto '=https' --tlsv1.2 --fail --location --silent --show-error \
  "$base_url/SHA256SUMS" --output "$temporary/SHA256SUMS"
expected=$(awk -v name="$asset" '$2 == name { print $1; matches++ } END { if (matches != 1) exit 1 }' "$temporary/SHA256SUMS")
case "$expected" in *[!0-9a-fA-F]*|'') printf 'Invalid release checksum.\n' >&2; exit 1 ;; esac
if [ "${#expected}" -ne 64 ]; then printf 'Invalid release checksum.\n' >&2; exit 1; fi
if [ "$checksum_command" = sha256sum ]; then
  actual=$(sha256sum "$temporary/archive.tar.gz")
else
  actual=$(shasum -a 256 "$temporary/archive.tar.gz")
fi
actual=${actual%% *}
if [ "$actual" != "$expected" ]; then
  printf 'Release checksum mismatch. The installed binary has not changed.\n' >&2
  exit 1
fi

tar -xzf "$temporary/archive.tar.gz" -C "$temporary" claudex
if [ ! -f "$temporary/claudex" ] || [ -L "$temporary/claudex" ]; then
  printf 'The release archive must contain a regular claudex executable.\n' >&2
  exit 1
fi
mkdir -p "$install_dir"
staged=$(mktemp "$install_dir/.claudex.XXXXXX")
install -m 755 "$temporary/claudex" "$staged"
mv "$staged" "$install_dir/claudex"
printf 'Installed claudex at %s/claudex.\n' "$install_dir" >&2
case ":$PATH:" in
  *":$install_dir:"*) ;;
  *) printf 'Add %s to PATH, then run claudex.\n' "$install_dir" >&2 ;;
esac
