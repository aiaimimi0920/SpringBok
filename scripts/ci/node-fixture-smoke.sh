#!/usr/bin/env bash
set -euo pipefail
[[ ${GITHUB_ACTIONS:-} == true && ${RUNNER_ENVIRONMENT:-} == github-hosted && ${GITHUB_RUN_ID:-} =~ ^[0-9]+$ && ${GITHUB_RUN_ATTEMPT:-} =~ ^[0-9]+$ ]] || { echo 'Disposable hosted CI only'; exit 2; }
prefix="springbok-fixture-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
volume="$prefix-data"
container="$prefix-app"
# Exact fresh resources only; never prune or delete a pre-existing name.
if docker container inspect "$container" >/dev/null 2>&1 || docker volume inspect "$volume" >/dev/null 2>&1; then echo 'Fixture resource collision'; exit 2; fi
cleanup() {
  local status=$?
  trap - EXIT
  docker rm -f "$container" >/dev/null 2>&1 || :
  docker volume rm "$volume" >/dev/null 2>&1 || :
  if ! docker info >/dev/null 2>&1 || docker container inspect "$container" >/dev/null 2>&1 || docker volume inspect "$volume" >/dev/null 2>&1; then status=1; fi
  exit "$status"
}
trap cleanup EXIT
docker volume create "$volume" >/dev/null
for version in v1 v2 bad; do
  docker build --pull --build-arg "FIXTURE_VERSION=$version" -t "$prefix-$version" examples/node-fixture >/dev/null
done
marker=''
round=0
container_ids=()
for version in v1 v2 bad v1; do
  round=$((round + 1))
  docker run -d --name "$container" --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
    --pids-limit 64 --memory 128m --cpus 0.5 --mount "type=volume,source=$volume,target=/data" "$prefix-$version" >/dev/null
  container_id=$(docker inspect --format '{{.Id}}' "$container")
  [[ "$container_id" =~ ^[a-f0-9]{64}$ ]] || exit 1
  for previous_id in "${container_ids[@]}"; do [[ "$container_id" != "$previous_id" ]] || exit 1; done
  container_ids+=("$container_id")
  expected=$(docker image inspect --format '{{.Id}}' "$prefix-$version")
  for attempt in {1..30}; do
    status=$(docker inspect --format '{{.State.Status}}/{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container")
    if [[ "$version" == bad && "$status" == exited/* ]] || [[ "$version" != bad && "$status" == running/healthy ]]; then break; fi
    sleep 1
  done
  receipt=$(docker inspect --format '{{json .State}}' "$container")
  actual=$(docker inspect --format '{{.Image}}' "$container")
  [[ "$actual" == "$expected" ]] || exit 1
  current=$(printf '%s' "$receipt" | node --input-type=module -e '
    let raw=""; for await(const chunk of process.stdin)raw+=chunk;
    const s=JSON.parse(raw), version=process.argv[1];
    if(s.OOMKilled!==false||s.Paused!==false)process.exit(1);
    if(version==="bad"){if(s.Status!=="exited"||s.Running!==false||s.ExitCode!==1)process.exit(1);console.log("expected-failure");}
    else {if(s.Status!=="running"||s.Running!==true||s.Health?.Status!=="healthy")process.exit(1);
      const l=s.Health.Log.at(-1),v=JSON.parse(l.Output);if(l.ExitCode!==0||v.fixture!==true||v.version!==version||!/^[a-f0-9]{64}$/.test(v.marker))process.exit(1);console.log(v.marker);}
  ' "$version")
  if [[ "$version" != bad ]]; then
    if [[ -n "$marker" && "$current" != "$marker" ]]; then echo 'Fixture persistence lost'; exit 1; fi
    marker="$current"
  fi
  if [[ "$round" == 4 ]]; then
    docker restart "$container" >/dev/null
    for attempt in {1..30}; do
      if [[ $(docker inspect --format '{{.State.Health.Status}}' "$container") == healthy ]]; then break; fi
      sleep 1
    done
    current=$(docker exec "$container" node health.mjs | node --input-type=module -e 'let s="";for await(const c of process.stdin)s+=c;console.log(JSON.parse(s).marker)')
    [[ "$current" == "$marker" ]] || exit 1
    echo 'PASS real fixture process restart retains the same volume marker'
  fi
  docker rm -f "$container" >/dev/null
  echo "PASS real fixture $version image, health and persistent volume"
done
echo 'PASS fixture-only containers; Komodo and cloud deployment are not tested here'
