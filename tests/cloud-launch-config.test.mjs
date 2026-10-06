import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = name => JSON.parse(readFileSync(new URL(`../cloud/${name}`, import.meta.url), 'utf8'));
const base = read('wrangler.jsonc');
const launch = read('wrangler.launch.json');

test('launch preserves durable object identities and additive migration history', () => {
  assert.equal(launch.name, 'springbok-test');
  assert.equal(launch.main, base.main);
  assert.equal(launch.compatibility_date, base.compatibility_date);
  assert.deepEqual(launch.durable_objects, base.durable_objects);
  assert.deepEqual(launch.migrations, base.migrations);
  for (const migration of launch.migrations) {
    assert.deepEqual(Object.keys(migration).sort(), ['new_sqlite_classes', 'tag']);
  }
});

test('launch enables authenticated management without fixture or node execution', () => {
  assert.equal(base.vars.ENABLE_ADMIN, 'no');
  assert.equal(launch.workers_dev, false);
  assert.equal(launch.preview_urls, false);
  assert.deepEqual(launch.routes, [{ pattern: 'springbok-test.aiaimimi.com', custom_domain: true }]);
  assert.deepEqual(launch.assets, base.assets);
  assert.equal(launch.assets.run_worker_first, true);
  for (const [key, value] of Object.entries(launch.vars)) {
    if (key.startsWith('ENABLE_')) {
      assert.equal(value, ['ENABLE_ADMIN', 'ENABLE_CATALOG'].includes(key) ? 'yes' : 'no');
    }
    assert.ok(!/TOKEN|SECRET|PASSWORD/.test(key));
  }
  assert.deepEqual(JSON.parse(launch.vars.ADMIN_EMAILS), ['vmjcv666@gmail.com']);
  assert.equal(launch.vars.ADMIN_ORIGIN, 'https://springbok-test.aiaimimi.com');
  assert.equal(launch.vars.ACCESS_ISSUER, 'https://aiaimimi.cloudflareaccess.com');
  assert.match(launch.vars.ACCESS_AUD, /^[a-f0-9]{64}$/);
});
