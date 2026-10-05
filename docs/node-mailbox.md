# N01-S01：独立节点邮箱与内部只读协议

任务开始日期：2026-10-04；负责人：主 AI；基线 `d9cae17715a86fed724faae2284cdada472a0a33`。
总进度见 [开发计划](development-plan.md)，前置约束见 [执行架构](execution-architecture.md) 和 [存储设计](storage-architecture.md)。

## 1. 本切片的用途与安全边界

本切片为后续加入/认证节点建立独立的持久任务核心，不开放生产节点通道。
`cloud/node-mailbox.mjs` 的 `NodeMailbox` 只提供可信服务端内部 RPC：
`snapshot`、`submitProbe`、`pollProbe`、`reportProbe`。没有通用 `apply/dispatch`、shell 或部署适配器。
`ENABLE_NODE_MAILBOX=no` 默认关闭；Worker 仅导出新类，不新增 HTTP 路由，也不把旧 token 转换为新身份。

内部调用方必须先得到可信的 `{ownerId,nodeId}` 上下文；验证字段格式不是验证节点身份。
当前产品没有这样的公开调用方。测试驱动提供的上下文只是内部调用前提的夹具，
不是加入流程、Access 登录或独立节点凭据的完成证据。
以后 N02/N03 提供权威加入/凭据记录，再由 N01-S02 接入出站桥和公开通道，
并将角色、epoch、active/revoked 校验与任务领取放到同一权威事务中。
本次上下文格式不预先规定未来凭据编码，也不能代替其授权判断。

## 2. 寻址与存储

- 新 binding：`NODES`；新 SQLite 类：`NodeMailbox`；只追加迁移 `v3-node-mailbox`。
- 名称：`node/v2/<ownerId>/<nodeId>`；owner 是既有 actor 格式的 64 位小写 hex，node 是服务端 UUID 格式。
- 每次 RPC 同时比较上下文生成的实际 DO ID 与 `ctx.id`，首次写入前即拒绝错对象上下文。
- `node_meta` 保存单行 `schema_version=1, owner_id, node_id`；绑定不可变。
- `node_ledger` 保存单行 `{revision,jobs}`；每节点最多 100 条记录（包括终态），最多一个 queued/claimed/unknown。
- 初始化在同步 SQLite 事务中完成。关键表/列/行缺失、未知版本、身份或 ledger 损坏时拒绝，不重建空库。
- 每次读取校验所有计划的规范字段与 SHA-256 摘要；摘要等待期间用 `blockConcurrencyWhile` 防止 RPC 交错。
  最终状态更新在同步事务中提交，先写 claimed 后交付。当前只读内部协议不包含未来节点权限生命周期。

关闭开关拒绝内部读写但不删数据，重新开启后原记录仍保留。未创建真实云资源或执行线上迁移。
旧 `TARGET`、`TargetMailbox`、固定 `pc2-test`、旧 bridge/fixture 和历史证据均保持原样，
不搬运旧 claimed 为新 queued，也不通过删除新存储来“回退”。

## 3. v2 只读 probe 契约

提交请求只接受 `{requestId,revision,challenge}`，三者分别为 UUID、非负安全整数、64 位小写 hex。
owner/node 仅来自内部上下文；其他计划字段由服务端固定生成：

```text
protocolVersion = 2
ownerId, nodeId = 已校验的内部上下文
serviceId = null
environment = control
operation = protocol-probe
requestId, revision, challenge = 严格规范化请求
planDigest = sha256(上述完整规范字段的 JSON)
```

`serviceId=null/environment=control` 仅表示控制通道只读连通探针，没有实际业务服务目标，
不是生产环境授权。相同 request/challenge 在不同 owner/node 下仍产生不同摘要。
未知版本、fixture-cycle、deploy、额外 owner/node/operation/planDigest 字段均拒绝。
真实服务/环境/配置/制品 resolver 属于 D07/D09/D10，不从用户自报字段构造执行授权。

