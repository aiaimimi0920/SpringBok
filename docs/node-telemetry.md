# M06 / M02-S02：鉴权 CPU/内存上报与独立最新快照

任务日期：2026-10-05；负责人：主 AI；基线 `31bf919ae905d3eda2b460e2f2a14c432c36ebde`。
总入口：[开发计划](development-plan.md)；前置：[CPU 采集](cpu-collection.md)、[心跳](node-heartbeat.md)、[存储设计](storage-architecture.md)。

## 范围与权威边界

M06 最初实现 CPU 最小上报/查询链；M02-S02 后续增加版本化内存，不是全部监控平台。`NodeTelemetry` 是独立 SQLite Durable Object，名称 `telemetry/v1/<ownerId>/<nodeId>/<enrollmentId>`；仅保存一个会话和一份最新样本，没有历史、离线磁盘队列或任务记录。M06 Wrangler 仅追加类迁移，M02-S02 不改变 binding/迁移；功能默认关闭，D1/KV/R2 未接入，也没有创建真实 Cloudflare 资源。

公网 `POST /node/v2/telemetry/observe/<ownerId>/<nodeId>/<enrollmentId>/{read,start,sample}` 必须先经 NodeMailbox 的最终事务验证 joined/observe/token/enrollment。它返回严格内部授权上下文后结束事务和并发 block，Worker 才转发指标。Telemetry 再检查 binding/DO ID/不可变持久身份/schema。上下文不是密码学 capability，可信 Worker/DO 是边界，不对恶意节点的采样真实性作证明，也不提供绕过鉴权的 HTTP 或内部浏览器入口。

`GET /api/admin/nodes/<nodeId>/telemetry` 经真实服务端 Access 验签、owner 目录引用与 joined 身份查询，仅读本 owner/enrollment。目录仍 enrolling 但节点已 joined 时可查询；未 joined 为未知。查询不初始化指标库，不变更目录/任务/心跳。未来撤销后的新鉴权应拒绝；鉴权后在途请求可能晚到，跨 DO 没有原子撤回承诺，generation 不是凭据 epoch。

## 会话、限量与时间

- 协议版本 2，模式 `node-telemetry-only`，CPU payload 固定 `springbok-cpu/v1`。严格字段/status/reason/null、单位和 0–100% 口径，不支持任意 metric、文件路径、日志或环境变量。`linux-proc-stat` 不证明运行位置是用户宿主。
- telemetry 请求严格 UTF-8 JSON，declared length 和实际流均最多 8 KiB，读取 deadline 5 秒；其他旧入口仍 2 KiB。记录最大一份最新样本和一份会话，不无限追加 receipt。
- read 返回 generation；start 使用随机 bootId 和 previousGeneration CAS。丢响应只重送同输入，不重新读代次夺取会话；旧代次即使高序号也拒绝。start 保留旧 latest，因此换 boot 不绕过 30 秒最小成功接收间隔。
- `receivedAt` 由 Telemetry 同事务首次成功持久接收生成。写前失败无接收；写后丢 ack 精确重送全规范化 payload，返回原时间。相同 key 改 payload 拒绝；latest 已被覆盖的旧样本拒绝，不拿新回执冒充旧成功，不倒写。
- 保留客户端 `sampledAt` 与实际 CPU `intervalMs`，云端新鲜度仅看 `receivedAt`；90 秒陈旧。采集未知/不可用与新鲜度分开，数值 0 有效，null 不假绿；云时钟回退为未知/拒绝写入。
- observe daemon 使用原普通用户安装/锁与独立凭据，执行角色不采集。至多一份内存 pending，单调年龄达到 90 秒或时钟异常后丢弃，不改旧样本 sequence 伪装新采样。暂时错误保留原 pending，非暂时错误停指标能力并报告 unconfirmed，不改变执行结果/网络退避或触发任务重放。identity/heartbeat 保留原策略。
- M06 v4 包是当时显式新安装格式，不覆盖 v3 安装；M02-S02 当前格式见下节。旧包和 state 保留。SIGINT/SIGTERM 不发迟到样本，等待当前读取/请求结束后正常释放自有锁。

真实 fetch 会收到停止信号并在有界请求内中止，服务端可能已提交而 ACK 未收到；指标没有任务副作用，不保证 ACK drain。已安装进程测试的 IPC 传输会人工 hold ACK 来验证进程收尾/不发第三次样本，不冒称验证真实 TLS 网络的信号传播。节点身份/执行 step 的原在途 drain 策略不变。

