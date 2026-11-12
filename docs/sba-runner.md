# SBA 受控执行端

实现 `src/sba/runner.mjs`，测试 `tests/sba-runner.test.mjs`。
复用 [SBA 请求与回执契约](../ai-docs/lifecycle.md)，只负责一次已授权入口的执行和结果校验，不解释
应用的构建、迁移、发布顺序。它不是独立部署 CLI，也不是恶意应用沙箱。

## 调用与责任

上层在可信、一次性的 Windows 或 Ubuntu runner 内取得已审阅的 GitHub 完整 SHA checkout，
提供契约 request、受控临时根目录与本应用环境，然后调用：

```js
import { executeCheckout } from './src/sba/runner.mjs';

const { result, receiptPath } = await executeCheckout({
  checkout,
  request,
  tempRoot,
  environment: process.env,
});
```

这些变量由受控调用方提供，不从应用的 README/AGENTS 或自由文本解析。默认执行
按 manifest 完整 runtime 选择 Windows PowerShell 5.1 或 Ubuntu 24.04 x64 / PowerShell
7.6.9；`invoke` 注入仅用于测试，不是用户可选择的命令接口。
上层仍须负责 GitHub 来源获取、精确版本授权、运行环境准备、任务持久化/互斥/去重、
Actions run 关联和回执回收。仅配置一个 origin URL 并不证明 GitHub 来源。

## 执行前边界

- 要求普通 `.git` 目录，checkout 顶层、HEAD 完整 SHA、origin 仓库均匹配请求；
  拒绝 dirty/untracked/ignored 内容、隐藏索引修改标记，不支持 worktree 指针。
- `.sba` 必须在 checkout 内；manifest 上限 64 KiB、入口上限 1 MiB。实际目录/文件、
  realpath、符号链接、硬链接及入口 blob 均校验，严格 UTF-8、有界读取并核对文件
  读取前后的身份/大小/时间。先只读打开，以同一描述符的 fstat 为基准，再核路径
  lstat 和读后状态；拒绝目录、链接和 FIFO，不依赖打开前的路径检查保证身份。
  Git 使用干净的配置环境；不把本地配置当远端证明。
- `tempRoot` 由执行器控制，不能位于 checkout 内。每次新建 `springbok-sba-*` 目录，
  请求用独占创建写入；不接受调用方指定现成结果文件，不复用前次结果。
- 仅继承必要系统环境和 manifest 所列秘密；不继承 GitHub 控制 token、Actions
  command 文件、其他应用秘密或工具注入变量。临时目录重定向到本次目录。
  `SBA_EXECUTE=1` 是入口约定，不替代上层授权。

## 进程与结果

固定 PowerShell 路径，通过 `shell: false` 的参数数组传递入口、`-RequestPath` 与
`-ResultPath`，工作目录为 checkout 根。原始 stdout/stderr 丢弃，避免应用数据或
秘密进入 Actions 日志；机器协议只接受结果文件。

应用结果上限 32 KiB，必须严格匹配 task/action/SHA/version；成功结果还必须与退出码
一致。执行器原子生成经过校验的 `result.json`，返回其路径和规范化结果。

| 情况 | 执行器结果 |
| --- | --- |
| 校验前失败 | 固定 `SBA_RUNNER_PREFLIGHT_FAILED`，不启动应用 |
| 入口超时 | `unknown / SBA_EXECUTION_TIMEOUT` |
| 非零或未知退出但结果自报成功 | `unknown / SBA_EXIT_RESULT_MISMATCH` |
| 结果缺失、非法 UTF-8/JSON、超限、链接或身份不匹配 | `unknown / SBA_RESULT_INVALID` |
| 合法 failed/unknown | 保留应用的规范化结果，不推进部署成功 |
| 零退出且合法 succeeded/deployed-unverified | 接受其状态，但不是独立业务验收证明 |

Windows 超时尝试 taskkill 终止本次进程树，终止调用有 15 秒上限；Linux 使用独立进程组，
向普通后代所在组发 SIGKILL，不承诺约束主动 setsid 逃逸的恶意程序。随后等待进程 `close`，额外宽限
最多 5 秒，避免终止请求刚发出就返回、调用方清理时工作目录仍被占用。终止报错不能
绕过这段宽限；无论退出码或终止结果如何均返回 unknown。没有证明所有复杂后代
进程或云端操作已经停止，不能据此自动重试发布。目录与回执
生命周期由上层管理，本模块不清理其他任务目录或撤销外部副作用。

## 固定 Linux 路径

完整 tuple 及固定 workflow 由 `src/sba/runtime.mjs` 定义，不接受用户 shell/路径。
原生执行前检查 host、Ubuntu 24.04/x64 和固定工具目录实际版本；受信 workflow 先下载
官方 PowerShell 7.6.9 linux-x64 发行包，SHA-256
`1da6d6d6035d651f20e70ddee7c4c15ac6ab8b9fb40ee92240d91263f28a884b`，校验后才解包。
入口通过绝对路径运行，不从应用 PATH 选择 pwsh。版本探针不是整个目录的逐文件完整性
证明，可信字节根来自相同作业的 checksum installer；仍不将应用执行器称为恶意代码沙箱。

## 验证入口

`node --test tests/sba-runner.test.mjs`；平台原生测试须在对应运行环境验证。
云端身份、源码获取与回执回收见[控制链](sba-cloud-control.md)。超时不证明复杂后代或远端副作用全部停止。
