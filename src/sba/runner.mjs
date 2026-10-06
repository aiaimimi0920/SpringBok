import { spawn, execFileSync } from 'node:child_process';
import { lstat, realpath, open, mkdtemp, writeFile, rename } from 'node:fs/promises';
import { constants } from 'node:fs';
import { devNull } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { validateManifest, validateRequest, validateResult } from './contract.mjs';

const reject = () => { throw new Error('SBA_RUNNER_PREFLIGHT_FAILED'); };
const inside = (root, path) => {
  const rel = relative(root, path);
  return rel !== '' && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') && !isAbsolute(rel);
};

async function regularFile(path, maxBytes) {
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    // 以实际打开的描述符为基准，不把打开前的路径检查当作文件身份保证。
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > maxBytes) reject();
    const same = next => next.isFile() && next.dev === info.dev && next.ino === info.ino && next.nlink === 1 &&
      next.size === info.size && next.mtimeMs === info.mtimeMs && next.ctimeMs === info.ctimeMs;
    if (!same(await lstat(path))) reject();
    // 使用同一文件描述符且最多读上限加一字节，增长文件也不能绕过大小限制。
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > maxBytes || !same(await file.stat()) || !same(await lstat(path))) reject();
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, length));
  } finally { await file.close(); }
}

function runtimeEnvironment(source) {
  const output = {};
  const permitted = new Set([
    'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'SYSTEMDRIVE',
    'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES',
    'PROGRAMFILES(X86)', 'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)',
    'HOME', 'LANG', 'LC_ALL', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE',
  ]);
  for (const [key, value] of Object.entries(source)) {
    const name = key.toUpperCase();
    if (!permitted.has(name) || typeof value !== 'string') continue;
    if (Object.hasOwn(output, name) && output[name] !== value) reject();
    output[name] = value;
  }
  return output;
}

// 不继承 GitHub 控制凭据、Actions 文件命令或其他应用的 secret。
export function applicationEnvironment(source, manifest, directory) {
  const app = validateManifest(manifest), output = runtimeEnvironment(source);
  for (const name of app.secrets) {
    if (typeof source[name] !== 'string' || !source[name]) reject();
    output[name] = source[name];
  }
  return { ...output, TEMP: directory, TMP: directory, RUNNER_TEMP: directory, CI: 'true', SBA_EXECUTE: '1' };
}

export async function inspectCheckout(checkout, request) {
  try { return await inspectTrustedCheckout(checkout, request); }
  catch { reject(); } // 不将 Git/JSON 原始异常和可能的秘密传给日志。
}

