import { startConfigReview } from '../src/config/server.mjs';
try {
  const app = await startConfigReview({ port: 3211 });
  console.log(`SpringBok 配置检查 · 仅本地校验，未连接服务器\n${app.origin}\n不保存输入或密钥；Ctrl+C 退出`);
  let closing = false;
  const close = async () => { if (closing) return; closing = true; await app.close(); };
  process.on('SIGINT', close); process.on('SIGTERM', close);
} catch { console.error('配置检查页启动失败，请检查本地3211端口。未连接服务器或写入配置。'); process.exitCode = 1; }
