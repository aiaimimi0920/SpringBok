# N01-S02：认证节点通道与独立出站桥

本项接续 [节点邮箱](node-mailbox.md)、[一次性加入](node-enrollment.md) 和 [角色凭据](node-credentials.md)，总进度见 [开发计划](development-plan.md)。它把原内部 v2 `protocol-probe` 接入真实已加入身份、管理员 API 和 Linux 出站桥；不是通用 dispatch、业务部署或常驻 Agent。

## 管理员与节点入口

管理员使用已有 Cloudflare Access 服务端验签和名单；owner 来自可信 session.actor，而非请求体：

```text
GET  /api/admin/nodes/<nodeId>/probe
POST /api/admin/nodes/<nodeId>/probe
POST body = {requestId, revision, challenge}
```

POST 要求同源 Origin 和本 session 的 `x-csrf-token`，body 沿用严格 probeRequest；revision 是节点 ledger 的版本，不是目录版本。GET 返回限定 owner/node/enrollment 的节点 revision/jobs，POST 返回同一身份范围下的 `{result:{requestId,status}}`。二者始终 `executionReady:false`，不接受 actor、任意 operation、服务、镜像或 shell 字段。用户界面向导/监控页面仍由对应 D/M 任务实施；本项交付 API/CLI，不给原固定 fixture 页面改名冒充新节点操作。

目录先限制为本人 enrolling/active 节点，不能引用别人的服务器；节点当前 joined 是最终权威。节点 joined、目录 finalize uncertain 可以提交控制 probe，不能因为目录尚未 active 就把合法身份当未加入。目录读与节点提交没有跨 DO 原子事务；节点最后再次核对实际 DO、持久 owner/node 和当前 joined。本项没有删除/归档/撤销入口。

节点通过自身 execute 文件访问：

```text
POST /node/v2/channel/<execute|observe>/<ownerId>/<nodeId>/<enrollmentId>/poll
POST /node/v2/channel/<execute|observe>/<ownerId>/<nodeId>/<enrollmentId>/report
Authorization: Bearer <本角色 token>
Content-Type: application/json
poll body = {protocolVersion:2}
report body = {protocolVersion:2,requestId,planDigest,challenge,outcome:'observed'|'unknown'}
```

只有 execute 角色可用；observe 文件在客户端即拒绝，服务器也拒绝 observe 或将 observe token 用到 execute 路径。URL 字段不是权限证明。服务器在同一节点 DO 最终同步事务内核对当前 joined、对应角色摘要和 expected enrollment，再读取当前 ledger、执行 nodeTransition、保存 claimed/回执后返回。错误 enrollment 在 transition 前拒绝，不能先消耗任务再由客户端发现 metadata 不匹配。

前置 ledger 摘要校验的 await 区间由 `blockConcurrencyWhile()` 覆盖，最终事务重新读取 ledger；未来不能移除这个并发边界后仍信任前置校验。当前无 epoch/revoked，后续 N04/N05 必须在同一权威 seam 接入，不能宣称现在已完成轮换/撤销。

节点 poll/report 响应严格为 `{protocolVersion:2,ownerId,nodeId,enrollmentId,role:'execute',executionReady:false,result}`。客户端拒绝错身份/角色/额外字段和扩大权限的回执；poll 的 result 只有 idle/claimed/unknown/expired/delivery，report 只有 observed/unknown，requestId 必须匹配。交付计划沿用完整 owner/node/serviceId=null/environment=control/operation=protocol-probe/requestId/revision/challenge/planDigest 绑定。低层 client 检查计划字段及摘要格式，桥在写 intent 前及重开 projector 中重新计算真实 SHA-256；两者保证层次不能混称。

## 开关与请求限制

新增 `ENABLE_NODE_CHANNEL=no`，没有新 binding、schema、迁移或依赖。通道需要 node mailbox、credentials、channel 三开关；管理员入口另外需要 Access/admin、catalog/REGISTRY。关闭加入/目录/管理员不隐式禁用已加入节点的通道，关闭 credentials 或 channel 则拒绝而不清数据。身份端点不依赖 channel 开关。

节点请求必须 HTTPS，无 query/cookie，Origin 缺省或同源；严格 token/path/body、固定响应错误、禁止缓存。服务未启用 503，未知路径/方法 404，基础请求拒绝 403，身份/格式/存储不确定 409。空库/schema 1 不初始化或升级，缺表、未知版本、损坏记录失败关闭。客户端固定独立确认的 HTTPS origin，与文件 origin 严格匹配，禁止 redirect、5 秒请求超时、4096 字节响应上限，不自动重试。

## Linux 一次出站桥与持久恢复

```text
node scripts/node-channel.mjs --credential <private-execute-file> --expected-origin <independently-confirmed-https-origin> --state <private-channel-state>
```

桥只读取该角色文件，输出脱敏 `{status,executionReady:false,operation:'protocol-probe'}`，固定错误不输出 token、challenge、摘要、任意上游错误。CLI 一次只执行一个 step；不装服务、不常驻、不创建凭据，也不调用 Docker、shell 或任何业务 executor。observed 仅确认控制 probe 回执，不是在线、健康或部署成功。

复用现有 Linux openJournal 的独占锁、写前记录、fsync、原子替换及 poisoned 状态；使用独立 `node-channel/v2` binding，绑定 origin/owner/node/enrollment/role，不含 token，不能复用旧 fixture/加入 journal。私有目录同 uid/0700，已有 ledger 必须同 uid、私有普通文件、非 symlink；可信父路径/主机/同 uid 写入者边界同 N03，没有强 OS 隔离承诺。

