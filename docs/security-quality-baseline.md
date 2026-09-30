# Configuration-only repository baseline

The initial main commit contains only a reviewed README. All automation is
introduced through a separately reviewed and tested pull request.

## Active checks

- actionlint 1.7.12 validates all GitHub Actions workflow definitions.
- Gitleaks 8.30.1 scans complete committed Git history, redacts findings, and
  fails on detections. New uncommitted files are covered after committing them.
- Both tools are downloaded from official releases with fixed SHA-256 checks.
- CodeQL analyzes Actions only; no application language has been selected.
- Dependabot proposes weekly, bounded GitHub Actions updates. It does not merge.
- `node --test scripts/ci/security-baseline.test.mjs` validates these contracts.
  Node is used for repository tooling; it does not select the future app stack.

Checks run on pull requests, main, weekly schedules and manual dispatch. The
normal token scope is contents-read; only CodeQL gets the job-scoped permissions
needed to upload SARIF. Workflows do not deploy or receive real credentials.

## Deliberately deferred

There is no application build, application test suite, lockfile dependency
scan, container build, license decision or release pipeline at this stage.
Once an upstream/product is chosen, review its license, provenance, languages,
manifests and deployment boundaries, then replace the bootstrap-specific
contract and add matching tests/build/OSV coverage. Do not invent lockfiles to
make an empty repository appear scanned.

GitHub branch protection, secret-scanning/push-protection settings, paid security
products and persistent account access were not changed by this baseline.
Findings require review; no blanket scanner allowlist is supplied. A green
repository scan does not certify future application or deployment safety.
