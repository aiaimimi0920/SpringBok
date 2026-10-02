import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { compileConfiguration } from './compile.mjs';
import { compareConfigurations } from './compare.mjs';
const maxBytes = 65536;
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let length = 0; const chunks = [];
    const finish = (error, body) => { clearTimeout(timer); req.off('data', data); req.off('end', end); req.off('aborted', aborted); req.off('error', aborted); error ? reject(error) : resolve(body); };
    const data = chunk => { length += chunk.length; if (length > limit) { req.pause(); finish({ status: 413 }); } else chunks.push(chunk); };
    const end = () => finish(null, Buffer.concat(chunks));
    const aborted = () => finish({ status: 400 });
    const timer = setTimeout(() => { req.pause(); finish({ status: 408 }); }, 5000);
    req.on('data', data); req.once('end', end); req.once('aborted', aborted); req.once('error', aborted);
  });
}
export async function startConfigReview({ port = 0 } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('invalid port');
  const assets = new Map([['/', ['index.html', 'text/html; charset=utf-8']], ['/app.js', ['app.js', 'text/javascript; charset=utf-8']], ['/style.css', ['style.css', 'text/css; charset=utf-8']]]
    .map(([path, [file, type]]) => [path, { type, body: readFileSync(new URL(`../../public/config/${file}`, import.meta.url)) }]));
  const csrf = randomBytes(32).toString('hex'); let origin;
  const server = http.createServer(async (req, res) => {
    req.on('error', () => {}); // A disconnected upload cannot become an unhandled process error.
    const reply = (status, value, type = 'application/json; charset=utf-8') => {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer', 'Connection': 'close',
        'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" });
      res.end(type.startsWith('application/json') ? JSON.stringify(value) : value);
    };
    try {
      if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin) ||
        (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site']))) return reply(403, { error: '来源被拒绝' });
      if (req.method === 'GET' && assets.has(req.url)) { const asset = assets.get(req.url); return reply(200, asset.body, asset.type); }
      if (req.method === 'GET' && req.url === '/api/session') return reply(200, { csrf });
      if (req.method !== 'POST' || !['/api/validate', '/api/compare'].includes(req.url)) return reply(404, { error: '未知路径或方法' });
      const token = req.headers['x-csrf-token'];
      if (req.headers.origin !== origin || req.headers['content-type'] !== 'application/json' ||
        typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token) || !timingSafeEqual(Buffer.from(token), Buffer.from(csrf))) return reply(403, { error: '请刷新当前本地会话' });
      const limit = req.url === '/api/compare' ? maxBytes * 2 + 32 : maxBytes;
      if (Number(req.headers['content-length'] || 0) > limit) return reply(413, { error: '请求超过大小限制' });
      const bytes = await readBody(req, limit);
      let input;
      try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
      catch { return reply(400, { error: '文件必须为有效UTF-8 JSON' }); }
      // The compiler has no I/O and its errors contain fixed rules/field indexes,
      // never input values, unknown keys, filesystem paths or exception objects.
      let result;
      try { result = req.url === '/api/compare' ? compareConfigurations(input) : compileConfiguration(input); }
      catch (error) { return reply(400, { error: error.message }); }
      return reply(200, result);
    } catch (error) {
      reply(error.status || 400, { error: error.status === 413 ? '请求超过大小限制' : error.status === 408 ? '读取文件超时' : '校验失败，请重新选择文件' });
    }
  });
  server.requestTimeout = 6000; server.headersTimeout = 5000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}
