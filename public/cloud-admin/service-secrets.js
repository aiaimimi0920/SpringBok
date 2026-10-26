// Secret values are submitted only to the vault, never to a public deployment plan.
const importLimit = 32768, importError = '秘密文件格式或内容不匹配';
export function parseApplicationSecretImport(text, names) {
  try {
    if (typeof text !== 'string' || new TextEncoder().encode(text).length > importLimit) throw new Error();
    const values = JSON.parse(text.replace(/^\ufeff/, ''));
    if (!values || typeof values !== 'object' || Array.isArray(values) || Object.keys(values).length !== names.length) throw new Error();
    for (const name of names) {
      const value = Object.hasOwn(values, name) ? values[name] : null;
      if (typeof value !== 'string' || !value || new TextEncoder().encode(value).length > 512 || /[\x00-\x1f\x7f]/.test(value)) throw new Error();
    }
    return values;
  } catch { throw new Error(importError); }
}

export function applicationSecretFields(data, profiles, container, addField, request, changed) {
  const names = data.declaration.applicationSecrets ?? [];
  if (!names.length) return null;
  const matching = profiles.filter(row => row.repository === data.repository.toLowerCase() && row.applicationId === data.manifest.id &&
    row.names.length === names.length && names.every(name => row.names.includes(name)));
  const select = document.createElement('select'), inputs = new Map();
  select.append(new Option('新建秘密配置', ''));
  for (const row of matching) select.append(new Option(new Date(row.createdAt).toLocaleString(), row.id));
  if (matching.length === 1) select.value = matching[0].id;
  addField(container, 'service-secret-profile', '业务秘密', select);
  const file = document.createElement('input'), status = document.createElement('output');
  file.type = 'file'; file.accept = '.json,application/json';
  addField(container, 'service-secret-file', '导入 JSON', file);
  status.id = 'service-secret-import-status'; status.className = 'service-secret-import-status'; status.setAttribute('role', 'status');
  file.closest('.field').append(status);
  for (const name of names) {
    const input = document.createElement('input'); input.type = 'password'; input.autocomplete = 'new-password'; input.maxLength = 512;
    inputs.set(name, input); addField(container, 'service-secret-' + name, name, input);
  }
  let saved = null, importGeneration = 0, reading = false;
  const cancelImport = () => { importGeneration++; reading = false; file.value = ''; status.textContent = ''; };
  const dialog = container.closest('dialog');
  const sync = () => {
    saved = null; cancelImport();
    file.disabled = !!select.value; file.closest('.field').hidden = !!select.value;
    for (const input of inputs.values()) { input.value = ''; input.required = !select.value; input.disabled = !!select.value; input.closest('.field').hidden = !!select.value; }
    changed();
  };
  select.addEventListener('change', sync); sync();
  for (const input of inputs.values()) input.addEventListener('input', cancelImport);
  dialog?.addEventListener('close', () => { cancelImport(); for (const input of inputs.values()) input.value = ''; }, { once: true });
  file.addEventListener('change', async () => {
    const selected = file.files[0]; cancelImport();
    if (!selected || select.value || !file.isConnected) return;
    const version = importGeneration;
    const current = () => version === importGeneration && file.isConnected && !select.value && (!dialog || dialog.open);
    reading = true; saved = null; changed(); status.textContent = '正在导入…'; status.dataset.tone = 'info';
    try {
      if (selected.size > importLimit) throw new Error();
      const values = parseApplicationSecretImport(await selected.text(), names);
      if (!current()) return;
      for (const name of names) inputs.get(name).value = values[name];
      status.textContent = '已导入 ' + names.length + ' 项'; status.dataset.tone = 'success'; changed();
    } catch {
      if (current()) { status.textContent = importError; status.dataset.tone = 'error'; }
    } finally { if (current()) reading = false; }
  });
  return async () => {
    if (reading) throw new Error('业务秘密正在导入');
    if (saved) return saved;
    if (select.value) {
      const row = matching.find(row => row.id === select.value);
      if (!row) throw new Error('业务秘密不可用');
      return { id: row.id, revision: row.revision };
    }
    const values = Object.fromEntries([...inputs].map(([name,input]) => [name,input.value]));
    if (names.some(name => !values[name])) throw new Error('请输入全部业务秘密');
    let result;
    try { result = await request('/api/admin/resources', { action: 'application-secrets', id: crypto.randomUUID(), repository: data.repository, applicationId: data.manifest.id, values }); }
    finally { for (const name of names) { values[name] = undefined; inputs.get(name).value = ''; } }
    const row = result.profile; matching.push(row); profiles.push(row);
    saved = { id: row.id, revision: row.revision };
    select.append(new Option(new Date(row.createdAt).toLocaleString(), row.id)); select.value = row.id;
    cancelImport(); file.disabled = true; file.closest('.field').hidden = true;
    for (const input of inputs.values()) { input.required = false; input.disabled = true; input.closest('.field').hidden = true; }
    return saved;
  };
}
