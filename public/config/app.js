'use strict';
const fileInput = document.querySelector('#config-file'), status = document.querySelector('#status');
const resultBox = document.querySelector('#result'), download = document.querySelector('#download');
const names = { gateway: 'Gateway 网关', forum: '论坛', game: '在线游戏', account: '账号服务' };
const requirements = {
  'resolve-complete-live-config-and-resource-ownership': '解析真实完整配置并核对资源所有权',
  'verify-image-pull-platform-and-provenance': '验证镜像拉取、平台和来源',
  'verify-image-healthcheck-and-business-health': '验证镜像健康检查与业务健康',
  'approve-runtime-and-authentication': '确认运行位置与身份认证',
  'review-external-network-exposure': '审查对外监听的网络暴露',
  'verify-volume-provisioning-ownership-backups-and-data-migration': '核对命名卷、权限、备份和数据迁移',
  'resolve-secret-references-through-approved-channel': '通过批准的渠道解析密钥引用',
};
let csrf = null, generation = 0, request = null, result = null, objectUrl = null;
function element(tag, text, className) { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; }
function clear(message = '已清空；请选择配置文件') {
  generation++; request?.abort(); request = null; result = null; download.disabled = true;
  if (objectUrl) URL.revokeObjectURL(objectUrl); objectUrl = null;
  fileInput.value = ''; resultBox.hidden = true;
  document.querySelector('#overview').replaceChildren(); document.querySelector('#services').replaceChildren();
  status.textContent = message; status.className = '';
}
function render(review) {
  const overview = document.querySelector('#overview');
  for (const [label, value] of [['项目', review.manifest.project], ['配置摘要', review.manifestDigest],
    ['已配置服务', review.manifest.services.map(s => names[s.id]).join('、')],
    ['未配置服务', review.omittedServices.map(id => names[id]).join('、') || '无']]) overview.append(element('dt', label), element('dd', value));
  const services = document.querySelector('#services');
  for (const service of review.manifest.services) {
    const article = element('article'); article.append(element('h3', names[service.id]), element('p', service.image, 'digest'));
    const targets = element('div', undefined, 'targets');
    for (const role of ['test', 'production']) {
      const target = service[role], draft = review.drafts.find(d => d.service === service.id && d.environment === role);
      const box = element('section'); box.append(element('h4', role === 'test' ? '测试目标' : '生产目标 · 仅配置'));
      box.append(element('p', target.deploymentName), element('p', `Server ${target.serverId}`, 'digest'));
      for (const [label, values] of [
        ['端口', target.ports.map(p => `${p.hostIp}:${p.hostPort} → ${p.containerPort}/${p.protocol}`)],
        ['命名卷', target.volumes.map(v => `${v.name} → ${v.containerPath} · ${v.readOnly ? '只读' : '读写'}`)],
        ['未解析密钥引用（不是密钥值）', target.secretRefs.map(ref => `${ref.variable} ← ${ref.reference}`)],
        ['待完成', draft.requirements.map(id => requirements[id] || '未知要求，需核对')],
      ]) { box.append(element('h5', label)); const list = element('ul'); for (const value of values.length ? values : ['无']) list.append(element('li', value)); box.append(list); }
      targets.append(box);
    }
    article.append(targets); services.append(article);
  }
  resultBox.hidden = false;
}
fileInput.addEventListener('click', () => clear('选择新文件会撤销之前的导出结果'));
fileInput.addEventListener('cancel', () => clear('已取消选择；没有可下载结果'));
fileInput.addEventListener('change', async () => {
  const file = fileInput.files[0]; clear('正在校验配置…');
  if (!file) return clear('未选择文件');
  const current = generation; let timer;
  try {
    if (!csrf) throw new Error('本地会话未就绪，请刷新页面');
    if (file.size > 65536) throw new Error('文件超过64KiB');
    const bytes = await file.arrayBuffer(); if (current !== generation) return;
    const body = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    request = new AbortController(); const active = request;
    timer = setTimeout(() => active.abort(), 8000);
    const response = await fetch('/api/validate', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body, signal: request.signal });
    const review = await response.json(); if (current !== generation) return;
    if (!response.ok) throw new Error(review.error || '配置被拒绝');
    if (review.mode !== 'user-configuration-review' || review.readiness !== false || review.executable !== false) throw new Error('校验响应无效');
    render(review); result = review; download.disabled = false; status.textContent = '输入校验通过；仍需核对下列未完成项。尚未连接或部署';
  } catch (error) {
    if (current !== generation) return;
    clear(); status.textContent = error.name === 'AbortError' ? '校验超时，请重新选择文件' : error.name === 'TypeError' ? '读取或校验失败，请检查UTF-8文件并重新选择' : error.message;
    status.className = 'error';
  } finally { clearTimeout(timer); if (current === generation) request = null; }
});
document.querySelector('#reset').onclick = () => clear();
for (const name of ['popstate', 'pagehide']) window.addEventListener(name, () => clear('页面导航已清空结果，请重新选择文件'));
window.addEventListener('pageshow', event => { if (event.persisted) clear(); });
download.onclick = () => {
  if (!result) return;
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2) + '\n'], { type: 'application/json' }));
  const link = element('a'); link.href = objectUrl; link.download = 'springbok-review.json'; document.body.append(link); link.click(); link.remove();
};
fetch('/api/session', { cache: 'no-store' }).then(response => { if (!response.ok) throw new Error(); return response.json(); })
  .then(session => { if (!/^[a-f0-9]{64}$/.test(session.csrf)) throw new Error(); csrf = session.csrf; fileInput.disabled = false; status.textContent = '请选择配置文件；内容不会保存到服务端'; })
  .catch(() => { clear('本地会话建立失败，请刷新页面'); });
