#!/usr/bin/env bash
set -euo pipefail

# 授权边界仅是一次性 GitHub-hosted runner；不在开发机/自托管机创建账号或开启 linger。
[[ ${GITHUB_ACTIONS:-} == true && ${RUNNER_ENVIRONMENT:-} == github-hosted ]]
name=springbok-systemd-test
started=$(date --iso-8601=seconds)
mkdir -p .tmp/systemd-evidence
! id "$name" >/dev/null 2>&1
node=$(command -v node)
node=$(readlink -f "$node")
sudo useradd --create-home --shell /bin/bash "$name"
uid=$(id -u "$name")
home=$(getent passwd "$name" | cut -d: -f6)
sudo -u "$name" mkdir -p "$home/.config/systemd/user" "$home/springbok-tmp" "$home/checkout" "$home/runtime"
sudo -u "$name" chmod 700 "$home/.config" "$home/.config/systemd" "$home/.config/systemd/user" "$home/springbok-tmp"
# GitHub runner 的 home/cache 不保证其他 uid 可访问或符合产品运行时 owner 策略。
# 在新账户内导出同一精确 Git HEAD；不放宽主检出或产品权限检查。
git archive HEAD | sudo -u "$name" tar -x -C "$home/checkout"
stat -c 'Node runtime owner=%u mode=%a path=%n' "$node"
sudo chmod 700 "$home/runtime"
sudo install -o "$name" -g "$name" -m 700 "$node" "$home/runtime/node"
sudo cmp "$node" "$home/runtime/node"
node="$home/runtime/node"
cleanup() {
  code=$?
  printf 'CI exitCode=%s\n' "$code" > .tmp/systemd-evidence/exit.txt
  if [[ $code != 0 ]]; then
    if ! sudo systemctl status "user@$uid.service" --no-pager > .tmp/systemd-evidence/user-manager-status.txt; then
      printf 'Failed manager status retained for diagnosis\n'
    fi
    sudo journalctl -u "user@$uid.service" --since "$started" --no-pager -n 120 > .tmp/systemd-evidence/user-manager-journal.txt
    cat .tmp/systemd-evidence/user-manager-status.txt .tmp/systemd-evidence/user-manager-journal.txt
  fi
  sudo loginctl disable-linger "$name"
  sudo systemctl stop "user@$uid.service"
  exit "$code"
}
trap cleanup EXIT
sudo loginctl enable-linger "$name"
sudo systemctl start "user@$uid.service"
run_phase() {
  sudo -u "$name" env HOME="$home" XDG_RUNTIME_DIR="/run/user/$uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" \
    TMPDIR="$home/springbok-tmp" SPRINGBOK_DISPOSABLE_SYSTEMD_CI=1 PATH="$(dirname "$node"):/usr/bin:/bin" \
    "$node" "$home/checkout/tests/node-user-service-systemd.mjs" "$1"
}
run_phase exercise
sudo systemctl restart "user@$uid.service"
run_phase restart
sudo systemctl restart "user@$uid.service"
run_phase disabled
sudo cat "$home/springbok-systemd-evidence/execute-journal.txt" > .tmp/systemd-evidence/execute-journal.txt
sudo cat "$home/springbok-systemd-evidence/observe-journal.txt" > .tmp/systemd-evidence/observe-journal.txt
printf 'actual isolated user manager acceptance passed\n' > .tmp/systemd-evidence/result.txt
