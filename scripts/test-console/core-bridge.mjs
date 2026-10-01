import net from 'node:net';

export function validateCoreAddress(address) {
  if (net.isIP(address) !== 4) throw new Error('expected exact internal Core IPv4');
  const [a, b] = address.split('.').map(Number);
  if (!(a === 10 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168)) throw new Error('Core must be on the private Docker bridge');
}
// The harness supplies the IP read from this run's named Core container on this
// run's internal network. No HTTP/client-selected upstream, DNS or external bind.
export async function openCoreBridge(coreAddress) {
  validateCoreAddress(coreAddress);
  const sockets = new Set();
  const server = net.createServer(local => {
    const remote = net.connect({ host: coreAddress, port: 9120 });
    for (const socket of [local, remote]) {
      sockets.add(socket); socket.on('close', () => sockets.delete(socket));
      socket.setTimeout(20000, () => { local.destroy(); remote.destroy(); });
      socket.on('error', () => { local.destroy(); remote.destroy(); });
    }
    local.pipe(remote).pipe(local);
  });
  server.maxConnections = 32;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { port: server.address().port, address: server.address().address,
    async close() { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); } };
}
