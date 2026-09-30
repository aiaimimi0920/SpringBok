import { startDemo } from '../src/demo/server.mjs';
try {
  const app = await startDemo();
  console.log(`SpringBok DEMO · 未连接真实服务器\n${app.origin}\n记录保存在当前目录 .springbok-demo；Ctrl+C 退出`);
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; await app.close(); process.exitCode = 0; };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
} catch (error) {
  if (error.code === 'UNSUPPORTED_PLATFORM') console.error('M3 演示目前仅支持 Linux；Windows/macOS 持久化尚未验证，未写入记录。');
  else console.error('DEMO 启动失败。检查 3210 端口、.springbok-demo 记录或 owner.lock；恢复步骤见 docs/demo-console.md。未自动重置记录。');
  process.exitCode = 1;
}
