// Presentation only: no session, credentials, storage or deployment requests.
const paths = {
  cloudflare: 'M4 17h15a3 3 0 0 0 0-6h-1a6 6 0 0 0-11-3 4 4 0 0 0-3 9Zm-2 3h20',
  github: 'M8 21v-4c-4 1-4-2-6-2m14 6v-4c0-1-.4-2-1-2 4-.5 6-2 6-6 0-2-1-3-2-4 0-1 0-2-.5-3-2 0-3 1-4 2a14 14 0 0 0-5 0C8 3 7 2 5 2c-.5 1-.5 2-.5 3C3 6 2 7 2 9c0 4 2 5.5 6 6-.6 0-1 1-1 2',
  add: 'M12 5v14M5 12h14',
  database: 'M4 6a8 3 0 1 0 16 0 8 3 0 1 0-16 0m0 0v12a8 3 0 0 0 16 0V6M4 12a8 3 0 0 0 16 0',
  keyvalue: 'M3 5h18v14H3ZM7 9h3m4 0h3M7 15h3m4 0h3',
  bucket: 'M4 5h16l-2 16H6ZM4 5a8 2 0 0 1 16 0M8 10a4 4 0 0 0 8 0',
  brand: 'M5 3 11 7 18 3 15 10 20 14 13 14 9 21 7 13 3 9 8 9Z',
  deploy: 'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5',
  resources: 'm3 7 9-4 9 4-9 4-9-4Zm0 5 9 4 9-4M3 17l9 4 9-4',
  history: 'M3 11a9 9 0 1 1 2 7M3 4v7h7m2-5v6l4 2',
  settings: 'm9 3-.6 2.4-2 .9L4 5.7 2 9l1.7 1.8v2.4L2 15l2 3.3 2.4-.6 2 .9L9 21h4l.6-2.4 2-.9 2.4.6 2-3.3-1.7-1.8v-2.4L20 9l-2-3.3-2.4.6-2-.9L13 3Zm6 9a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
  refresh: 'M20 7V3l-3 3a8 8 0 0 0-13 6m0 5v4l3-3a8 8 0 0 0 13-6',
};
export function decorateIcons(root = document) {
for (const host of root.querySelectorAll('[data-icon]')) {
  if (host.querySelector('svg')) continue;
  const data = paths[host.dataset.icon];
  if (!data) continue;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(svg.namespaceURI, 'path');
  path.setAttribute('d', data); svg.append(path); host.prepend(svg);
}
}
decorateIcons();

// Dialog behavior stays with the page controllers; this module only adds icons.
