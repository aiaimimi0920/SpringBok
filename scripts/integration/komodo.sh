#!/usr/bin/env bash
set -euo pipefail
# Intentionally cannot be run on a personal machine. This guard is accidental-use
# protection, not an authorization system. Explicit human permission is still required.
[[ ${GITHUB_ACTIONS:-} == true && ${RUNNER_ENVIRONMENT:-} == github-hosted && \
   ${GITHUB_REPOSITORY:-} == aiaimimi0920/SpringBok && \
   ${SPRINGBOK_ALLOW_EPHEMERAL_DOCKER:-} == yes ]] || { echo 'Requires explicitly approved disposable GitHub runner'; exit 2; }
[[ ${GITHUB_RUN_ID:-} =~ ^[0-9]+$ && ${GITHUB_RUN_ATTEMPT:-} =~ ^[0-9]+$ ]] || exit 2
prefix="springbok-m2-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
network="$prefix-net"
work=$(mktemp -d /dev/shm/springbok-m2.XXXXXX)
chmod 700 "$work"
containers=("$prefix-core" "$prefix-mongo" "$prefix-periphery" "$prefix-driver")
fixtures=()
for service in gateway forum game account; do
  for environment in test production; do fixtures+=("springbok-$service-$environment"); done
done
armed=false
cleanup() {
  local status=$?
  trap - EXIT
  if [[ "$armed" == true ]]; then
    if [[ "$status" != 0 ]]; then
      for name in "${containers[@]}"; do
        docker inspect --format '{{.Name}} status={{.State.Status}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}}' "$name" 2>/dev/null || :
      done
      # Whitelisted error categories only; never print raw startup logs/config.
      docker exec "$prefix-core" sh -c '
        for category in "Read-only file system" "Permission denied" "No such file" "database" "panicked" "Invalid" "Failed" "Authentication failed" "Server selection timeout" "Connection refused" "failed to lookup" "No space left" "Unauthorized" "create index" "error code"; do
          if grep -qi "$category" /tmp/core-startup.log; then printf "Core diagnostic category: %s\n" "$category"; fi
        done
        if test -f /tmp/core-exit-code; then printf "Core process exit: "; cat /tmp/core-exit-code; fi
      ' 2>/dev/null || :
    fi
    docker rm -f -v "${containers[@]}" "${fixtures[@]}" >/dev/null 2>&1 || :
    docker network rm "$network" >/dev/null 2>&1 || :
  fi
  # Only generated tmpfs material in our mktemp directory, never repository/user files.
  rm -rf -- "$work"
  exit "$status"
}
trap cleanup EXIT
for name in "${containers[@]}" "${fixtures[@]}"; do
  if docker container inspect "$name" >/dev/null 2>&1; then echo 'Unexpected pre-existing test container'; exit 2; fi
done
armed=true
mkdir "$work/keys"
# Generate inside the ephemeral runner; never echo, persist to artifacts, or use real accounts.
node --input-type=module - "$work" <<'JS'
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
const dir = process.argv[2];
const admin = randomBytes(32).toString('hex');
const db = randomBytes(32).toString('hex');
const write = (file, lines) => writeFileSync(`${dir}/${file}`, lines.join('\n')+'\n', { mode: 0o600 });
write('mongo.env', ['MONGO_INITDB_ROOT_USERNAME=ci', `MONGO_INITDB_ROOT_PASSWORD=${db}`]);
write('core.env', [
  'KOMODO_DATABASE_ADDRESS=mongo:27017', 'KOMODO_DATABASE_USERNAME=ci', `KOMODO_DATABASE_PASSWORD=${db}`,
  'KOMODO_INIT_ADMIN_USERNAME=springbok-ci', `KOMODO_INIT_ADMIN_PASSWORD=${admin}`,
  'KOMODO_LOCAL_AUTH=true', 'KOMODO_DISABLE_USER_REGISTRATION=true',
  'KOMODO_DISABLE_INIT_RESOURCES=true', 'KOMODO_FIRST_SERVER_NAME=springbok-ci',
  'KOMODO_REPORTING_ENABLED=false', 'KOMODO_HOST=http://core:9120', 'KOMODO_PERIPHERY_PUBLIC_KEY=file:/config/keys/periphery.pub',
  'KOMODO_MONITORING_INTERVAL=1-sec', 'KOMODO_RESOURCE_POLL_INTERVAL=1-day',
  `KOMODO_JWT_SECRET=${randomBytes(32).toString('hex')}`, `KOMODO_WEBHOOK_SECRET=${randomBytes(32).toString('hex')}`,
]);
write('driver.env', [`KOMODO_INIT_ADMIN_PASSWORD=${admin}`]);
JS
# Exact upstream release, official images. Resolved digests are public provenance.
docker pull ghcr.io/moghtech/komodo-core:2.3.3
docker pull ghcr.io/moghtech/komodo-periphery:2.3.3
docker pull mongo:8.0
for image in ghcr.io/moghtech/komodo-core:2.3.3 ghcr.io/moghtech/komodo-periphery:2.3.3 mongo:8.0; do
  docker image inspect --format '{{json .RepoDigests}}' "$image"