1. 获得合法 delivery 后重算完整计划摘要，先保存 started intent，再保存固定只读 observed result，最后发送原 receipt；没有可注入业务 executor。
2. result 已保存、ack 丢失：下次优先重送完全相同 receipt，不先 poll、不给新 observed 结果。云端原回执幂等。
3. intent 有而 result 无：正常重开后保存 unknown，不重新观察/执行。只有明确持久证据允许恢复；不能从意图推断成功。
4. 本地 receipt 为 unknown 或云 ack 为 unknown：持久保留两种状态，后续 step 永久返回 unknown，不再 poll。即使原 observed 结果晚到、云端因过期回 unknown，也不能以原结果解除阻断。
5. 领取响应丢失、无本地计划：不能猜 requestId/摘要或伪造 receipt。云 claimed 不重投；云 unknown 到达时保存 remote-unknown 终态，重开后仍零新 poll。
6. ack 本地写失败或其他 journal 写入不确定：poison 后停止。保留 journal，重开仅按实际持久结果恢复/重送；不重置标记。

正常 close 后重开不等于任意异常进程自动恢复。崩溃残留 owner.lock 必须核对原进程与证据，当前不自动删除。journal 1000 事件/1 MiB 上限保持，桥最多 100 个任务，与云端容量一致；100 条正常任务约 300 事件，不无限增长或自动清理。云 unknown 永久阻断，恢复/撤销仍由后续限定流程承担。

## 验证与限制

证据根为 `C:/Users/Public/nas_home/AI/GameEditor/linshi/springbok-node-channel-20261005/`。使用固定 Node.js 24.18.1/Chromium Docker 镜像、相同 lockfile 的只读依赖、tmpfs 私有状态；源码副本按 LF 核对，不改 Windows Git 换行配置或历史 evidence。Windows Node.js 22.22.2 只验证跨平台契约。

新增 workerd 测试直接通过 Access 合成 session、真实目录/加入、原私有文件、真实桥和 SQLite 走管理员提交→单节点领取→持久 result→云回执；覆盖双节点/双 owner/同 requestId 不串、错 enrollment 不消费、角色隔离、8 路竞争、严格请求/回执、丢 delivery/ack、ack 写失败、intent-only/晚到 observed→unknown、零后续 poll、独立开关、旧 schema/损坏库及非法计划/CLI origin。fetcher 注入 Miniflare dispatchFetch，不是外部 HTTPS/TLS 或真实服务器实测；模拟 307 仅验证 redirect:error 和拒绝行为。

第一轮 8 项中 7 通过，1 失败是测试关闭管理员后漏恢复该开关，后续创建节点被正确返回 503；修正测试状态，不放宽生产门禁。原日志 `snapshot/.tmp/linux-channel-first.log` 保留。

| 检查 | 实际结果与证据 |
| --- | --- |
| Windows `node --test tests/node-channel-contract.test.mjs tests/node-credentials.test.mjs tests/cloud-admin-boundary.test.mjs` | Node.js 22.22.2，7/7，0 失败/跳过 |
| Linux 新通道 `node --test tests/cloud/node-channel.test.mjs` | 8/8，0 失败/跳过；`snapshot/.tmp/linux-channel-final.log`，已核对源码哈希并复用 |
| Linux 全量契约 `node --test tests/*.test.mjs scripts/ci/security-baseline.test.mjs` | 186/186，0 失败/跳过；`snapshot/.tmp/linux-unit-final.log`，197 个 tracked 文件与快照一致 |
| Linux 完整 Worker `npm test --prefix tests/cloud` | 本轮重新执行 42/42，0 失败/跳过；`snapshot/.tmp/linux-cloud-resume.log` |
| 旧凭据导出失败点独立复核 | 原代码、原 5 秒超时和断言下 1/1；`snapshot/.tmp/linux-focused-resume.log` |

原完整 Worker 日志 `linux-cloud-final.log` 实为 41/42，不能按文件名中的 final 推定成功：旧凭据 CLI 子进程 `status=null`，确切终止原因未保留；本轮未改产品或测试门禁，聚焦及完整复跑通过。恢复运行时曾缺少 `cloud/node_modules` 挂载，以及 PowerShell 将 npm notice 误判为终止错误，修正仅临时测试装配与日志包装。未改 UI，本地不重复浏览器场景；精确 PR/main 的既有浏览器 CI 另记回执。

主 AI 完成源码与调用点审阅；独立审查代理因上游 503 未能运行，不计为独立审查通过。UTF-8/哈希/文档、安全工具与精确提交/PR/main 检查记录在开发计划和交付回执，不预报尚未执行的成功。

后续 N07-S01 已增加 [安装后常驻入口](node-daemon.md)：保持本页 bridge 的持久化语义，传输层仅将明确的暂时网络/选定 HTTP 错误分类为可退避重试；协议、身份和本地 journal 错误仍停止。下列未验证项及上述数字是 N01-S02 交付时记录，当前进度以总计划和 N07-S01 回执为准。

未验证：真实 Cloudflare/Access、资源限额、多服务器网络、原生 CLI 的外部 HTTPS、发行安装/不同账户权限、常驻/心跳、轮换/撤销、指标与业务部署。没有配置真实账号、购买资源、执行远程安装、生产迁移或删除业务数据。CodeQL 对私有文件/本地 receipt 到独立固定控制面的必要协议数据流须按最新 SARIF 实际审阅，不 suppress/dismiss，不把扫描成功称零漏洞。
