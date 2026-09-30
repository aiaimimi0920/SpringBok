import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import test from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (path) => readFileSync(resolve(root, path), "utf8");
const workflowNames = readdirSync(resolve(root, ".github/workflows"));

test("security workflows keep least privilege and untrusted PR boundaries", () => {
  for (const name of ["repository-quality.yml", "codeql.yml"]) {
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
  assert.match(quality, /gitleaks" git --redact=100 --no-banner --exit-code=1/);
  assert.doesNotMatch(quality, /continue-on-error|\|\| true/);
});

test("Dependabot tracks Actions with bounded pull requests", () => {
  const config = read(".github/dependabot.yml");
  assert.match(config, /package-ecosystem: github-actions/);
  assert.match(config, /interval: weekly/);
  assert.match(config, /open-pull-requests-limit: [1-5]/);
});

test("bootstrap makes no unsupported product, dependency or release claims", () => {
  assert.match(read("README.md"), /pending evaluation/);
  assert.match(read(".github/workflows/codeql.yml"), /language: \[actions\]/);
  assert.doesNotMatch(workflowNames.join(" "), /release|deploy|dependency-security/);
  for (const path of ["package.json", "package-lock.json", "Cargo.toml", "LICENSE"]) {
    assert.equal(existsSync(resolve(root, path)), false, path);
  }
});
