# M02-S01：普通用户只读内存采集

总进度见 [开发计划](development-plan.md)，权限和宿主职责见 [执行架构](execution-architecture.md)。M02 分为本项采集与 M02-S02 版本化上报/只读展示；本项自身不是已部署监控、云端内存展示或 M07 完整总览。后续产品接入见 [指标协议与兼容](node-telemetry.md)，两项验收不代表真实用户宿主已部署。

## 运行入口与权限

在审阅过的 checkout 中，使用预装 Node.js 22+、普通 Linux 用户运行：

```text
node scripts/node-memory.mjs
```

无参数、凭据、网络、依赖安装或本地状态文件。只以 `O_RDONLY | O_NOFOLLOW | O_NONBLOCK` 打开固定 `/proc/meminfo`，最多接受 64 KiB 实际字节，至多额外读取 1 字节用于判定超限，严格 UTF-8 解码并在成功/失败时关闭描述符；不依赖 procfs 通常为 0 的文件大小。不读取业务文件、进程 RSS、环境变量、Docker socket、Core API、cgroup 文件或任意输入路径。root、非 Linux 和额外参数均以固定脱敏错误及退出码 2 拒绝。

stdout 每行一个 JSON 样本。内存是时点 gauge，第一条可立即 `available`，不套用 [CPU 差分](cpu-collection.md) 的预热。每次采集及同步 JSON 输出回调完成后等待至少 30 秒，串行、不补采；读取和调度延迟只会延长周期。SIGINT/SIGTERM 中断等待，进行中的读取先关闭资源，停止后丢弃迟到样本，正常退出码 0。共享 `runSamplingLoop` 保留原 `runCpuLoop` alias 和固定 30000ms 行为，不宣称支持异步输出回调的串行等待。

示例（合成值，不是用户主机实测）：

```json
{"schema":"springbok-memory/v1","metric":"memory","scope":"linux-proc-meminfo","unit":"bytes","status":"available","reason":null,"sampledAt":"2026-10-05T19:00:00.000Z","totalBytes":102400,"availableBytes":40960,"usedBytes":61440,"usagePercent":60}
```

## 数值口径与宿主边界

- `totalBytes = MemTotal × 1024`：内核报告的可用 RAM 总量，不是物理内存条容量保证，不含 swap。
- `availableBytes = MemAvailable × 1024`：内核估计无需 swap 即可供新应用使用的内存；不是纯空闲 `MemFree`，也不是所有 cache/slab 都能释放的承诺。
- `usedBytes = totalBytes - availableBytes`：已用或不可用内存，不是所有进程 RSS 加总、缓存占用或内存压力/OOM 判定。
- `usagePercent = usedBytes / totalBytes × 100`，整体 0–100%，BigInt 四舍五入至两位小数。真实 0 可用量/已用量分别保留为 0，不与 null 混淆。
- 两个必需字段严格解析非负十进制 `kB`，先 BigInt 乘 1024 再检查 Number 安全整数上限。重复、负数、小数、错误单位、总量为 0、可用量超过总量或超限拒绝；不 clamp、不靠 `MemFree + cache` 修复。其他字段不进入结果。

`scope: linux-proc-meminfo` 只表示进程读到了当前可见内核入口，**不证明处于目标用户服务器的宿主**。容器可能看到虚拟机/宿主聚合数值，却受另一套 cgroup 限额约束；某些 procfs 代理也会改写视图。本项不检测/声称宿主认证，不把这些读数当容器可分配内存，不挂宿主 `/proc` 到执行容器。正式监控必须在授权目标宿主按节点接入边界运行。

## 失败、时间与恢复

| status / reason | 行为 |
| --- | --- |
| `available / null` | 采样时间为 ISO；总量/可用/已用和占比有效；首样本及故障后的合法样本均可立即可用 |
| `unavailable / memavailable-missing` | 总量合法但缺少 `MemAvailable`；不使用旧内核启发式，时间和所有数值均 null |
| `unavailable / invalid-meminfo` | 必需字段存在但畸形/重复/矛盾、总量缺失或超限；时间和所有数值均 null |
| `unavailable / read-failed` | 打开/读取/关闭、实际字节或严格 UTF-8 读取失败；不泄漏原内容/路径/异常，所有数值均 null |
| `unavailable / clock-unavailable` | 墙钟抛错、负数、非安全整数或超出 Date 可表示范围；时间和所有数值均 null |

不存在 CPU 风格差分基线或陈旧数值缓存。内核内存信息本身是动态统计，不承诺跨字段或跨工具的原子时点。`sampledAt` 来自采集后的墙钟；合法墙钟回退仍记录实际时间，不伪造差分或新鲜度。循环等待使用 Node.js 单调计时器，与墙钟无关；未来云端新鲜度仍必须以独立持久接收时间判定。同一 sampler 的重叠调用明确拒绝，开发 seam 可注入文本/时钟或文件 opener 供测试，但生产 CLI 不暴露配置。

## 来源与验证

2026-10-05 联网核对：

- [Linux kernel proc 文档 meminfo](https://docs.kernel.org/filesystems/proc.html#meminfo)：`MemTotal` 是 usable RAM，`MemAvailable` 是考虑可回收缓存/水位的无需 swapping 的可用估计，部分统计重叠。
- [procps free(1)](https://man7.org/linux/man-pages/man1/free.1.html)：`free -b -w` 的 bytes、available、used 口径；当前 used 为 total minus available。某些旧 procps 的 used 定义不同，原生验收遇到该语义不符须失败，不悄悄换参考列/放宽检查。

验证入口：

```text
node --test tests/memory.test.mjs tests/memory-process.test.mjs tests/cpu.test.mjs tests/cpu-process.test.mjs scripts/ci/security-baseline.test.mjs
node scripts/ci/memory-native.mjs
```

原生验收在一次性普通 Linux 用户上运行真实 CLI 和独立 `/usr/bin/free -b -w -s 30 -c 2`，取得两次间隔至少 30 秒的 gauge：总量精确一致，已用公式精确一致，可用/已用差异不得超过 `max(16 MiB, total × 0.25%)`。该容差只覆盖两个进程读取时点与正常内存波动；单测另以 cache/free 与 available 不同的夹具严格证明公式，不能把容差测试当所有口径正确的唯一证据。不分配压力负载、不清缓存、不制造 OOM、不安装工具。finally 只按自身 ChildProcess 引用停止并等待关闭，不批量杀进程。

CI 在既有 Ubuntu contracts job 中执行原生对照；本地固定 Linux Docker 镜像 `sha256:fee853fafa59550d162cef52bca02d907694b44ebf6ef9fb075bcc0c65d8dedb`、Node.js 24.18.1、uid 1000、只读 LF 快照和一次性 tmpfs 只证明该环境的可见 Linux 内核口径，不替代原生 runner 或用户宿主。证据根：`C:/Users/Public/nas_home/AI/GameEditor/linshi/springbok-memory-collection-20261005/`；已执行结果、精确提交/PR/main 见总计划与回执，不预报未完成 CI。

M02-S01 当时不包含 observe 包/云端接入；该历史证据不改写。M02-S02 后续在独立 v5 包装配采集器并完成版本化上报/只读小详情，见指标专题与总计划。旧固定 v4 包及 CPU schema 保留，不将它宣称包含本入口，不升级或覆盖现有安装；生产默认开关、真实 Cloudflare/用户宿主验收仍不变。
