# M03-S01：普通用户只读磁盘容量采集

总进度见 [开发计划](development-plan.md)，采集分权见 [执行架构](execution-architecture.md)。M03 分为本项采集与 M03-S02 版本化上报/只读展示。本项是可运行的普通用户 CLI，不是已部署监控、云端磁盘详情或 M07 完整总览；旧 v5 /26 文件包和 observe daemon 不包含新磁盘入口，不修改已有安装。M03-S02 的后续 v6 包/版本化上报与只读小详情见 [指标协议](node-telemetry.md)，本页验收数字仍是采集器任务的历史证据。

## 运行与权限

在已审阅 checkout 中，用预装 Node.js 22+、普通 Linux 用户运行：

```text
node scripts/node-disk.mjs
```

没有参数、凭据、网络、运行依赖安装或本地持久状态。非 Linux、root 或额外参数以固定脱敏错误/退出码 2 拒绝。stdout 每行一个 JSON。每次采样及同步输出完成后等至少 30 秒，串行、不补采；第一条是 gauge，可立即可用。SIGINT/SIGTERM 取消等待，进行中的采样只停止自有 worker，停止后不输出迟到结果。

只以 `O_RDONLY | O_NOFOLLOW | O_NONBLOCK` 打开固定 `/proc/self/mountinfo`。按实际读取 bytes 接受最多 512 KiB，至多额外 1 byte 作为溢出探针；严格 UTF-8、finally 关闭，不依赖 procfs 的文件大小。最多 4096 条目、单路径 UTF-8 4096 bytes、32 个选中挂载点；超限整体不可用，不静默截断。严格 ID/device/结构、绝对规范路径与四种内核转义 `\040`、`\011`、`\012`、`\134`；不 URL 解码、不 Unicode 归一化。未知 optional fields 忽略，完整原文本仅用于前后私有比较，mount source、optional fields、super options 和原始异常不输出。

## 挂载点与覆盖范围

只支持已核对 Linux 单位的 ext2/ext3/ext4、xfs、btrfs。overlay 转发到未知底层，仅凭 overlay magic 不能证明 f_bsize 与容量单位相同，因此也明确计入 unsupported，不猜测 bytes。proc/sysfs/tmpfs/devtmpfs/devpts/cgroup 等伪文件系统明确过滤；网络、FUSE、autofs 与未知类型不支持。筛选发生在路径检查和 `statfs` 前，结果的 `filtered` 只给类别计数。`root != /` 的 bind/file bind/subvolume 子树首版也过滤，避免重复容量归属；不是完整 btrfs 子卷或 bind 展示实现。

同路径叠加、隐藏条目、环路和不属于 mount parent 链的路径祖先保守拒绝；目标路径必须有唯一且受支持的 namespace 根及全部可见挂载祖先，不能经不支持的网络/autofs/FUSE 前缀采样。父挂载 ID 允许在当前视图外，不能要求所有 parent 都存在。选中路径还需实际 `lstat` 为目录、`realpath` 与 mountpoint 完全一致；不跟随符号链接改换目标。再核对 statfs magic 与声明 fsType 一致。

`scope: linux-mount-namespace` 仅表示**当前进程可见的挂载命名空间**。overlay 不输出猜测容量；其底层可能共享、不可见或不是已核对的文件系统。不做物理盘/宿主位置认证，也不是容器配额保证。不列块设备、读取 Docker socket 或扫描目录；多个挂载点不合计为“全机总容量”。`available` 只表示选中的支持集成功，不意味着被过滤的挂载也健康或全机覆盖完整。

采样前后重读完整 mountinfo；任何字节变化或重读失败都丢弃全部读数。不承诺原子快照：前后相等仍可能有中间卸载/重新挂回的 ABA；mount ID 可复用，Node statfs 没有返回 mount ID/fsid，magic 检查也不能消除全部 TOCTOU。本项不为此引入原生 helper。

## 数值口径

Node `statfs(path, { bigint: true })` 暴露 Linux `f_bsize`，**不暴露 `f_frsize`**。Linux v6.12 的 ext2/ext4/xfs/btrfs statfs 使用文件系统 block/sector size，未设置单独 frsize；`statfs.c` 在 frsize=0 时回填 bsize，ext3 由 ext4 实现兼容。此支持集的单位证据和原生 `stat` 对照见下节；不能把该乘法扩展为任意 Linux 文件系统承诺。

| 字段 | 公式与含义 |
| --- | --- |
| `totalBytes` | `blocks × bsize`，文件系统报告的总数据空间，不是物理设备原始容量 |
| `freeBytes` | `bfree × bsize`，全部空闲空间 |
| `availableBytes` | `bavail × bsize`，普通用户可用空间，不等于全部空闲 |
| `usedBytes` | `(blocks - bfree) × bsize`，实际已用，不用 `total - available` 把差额计为已用 |
| `reservedBytes` | `(bfree - bavail) × bsize`，不可供普通用户使用的差额，不等于已认证 ext 保留块配置 |
| `usagePercent` | `used / (used + available) × 100`，BigInt 四舍五入到两位；GNU df 的同口径显示采用向上取整，不能直接要求两者数字相同 |

所有计数先检查 BigInt、magic、非负关系 `bavail <= bfree <= blocks`；bsize/总量/百分比分母必须大于 0，bytes 不超过 Number 安全整数。负数、非 BigInt、矛盾、溢出、错误 magic、0 总量/0 分母全部失败，不 clamp。合法 used=0、available=0、reserved=0 保留 0，不当缺失。

## 状态与阻塞生命周期

