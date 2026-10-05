import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import test from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (path) => readFileSync(resolve(root, path), "utf8");
const workflowNames = readdirSync(resolve(root, ".github/workflows"));

test("security workflows keep least privilege and untrusted PR boundaries", () => {
  for (const name of workflowNames) {
    const workflow = read(`.github/workflows/${name}`);
    assert.match(workflow, /contents: read/);
    assert.match(workflow, /persist-credentials: false/);
    assert.match(workflow, /timeout-minutes:/);
    assert.doesNotMatch(workflow, /pull_request_target|secrets\.|contents: write|packages: write|id-token:/);
    for (const [, ref] of workflow.matchAll(/uses:\s+([^\s]+) /g)) {
      assert.match(ref, /@[a-f0-9]{40}$/);
    }
  }
});

test("secret and workflow scanners have exact verified releases and fail closed", () => {
  const install = read("scripts/ci/install-tool.sh");
  assert.match(install, /set -euo pipefail/);
  assert.match(install, /sha256sum --check --status/);
  assert.match(install, /v1\.7\.12\//);
  assert.match(install, /v8\.30\.1\//);
  assert.equal([...install.matchAll(/sha256=[a-f0-9]{64}/g)].length, 2);
  const quality = read(".github/workflows/repository-quality.yml");
  assert.match(quality, /fetch-depth: 0/);
  assert.match(quality, /gitleaks" git --redact=100 --no-banner --exit-code=42/);
  assert.match(quality, /scripts\/security_findings\.py gitleaks/);
  assert.match(quality, /if-no-files-found: error/);
  assert.doesNotMatch(quality, /continue-on-error|\|\| true/);
});

test("Dependabot tracks Actions with bounded pull requests", () => {
  const config = read(".github/dependabot.yml");
  assert.match(config, /package-ecosystem: github-actions/);
  assert.match(config, /interval: weekly/);
  assert.match(config, /open-pull-requests-limit: [1-5]/);
});

test("browser test dependency audit covers the committed lock without executing packages", () => {
  const quality = read(".github/workflows/repository-quality.yml");
  assert.match(quality, /name: Audit committed browser test dependencies\n\s+timeout-minutes: 5\n\s+working-directory: tests\/browser\n\s+run: python3 \.\.\/\.\.\/scripts\/run_dependency_audit\.py npm --output \.\.\/\.\.\/\.tmp\/security-reports\/browser -- npm audit --package-lock-only --include=dev --include=optional --include=peer --audit-level=low/);
  assert.equal(existsSync(resolve(root, "tests/browser/package-lock.json")), true);
  assert.doesNotMatch(quality, /--omit|continue-on-error|\|\| true/);
});

test("contract lab makes no unsupported product stack or release claims", () => {
  assert.match(read("README.md"), /pending evaluation/);
  assert.match(read(".github/workflows/codeql.yml"), /language: \[actions, javascript-typescript, python\]/);
  assert.doesNotMatch(workflowNames.join(" "), /release|deploy/);
  for (const path of ["package.json", "package-lock.json", "Cargo.toml", "LICENSE"]) {
    assert.equal(existsSync(resolve(root, path)), false, path);
  }
});

test("CodeQL initialization and analysis share an exact release pin", () => {
  const workflow = read(".github/workflows/codeql.yml");
  const pins = [...workflow.matchAll(/uses:\s+github\/codeql-action\/(init|analyze)@([a-f0-9]{40})(?=\s|$)/g)];
  assert.deepEqual(pins.map(([, action]) => action).sort(), ["analyze", "init"]);
  assert.equal(new Set(pins.map(([, , pin]) => pin)).size, 1, "mixed CodeQL versions cannot read each other's configuration");
  assert.match(read(".github/dependabot.yml"), /groups:\s+codeql-actions:\s+patterns:\s+- "github\/codeql-action\/\*"/);
});

test("systemd acceptance remains isolated to a disposable hosted account and preserves fatal-state policy", () => {
  const script = read("scripts/ci/node-user-service.sh");
  assert.match(script, /GITHUB_ACTIONS:-.*true.*RUNNER_ENVIRONMENT:-.*github-hosted/);
  assert.match(script, /! id "\$name"/);
  assert.ok(script.indexOf('trap cleanup EXIT') < script.indexOf('sudo loginctl enable-linger'));
  assert.match(script, /run_phase exercise/); assert.match(script, /run_phase restart/); assert.match(script, /run_phase disabled/);
  assert.doesNotMatch(script, /--privileged|userdel|rm -rf|\|\| true/);
  const source = read("src/node-service/user-unit.mjs");
  assert.match(source, /Restart=no/); assert.match(source, /TimeoutStopSec=30s/);
  assert.doesNotMatch(source, /execSync|spawn|unlinkSync\([^)]*lock|Restart=always/);
});