async function inspectTrustedCheckout(checkout, request) {
  const root = await realpath(checkout);
  const metadata = join(root, '.git'), repository = await lstat(metadata);
  if (!repository.isDirectory() || repository.isSymbolicLink() || await realpath(metadata) !== metadata) reject();
  const sba = join(root, '.sba');
  const directory = await lstat(sba);
  if (!directory.isDirectory() || directory.isSymbolicLink() || await realpath(sba) !== sba) reject();
  const manifestText = await regularFile(join(sba, 'manifest.json'), 65536);
  const manifest = validateManifest(JSON.parse(manifestText));
  const input = validateRequest(request, manifest);
  const entrypoint = join(sba, manifest.entrypoint);
  const entrypointText = await regularFile(entrypoint, 1024 * 1024);
  if (await realpath(entrypoint) !== entrypoint) reject();
  const git = (args, input) => execFileSync('git', ['-c', 'core.fsmonitor=false', '-C', root, ...args], {
    encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024, windowsHide: true,
    env: { ...runtimeEnvironment(process.env), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : devNull }, input,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
  if (await realpath(git(['rev-parse', '--show-toplevel'])) !== root || git(['rev-parse', 'HEAD']) !== input.sourceSha ||
      git(['status', '--porcelain=v1', '--untracked-files=all', '--ignored=matching', '--ignore-submodules=none'])) reject();
  // assume-unchanged / sparse flags 不能掩盖入口调用的其他跟踪文件被修改。
  if (git(['ls-files', '-v', '-z']).split('\0').filter(Boolean).some(file => !file.startsWith('H '))) reject();
  for (const [file, text] of [['.sba/manifest.json', manifestText], [`.sba/${manifest.entrypoint}`, entrypointText]]) {
    if (git(['rev-parse', `HEAD:${file}`]) !== git(['hash-object', `--path=${file}`, '--stdin'], text)) reject();
  }
  // 不接受 SSH 别名、URL 内嵌凭据或来自其他仓库的 checkout。
  const origin = git(['remote', 'get-url', 'origin']);
  if (origin !== `https://github.com/${input.repository}.git` && origin !== `https://github.com/${input.repository}`) reject();
  return { root, manifest, input, entrypoint };
}

export function invokePowerShell({ root, entrypoint, requestPath, resultPath, environment, timeoutSeconds }) {
  if (process.platform !== 'win32') reject();
  return new Promise(resolveResult => {
    const executable = join(environment.SystemRoot || environment.SYSTEMROOT || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', entrypoint, '-RequestPath', requestPath, '-ResultPath', resultPath], {
      cwd: root, env: environment, shell: false, windowsHide: true,
      // 应用输出可能含业务数据或秘密；只消费经过校验的结果，不转发原始日志。
      stdio: 'ignore',
    });
    let timedOut = false, closeTimer;
    const finish = exitCode => {
      clearTimeout(timer);
      clearTimeout(closeTimer);
      resolveResult({ exitCode: timedOut ? null : exitCode, timedOut });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) {
        // 终止本次子进程树，不只终止 PowerShell 而遗留发布子进程。
        try {
          execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
            windowsHide: true, timeout: 15000, stdio: 'ignore',
          });
        } catch { /* 无论外部进程是否已退出，超时一律归为 unknown。 */ }
      }
      // 终止请求不等于进程已经关闭；先给 close 事件释放工作目录句柄的机会。
      // 无法观测 close 时仍有界结束，不宣称所有外部副作用已停止。
      closeTimer = setTimeout(() => finish(null), 5000);
      try { child.kill(); } catch { /* 终止失败也等待 close 或固定宽限上限。 */ }
    }, timeoutSeconds * 1000);
    child.once('error', () => { if (!timedOut) finish(null); });
    child.once('close', finish);
  });
}

const unknown = (request, errorCode) => ({
  schemaVersion: 2, taskId: request.taskId, action: request.action,
  sourceSha: request.sourceSha, applicationVersion: request.applicationVersion,
  status: 'unknown', checks: [], errorCode,
});

export async function readExecutionResult(path, request, execution) {
  if (execution.timedOut) return unknown(request, 'SBA_EXECUTION_TIMEOUT');
  try {
    const result = validateResult(JSON.parse(await regularFile(path, 32768)), request);
    if (execution.exitCode !== 0 && !['failed', 'unknown'].includes(result.status)) {
      return unknown(request, 'SBA_EXIT_RESULT_MISMATCH');
    }
    return result;
  } catch {
    return unknown(request, 'SBA_RESULT_INVALID');
  }
}

// tempRoot 必须是执行器控制的目录；每次新建独立输入/输出位置，不接受旧结果。
export async function executeCheckout({ checkout, request, tempRoot, environment = process.env, invoke = invokePowerShell }) {
  if (invoke === invokePowerShell && process.platform !== 'win32') reject();
  const checked = await inspectCheckout(checkout, request);
  const temporary = await realpath(tempRoot);
  if (temporary === checked.root || inside(checked.root, temporary)) reject();
  const directory = await mkdtemp(join(temporary, 'springbok-sba-'));
  const requestPath = join(directory, 'request.json');
  const resultPath = join(directory, 'application-result.json');
  const childEnvironment = applicationEnvironment(environment, checked.manifest, directory);
  await writeFile(requestPath, JSON.stringify(checked.input), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  let execution;
  try {
    execution = await invoke({ ...checked, requestPath, resultPath, environment: childEnvironment,
      timeoutSeconds: checked.manifest.actions[checked.input.action].timeoutSeconds });
  } catch { execution = { exitCode: null, timedOut: false }; }
  const result = await readExecutionResult(resultPath, checked.input, execution);
  const receiptPath = join(directory, 'result.json');
  await writeFile(`${receiptPath}.tmp`, JSON.stringify(result), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  await rename(`${receiptPath}.tmp`, receiptPath);
  return { result, receiptPath, directory };
}
