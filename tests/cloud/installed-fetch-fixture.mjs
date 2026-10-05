// 仅供本地子进程 CLI 测试：通过 IPC 转交给父进程的实际 workerd，不接外网。
let sequence = 0;
globalThis.fetch = (url, init) => new Promise((resolve, reject) => {
  const id = ++sequence;
  const timer = setTimeout(() => { process.off('message', receive); reject(new Error('fixture request timeout')); }, 10000);
  function receive(message) {
    if (message.id !== id) return;
    clearTimeout(timer); process.off('message', receive);
    if (message.error) reject(new Error('fixture transport failed'));
    else resolve(new Response(message.body, { status: message.status, headers: message.headers }));
    if (!process.listenerCount('message')) process.channel.unref();
  }
  process.channel.ref(); process.on('message', receive);
  process.send({ id, url, init: { method: init.method, headers: init.headers, body: init.body, redirect: init.redirect } });
});
process.channel.unref();