poll 只接受 `{protocolVersion:2}`；回执只接受
`{protocolVersion:2,requestId,planDigest,challenge,outcome:'observed'|'unknown'}`。
回执必须命中当前邮箱的完整任务绑定，不能用同 ID/同 challenge 串到另一节点。
`observed` 表示探针回执被接收，不是服务器在线、业务健康或部署成功；快照始终
`mode=internal-node-probe-only, executionReady=false`。

## 4. 交付与未知结果

同 requestId/同完整规范输入返回原任务状态，不增加 revision；不同输入拒绝。
新提交必须匹配当前 revision、满足容量且没有未完成任务。并发领取只返回一次 delivery。
probe 期限固定 120 秒；排队超时变 expired，不执行；已领取超时变 unknown，永久不重投。
明确 unknown 回执被保留，内容冲突拒绝；超时产生的 unknown 不接受迟到 observed 来解除阻断。
observed 回执可幂等重送，包括响应丢失、workerd 重启之后；不再次执行或交付任务。
容量满不自动删除历史，仍支持读取和已有请求重放。

## 5. 验证入口与未验证项

```text
node --test tests/node-protocol.test.mjs tests/cloud-admin-boundary.test.mjs
npm ci --ignore-scripts --no-audit --no-fund --prefix cloud
npm ci --ignore-scripts --no-audit --no-fund --prefix tests/cloud
npm test --prefix tests/cloud
```

新增 workerd 测试由既有 Cloud Node Protocol CI 入口显式包含，不增加 workflow 权限或依赖。
`tests/cloud/node-mailbox-fixture.mjs` 是仅测试使用的 RPC/损坏注入入口，生产 Worker 不导入它。
验收覆盖同 owner 双节点、不同 owner 相同 node ID、首次错上下文、同 ID/挑战的跨节点回执、
竞争领取、重启、丢 ack 重送、超时未知、默认关闭/启用后 HTTP 仍不可调用以及损坏存储不重建。
超时用例在测试存储注入过期时间以避免真实等待，纯契约同时覆盖精确 120 秒边界。

测试运行时将 TEMP/TMP/TMPDIR 指向 linshi 一次性副本的 `.tmp`；新增 workerd 用例在 Windows
检测临时根不在 linshi 内时直接拒绝启动，并在清理前验证解析后的子目录边界。
结构校验不能证明任意外部篡改检测：若两张应用表均被外部删除，当前会视为首次初始化；
产品没有删除这些表的入口。真实 Cloudflare `cpu_ms=10` 在满容量摘要校验下的成本/延迟仍待 V01 核实，
本地 workerd 满容量通过不等于真实云资源限额验收。

实际运行：Windows Node.js 22.22.2 聚焦 5/5；Linux Node.js 24.18.1 全量契约 177/177、
workerd/SQLite 21/21，失败/跳过均为 0。后者包含真实 DO 满 100 条后的拒绝/读取/重放/重启，
以及旧协议/管理页身份/目录层邻近回归。本轮未改页面，未另跑本地浏览器截图；精确 PR/main 的
既有浏览器 CI 结果另记交付回执。源码与本地验证完成，最终提交/PR/main 状态以 PR 回执为准。
actionlint 1.7.12 对全部 workflow 的语法检查通过，未额外执行 ShellCheck；工具与 Gitleaks 8.30.1
均由仓库固定版本归档 SHA-256 验证。11 文件 UTF-8 无 BOM、32 本地链接、82 任务无环检查通过。
证据目录：
`C:/Users/Public/nas_home/AI/GameEditor/linshi/springbok-multi-node-20261004/`。
没有真实 Cloudflare/Access/外部节点验收；没有节点注册、凭据隔离、常驻桥或真实部署。
N01 父项保持部分实现，下一项是 N02；认证 HTTP/桥接缺口仍由 N01-S02 承担。
