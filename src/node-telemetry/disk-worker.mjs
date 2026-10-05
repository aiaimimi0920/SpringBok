import { collectDisk } from './disk.mjs';

try {
  if (process.argv.length !== 2 || process.platform !== 'linux' || !(process.getuid() > 0)) throw new Error('Unsupported invocation');
  console.log(JSON.stringify(await collectDisk()));
} catch {
  // 原始错误与挂载配置不跨进程输出。
  process.exitCode = 2;
}
