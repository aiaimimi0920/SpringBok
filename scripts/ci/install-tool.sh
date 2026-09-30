#!/usr/bin/env bash
set -euo pipefail

# Fixed official release archives; no repository secrets or install hooks.
case "${1:-}" in
  actionlint)
    tool=actionlint
    url=https://github.com/rhysd/actionlint/releases/download/v1.7.12/actionlint_1.7.12_linux_amd64.tar.gz
    sha256=8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8
    ;;
  gitleaks)
    tool=gitleaks
    url=https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz
    sha256=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb
    ;;
  *) echo "Usage: $0 actionlint|gitleaks [destination]" >&2; exit 2 ;;
esac

destination=${2:-.tmp/ci-tools}
archive_dir=$(mktemp -d)
trap 'rm -rf "$archive_dir"' EXIT
curl --fail --silent --show-error --location --retry 3 "$url" -o "$archive_dir/tool.tar.gz"
printf '%s  %s\n' "$sha256" "$archive_dir/tool.tar.gz" | sha256sum --check --status
mkdir -p "$destination"
tar -xzf "$archive_dir/tool.tar.gz" -C "$destination" "$tool"
chmod +x "$destination/$tool"
