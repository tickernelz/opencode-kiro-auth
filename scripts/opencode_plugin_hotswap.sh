#!/usr/bin/env bash
set -euo pipefail

pkg="${1:-@zhafron/opencode-kiro-auth}"
repo="${2:-$(pwd)}"

if [[ ! -d "$repo/dist" ]]; then
  echo "Missing dist/ in $repo. Run: bun run build" >&2
  exit 1
fi

cache_root="${OPENCODE_CACHE_DIR:-$HOME/.cache/opencode}"
pkg_dir="$cache_root/packages/${pkg}@latest/node_modules/${pkg}"

if [[ ! -d "$pkg_dir" ]]; then
  echo "OpenCode has not installed $pkg yet. Run any opencode command that loads plugins first." >&2
  exit 1
fi

stamp="$(date +%Y%m%d-%H%M%S)"
backup="$pkg_dir/dist.bak.$stamp"

cp -a "$pkg_dir/dist" "$backup"
rm -rf "$pkg_dir/dist"
cp -a "$repo/dist" "$pkg_dir/dist"
cp "$repo/package.json" "$pkg_dir/package.json"

echo "Hot-swapped $pkg dist/"
echo "Backup: $backup"
