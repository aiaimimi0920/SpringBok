import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { closeBrowserServer } from './helpers/browser-server-close.mjs';

test('browser fixture shutdown closes a preconnected TCP socket before awaiting the HTTP server', { timeout: 5000 }, async () => {
  const server = http.createServer((_, response) => response.end('synthetic'));
  server.requestTimeout = 5000; server.headersTimeout = 5000;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const accepted = once(server, 'connection');
  const socket = net.connect({ host: '127.0.0.1', port: server.address().port });
  await Promise.all([once(socket, 'connect'), accepted]);
  let closeFinished = false, callbackFinished = false, cleanupFinished = false;
  const app = { server, close: async () => {
    await new Promise(resolve => {
      server.close(() => { callbackFinished = true; resolve(); }); server.closeIdleConnections();
    });
    await delay(0); cleanupFinished = true;
  } };
  const closed = closeBrowserServer(app).then(() => { closeFinished = true; });
  try {
    assert.equal(server.listening, false, 'stop accepting before closing connected sockets');
    await Promise.race([closed, delay(500)]);
    assert.equal(closeFinished, true, 'a connection without an HTTP request must not block the fixture restart');
    assert.equal(callbackFinished, true, 'wait for the original close callback, not only the forced socket close');
    assert.equal(cleanupFinished, true, 'wait for application cleanup after the server has closed');
  } finally {
    socket.destroy(); server.closeAllConnections(); await closed;
  }
});
