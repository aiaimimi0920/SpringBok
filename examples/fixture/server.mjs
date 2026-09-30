import { createServer } from 'node:http';
const services = ['gateway', 'forum', 'game', 'account'];
const service = process.env.SERVICE;
if (!services.includes(service)) throw new Error('SERVICE must be a known sample service');
const version = process.env.FIXTURE_VERSION || 'v1';
if (!/^v[12]$/.test(version)) throw new Error('unknown fixture version');
const server = createServer((req, res) => {
  if (req.method !== 'GET' || req.url !== '/health') { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ service, version, fixture: true, ok: true }));
});
server.listen(8080, '0.0.0.0');
process.on('SIGTERM', () => server.close());
