// Secret values are submitted only to the vault, never to a public deployment plan.
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
  for (const name of names) {
    const input = document.createElement('input'); input.type = 'password'; input.autocomplete = 'new-password'; input.maxLength = 512;
    inputs.set(name, input); addField(container, 'service-secret-' + name, name, input);
  }
  let saved = null;
  const sync = () => {
    saved = null;
    for (const input of inputs.values()) { input.value = ''; input.required = !select.value; input.disabled = !!select.value; input.closest('.field').hidden = !!select.value; }
    changed();
  };
  select.addEventListener('change', sync); sync();
  return async () => {
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
    for (const input of inputs.values()) { input.required = false; input.disabled = true; input.closest('.field').hidden = true; }
    return saved;
  };
}
