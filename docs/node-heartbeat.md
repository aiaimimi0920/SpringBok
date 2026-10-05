# N08：独立角色心跳与云端离线判定

本项接续 [常驻客户端](node-daemon.md)、[用户服务](node-user-service.md) 和 [存储设计](storage-architecture.md)。只提供控制客户端进程到云端的可达性观测，不采集主机指标、不证明业务健康或部署就绪；所有结果保留 `executionReady=false`。真实 Cloudflare、Access、用户主机和多机验收仍未完成。

## 鉴权与有界数据

`ENABLE_NODE_HEARTBEAT` 默认 `no`，还需要节点 mailbox/credentials 开关与 `NODES` binding；管理员读需要原 Access、目录开关与 `REGISTRY`。没有新增 binding/DO 类、D1/KV/R2 或运行依赖。本轮不启用生产开关。

节点仅以自己已 joined 的独立 execute/observe Bearer 凭据访问：

```text
POST /node/v2/heartbeat/<execute|observe>/<ownerId>/<nodeId>/<enrollmentId>/read
POST /node/v2/heartbeat/<execute|observe>/<ownerId>/<nodeId>/<enrollmentId>/start
POST /node/v2/heartbeat/<execute|observe>/<ownerId>/<nodeId>/<enrollmentId>/sample
GET  /api/admin/nodes/<nodeId>/heartbeat
```

寻址 ID 不是授权。NodeMailbox 最终同步事务重新验证 joined、角色摘要、enrollment 与开关后才读写。角色不能使用对方 token，加入挑战、旧共享 NODE_TOKEN、其他 node/owner 或假 enrollment 不能替代。HTTPS、固定 origin、无 Cookie、严格字段/版本、5 秒请求超时和 body/response 大小限制沿用现有控制通道。错误固定脱敏，不返回 token/challenge。

管理员 owner 来自验签后的 `session.actor`。目录仅检查其服务器引用为 enrolling/active，不把 active 当在线，也允许目录收尾失败但节点已 joined 的心跳。管理员只有 GET；未 joined/无样本为未知，不自动初始化节点或迁移 schema。GET 失败为未确认，不能伪装成已确认离线。

每个节点只保存两个角色的当前会话与各自最新样本，不追加历史、日志或任务。样本保存 `sampledAt, receivedAt, bootId, generation, sequence`；generation 是心跳会话代次，**不是凭据 epoch**，没有实现 N04 轮换/N05 撤销。

## 重启、乱序与重送

1. 每次 daemon 生成随机 bootId；read 取得当前角色代次，start 以 `previousGeneration` 做 compare-and-set 并分配下一代次。read 输入只取一次，丢 start 响应重送同一 bootId/前代次；不重新读取并夺取另一会话。
2. start 本身不记录心跳、不刷新 receivedAt，保留前代次最新样本。旧 sample/旧 start 在新会话建立后拒绝；同一代次只接受严格递增 sequence，同一最新序号/采样时间的精确重送返回原样本及原 receivedAt。
3. 不同代次也不能绕过每角色最小 30 秒接收间隔；提前的新样本返回 `deferred` 且不写入。客户端保留原 pending 样本，下次循环发送原输入；网络丢包同样重送原输入，不伪造新采样/接收时间。
4. 代次是云端受权会话顺序，不能证明客户端的 OS 启动时间。两个安装复用同一角色材料时，新 CAS 会话可能使旧心跳冲突并停止旧进程；本项不把它声明为跨安装任务仲裁。既有凭据复制限制仍有效。

## 判定和页面新鲜度

固定阈值使用 **云端 `evaluatedAt - receivedAt`**，不用客户端 sampledAt 或浏览器墙钟：

| 接收年龄 | 判定 |
| --- | --- |
| 无样本/未 joined/云时钟早于记录 | unknown |
| 小于 90 秒 | online |
| 大于等于 90 秒且小于 300 秒 | stale |
| 大于等于 300 秒 | offline |

过去/未来客户端采样时间只作为诊断展示，不延长在线。云时钟倒退导致当前时间早于持久记录时失败关闭/未知，不倒写接收时间。offline 表示此角色没有在阈值内完成受权上报，不确诊主机关机、网络或业务原因。

管理页按服务器分别展示 execute/observe 状态、采样/接收/判定时间与阈值，不生成聚合绿色“服务器就绪”。读失败保留目录操作边界。快照最多展示 30 秒，临近服务端阈值时更早失效，并扣除请求耗时；之后显示“当前未知，请刷新”，不由浏览器时钟自行伪造云判定。后台页面恢复时再检查单调时间有效期。重新渲染、换 owner、离页和 BFCache 清理均中止读请求、清定时器并丢弃迟到响应；没有自动 POST 或重送目录变更。

## daemon 与包兼容

