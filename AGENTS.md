# SpringBok repository rules

The current priority is reliable, repeatable deployment of the owner's services
onto the selected server, not unrelated general-purpose platform features.
Read `docs/owned-service-deployment.md` before choosing new deployment work.
It records the real targets, acceptance requirements and unresolved integration
boundaries. Gateway, Platform, AssetLibrary, Rauthy and optional read-only Crow
are planning targets; Hook and Loom are desktop clients, not server workloads.

The existing gateway/forum/game/account IDs are contract and fixture identities,
not evidence that the real applications are configured or deployed. Do not rename
or repurpose those IDs implicitly: a real-service catalog adapter needs a separate
reviewed design and regression coverage. Preserve historical integration evidence.
Production execution, infrastructure purchases, credentials/access provisioning
and license selection are not authorized by this planning document. Do not
introduce them, a new application stack or a fork without applicable approval.

Preserve the repository checks described in `docs/security-quality-baseline.md`.
Use pinned Actions and checksum-verified CLI downloads. Keep default workflow
permissions read-only; only CodeQL SARIF publication receives the necessary
job-scoped security-events permission. Never use pull_request_target to run
untrusted contribution code with elevated permissions.

Validate changed automation with the repository contracts, actionlint and
Gitleaks. Review and test an exact PR head before merge, then check main. Do not
claim application tests, builds, vulnerability-lock coverage, or deployment
verification when the corresponding product files do not exist.
