# M01：独立只读 CPU 差分采集

本项接续 [执行架构](execution-architecture.md) 的宿主普通用户监控边界；总进度见 [开发计划](development-plan.md)。这是本地 CPU 能力，不是 M06 指标上报、M07 总览或已安装 v3 daemon 的新功能。

## 运行入口与权限

在经过审阅的 checkout 中，用预装 Node.js 22+、普通 Linux 用户运行：

```text
node scripts/node-cpu.mjs
```

没有参数、安装步骤、凭据、网络请求或运行依赖。唯一读取入口是固定 `/proc/stat`，以只读、NOFOLLOW、NONBLOCK 打开，最多读取 1 MiB 实际字节并关闭描述符；不依赖 procfs 通常为 0 的文件大小。程序不读取环境变量、业务文件、Docker socket、Core API 或任意传入路径，不写本地状态/日志文件。root、非 Linux 和额外参数均以固定脱敏错误、退出码 2 拒绝。

第一条输出为 `unknown/warming-up`，至少等待 30 秒后才可能输出数值，之后串行采集。stdout 每行一个 JSON 样本；SIGINT/SIGTERM 中断等待并停止，正在读取的资源先收尾，但停止后不再输出迟到样本，正常退出码 0。

**30 秒是固定最小间隔，不是实时系统的毫秒级严格节拍。** 每次采集/输出完成后等待 30 秒；读取、输出和调度延迟会延长实际窗口，`intervalMs` 返回单调时钟的实际时间差，不追赶、不补采、不把延长窗口伪标为恰好 30 秒。独立采集循环不借用任务/心跳的抖动或网络失败退避，不改变其执行结果。

示例数值结构（示例不是用户主机实测）：

```json
{"schema":"springbok-cpu/v1","metric":"cpu","scope":"linux-proc-stat","unit":"percent","status":"available","reason":null,"sampledAt":"2026-10-05T16:25:16.068Z","logicalCpuCount":12,"intervalMs":30006,"usagePercent":13.4}
```

## 数值口径

- 读取聚合 `cpu` 和全部 `cpuN` 行。`logicalCpuCount` 是本次 `/proc/stat` 中逻辑 CPU 行数，不是容器 CPU 限额、进程 affinity/cpuset 数或 vCPU 规格保证。
- 十列累计计数按无符号 64 位整数解析，以 BigInt 差分，不先转换成可能丢失低位的 Number；最多 8192 个逻辑 CPU。缺列、多列、重复/非法 ID、负数、超限或矛盾 guest 计数均不猜测修复。
- `total = Δ(user + nice + system + idle + iowait + irq + softirq + steal)`；`busy = total - Δidle - Δiowait`；`usagePercent = busy / total × 100`，四舍五入两位小数。
- guest/guest_nice 已包含在 user/nice 中，不再加入 total。iowait 被排除出 busy；steal 被计入非空闲占比，因而这不是进程实际 CPU 消耗、CPU load average 或虚拟机内部可执行工作量的同义词。
- 这是全部所列 CPU 的整体 **0–100%**，不乘核数。一个逻辑 CPU 满载在 N 核机器上约贡献 `100/N` 个百分点，不能与 `top` 的单进程“一个核为 100%”混淆。
- 墙钟 `sampledAt` 是 ISO 时间戳；测定间隔使用单调时钟。墙钟前跳不会改变 CPU 差分或缩短最小间隔；回退不会给出可用数值。

`scope: linux-proc-stat` 只表明读取了该 Linux 可见内核入口，**不自动证明已处于目标服务器宿主**。某些容器会看到宿主或虚拟机聚合计数，却受到另一套 cpuset/cgroup 限额；本程序既不将其称为容器自身用量，也不把容器内读数当用户宿主验收。正式采集必须按 N09/M06 的后续接入边界确认宿主运行位置，不能未经审查挂宿主 `/proc` 到执行容器。

## 未知、失败与恢复

