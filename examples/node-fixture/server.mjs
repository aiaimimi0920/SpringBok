import { createServer } from 'node:http';
import { openSync, readFileSync, writeFileSync, closeSync, fsyncSync, constants } from 'node:fs';
import { randomBytes } from 'node:crypto';
const version = process.env.FIXTURE_VERSION;
if (!['v1', 'v2', 'bad'].includes(version)) throw new Error('invalid fixture version');
let fd;
try {
  fd = openSync('/data/marker', constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  writeFileSync(fd, randomBytes(32).toString('hex')); fsyncSync(fd); closeSync(fd); fd = undefined;
  const dir = openSync('/data', constants.O_RDONLY); try { fsyncSync(dir); } finally { closeSync(dir); }
} catch (error) { if (error.code !== 'EEXIST') throw error; } finally { if (fd !== undefined) closeSync(fd); }
const handle = openSync('/data/marker', constants.O_RDONLY | constants.O_NOFOLLOW);
let marker; try { marker = readFileSync(handle, 'utf8'); } finally { closeSync(handle); }
if (!/^[a-f0-9]{64}$/.test(marker)) throw new Error('invalid fixture data');
if (version === 'bad') process.exit(1);
const server = createServer((req, res) => {
  if (req.method !== 'GET' || req.url !== '/health') { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ fixture: true, version, marker }));
});
server.listen(8080, '127.0.0.1'); process.on('SIGTERM', () => server.close());
