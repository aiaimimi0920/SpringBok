#!/usr/bin/env bash
set -euo pipefail

# Exact official release, verified before extracting. Shared by the executor and credential-free CI.
test "$(uname -s)" = Linux
test "$(uname -m)" = x86_64
test -n "${RUNNER_TEMP:-}"
test "$(realpath "$RUNNER_TEMP")" = "$RUNNER_TEMP"
version=7.6.9
sha256=1da6d6d6035d651f20e70ddee7c4c15ac6ab8b9fb40ee92240d91263f28a884b
directory="$RUNNER_TEMP/sba-pwsh-$version"
mkdir -m 700 "$directory"
archive="$directory/powershell.tar.gz"
curl --fail --location --proto '=https' --proto-redir '=https' \
  --connect-timeout 15 --max-time 180 --retry 1 --retry-max-time 240 \
  "https://github.com/PowerShell/PowerShell/releases/download/v$version/powershell-$version-linux-x64.tar.gz" \
  --output "$archive"
printf '%s  %s\n' "$sha256" "$archive" | sha256sum --check --strict
tar --extract --gzip --file "$archive" --directory "$directory" --no-same-owner
chmod 700 "$directory/pwsh"
test "$("$directory/pwsh" -NoLogo -NoProfile -NonInteractive -Command '$PSVersionTable.PSVersion.ToString()')" = "$version"
