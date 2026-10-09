import { readFile, mkdir, writeFile, copyFile, lstat, readdir, realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkExample, root } from './check-example.mjs';

// A deliberately small, escaped Markdown subset; no raw HTML, plugins or remote includes.
export const escapeHtml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
export function safeHref(value) {
  if (/^https:\/\//.test(value)) return new URL(value).href;
  if (/^[a-z][a-z0-9-]*\.html(?:#[a-z0-9-]+)?$/.test(value) || /^#[a-z0-9-]+$/.test(value)) return value;
  throw new Error('Unsupported documentation link: ' + value);
}
function inline(text) {
  const tokens = /(`[^`]+`|\[[^\]]+\]\([^)]+\)|\*\*[^*]+\*\*)/g;
  return text.split(tokens).map(part => {
    if (part.startsWith('`') && part.endsWith('`')) return '<code>' + escapeHtml(part.slice(1, -1)) + '</code>';
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
    if (link) return `<a href="${escapeHtml(safeHref(link[2].replace(/\.md$/, '.html')))}">${escapeHtml(link[1])}</a>`;
    if (part.startsWith('**') && part.endsWith('**')) return '<strong>' + escapeHtml(part.slice(2, -2)) + '</strong>';
    return escapeHtml(part);
  }).join('');
}
export function renderMarkdown(source) {
  const lines = source.replaceAll('\r\n', '\n').split('\n');
  let html = '', index = 0, heading = 0, titleCount = 0;
  const toc = [];
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index++; continue; }
    if (line.startsWith('```')) {
      const language = line.slice(3).trim();
      if (!/^[a-z0-9-]*$/.test(language)) throw new Error('Invalid code language');
      const code = []; index++;
      while (index < lines.length && lines[index] !== '```') code.push(lines[index++]);
      if (index === lines.length) throw new Error('Unclosed code fence');
      index++;
      html += `<div class="code-block"><span class="code-language">${escapeHtml(language || 'text')}</span><pre tabindex="0"><code>${escapeHtml(code.join('\n'))}</code></pre></div>`;
      continue;
    }
    const h = /^(#{1,3}) (.+)$/.exec(line);
    if (h) {
      const level = h[1].length, id = `section-${++heading}`;
      if (level === 1) titleCount++;
      else toc.push({ id, title: h[2], level });
      html += `<h${level} id="${id}">${inline(h[2])}</h${level}>`; index++; continue;
    }
    if (line.startsWith('|')) {
      const rows = [];
      while (index < lines.length && lines[index].startsWith('|')) rows.push(lines[index++].slice(1, -1).split('|').map(v => v.trim()));
      if (rows.length < 2 || !rows[1].every(v => /^:?-{3,}:?$/.test(v))) throw new Error('Invalid Markdown table');
      const width = rows[0].length;
      if (rows.some(row => row.length !== width)) throw new Error('Inconsistent table columns');
      html += `<div class="table-scroll" role="region" aria-label="参考表格" tabindex="0"><table><thead><tr>${rows[0].map(v => `<th scope="col">${inline(v)}</th>`).join('')}</tr></thead><tbody>${rows.slice(2).map(row => '<tr>' + row.map(v => `<td>${inline(v)}</td>`).join('') + '</tr>').join('')}</tbody></table></div>`;
      continue;
    }
    if (/^(?:- |\d+\. )/.test(line)) {
      const ordered = /^\d/.test(line), pattern = ordered ? /^\d+\. / : /^- /, tag = ordered ? 'ol' : 'ul';
      const items = [];
      while (index < lines.length && pattern.test(lines[index])) items.push(lines[index++].replace(pattern, ''));
      html += `<${tag}>${items.map(v => `<li>${inline(v)}</li>`).join('')}</${tag}>`; continue;
    }
    html += '<p>' + inline(line) + '</p>'; index++;
  }
  if (titleCount !== 1) throw new Error('Each page must have exactly one H1');
  return { html, toc };
}
const examples = {
  manifest: ['.sba/manifest.json', 'json'], deployment: ['.sba/deployment.json', 'json'],
  entrypoint: ['.sba/springbok.ps1', 'powershell'], request: ['request.json', 'json'],
};
async function sourceFor(page) {
  if (!/^(ai-docs\/[a-z-]+\.md|pages\/content\/[a-z-]+\.md)$/.test(page.source)) throw new Error('Source not in public documentation allowlist');
  const path = resolve(root, page.source);
  if ((await lstat(path)).isSymbolicLink() || resolve(await realpath(path)) !== path) throw new Error('Symlink source rejected');
  let text = await readFile(path, 'utf8');
  for (const [name, [file, language]] of Object.entries(examples)) {
    text = text.replaceAll(`{{example:${name}}}`, '```' + language + '\n' + (await readFile(resolve(root, 'ai-docs/examples/minimal', file), 'utf8')).trim() + '\n```');
  }
  if (text.includes('{{example:')) throw new Error('Unknown example');
  return text;
}
export async function build(output) {
  if (!output) throw new Error('An explicit output directory is required');
  const out = resolve(output), rel = relative(root, out);
  if (!rel || (!rel.startsWith('..') && !isAbsolute(rel) && rel !== 'pages/_site')) throw new Error('Do not build over repository sources');
  try { if ((await readdir(out)).length) throw new Error('Output must be empty; refusing stale or private artifact contents'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await checkExample();
  const config = JSON.parse(await readFile(resolve(root, 'pages/site.json'), 'utf8'));
  const ids = new Set();
  for (const p of config.pages) {
    if (!/^[a-z][a-z0-9-]*$/.test(p.id) || ids.has(p.id)) throw new Error('Invalid page id');
    ids.add(p.id);
  }
  const documents = [];
  for (const page of config.pages) {
    const rendered = renderMarkdown(await sourceFor(page));
    for (const [, href] of rendered.html.matchAll(/href="([^"]+)"/g)) {
      if (/^[a-z][a-z0-9-]*\.html$/.test(href) && !ids.has(href.slice(0, -5))) throw new Error('Broken internal link ' + href);
    }
    const nav = config.pages.map(p => `<a href="${p.id}.html"${p.id === page.id ? ' aria-current="page"' : ''}><span>${escapeHtml(p.title)}</span></a>`).join('');
    const toc = rendered.toc.map(h => `<a href="#${h.id}" class="level-${h.level}">${escapeHtml(h.title)}</a>`).join('');
    const position = config.pages.indexOf(page), next = config.pages[position + 1];
    documents.push([page.id + '.html', `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="SpringBok 服务部署与 SBA 接入开发者文档"><title>${escapeHtml(page.title)} · ${escapeHtml(config.title)}</title><link rel="stylesheet" href="style.css"></head>
<body><a class="skip" href="#main">跳到正文</a><header><a class="brand" href="index.html"><span class="brand-mark">S</span> SpringBok <span class="brand-label">DEVELOPER DOCS</span></a><a class="repository" href="https://github.com/aiaimimi0920/SpringBok">GitHub ↗</a></header>
<div class="layout"><nav class="sidebar" aria-label="文档导航"><p class="eyebrow">开发者手册</p>${nav}<div class="version">MANIFEST v3<br>DEPLOYMENT v2</div></nav><main id="main" tabindex="-1"><p class="eyebrow">${escapeHtml(page.group)} / ${escapeHtml(page.title)}</p><article>${rendered.html}</article><footer><a href="https://github.com/aiaimimi0920/SpringBok/blob/main/${page.source}">查看本文源文件 ↗</a>${next ? `<a href="${next.id}.html">下一篇 · ${escapeHtml(next.title)} →</a>` : '<a href="index.html">返回项目介绍 →</a>'}</footer></main><aside aria-label="本页目录"><p class="eyebrow">本页内容</p>${toc}</aside></div></body></html>\n`]);
  }
  // No recursive copies: internal docs, vaults and deployment evidence cannot enter the artifact.
  await mkdir(out, { recursive: true });
  for (const [file, html] of documents) await writeFile(resolve(out, file), html, 'utf8');
  await copyFile(resolve(root, 'pages/style.css'), resolve(out, 'style.css'));
  await writeFile(resolve(out, '.nojekyll'), '', 'utf8');
  return documents.map(([file]) => file);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify({ pages: await build(process.argv[2]) })); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