done
for version in v1 v2 bad; do
  docker build --pull --build-arg "FIXTURE_VERSION=$version" -t "$prefix-$version" examples/fixture
done
docker build --pull -f scripts/integration/driver.Dockerfile -t "$prefix-driver" .
for pair in 'v1 IMAGE_V1' 'v2 IMAGE_V2' 'bad IMAGE_BAD'; do
  read -r tag key <<< "$pair"
  printf '%s=%s\n' "$key" "$(docker image inspect --format '{{.Id}}' "$prefix-$tag")" >> "$work/driver.env"
done
docker network create --internal "$network" >/dev/null
# No published ports, no host/proc mounts, no real credentials, no logs containing secrets.
docker run -d --name "$prefix-mongo" --network "$network" --network-alias mongo \
  --log-driver=none --memory=1g --cpus=1 --pids-limit=256 \
  --tmpfs /data/db:rw,size=512m --tmpfs /data/configdb:rw,size=64m \
  --env-file "$work/mongo.env" mongo:8.0 --quiet --wiredTigerCacheSizeGB 0.25 >/dev/null
# Wait for the authenticated final Mongo process, not the transient initialization server.
for attempt in {1..60}; do
  if docker exec "$prefix-mongo" mongosh --quiet --eval '
    const admin = db.getSiblingDB("admin");
    const auth = admin.auth(process.env.MONGO_INITDB_ROOT_USERNAME, process.env.MONGO_INITDB_ROOT_PASSWORD);
    if (auth !== 1 && auth?.ok !== 1) quit(1);
    const opts = admin.runCommand({getCmdLineOpts:1});
    if (opts.parsed.net.bindIp !== "*" && opts.parsed.net.bindIpAll !== true) quit(1);
    if (admin.runCommand({ping:1}).ok !== 1) quit(1);
  ' >/dev/null 2>&1; then break; fi
  if [[ "$attempt" == 60 ]]; then echo 'Mongo authenticated readiness failed'; exit 1; fi
  sleep 1
done
echo 'PASS authenticated Mongo readiness'
docker run -d --name "$prefix-core" --network "$network" --network-alias core \
  --log-driver=none --restart=on-failure:3 --memory=1g --cpus=1 --pids-limit=256 \
  --read-only --tmpfs /tmp:rw,size=64m --tmpfs /backups:rw,size=64m \
  --mount "type=bind,source=$work/keys,target=/config/keys" \
  --env-file "$work/core.env" --entrypoint /bin/sh ghcr.io/moghtech/komodo-core:2.3.3 -c \
  'core >/tmp/core-startup.log 2>&1; printf "%s\n" "$?" >/tmp/core-exit-code; sleep 300' >/dev/null
docker run -d --name "$prefix-periphery" --network "$network" \
  --log-driver=none --restart=on-failure:3 --memory=512m --cpus=1 --pids-limit=256 \
  --read-only --tmpfs /tmp:rw,size=64m --tmpfs /etc/komodo:rw,size=64m \
  --mount "type=bind,source=$work/keys,target=/config/keys" \
  --mount type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock \
  -e PERIPHERY_CORE_ADDRESS=ws://core:9120 -e PERIPHERY_CONNECT_AS=springbok-ci \
  -e PERIPHERY_CORE_PUBLIC_KEYS=file:/config/keys/core.pub \
  -e PERIPHERY_DISABLE_TERMINALS=true -e PERIPHERY_DISABLE_CONTAINER_TERMINALS=true \
  ghcr.io/moghtech/komodo-periphery:2.3.3 >/dev/null
# No Docker socket or key material inside the test driver.
docker run --name "$prefix-driver" --network "$network" --read-only \
  --cap-drop=ALL --security-opt=no-new-privileges --memory=256m --cpus=1 --pids-limit=64 \
  --env-file "$work/driver.env" "$prefix-driver"
