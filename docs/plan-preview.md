# M5: offline fixed release-plan preview

Open the existing Linux / Node.js 22+ DEMO with `node scripts/demo.mjs` and scroll
to **离线计划预览**. The preview is a separate read-only view of synthetic M4
scenarios. It does not read, approve, update or execute the M3 simulated releases
shown in the service cards. Selecting a scenario never revives their approvals.

Choose one of the four services, a fixed scenario and test/promote/rollback. The
view shows the pinned target name/ID, immutable image and configuration digests,
differences against the last confirmable synthetic success, rollback conditions
and the reason a plan cannot execute. It includes fresh, v2-approved, v2-live and
unknown-submission scenarios. Unknown execution results make the whole service's
current state unknown, even if an older test-target success exists. Unknown is
never treated as a successful current deployment or a safe baseline for a diff.

The v2-approved and rollback examples intentionally show **configuration not yet
prepared**. M4 coordinates preconfigured resources; this preview does not silently
write their configuration. A known-good rollback is derived by the existing
contract, never by supplying a new digest or guessing the previous version.

## Reused contract; no new execution surface

`src/preview/plan.mjs` creates a private projection with the M4 catalog and journal
replay. It evaluates the fixed operation using the existing dispatch rules in that
isolated in-memory instance, then discards it. It does not open a journal, persist
an approval, call a transport or duplicate the state machine. All returned plans
have `executable: false`, including those whose fixture contract phase is eligible.
Real owner identity, authenticated transport and exclusive configuration control
are explicitly unverified. A plan is information, not acceptance or authority.

`src/preview/fixtures.mjs` builds fixed synthetic histories using the same M4
projection and dispatch. It reuses the M2 isolated deployment mapping to make the
example configurations, replacing only synthetic resolved resource/server IDs.
These fixture configurations are not claimed to be complete live Komodo defaults.
No real host, business service, image provenance or deployment is represented.

`src/preview/connection.mjs` is a pure data contract for future read-only connection
work. Its current validator accepts only the explicit `synthetic-fixture` source,
Komodo 2.3.3, and all eight known resource IDs/names. It compares each complete
configuration to known catalog digests and returns only known non-sensitive IDs,
names, image/configuration hashes and readiness flags. A changed/unknown
configuration yields unknown data; raw configuration fields are never returned.
Wrong versions, duplicate/foreign targets, URL or credential fields fail closed.
This is not an implemented network connector, login flow or authentication proof.

The DEMO exposes only `GET /api/plan` with exactly three fixed selectors: `service`,
`scenario`, `operation`. There is no catalog upload, URL, credential, arbitrary
operation or caller-controlled actor input. Existing loopback Host/Origin/Fetch
Metadata restrictions, CSP and no-store headers apply. No CSRF token, raw backend
body or journal events appear in preview responses. Preview requests do not write
the demo ledger. Rapid selections cancel obsolete reads and discard stale replies.

## Verification and next boundary

Seven additional Node tests cover all 48 selection combinations, non-mutation,
unknown execution, catalog/configuration privacy, version/resource validation,
known-good rollback and HTTP method/selector/ledger boundaries. The browser suite
checks the visible differences, unknown-state blocking, rollback, rapid changes,
unchanged M3 history, zero preview writes and desktop/mobile layout. It captures
dedicated plan screenshots alongside the unchanged full DEMO screenshots.

Run `node --test tests/*.test.mjs scripts/ci/security-baseline.test.mjs`; the full
suite now contains 72 tests. Real Chrome checks run in the ordinary Demo Browser
workflow. No privileged Komodo run is added or invoked.

Actual connection still requires decisions on runtime location and owner login,
approved credential handling and ownership of managed Komodo configurations.
Komodo's lack of a configuration compare-and-swap condition remains unresolved.
This milestone does not choose those policies, grant access, connect to a server,
or make a production deployment executable.
