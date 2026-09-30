# Komodo integration evaluation (2026-09-30)

Komodo remains the preferred candidate, not an approved fork or adopted stack.
Official sources checked:

- [Introduction](https://komo.do/docs/intro): Docker-based server/deployment tooling
- [Containers](https://komo.do/docs/deploy/containers): Deployment resource for containers
- [Procedures](https://komo.do/docs/automate/procedures): ordered stages with parallel
  executions within each stage; Actions can execute TypeScript and terminal commands
- [Upstream LICENSE](https://github.com/moghtech/komodo/blob/main/LICENSE): GNU GPL v3 text
- [Workspace manifest](https://github.com/moghtech/komodo/blob/main/Cargo.toml):
  `GPL-3.0-or-later` license declaration

No upstream implementation was copied or bundled. The repository has no new
LICENSE and makes no legal conclusion that a particular distribution/integration
is exempt from upstream obligations. Forking, distribution and combined-product
licensing need a separate reviewed decision, against the exact selected release.

## Proposed small integration surface

Map each fixed service/environment pair to a specific reviewed Komodo resource
ID, and dispatch only a predefined operation against that exact ID. Avoid batch
wildcards, arbitrary Action scripts, terminal access, AI-supplied hostnames and
on-the-fly stack edits. Treat Komodo as the executor and existing UI candidate;
SpringBok's M1 only verifies the acceptance/release contract around it.

Do not interpret stage sequencing as human acceptance. Acceptance, evidence
correlation, immutable artifact selection and rollback provenance must be verified
explicitly. General-purpose Actions/terminals should not be exposed to an AI
caller. API credential scopes and separation of reader/operator/admin permissions
need validation; no API token is created by this milestone.

## Still unverified

No Komodo Core/Periphery was installed and no real server was attached. The local
cloud workspace has no Docker daemon and limited free disk. GitHub CI can test
the tiny fixture containers, but that does not validate Komodo compatibility,
resource import syntax, permissions, networking, persistent databases, recovery
or suitability for the user's infrastructure. No speculative Komodo config is
presented as tested or ready to import.
