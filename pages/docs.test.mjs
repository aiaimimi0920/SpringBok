import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { build, renderMarkdown, safeHref, readPublicFile } from './build.mjs';
import { checkExample, root, exampleRoot } from './check-example.mjs';
import { validateManifest, validateRequest, validateResult } from '../src/sba/contract.mjs';
import { deploymentDeclaration, automaticConfiguration } from '../cloud/deployment-contract.mjs';
const json = async path => JSON.parse(await readFile(resolve(root, path), 'utf8'));
const temporary = () => mkdtemp(join(process.env.DOCS_TEST_TMP || tmpdir(), 'springbok-docs-'));

test('public source reader uses a regular open file and rejects linked source directories', async () => {
  const base = await temporary(), target = join(base,'public.md'), link = join(base,'linked');
  await writeFile(target,'# Public\n','utf8');
  assert.equal(await readPublicFile(target),'# Public\n');
  await symlink(base,link,process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(readPublicFile(join(link,'public.md')),/Symlink source rejected/);
  await assert.rejects(readPublicFile(base),/regular file/);
});

test('example uses actual v3/v2 contracts without claiming deployment', async () => {
  assert.deepEqual(await checkExample(), {application:'demo-service',manifest:3,deployment:2,execution:false});
  const m = await json('ai-docs/examples/minimal/.sba/manifest.json');
  const d = await json('ai-docs/examples/minimal/.sba/deployment.json');
  assert.throws(() => validateManifest({...m, capabilities:[]}));
  const missing = structuredClone(m); delete missing.actions.preview;
  assert.throws(() => validateManifest(missing));
  const invalid = structuredClone(d); delete invalid.fields[0].template;
  assert.throws(() => deploymentDeclaration(invalid));
  const r = validateRequest(await json('ai-docs/examples/minimal/request.json'),m);
  assert.deepEqual(automaticConfiguration(d, {'server.url':'https://demo.example.com'}, {}, {runtime:{accountId:'0'.repeat(32)}}, 'demo'),r.configuration);
});

test('renderer escapes HTML and code, rejects unsafe links and malformed Markdown', () => {
  const result = renderMarkdown('# Title\n\n<script>alert(1)</script>\n\n```html\n<img src=x onerror=x>\n```\n\n## More\n\n[Link](files.md)');
  assert.ok(!result.html.includes('<script>')); assert.ok(result.html.includes('&lt;img'));
  assert.match(result.html,/href="files.html"/);
  assert.deepEqual(result.toc,[{id:'section-2',title:'More',level:2}]);
  for (const url of ['javascript:alert(1)','//evil.example','../private.json','http://example.com']) assert.throws(()=>safeHref(url));
  assert.throws(()=>renderMarkdown('# T\n```json\n{}')); assert.throws(()=>renderMarkdown('# T\n# Second'));
  assert.throws(()=>renderMarkdown('# T\n| a | b |\n| --- | --- |\n| one |'));
});

test('public output is allowlisted and links work at a GitHub project subpath', async () => {
  const out = await temporary(), names = await build(out);
  assert.equal(names.length,9);
  assert.deepEqual((await readdir(out)).sort(),[...names,'style.css','.nojekyll'].sort());
  for (const name of names) {
    const html = await readFile(join(out,name),'utf8');
    assert.equal((html.match(/<h1 /g)||[]).length,1); assert.equal((html.match(/aria-current="page"/g)||[]).length,1);
    assert.match(html,/<html lang="zh-CN">/); assert.match(html,/href="#main"/);
    assert.doesNotMatch(html,/<script|src="https:|href="\/|vmjcv666@gmail|yamiyu\.com|dc-28f170|vault-backup/);
    for (const [,link] of html.matchAll(/href="([^"]+)"/g)) {
      const url = new URL(link, 'https://example.github.io/SpringBok/' + name);
      if (url.origin === 'https://example.github.io') {
        assert.ok(url.pathname.startsWith('/SpringBok/'));
        if (link.startsWith('#')) assert.ok(html.includes(`id="${link.slice(1)}"`));
        else assert.ok(names.includes(url.pathname.split('/').at(-1)) || link === 'style.css');
      }
    }
  }
  const example = await readFile(join(out,'example.html'),'utf8');
  assert.match(example,/EXAMPLE_NOT_IMPLEMENTED/); assert.match(example,/destroy-preview/); assert.doesNotMatch(example,/\{\{example:/);
  await assert.rejects(build(out),/Output must be empty/); await assert.rejects(build(root),/repository sources/);
  await assert.rejects(build(resolve(root,'ai-docs')),/repository sources/);
});

test('both audiences share references and tested examples', async () => {
  const site = await json('pages/site.json');
  for (const id of ['files','manifest','deployment','lifecycle','validation']) assert.equal(site.pages.find(p=>p.id===id).source,`ai-docs/${id}.md`);
  for (const file of ['manifest','deployment']) {
    const value = await json(`ai-docs/examples/minimal/.sba/${file}.json`), text = await readFile(resolve(root,`ai-docs/${file}.md`),'utf8');
    for (const key of Object.keys(value)) assert.ok(text.includes(key),key);
  }
  const lifecycle = await readFile(resolve(root,'ai-docs/lifecycle.md'),'utf8');
  for (const name of ['backup-created','data-preserved','snapshot-copied','migration-verified','source-unchanged','side-effects-isolated','repair-completed','unchanged-resources-verified','service-ready']) assert.ok(lifecycle.includes(name));
  const entry = await readFile(resolve(exampleRoot,'.sba/springbok.ps1'),'utf8');
  assert.match(entry,/status = 'failed'/); assert.doesNotMatch(entry,/Invoke-WebRequest|Invoke-RestMethod|SBA_EXECUTE|CLOUDFLARE_API_TOKEN|status = 'succeeded'/);
});

test('native PowerShell skeleton returns a valid failed result without cloud execution', {skip:process.platform !== 'win32'}, async () => {
  const dir = await temporary(), result = join(dir,'result.json');
  const run = spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-File',resolve(exampleRoot,'.sba/springbok.ps1'),'-RequestPath',resolve(exampleRoot,'request.json'),'-ResultPath',result],{encoding:'utf8',timeout:15000});
  assert.equal(run.status,0,run.stderr);
  const value = validateResult(JSON.parse(await readFile(result,'utf8')),await json('ai-docs/examples/minimal/request.json'));
  assert.equal(value.status,'failed'); assert.equal(value.errorCode,'EXAMPLE_NOT_IMPLEMENTED'); assert.equal(run.stdout.trim(),'');
});
