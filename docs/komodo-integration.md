# M2: actual Komodo integration, disposable CI only

## Scope

The test installs official Komodo Core + Periphery 2.3.3 and MongoDB 8.0 on a
fresh GitHub-hosted runner. It exercises real HTTP APIs, real Procedures and real
Docker containers. It does not install anything on user computers or production.
No Komodo source/client package is copied, forked or bundled. Node standard-library
adapter code only; no project license or full product/UI stack has been selected.
The official images retain their upstream licenses; MongoDB is an integration-test
dependency, not a choice of product database or redistribution package.

Exact source reference: release `v2.3.3`, tree
`780ac68b992094a9fccd5fffb760e0c84fd3c3d1`, published 2026-09-01.

- [Release](https://github.com/moghtech/komodo/releases/tag/v2.3.3)
- [Deployment fields and tagged image type](https://github.com/moghtech/komodo/blob/v2.3.3/client/core/rs/src/entities/deployment.rs)
- [Procedure stages](https://github.com/moghtech/komodo/blob/v2.3.3/client/core/rs/src/entities/procedure.rs)
- [Execution result lifecycle](https://github.com/moghtech/komodo/blob/v2.3.3/client/core/rs/src/entities/update.rs)
- [Upstream container configuration](https://github.com/moghtech/komodo/blob/v2.3.3/compose/mongo.compose.yaml)
- [Upstream Docker execution](https://github.com/moghtech/komodo/blob/v2.3.3/bin/periphery/src/api/container/run.rs)

Image tags are exact Komodo release tags, but are not cryptographically immutable.
The run prints resolved public repository digests and verifies the running Core
version. Fixture v1/v2/bad are distinct local images referenced by immutable Docker
image ID, never mutable tags. This validates local-image deployment, not registry
signatures, SBOMs, a production supply chain or multi-architecture releases.

## What is verified

1. Fixed Core version, login with generated test credentials, authenticated
   Periphery connection, eight deployment mappings (four services × test/production
   roles on the disposable server), and four test-only Procedures
2. For each service: actual test Procedure → healthy image → synthetic acceptance
   → actual production-role fixture → second immutable image → rollback to the
   recorded successful first image
3. Every execution must correlate its exact Update ID, operation, target type/ID,
   Complete status and success. Then inspect the actual container image ID and
   health. Merely accepting an API request is never counted as deployment success
4. A deliberately broken test image exits; the test records failure, denies
   promotion, and verifies the production-role fixture remains at the known good image

The word production in fixture names denotes a test role, not a real environment.
Acceptance in this integration test is synthetic harness input. This does not
implement authenticated human acceptance, durable release history, crash recovery,
user-facing UI, actual multi-server operation or real business services. M1's role
model still is not a security boundary; do not expose the CI client as a server.

## Permission and isolation

Periphery receives the temporary runner's Docker socket. That gives it effective
Docker-administrator control of that entire disposable VM; a bridge network and
read-only root filesystem do NOT sandbox that power. This requires explicit human
approval per integration task. Never attach a personal, persistent, self-hosted or
production Docker daemon. The shell refuses ordinary local execution; its CI
checks prevent accidents, not malicious identity spoofing.

Core/Mongo/Periphery use an internal Docker network, no published ports and no
host network. Test deployment containers use `network=none`, read-only filesystems,
non-root fixture user, dropped capabilities and resource limits. No `/proc` or
host-root mount. The only host binds are the approved socket and a narrow generated
key directory on `/dev/shm`. Database storage is tmpfs. Core and Periphery terminal
features are disabled. No API key, OAuth grant or persistent access is created.

Random test passwords and JWT seeds are generated on the runner, kept in mode-600
files under a mode-700 tmpfs directory, and never printed or uploaded. Internal
HTTP carries only synthetic ephemeral credentials on the isolated network; this
is NOT a TLS pattern for real environments. Core/Mongo/Periphery logging is disabled
to avoid accidentally publishing credentials. The driver emits only fixed status,
public image IDs and update IDs, not response bodies. No credentials are in images.
Exit cleanup removes all test containers, the internal network and generated tmpfs
files, including on failure; destruction of the hosted VM is the final boundary
on force-cancellation. Nothing is exported as an artifact.

## Running and CI policy

Ordinary pull requests run unit/static and small fixture tests only. The privileged
integration must not run for arbitrary contribution code, `pull_request_target`,
schedules or main pushes. During this authorized M2 bootstrap only, the exact
reviewed dedicated `feat/komodo-integration-m2` push can run it. Remove that bootstrap
trigger after validation. Future manual runs require an explicit authorization
and an independently reviewed ref. CI code review precedes starting the test.

Local offline checks:

```sh
node --test tests/*.test.mjs scripts/ci/security-baseline.test.mjs
```

## Next product milestone

Use the proven mapping/API boundary to design the smallest owner-only UI and
persistent approval/execution ledger. Confirm real target inventory, how the owner
logs in, secret handling and failure/restart reconciliation before implementing a
network-enabled production executor. Reuse Komodo's UI/resources where practical;
do not assume this CI harness is already an installable management product.
