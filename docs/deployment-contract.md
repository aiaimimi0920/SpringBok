# M1: fixed deployment contract laboratory

## Goal and deliberate limits

Validate a thin future Komodo adapter contract, not build a second deployment
platform. There is no dashboard, authenticated API, external execution, persistent
store, credentials, real environment, or production authority in M1. The only
runtime dependency is Node's standard library. Existing repository tooling already
uses Node; this does not choose the eventual product stack or project license.

Four independent service IDs: gateway, forum, game, account. Each has distinct,
predefined test and production target IDs. IDs are logical resource references,
not hostnames or commands. Samples use synthetic sha256 values: syntactic digest
validation does not prove an image exists or its provenance. No real account data.
Configuration digest covers the future resolved deployment specification, not just
an image: the executor must resolve and verify it before any execution.

## Fixed flow

| Operation | Caller | Allowed state | Outcome |
| --- | --- | --- | --- |
| test | human / AI | ready, test-failed, tested, approved | testing; removes approval |
| test-result | runner | testing | tested or test-failed |
| approve | human | tested | approved, bound to exact release and targets |
| promote | human / AI | approved | promoting; consumes approval |
| production-result | runner | promoting | live or production-failed |
| candidate | human | ready, test-failed, tested, approved, live, rolled-back | ready; invalidates approval |
| rollback | human / AI | live, production-failed, rollback-failed | rolling-back to known good only |
| rollback-result | runner | rolling-back | rolled-back or rollback-failed |

Approval fingerprints include service, production environment, production target,
test target, artifact digest, and configuration digest. Both digest changes and
retests invalidate acceptance. Another service's acceptance cannot be reused.
Only fixed operations and exact field sets are accepted; no shell, URLs, arbitrary
Komodo Action code, arbitrary rollback digest or new targets can be supplied.
Repeated operations and skipped gates fail. Rejected calls leave state unchanged.

A successful promotion records its predecessor; rollback selects that known-good
release. A failed promotion can be partially applied, so it restores the last
successful active release. A rollback failure keeps its exact target for retry
and stays failed until new positive evidence arrives. First deployment has no
known-good rollback target; failure stays blocked pending future authenticated
reconciliation, rather than assuming success or allowing an unsafe retry.
Database migrations, data rollback, cross-service ordering and game-session drain
are NOT covered by a stateless container restart and need separate contracts.

## Trust boundary (not an authentication implementation)

`createLab` is an in-memory test model. Its actor argument is a harness-provided
role, not proof of identity. Anyone controlling this process can call it as human
or runner. Do not expose it as an API or connect it to production. Tests exercise
role policy only; they do not prove that a real human accepted a real deployment.
The demo stops before approval. Test code supplies synthetic acceptance to cover
positive/negative transitions and labels it as laboratory evidence.

A real adapter MUST derive actor identity from an authenticated session, keep
human approval outside the AI tool surface, derive runner evidence from the exact
execution ID/target/digest, reject stale callbacks, serialize per-service operations,
and persist a tamper-resistant audit history. Crash/restart reconciliation, locks,
timeouts, replay/idempotency, secret storage and authorization need implementation
and testing before any network executor is enabled. The current journal is only
an ordered in-memory trace; it is not a durable security audit log.

## Container fixture verification

The separate GitHub job builds a minimal official Node image with one health
endpoint. For each service it runs v1, v2, then v1 and validates service identity,
version and health from inside the network-disabled container. No host port is
published. Containers are non-root, read-only, capability-dropped and resource
limited. Cleanup runs on exit. This is actual container lifecycle smoke coverage
when CI passes, NOT deployment-contract integration or multi-server validation.

The fixture base tag is intentionally a moving official Node 22 Alpine test base,
not the immutable production artifact in the contract. No registry image is
published, production image selected, or SBOM/vulnerability claim made. Before
real deployment, choose and verify immutable base/fixture digests and provenance.

## Next acceptance milestone

After an authorized disposable Docker host and a specific Komodo release are
chosen: verify four resource mappings, immutable image/config resolution,
authenticated owner acceptance, exact runner results, interrupted deployment,
health failure, known-good rollback and restart recovery. Then implement the
minimal UI (service cards, test status, accept/promote, rollback and history).
Do not install a public control panel or enable production while those are absent.
