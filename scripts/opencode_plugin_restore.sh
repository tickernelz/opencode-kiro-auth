#!/usr/bin/env bash
set -euo pipefail

pkg="${1:-@zhafron/opencode-kiro-auth}"
cache_root="${OPENCODE_CACHE_DIR:-$HOME/.cache/opencode}"
pkg_dir="$cache_root/packages/${pkg}@latest/node_modules/${pkg}"

if [[ ! -d "$pkg_dir" ]]; then
  echo "OpenCode package cache not found for $pkg" >&2
  exit 1
fi

backup="${2:-}"
if [[ -z "$backup" ]]; then
  backup="$(find "$pkg_dir" -maxdepth 1 -type d -name 'dist.bak.*' | sort | tail -n 1)"
fi

if [[ -z "$backup" || ! -d "$backup" ]]; then
  echo "No dist backup found for $pkg" >&2
  exit 1
fi

rm -rf "$pkg_dir/dist"
mv "$backup" "$pkg_dir/dist"

echo "Restored $pkg from $backup"