每轮先完成原任务/身份 step，再串行心跳；任务暂时传输失败也可尝试独立心跳。心跳暂时网络/选定 HTTP 失败只输出 `heartbeat: unavailable`，不改已完成任务结果、不重放 probe、不改变任务退避计数。身份/协议/CAS/本地持久化不确定仍停止；unknown 在心跳前阻断并保留 ledger。成功间隔至少 30 秒，任务连续失败沿用至多 300 秒退避，可能形成缺测，不能因此伪造在线。

SIGINT/SIGTERM 后不开始新的心跳 HTTP 调用；已在途调用收尾，保留任务 intent/result/ack 的原语义。日志新增固定 `heartbeat` 事件，仍不输出秘密或原始样本。

当前包显式升级为 `springbok-control-node/v3`，22 个固定源文件，协议仍为 node v2、安装记录仍为 v1。旧 v1/v2 安装继续使用自身旧代码，没有原地覆盖、迁移 state、清锁或自动升级。新版可信安装器拒绝旧格式或拿新包覆盖旧安装。用户服务 unit 仍指向经验证的安装，无新参数/秘密；当前可信生成器只为当前 v3 安装生成，旧 v2 服务仍由旧 checkout 维护。

## schema 迁移与回退

NodeMailbox 原 schema 1/2、node_ledger 和 node_enrollment 保留。只有受权 start 的首次实际写入在同一事务增加单行 `node_heartbeat`、将 node_meta 升级到 3；read、管理员查询和拒绝请求不迁移。旧表/owner/计划先校验，任务/enrollment 字节不变。心跳缺表/坏行只让心跳路径失败关闭，不阻断完好原身份/任务 API 的领取或 report；核心 metadata/ledger/enrollment 损坏、未知 schema 仍全部拒绝。不重建空心跳状态。v3 daemon 对任何非暂时心跳错误仍退出保留现场，这是明确失败策略，不承诺损坏观测后进程自动继续。心跳开关关闭保留全部数据，恢复后可读。

旧 schema 2 读者不认识 3，拒绝而非清空。回退部署必须先停新写入并核对在途任务，保留新代码或走后续已审阅恢复方案；关闭开关不等于把 schema 降回 2。本项没有真实账户迁移、数据删除或生产回退。

## 验证入口与边界

证据根：`C:/Users/Public/nas_home/AI/GameEditor/linshi/springbok-node-heartbeat-20261005/`。固定 Linux Docker / Node.js 24.18.1、非 root uid 1000、只读 LF 快照、相同 lockfile 依赖与一次性 tmpfs；不是线上 Cloudflare 或用户服务器。

- `tests/node-heartbeat.test.mjs`、`tests/node-daemon-loop.test.mjs`：时间阈值/偏差、CAS/乱序/限频/精确重送、客户端丢回执和信号边界、心跳不重分类任务。
- `tests/cloud/heartbeat.test.mjs`：真实 workerd/SQLite、角色/node/owner/enrollment 鉴权、迁移保留/旧读者拒绝、重启、独立开关、损坏失败关闭。
- `tests/cloud/node-daemon.test.mjs`：实际 v3 安装进程与 workerd，丢 report ack 和 heartbeat ack、至少 30 秒等待、任务不重放、安全 drain 与 journal fatal。
- `tests/browser/node-heartbeat.mjs`：真实 Chrome/Worker/SQLite 的不同角色/节点/状态、未来采样、enrolling-but-joined、未知、读失败、快照过期/迟到 owner、GET-only/390px；浏览器时钟加速只验证 UI 失效，不替代真实后端阈值测试。
- 既有全量契约/Worker/浏览器、user-manager CI、安全流程和精确 Git 包兼容另核实际结果；源码存在不预报检查通过。

本地 Linux 全量契约 **211/211**、workerd **49/49**，无失败/跳过；浏览器入口五条 PASS，中文 390px 截图已视觉核对。功能 head `248eafdc016e95115a1fb39f914ad4147a649823` 的 6 workflows/14 checks 全部成功，实际 user-manager 双角色 journal 已确认 recorded 心跳并通过原重建/失败/锁保留矩阵；artifact `11354943979` 的 GitHub SHA-256 与内容匹配。精确 Git 包 22 文件/89,803 字节，manifest SHA-256 `bf86a152e26ae68630da4f194ebc63eb3214d75217729800e2acbf11e47c1ce5`，非 root 双角色安装/version/实际 daemon 心跳与安全退出、服务 CLI/parser 通过。旧 `448d53a` main 的 v2 安装/重装/version 与内容/inode/device/mode/mtime/state 保留实测通过。最终文档 head/合并 main、固定 main 包另记 PR 回执，不把旧包摘要当新 main 包摘要。

未完成：指标采集/总览/历史/告警、N04/N05/N10、执行依赖/真实业务、真实 Access/Cloudflare、多服务器安装和实际断网演练。实现的心跳断流阈值测试不冒称已在用户服务器拔网线验收。
