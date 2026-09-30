# SpringBok repository rules

This is a personal deployment configuration workspace. Upstream selection and
product implementation remain pending evaluation. Do not introduce an application
stack, license, infrastructure deployment, or real credentials without approval.

Preserve the repository checks described in `docs/security-quality-baseline.md`.
Use pinned Actions and checksum-verified CLI downloads. Keep default workflow
permissions read-only; only CodeQL SARIF publication receives the necessary
job-scoped security-events permission. Never use pull_request_target to run
untrusted contribution code with elevated permissions.

Validate changed automation with the repository contracts, actionlint and
Gitleaks. Review and test an exact PR head before merge, then check main. Do not
claim application tests, builds, vulnerability-lock coverage, or deployment
verification when the corresponding product files do not exist.
