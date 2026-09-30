#!/usr/bin/env bash
set -euo pipefail
# Isolated CI runner only. No registry push, credentials, volumes or public ports.
name="springbok-fixture-${GITHUB_RUN_ID:-local}"
cleanup() { docker rm -f "$name" >/dev/null 2>&1 || :; }
trap cleanup EXIT
image="springbok-fixture:${GITHUB_SHA:-local}"
docker build --pull -t "$image" examples/fixture
for service in gateway forum game account; do
  for version in v1 v2 v1; do
    cleanup
    docker run -d --name "$name" --read-only --cap-drop=ALL \
      --security-opt=no-new-privileges --pids-limit=64 --memory=128m --cpus=1 \
      --network=none -e "SERVICE=$service" -e "FIXTURE_VERSION=$version" "$image" >/dev/null
    for attempt in {1..30}; do
      if docker exec -e "EXPECTED_SERVICE=$service" -e "EXPECTED_VERSION=$version" "$name" node -e '
        fetch("http://127.0.0.1:8080/health").then(async r => {
          if (!r.ok) process.exit(1);
          const v = await r.json();
          if (!v.fixture || !v.ok || v.service !== process.env.EXPECTED_SERVICE || v.version !== process.env.EXPECTED_VERSION) process.exit(1);
        }).catch(() => process.exit(1));
      '; then break; fi
      if [[ "$attempt" == 30 ]]; then docker logs "$name"; exit 1; fi
      sleep 1
    done
    echo "PASS isolated fixture $service $version"
  done
done
