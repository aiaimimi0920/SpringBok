// Secret values are submitted only to the vault, never to a public deployment plan.
const importLimit = 262144, valueLimit = 16384, importError = '秘密文件格式或内容不匹配';
const validSecretValue = value => typeof value === 'string' && value.length > 0 && new TextEncoder().encode(value).length <= valueLimit && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
const profileText = row => (row.label ? row.label + ' · ' : '') + new Date(row.createdAt).toLocaleString();
export function parseApplicationSecretImport(text, names) {
  try {
    if (typeof text !== 'string' || new TextEncoder().encode(text).length > importLimit) throw new Error();
    const values = JSON.parse(text.replace(/^\ufeff/, ''));
    if (!values || typeof values !== 'object' || Array.isArray(values) || Object.keys(values).length !== names.length) throw new Error();
    for (const name of names) {
      const value = Object.hasOwn(values, name) ? values[name] : null;
      if (!validSecretValue(value)) throw new Error();
    }
    return values;
  } catch { throw new Error(importError); }
}

export function applicationSecretFields(data, profiles, container, addField, request, changed, isUpdate = false) {
  const names = data.declaration.applicationSecrets ?? [];
  if (!names.length) return null;
  const matching = profiles.filter(row => row.repository === data.repository.toLowerCase() && row.applicationId === data.manifest.id &&
    row.names.length === names.length && names.every(name => row.names.includes(name)));
  const select = document.createElement('select'), inputs = new Map(), importedRaw = new Map();
  if (isUpdate) select.append(new Option('保持原业务秘密', '__keep__'));
  select.append(new Option('新建秘密配置', ''));
  for (const row of matching) select.append(new Option(profileText(row), row.id));
  if (isUpdate) select.value = '__keep__';
  else if (matching.length === 1) select.value = matching[0].id;
  addField(container, 'service-secret-profile', '业务秘密', select);
  const file = document.createElement('input'), status = document.createElement('output');
  file.type = 'file'; file.accept = '.json,application/json';
  addField(container, 'service-secret-file', '导入 JSON', file);
  status.id = 'service-secret-import-status'; status.className = 'service-secret-import-status'; status.setAttribute('role', 'status');
  file.closest('.field').append(status);
  for (const name of names) {
    const input = document.createElement('input'); input.type = 'password'; input.autocomplete = 'new-password'; input.maxLength = valueLimit;
    inputs.set(name, input); addField(container, 'service-secret-' + name, name, input);
  }
  let saved = null, importGeneration = 0, reading = false;
  const cancelImport = () => { importGeneration++; reading = false; file.value = ''; status.textContent = ''; };
  const dialog = container.closest('dialog');
  const sync = () => {
    saved = null; importedRaw.clear(); cancelImport();
    const creating = select.value === '';
    file.disabled = !creating; file.closest('.field').hidden = !creating;
    for (const input of inputs.values()) { input.value = ''; input.required = creating; input.disabled = !creating; input.closest('.field').hidden = !creating; }
    changed();
  };
  select.addEventListener('change', sync); sync();
  for (const [name, input] of inputs) input.addEventListener('input', () => { importedRaw.delete(name); cancelImport(); });
  dialog?.addEventListener('close', () => { importedRaw.clear(); cancelImport(); for (const input of inputs.values()) input.value = ''; }, { once: true });
  file.addEventListener('change', async () => {
    const selected = file.files[0]; cancelImport();
    if (!selected || select.value !== '' || !file.isConnected) return;
    const version = importGeneration;
    const current = () => version === importGeneration && file.isConnected && select.value === '' && (!dialog || dialog.open);
    reading = true; saved = null; changed(); status.textContent = '正在导入…'; status.dataset.tone = 'info';
    try {
      if (selected.size > importLimit) throw new Error();
      const values = parseApplicationSecretImport(await selected.text(), names);
      if (!current()) return;
      importedRaw.clear();
      for (const name of names) { importedRaw.set(name, values[name]); inputs.get(name).value = values[name]; }
      status.textContent = '已导入 ' + names.length + ' 项'; status.dataset.tone = 'success'; changed();
    } catch {
      if (current()) { status.textContent = importError; status.dataset.tone = 'error'; }
    } finally { if (current()) reading = false; }
  });
  return async () => {
    if (reading) throw new Error('业务秘密正在导入');
    if (select.value === '__keep__') return null;
    if (saved) return saved;
    if (select.value) {
      const row = matching.find(row => row.id === select.value);
      if (!row) throw new Error('业务秘密不可用');
      return { id: row.id, revision: row.revision };
    }
    const values = Object.fromEntries([...inputs].map(([name,input]) => [name, importedRaw.get(name) ?? input.value]));
    if (names.some(name => !validSecretValue(values[name]))) throw new Error('请输入有效的业务秘密');
    let result;
    try { result = await request('/api/admin/resources', { action: 'application-secrets', id: crypto.randomUUID(), repository: data.repository, applicationId: data.manifest.id, values }); }
    finally { importedRaw.clear(); for (const name of names) { values[name] = undefined; inputs.get(name).value = ''; } }
    const row = result.profile; matching.push(row); profiles.push(row);
    saved = { id: row.id, revision: row.revision };
    select.append(new Option(profileText(row), row.id)); select.value = row.id;
    cancelImport(); file.disabled = true; file.closest('.field').hidden = true;
    for (const input of inputs.values()) { input.required = false; input.disabled = true; input.closest('.field').hidden = true; }
    return saved;
  };
}
