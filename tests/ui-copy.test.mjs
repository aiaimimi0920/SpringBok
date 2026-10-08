import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

test('UI-05: production UI does not restore explanatory copy or helper panels', async () => {
  const root = new URL('../public/cloud-admin/', import.meta.url);
  const files = (await readdir(root)).filter(name => /\.(html|m?js|css)$/.test(name));
  const forbidden = /已按账户更新资源|各类型的权限和读取结果见下方|resource-brand-help|resource-secret-help|connection-secret-help|应用声明文件要求|固定节点联调范围|读取应用声明后显示配置字段|这里仅登记元数据|不证明业务健康|未列出不代表不存在/;
  for (const file of files) {
    const source = await readFile(new URL(file, root), 'utf8');
    assert.doesNotMatch(source, forbidden, file);
    if (file.endsWith('.html')) assert.doesNotMatch(source, /class="(?:field-note|section-note|legacy-note)"/, file);
  }
  const resources = await readFile(new URL('resources.js', root), 'utf8');
  assert.match(resources, /lastRead=Date\.now\(\);notice\(''\)/);
  const deploy = await readFile(new URL('deploy.html', root), 'utf8');
  assert.match(deploy, /公开配置（勿填密钥）/);
  assert.match(deploy, /id="deploy-submit"[^>]*disabled/);
});
