import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);
export async function startTestConsole({ controller, port = 0 }) {
  const store = controller;
  const csrf = randomBytes(32).toString('hex'); // Memory-only cross-site defense, not owner authentication.
  let origin;
  const server = http.createServer(async (req, res) => {
    const headers = {
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    };
    const reply = (status, value, type = 'application/json; charset=utf-8') => {
      res.writeHead(status, { ...headers, 'Content-Type': type }); res.end(type.startsWith('application/json') ? JSON.stringify(value) : value);
    };
    try {
      if (req.headers.host !== new URL(origin).host) return reply(403, { error: 'Unknown host' });
      if (req.headers.origin && req.headers.origin !== origin) return reply(403, { error: 'Cross-origin request rejected' });
      if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) return reply(403, { error: 'Cross-site request rejected' });
      if (req.method === 'GET' && assets.has(req.url)) {
        const [file, type] = assets.get(req.url);
        return reply(200, readFileSync(new URL(`../../public/test-console/${file}`, import.meta.url)), type);
      }
      if (req.method === 'GET' && req.url === '/api/state') return reply(200, { ...store.snapshot(), csrf });
      if (req.method !== 'POST' || !['/api/action', '/api/reconcile'].includes(req.url)) return reply(404, { error: 'Unknown route' });
      if (req.headers.origin !== origin || req.headers['content-type'] !== 'application/json') return reply(403, { error: 'Same-origin JSON required' });
      const token = req.headers['x-csrf-token'];
      if (typeof token !== 'string' || token.length !== csrf.length || !timingSafeEqual(Buffer.from(token), Buffer.from(csrf))) return reply(403, { error: 'Refresh this test session' });
      const chunks = []; let length = 0;
      for await (const chunk of req) {
        length += chunk.length;
        if (length > 2048) return reply(413, { error: 'Request too large' });
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!body || typeof body !== 'object' || Array.isArray(body) || !Number.isSafeInteger(body.revision)) throw new Error('invalid request');
      if (req.url === '/api/reconcile') {
        if (Object.keys(body).sort().join(',') !== 'id,revision' || body.revision !== store.snapshot().revision ||
            typeof body.id !== 'string') throw new Error('invalid reconciliation');
        await store.reconcile(body.id);
      } else await store.action(body);
      return reply(200, { ...store.snapshot(), csrf });
    } catch (error) {
      // Only fixed application errors are exposed; no paths, file data or stack traces.
      return reply(error.status === 409 ? 409 : 400, { error: error.status === 409 ? '状态已变化，请刷新后重新操作' : '操作被拒绝或记录失败，请检查状态；未报告成功' });
    }
  });
  server.requestTimeout = 5000; server.headersTimeout = 5000;
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    origin = `http://127.0.0.1:${server.address().port}`;
  } catch (error) { throw error; }
  return { origin, server, close: async () => { await new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); }); }  };
}