| status / reason | 数值与基线行为 |
| --- | --- |
| `available / null` | `usagePercent` 为 0–100；真实空闲允许为 0，保留实际 interval、CPU 数与时间 |
| `unknown / warming-up` | 首次建立基线；数值为 null，不能显示为健康的 0 |
| `unknown / interval-too-short` | 未满 30 秒；数值为 null，不移动原基线 |
| `unknown / cpu-set-changed` | 逻辑 CPU ID 集变化，包括核数相同但 ID 替换；重建基线 |
| `unknown / counter-regressed` | 任一聚合/每核计数回退，包括可能下降的 iowait；重建基线，不 clamp 成 0 |
| `unknown / no-counter-progress` | 分母没有增长；重建基线，不除零 |
| `unknown / clock-regressed` | 单调时钟不前进或墙钟回退；重建基线 |
| `unavailable / read-failed` | 固定读取失败；丢弃基线，不保留陈旧数值 |
| `unavailable / invalid-counters` | 结构/计数不符合版本；丢弃基线 |
| `unavailable / clock-unavailable` | 无法提供有效时钟/时间戳；丢弃基线 |

不可用样本的数值、核数、interval、sampledAt 均为 null，不输出原始内容、异常或路径。恢复后先 warming-up，再经过完整窗口，不能跨读取失败拼接差分。同一个 sampler 不允许重叠读取；开发 seam 允许注入文本/时钟供测试，但生产 CLI 不暴露这种配置。

离散采样只能看到两个时点的 CPU ID/计数；不承诺识别采样之间离线又重新上线且没有可见变化的所有热插拔事件。不持久保存 CPU 基线，进程重启始终重新 warming-up。

## 来源与验证

2026-10-05 已联网读取：

- [Linux kernel proc 文档](https://docs.kernel.org/filesystems/proc.html)：`/proc/stat` 的聚合/每核行、USER_HZ 列口径及 iowait 不可靠且可能下降。比例计算不假定 USER_HZ 必为 100。
- [Linux v6.12 的 account_guest_time](https://github.com/torvalds/linux/blob/v6.12/kernel/sched/cputime.c#L143-L159)：guest 同时记入 USER/GUEST，nice guest 同时记入 NICE/GUEST_NICE。只用于核对统计语义，没有复制上游实现或改变项目许可证。

聚焦命令：

```text
node --test tests/cpu.test.mjs tests/cpu-process.test.mjs tests/node-daemon-loop.test.mjs scripts/ci/security-baseline.test.mjs
node scripts/ci/cpu-native.mjs
```

原生对照在一次性普通 Linux 用户下运行真实 CLI 的两个至少 30 秒窗口，用同窗口 `/usr/bin/top` 的整体 CPU 行独立对照，误差不得超过 1 个百分点。空闲窗口要求 top 至少 70% idle；负载窗口只有一个受控 worker，并核实该进程实际累计消耗至少一个 CPU 秒、整体采集值增长至少 `10/logicalCpuCount` 个百分点。所有自建进程在 finally 中仅按自身 ChildProcess 引用停止并等输出流关闭；不批量清理进程、不提高权限、不安装工具。CI 在现有 Ubuntu contracts job 中执行，不由容器烟测替代原生 runner。

本机证据：`C:/Users/Public/nas_home/AI/GameEditor/linshi/springbok-cpu-sampling-20261005/`；本地 Linux 使用固定 Docker 镜像 `sha256:fee853fafa59550d162cef52bca02d907694b44ebf6ef9fb075bcc0c65d8dedb`、Node.js 24.18.1、uid 1000、只读 LF 快照与一次性 tmpfs。这证明可见 Linux 内核口径，不是用户宿主或实际部署证据。精确版本、本地最终结果、PR/main 检查和独立审查按总计划及 PR 回执记录，不预报未运行结果。

未完成：M06 鉴权上报与独立最新快照、CPU 展示/历史/告警、其他主机指标、已安装 observe daemon 装配、真实目标服务器验收。当前 v3 控制包清单未变；不升级、覆盖或复制现有角色安装来启动第二实例。
