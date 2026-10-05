# N07-S01：控制客户端常驻循环与安全退出

本项接续 [私有安装](node-installation.md) 与 [认证控制通道](node-channel.md)，总进度见 [开发计划](development-plan.md)。本项交付的是 Linux 非 root 的前台常驻进程，不是 systemd 服务、心跳采集器或业务 executor。N07-S02 的后续服务与验收见 [用户服务](node-user-service.md)；所有输出保留 `executionReady=false`。

## 固定版本与运行入口

N07-S01 当时的包是 `springbok-control-node/v2` / 20 个源文件；N08 当前包为 v3 / 22 个源文件并增加独立角色心跳，见 [心跳与兼容](node-heartbeat.md)。协议仍是 node v2，安装记录仍是 `springbok-role-install/v1`；N07-S01 本身没有云端 schema 迁移。按可信引导流程安装后，以该安装的角色 uid 运行：

```text
node <installation>/release/scripts/node-daemon.mjs --installation <installation>
```

唯一参数是安装目录。启动时验证入口自身属于该 release、安装标记、源文件摘要、私有权限、身份和 origin，不读取任意配置指定的脚本。只依赖预装 Node.js 22+；不下载运行时、不创建账号、不安装/启用服务。

- `execute` 持有原 `openNodeChannelBridge`，串行处理控制 probe 与持久 `intent/result/ack`；不调用 shell、Docker 或业务部署。
- `observe` 周期调用 `identity:self`，不领取 probe、不创建执行 ledger。N08 另外上报独立心跳；身份核对成功本身不是心跳、主机在线或指标验收。
- 第一次 step 在启动后立即进行；其后每次 step 完成至少等待 30 秒，不重叠、无后台并行请求。正常等待也有正向抖动。

## 重试与停止边界

只在 fetch 或响应流读取边界把明确的网络错误（连接重置/拒绝、DNS 暂时不可用、网络不可达、已识别的 socket/timeout）转为脱敏 `RetryableNodeError`。HTTP 429、500、502、503、504 可重试。连续失败基础间隔为 30、60、120、240、300 秒，叠加 0–20% 正向抖动后仍不超过 300 秒；成功重置计数。没有可绕过最小间隔的 CLI 参数。

401/403/409 等拒绝、redirect、TLS 校验错误、未识别异常、响应超限/非法 JSON、身份或协议不匹配及本地 journal 失败均停止，不能因 catch 过宽被当作断网无限重试。每次真实 HTTP 请求仍有原 5 秒超时、固定 HTTPS origin、`redirect: 'error'` 和 4096 字节响应上限。

收到 SIGINT/SIGTERM 后立即中断等待，不开始下一轮 step；**已经在途的完整 step 继续收尾**，可能包含该 probe 的 result/report/ack，不强制取消后留下伪成功。若 report 已提交但 ack 丢失，持久 receipt 仍由原 bridge 重送同一内容，不重做 probe。停止期间遇到暂时错误则保留未确认 receipt 并退出，不再开始重试。

| 情况 | 行为 |
| --- | --- |
| 正常信号退出 | `stopping` 后等待在途 step 收尾，退出码 0；不表示业务已部署 |
| `unknown` | 输出 `status: unknown`、`blocked`，退出码 2；保留 ledger，重开仍阻断，不继续请求 |
| 身份/协议/持久化/退出失败 | 固定脱敏 stderr，退出码 2；不输出原始响应或 token |
| 暂时网络失败 | 状态转为 `retrying`；只有状态变化才输出，不逐次打印相同重试日志 |

stdout 是固定 JSON 事件 `started/status/stopping/stopped/blocked`，不打印凭据、原始计划/回执或任意上游错误。SIGKILL/掉电不具备 graceful drain；不能把退出信号当恢复证据。

## 单实例和保留式兼容

每个安装的私有 `state/daemon.lock` 以 `O_EXCL | O_NOFOLLOW` 独占创建，0600，写 PID 并 fsync。正常释放只针对本进程创建且 inode/device 仍匹配的锁；不按 PID/时间推断旧锁已失效。execute 同时持有既有 journal `owner.lock`，因此一次性 probe 也不能并行使用同一 ledger。

已有锁、SIGKILL 残留锁或关闭失败均保留；不自动清锁、不重置 unknown、不配置自动重启。单实例范围是**单安装目录**，不承诺仲裁复制到其他目录/机器的同一凭据。父路径/同 uid 必须可信；不声称抵御恶意同 uid 或 root。

N06-S01 的历史 `springbok-control-node/v1` 包为 17 个源文件，原安装继续由自身旧代码验证/运行，不自动迁移。v2 安装器明确拒绝 v1 清单；拿新包指向旧安装也因绑定不一致拒绝，不覆盖 release、credential、标记或 state。切换运行位置/处理旧状态属于后续升级设计，禁止为运行新版直接复制凭据并启动第二实例。

## 验证与未完成项

证据根：`C:/Users/Public/nas_home/AI/GameEditor/linshi/springbok-node-daemon-20261005/`。Linux 使用固定 Docker 镜像 `sha256:fee853fafa59550d162cef52bca02d907694b44ebf6ef9fb075bcc0c65d8dedb`、Node.js 24.18.1、uid 1000、只读源码/相同 lockfile 依赖和一次性 tmpfs 状态；没有修改宿主账号、服务或用户安装。

| 检查 | 证明范围 |
| --- | --- |
| `node --test tests/node-daemon-loop.test.mjs tests/node-package.test.mjs` | Windows 7/7：间隔/上限/抖动、错误分类、串行/退避重置、signal drain、unknown 不重试、v1 拒绝 |
| Linux loop/process/install/package 聚焦 | 16/16：实际安装后 CLI 双角色单实例、SIGTERM/SIGINT/重启、probe 互斥、SIGKILL 残留锁、unknown 跨进程零网络、fatal 不重试 |
| `node --test tests/cloud/node-daemon.test.mjs` | 2/2：真实本地 workerd/SQLite 丢 ack 后实际等待至少 30 秒，只重送相同 receipt；SIGTERM 不截断在途 ack；双端重启不重做；真实 journal 写失败保持 claimed，不 report/不重试 |
| Linux 全量契约 / 完整 workerd | 202/202 / 45/45，0 失败/跳过；完整 workerd 的真实重试间隔 35,175ms |
| 旧 v1 包保留式兼容 | 原 main `b6ac813` 固定包由旧代码安装/probe；新安装器拒绝旧格式/新包覆盖，旧版重装/version 仍通过，源码/状态/标记的内容、inode/device/mtime 不变 |

workerd 通过 test-only IPC 把安装后的实际子进程 fetch 转发到本地 Miniflare；是本地协议/持久化验收，不是公网 HTTPS/TLS、真实 Access 或多台服务器。单元构建夹具明确使用合成 revision；真正 Git HEAD 包在提交后另外构建并逐文件核对，最终 SHA/摘要在 PR 回执记录。

主 AI 审阅实际源码与 diff；独立审查代理因上游 503 未形成结论，不计独立审查通过。未完成：N07-S02 开机启动、N06-S02 完整执行环境、真实 Cloudflare/Access/多机部署、心跳/指标、凭据轮换/撤销、安全升级和业务验收。没有修改生产开关、DO schema、运行依赖或历史 fixture 身份。