每挂载点携带 `mountId/device/mountPoint/fsType/readOnly` 和数值。成功为 `available/null`；路径不可用、statfs 失败、无效统计分别为 `unavailable/path-unavailable`、`statfs-failed`、`invalid-statfs`，六个数值均 null，不能沿用故障前的读数。整体只有全体选中成功才 `available`，部分成功为 `partial/mount-unavailable`，全部失败为 `unavailable/mount-unavailable`，支持集为空为 `unavailable/no-supported-mounts`。有拓扑快照的尝试带 ISO 时间与筛选计数；读取/解析/超限/变更/时钟/worker 级故障没有挂载读数，时间/筛选计数为 null。

整次采样在自身普通用户子进程执行，父进程 deadline 固定 5 秒、stdout 最多 192 KiB，stderr/畸形 UTF-8/多行或不符合严格出口 schema 的结果拒绝。失败输出只包含固定 reason。截止或停止后 SIGKILL 只发给保存的 ChildProcess，销毁自有管道、取消计时器、移除 abort listener，未收到 close 前再次调用只返回 `worker-busy`，不启动替代 worker。

Node statfs options 没有 AbortSignal；Promise timeout 只停止等待，不能取消正在内核执行的请求。不可中断内核 I/O（D-state）可能延迟 SIGKILL 和 close，**不承诺严格零残留或已取消 syscall**。父进程可停止而不等待这个无界内核状态；正常循环也不积累更多 worker。代码不扫描 PID、不批量杀进程、不清理其他 owner。接收样本仍在 close 后执行有界严格形状/公式校验。

墙钟来自采集后的 Date.now，合法回退仍保留实际时间；非法墙钟整体不可用。等待使用 Node 单调计时器。此项不定义云端新鲜度；后续仍以持久 receivedAt 判定。

## 来源与验证

2026-10-05 联网核对的原始来源：

- [Linux mountinfo(5)](https://man7.org/linux/man-pages/man5/proc_pid_mountinfo.5.html)：进程 namespace、可扩展 optional fields、叠加/隐藏挂载和可复用 ID。
- [Linux statfs(2)](https://man7.org/linux/man-pages/man2/statfs.2.html)：bfree/bavail、block size 与 fragment size、底层 I/O 错误边界。
- [Node v22.22.2 libuv fs 实现](https://github.com/nodejs/node/blob/v22.22.2/deps/uv/src/unix/fs.c)：`uv__fs_statfs` 直接暴露 f_bsize，不提供 f_frsize；[Node 22 fs 文档](https://nodejs.org/docs/latest-v22.x/api/fs.html#fspromisesstatfspath-options) 的 options 只有 bigint。
- 固定 Linux v6.12 [statfs.c](https://kernel.googlesource.com/pub/scm/linux/kernel/git/torvalds/linux/+/refs/tags/v6.12/fs/statfs.c#67)、[ext2](https://kernel.googlesource.com/pub/scm/linux/kernel/git/torvalds/linux/+/refs/tags/v6.12/fs/ext2/super.c#1410)、[ext4](https://kernel.googlesource.com/pub/scm/linux/kernel/git/torvalds/linux/+/refs/tags/v6.12/fs/ext4/super.c#6796)、[xfs](https://kernel.googlesource.com/pub/scm/linux/kernel/git/torvalds/linux/+/refs/tags/v6.12/fs/xfs/xfs_super.c#819)、[btrfs](https://kernel.googlesource.com/pub/scm/linux/kernel/git/torvalds/linux/+/refs/tags/v6.12/fs/btrfs/super.c#1716)：上述实现的大小/计数单位与 frsize 回填；[overlay](https://kernel.googlesource.com/pub/scm/linux/kernel/git/torvalds/linux/+/refs/tags/v6.12/fs/overlayfs/super.c#240) 转发到底层并改写 magic，不能从 overlay 推定单位。GitHub raw 同一来源返回 429，改读官方镜像；下载原文及 SHA 在证据根保存。
- [GNU coreutils v9.7 df.c](https://github.com/coreutils/coreutils/blob/v9.7/src/df.c)：used=blocks-bfree、ceil(used/(used+bavail)) 的显示公式。

验证入口：

```text
node --test tests/disk.test.mjs tests/disk-process.test.mjs tests/cpu.test.mjs tests/memory.test.mjs scripts/ci/security-baseline.test.mjs
node scripts/ci/disk-native.mjs
```

原生验收运行真实 CLI，两条 namespace gauge 至少相隔 30 秒；对每个选中挂载点运行独立 `/usr/bin/df --block-size=1 --output=size,used,avail,pcent -- <mountPoint>` 和 `/usr/bin/stat --file-system --format=%S %s -- <mountPoint>`。total/差额精确一致、df ceil 公式精确一致，used/available 差异不超过 `max(16 MiB, total × 0.01%)`，实际 fundamental/transfer block size 必须相等。产品两位小数比率另与独立 df bytes 重算比率比较，容差为 `min(100, 0.01 + 200 × toleranceBytes / min(两方 used+available))` 个百分点，涵盖字节时点差异和舍入，不拿 df 整数向上取整当产品显示值。容差仅处理两个进程的读取时点和正常空间波动，单测另以 100/40/30 blocks 严格证明 used=60 而不是 70、reserved=10、占比 66.67 而非 60。不写数据、不产生压力、不创建挂载、不清理文件、不安装工具。

CI 复用 Ubuntu contracts job，所有既有 Node/CPU/内存/安全门禁保留。本地固定 Docker 镜像 `sha256:fee853fafa59550d162cef52bca02d907694b44ebf6ef9fb075bcc0c65d8dedb`、Node.js 24.18.1、uid1000、只读 LF 快照和 tmpfs 只验证该 namespace，不是用户宿主或真实 Cloudflare。证据根 `C:/Users/Public/nas_home/AI/GameEditor/linshi/springbok-disk-collection-20261005/`；已执行结果、精确 Git/PR/main 回执见总计划，不预报 CI 成功。