关闭/重新开启功能不会清除任何库或旧包。缺单表/行、未知 schema、错持久 owner/enrollment、坏 JSON 均拒绝且保留原样；若所有业务表均被外部删除，SQLite 空库与全新对象无法区分，本项不承诺检测这种外部清空。没有新增自动清理或备份能力。

## 验收和未验证项

以下数字是 M06 的历史验收，不冒充 M02-S02 新实现结果。

Linux Node.js 24.18.1、uid 1000、固定只读 LF 快照：全量契约 **225/225**、workerd/SQLite **56/56**，失败/跳过均为 0。指标专项六组覆盖 observe/owner/node/enrollment/default-off、8 KiB 实际流/declared length/UTF-8 与旧 2 KiB、SQLite 重启/完整 payload 重放/旧回执拒绝/CAS/跨 boot 限频、写前失败/写后丢 ACK/关闭恢复、坏库且 execute/heartbeat 继续、挂起指标 RPC 时完整任务 poll/report 仍可完成。

真实 v4 普通用户双角色安装进程复用实际 CPU sampler，observe 先 warm-up/null，再在 **30,947 ms** 后上报 available（实际 CPU 窗口 **31,016 ms**）；admin GET 与持久 receivedAt 相符，execute 指标请求为 0，observe 不创建任务 ledger，正常退出保留凭据并释放自有锁。采样运行在一次性 Linux 容器的可见内核口径，不证明用户宿主。

真实 Chrome/workerd 页面专项已通过：0/null/unknown/unavailable/stale 分开、enrolling-but-joined、局部失败保目录/心跳、错 owner、请求耗时扣减、临近 90 秒失效、不同值的迟到 render/owner、pagehide/BFCache、独立可见性失效、390px；仅 GET，无任务/目录/指标写入或浏览器存储。竞态和边界时间通过测试受控响应/时钟注入，并非声称线上发生过这些故障。

基线 `31bf919` 的真实 Git v3 / 22 文件包由自身旧代码完成双角色安装/重装/version；当前 v4 拒绝旧格式及覆盖旧安装，release/credential/install marker/state/锁的内容、inode/device/mode/uid/mtime 不变。该兼容证明不提供自动升级或公开签名发行。

证据根：`C:/Users/Public/nas_home/AI/GameEditor/linshi/springbok-telemetry-20261005/`。首轮错误包括 Docker 只读 mountpoint、Undici 对伪 Content-Length 的传输拒绝、测试等待 held ACK 无通知、Chrome 私有 HOME 未指定、浏览器延迟超请求 timeout、既有 binding 精确断言未追加新类；仅修测试/临时环境/明确 schema 断言，不降低产品限制。原失败日志保留。精确 Git 包、安全检查、远程 PR/head/main 与 user-manager CI 结果以本项最终回执为准，不提前预报。
本地/CI workerd、合成 Access、一次性非 root 安装和 Chrome 不代表真实 Cloudflare、用户宿主、业务部署或 V 系列验收。其他指标、历史、完整多服务器总览和告警仍未完成。

## M02-S02：严格版本化内存与混合版本边界

2026-10-05；负责人：主 AI；基线 `202d658ad066aa0d6d5ed8e27bc2f0ce0403518e`。

旧上报仍是 `{protocolVersion, bootId, generation, sequence, cpu}`，旧 latest/ACK 仍是 `{bootId, generation, sequence, cpu, receivedAt}`；不默认补字段。新形状显式多出 `sampleVersion: 2, memory`，node 协议仍为 2。缺版本却带 memory、新版缺 memory、未知版本或多余字段都拒绝。两种输入与回执共用规范化完整 payload，修改内存/CPU/版本的同 key 重送或 recorded ACK 都不能通过。

`memory` 固定 `springbok-memory/v1` / `linux-proc-meminfo` / bytes；采集口径见 [内存采集](memory-collection.md)。available 的 bytes 必须为安全非负整数，total>0、available≤total、used=total−available；百分比必须精确等于 BigInt 两位四舍五入公式。unavailable 只允许四个固定原因，时间和全部数值为 null；没有 CPU 式 unknown/预热。不能将可见 procfs 当宿主位置认证或容器可分配限额。

