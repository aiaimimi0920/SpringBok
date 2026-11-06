// Explicit immutable-source input; reading still uses the normal owner API.
export function applicationSourceFields(container, load) {
  const toggle = document.createElement('button'), form = document.createElement('form');
  toggle.type = 'button'; toggle.textContent = '指定来源';
  toggle.setAttribute('aria-expanded', 'false'); toggle.setAttribute('aria-controls', 'service-source-form');
  form.id = 'service-source-form'; form.hidden = true;
  const fields = document.createElement('fieldset');
  const github = document.createElement('select'), repository = document.createElement('input'), sourceSha = document.createElement('input');
  repository.pattern = '[A-Za-z0-9][A-Za-z0-9_.-]{0,99}/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}';
  repository.maxLength = 201; sourceSha.pattern = '[a-f0-9]{40}'; sourceSha.maxLength = 40;
  repository.autocomplete = 'off'; sourceSha.autocomplete = 'off';
  for (const [id, text, control] of [['service-source-github', 'GitHub 连接', github],
    ['service-source-repository', '仓库', repository], ['service-source-sha', '提交 SHA', sourceSha]]) {
    const row = document.createElement('div'), label = document.createElement('label');
    row.className = 'field'; control.id = id; control.required = true;
    label.htmlFor = id; label.textContent = text; row.append(label, control); fields.append(row);
  }
  const read = document.createElement('button'); read.type = 'submit'; read.textContent = '读取版本';
  fields.append(read); form.append(fields); container.append(toggle, form);
  toggle.addEventListener('click', () => {
    form.hidden = !form.hidden; toggle.setAttribute('aria-expanded', String(!form.hidden));
    if (!form.hidden) github.focus();
  });
  github.addEventListener('change', () => {
    const target = github.selectedOptions[0]?.dataset.target;
    if (target && !target.startsWith('@')) repository.value = target;
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (!fields.disabled && form.reportValidity()) void load({ connectionId: github.value, repository: repository.value, sourceSha: sourceSha.value });
  });
  return {
    reset(connections = [], binding = null) {
      form.hidden = true; toggle.setAttribute('aria-expanded', 'false');
      github.replaceChildren(new Option('请选择连接', ''));
      for (const row of connections.filter(row => row.provider === 'github' && row.state === 'verified' && row.deploymentAvailable !== false && (!binding || row.id === binding.connectionId))) {
        const option = new Option(row.name + ' · ' + row.target, row.id); option.dataset.target = row.target; github.append(option);
      }
      if (github.options.length === 2) github.selectedIndex = 1;
      const target = github.selectedOptions[0]?.dataset.target;
      github.disabled = !!binding; repository.readOnly = !!binding;
      repository.value = binding?.repository ?? (target && !target.startsWith('@') ? target : ''); sourceSha.value = '';
    },
    sync({ hidden, disabled }) { container.hidden = hidden; fields.disabled = disabled; toggle.disabled = disabled; }
  };
}
