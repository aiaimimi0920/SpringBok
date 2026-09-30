# M4: fixed execution coordination and recovery

This milestone connects M1's release state machine to a narrow Komodo-shaped
execution interface and a durable local journal. It is a library and test lab,
not a production executor. M3's DEMO interface does not call it. There is no new
login, credential, server connection, command-line execution entry point or
application dependency. Linux and Node.js 22+ are the supported test environment.

## What the coordinator accepts

`openCoordinator` receives a dedicated journal directory, initial four-service
manifest, fixed release catalog and an explicitly injected `transport.call`.
No default transport exists. The caller supplies the complete resolved Komodo
deployment configurations, including defaults, without secrets. Each catalog
release has one immutable local image ID and fixed test/production resource IDs
and names. Resource IDs cannot be shared or changed between releases. The
configuration digest includes both roles' IDs, names and full configurations;
JSON object-key ordering does not change that digest. The journal is bound to
the initial manifest and whole catalog, so changing either refuses replay.

This catalog differs from the M2 fixture manifest: it includes the resolved
resource IDs and full server-returned configurations. It must not be substituted
into an existing M1/M2 or M3 ledger. No ledger migration is implemented.

The public library methods are:

- `submit({ id, service, operation, params }, actor)`: fixed `test`, `approve`,
  `promote`, `candidate` and known-good `rollback` operations only
- `reconcile(requestId)`: read the already recorded execution ID and evidence
- `snapshot()`: inspect release phases, exact requests and ordered history
- `close()`: release this process's journal lock after outstanding calls finish

The actor is trusted harness input, not authentication. AI-role input cannot
approve, change candidates or supply runner results. A future trusted owner
session must establish real identities and keep human approval outside the AI
surface. This milestone does not establish that boundary.

Only four Komodo calls are issued: `read/GetDeployment`, `execute/Deploy`,
`read/GetUpdate` and `read/InspectDeploymentContainer`. Parameters contain only
the pinned resource ID or recorded Update ID. There are no write/configuration,
Procedure, shell, batch, URL, target-creation or arbitrary rollback operations.
The injected transport is a trusted dependency; a future real implementation
must supply authentication, exact-origin restrictions, redirects/error-body
handling, response limits and cancellation. The test HTTP implementation stays
inside the tests and connects only to a fresh loopback fake server.

## Intent before send; no automatic deployment retries

1. Validate the operation through the existing contract, resolve its exact
   release, and read the target's identity and complete configuration. Drift
   rejects the request before any execution intent is written or deployment sent
2. Persist the intent, transition and consumed approval using file fsync, atomic
   rename and directory fsync. Only then send `execute/Deploy` once
3. Accept a receipt only when its Update ID, operation, target type/ID and status
   are valid. Persist the Update ID separately. Receipt acceptance is not success
4. Reconciliation reads that exact Update ID. A complete failure records failure.
   A complete success also requires the exact target configuration, image ID and
   running/healthy/non-paused/non-OOM container evidence before recording success

Request IDs are permanent within the bounded journal and include the exact
input and actor in their comparison. Repeating an identical request returns its
recorded status without another write or send. Reusing an ID with different
intent fails. A per-instance busy guard rejects overlapping submission or
reconciliation; an exclusive directory lock rejects a second process. These
locks do not coordinate multiple independently created journals or other Komodo
operators and are not distributed locks.

Transport calls have bounded deadlines and an abort signal. Cancellation cannot
prove that the server did not receive or finish an operation. A dropped response,
timeout, invalid receipt or crash after intent persistence leaves `unknown`.
Even if the process crashed before actually sending, it must conservatively
treat that durable intent as potentially sent. The service remains in-flight;
neither the same ID nor a fresh ID can bypass the phase gate and redeploy.
There is deliberately no automatic retry, force-reset or attach-an-arbitrary-ID
recovery operation for unknown submissions. They need future authenticated
reconciliation with independent evidence. This does not promise exactly-once
execution on the remote server.

For a durably recorded Update ID, a restart can safely resume read-only
reconciliation. Pending results, read failures, mismatched IDs, unhealthy
containers and configuration drift never become success. A later read can retry
that known ID, without another `Deploy`. Confirmed failures retain the contract's
known-good rollback rules; a failed first deployment cannot invent a predecessor.

## Persistence and approval recovery

The separate versioned `execution-recovery-lab` journal holds normalized intent,
receipt and outcome events, not credentials, configuration bodies or raw server
responses. Every read/restart replays and validates the entire history through
the contract. Its maximum is 1000 events / 1 MiB; reaching the limit blocks writes
without deleting history. Capacity planning and migration are future work.

Unused approvals are revoked by a durable restart event before exposing the
coordinator. Their old request IDs remain recorded as `revoked`; replaying an old
approval request cannot approve again. Consumed approvals and known in-flight
executions remain in the history. A new harness approval after restart must use
a new request ID and the current release binding. This is approval-state recovery,
not a credential/session refresh or proof of a human identity.

Write errors poison the process. No success or usable snapshot is returned until
it is closed and the preserved ledger is inspected and reopened. An atomic rename
may have completed even when later durability reporting failed: after restart the
operation may therefore be present although its caller saw an error. Tests cover
this ambiguity before send and after result recording. Symlinks, corrupt JSON,
invalid replay, a different catalog and existing locks refuse startup without
overwriting the original records. Lock removal after a crash requires the same
manual process/ownership checks described for M3; there is no automatic stale-lock
deletion or process-killing API. Use a dedicated non-demo directory owned by the
test harness. Local files are not a tamper-resistant security audit store and do
not defend against a malicious process with directory access.

## What remains before real deployment

This implementation coordinates **already configured** resources. It does not
write a new candidate's configuration or prepare a rollback target; fixtures
explicitly stage that configuration before asking the coordinator to execute it.
M4 therefore does not yet perform a complete real-world release or rollback.

Komodo 2.3.3's [Deploy API](https://github.com/moghtech/komodo/blob/v2.3.3/client/core/rs/src/api/execute/deployment.rs)
accepts a resource reference and optional stop overrides, not an expected
configuration hash / compare-and-swap condition. Another operator could change
configuration after preflight, or between the later evidence reads. Post-checks
can refuse to report success but cannot prevent that intervening deployment.
Production integration needs an explicit exclusive configuration ownership or
equivalent atomic execution strategy, plus authenticated inventory resolution,
owner acceptance, protected audit storage, secret management, real image supply
chain checks, health/drain policy and multi-server tests. No assumption of those
guarantees is made here. The official [Update shape](https://github.com/moghtech/komodo/blob/v2.3.3/client/core/rs/src/entities/update.rs)
is the source for the receipt/status checks.

## Validation

Run `node --test tests/*.test.mjs scripts/ci/security-baseline.test.mjs`.
Twenty coordinator/storage tests and five loopback HTTP tests supplement the
existing forty checks. They cover all four services' v1/v2/known-good flows,
idempotency, concurrent requests, immutable inputs, preflight drift, receipt and
result mismatches, unknown submissions, read-only recovery, revoked approvals,
disk-error ambiguity, catalog binding and corrupt-history preservation.

Ordinary CI also runs the unchanged isolated sample-container and DEMO browser
checks. These are separate validation layers. M2's successful real Komodo evidence
and its execution source hashes remain unchanged; no new privileged Komodo run,
user-server connection, production deployment or durable access is implied.
