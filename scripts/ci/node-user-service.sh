#!/usr/bin/env bash
set -euo pipefail

# 授权边界仅是一次性 GitHub-hosted runner；不在开发机/自托管机创建账号或开启 linger。
[[ ${GITHUB_ACTIONS:-} == true && ${RUNNER_ENVIRONMENT:-} == github-hosted ]]
name=springbok-systemd-test
! id "$name" >/dev/null 2>&1
node=$(command -v node)
node=$(readlink -f "$node")
sudo useradd --create-home --shell /bin/bash "$name"
uid=$(id -u "$name")
home=$(getent passwd "$name" | cut -d: -f6)
sudo -u "$name" mkdir -p "$home/.config/systemd/user" "$home/springbok-tmp"
sudo -u "$name" chmod 700 "$home/.config" "$home/.config/systemd" "$home/.config/systemd/user" "$home/springbok-tmp"
cleanup() {
  sudo loginctl disable-linger "$name"
  sudo systemctl stop "user@$uid.service"
}
trap cleanup EXIT
sudo loginctl enable-linger "$name"
sudo systemctl start "user@$uid.service"
run_phase() {
  sudo -u "$name" env HOME="$home" XDG_RUNTIME_DIR="/run/user/$uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" \
    TMPDIR="$home/springbok-tmp" SPRINGBOK_DISPOSABLE_SYSTEMD_CI=1 PATH="$(dirname "$node"):/usr/bin:/bin" \
    "$node" tests/node-user-service-systemd.mjs "$1"
}
run_phase exercise
sudo systemctl restart "user@$uid.service"
run_phase restart
sudo systemctl restart "user@$uid.service"
run_phase disabled
mkdir -p .tmp/systemd-evidence
sudo cat "$home/springbok-systemd-evidence/execute-journal.txt" > .tmp/systemd-evidence/execute-journal.txt
sudo cat "$home/springbok-systemd-evidence/observe-journal.txt" > .tmp/systemd-evidence/observe-journal.txt
printf 'actual isolated user manager acceptance passed\n' > .tmp/systemd-evidence/result.txt