SQLite `telemetry_meta.schema_version` 1 只允许旧 latest，2 允许旧/新 union。首次成功 recorded 新形状才在相同事务升级 meta1→2 并写 state；读取、启动、deferred 和失败不升级，之后旧 CPU-only 覆盖 latest 也保持 meta2。schema1+新版 latest/未知 schema/损坏仍失败关闭且不修复。实际旧 reader 会拒绝 meta2，原数据保留，切回新版可读；不承诺旧 Worker 对新库仍可用，也不提供降级/清空。测试旧 reader 来自上述固定 Git 基线，只改相对 import 定位，并反向还原验证原 SHA-256，不是随实现升级的模拟旧逻辑。

当前固定包为 `springbok-control-node/v5` /26 文件，新增 `src/node-telemetry/memory.mjs`，无新运行依赖。observe 同时保存两指标 pending，重送不再采样；CPU/内存不是原子同一时点，各有 sampledAt。原 30 秒接收限频、90 秒单调 pending 丢弃、5 秒 fetch deadline、停止/暂时错误/任务退避/在途授权边界均保留。execute 不采集、不发指标请求。安装器只接受 v5，不自动升级、覆盖或收编旧 v4 安装。

目录行仍只有一次 GET，没有新增轮询、storage 或写入；CPU/内存分别验证和显示。旧 CPU-only 显示“内存未上报”，新版坏内存显示“内存未确认”，采集失败不是 0。坏 CPU 不遮蔽合法内存，反之亦然。GiB 按 bytes÷1024³，附精确 bytes 保留小非零值。新鲜度仍来自共同持久 receivedAt，扣请求耗时；到期、visibility、迟到 render/owner、pagehide/BFCache 不展示旧值为当前值。不是 M07 完整总览。

### 新版本地验收与停点

固定 Linux Node.js 24.18.1/uid1000/只读 LF 快照：契约 **237/237**、workerd/SQLite **58/58**，失败/跳过均 0。新增覆盖严格 union/数值/完整 replay/ACK、内存采集停止/年龄、真实 SQLite 升级写入途中故障回滚、deferred 不升级、重启、混合旧 latest 不降级、实际旧 reader 拒绝/切回恢复、矛盾 schema 不修复。既有 NodeMailbox/目录/任务/心跳隔离、8 KiB/默认关闭保持。

实际 v5 双角色安装进程读真实 Linux CPU/内存：首 CPU 预热时内存即 available，第二次间隔 **33,910ms**，CPU 实际窗口 **33,949ms**，两指标与 admin GET/持久 ACK 一致；execute 指标请求 0，SIGTERM 正常收尾保留凭据并释放自有锁。此 IPC hold ACK 测试仍不冒称真实 TLS ACK drain。

真实 Chrome/workerd 专项通过：内存真 0/1 byte/GiB、旧未上报、unavailable、新版缺失/矛盾/未知版本、双指标局部独立、陈旧/共同过期、迟到 render/owner、visibility/pagehide/BFCache、390px；GET-only、无 browser storage/持久写入。故障/时钟通过受控 seam 注入，截图含合成数据标识。

固定真实旧 v4 包（Git `aca3397b7a2554b2127dba0cfadce7fc1f08f1d1`，manifest SHA-256 `007441943c35a63eaaa785b1240414c119d76a4f9583d116be407935bcce6e08`）用自身旧代码完成双角色安装/daemon→新版 workerd/重装/version；CPU-only latest 仍为五字段、meta1。v5 拒绝旧包和覆盖，两角色 release/credential/markers/state/锁的 bytes/inode/device/mode/uid/mtime 不变。该证据不提供自动升级或公开签名发行。

证据根：`C:/Users/Public/nas_home/AI/GameEditor/linshi/springbok-memory-telemetry-20261005/`。本地首轮新增 ACK 单测误把带 role 的 credential 当 strict context，触发 `invalid protocol`；仅修测试调用，原失败日志保留，最终全量通过。workerd 全量有既有重启断连接 `Broken pipe` 诊断但全部测试通过，保留原日志。精确 head/PR/main、安全检查、fresh Git 固定包和交付以最终回执为准，不预报未运行 CI。不做生产部署/开关、用户宿主认证、历史/告警、新指标或 M07。
