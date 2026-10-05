# ARC-02：控制面与监控存储设计

任务日期：2026-10-04；源码基线：`a39a44f5a10651cb825c6546c04b684490e0c188`。
负责人：主 AI。本文是可实施的数据/接口约定，不是已创建云数据库或已实现节点注册的证明。
前置：[执行架构](execution-architecture.md)；总进度：[开发计划](development-plan.md)。

## 1. 首版选择：先用有明确所有权的 SQLite DO

首版沿用 SQLite Durable Objects，不为“使用数据库”而一次接入 D1/KV/R2。新目录和新节点记录采用独立类/命名空间，现有 `TargetMailbox`、`pc2-test`、fixture 限制及数据不迁移、不清空。

| 数据 | 权威位置 | 原子范围 / 禁止事项 |
| --- | --- | --- |
| 服务器/服务目录 | 每 owner 一个 `OwnerCatalog` DO | 目录记录、revision、请求幂等记录同事务；目录不是在线/执行授权证明 |
| 节点凭据、加入/撤销状态、能力、执行任务 | N01–N05 的每节点 DO | 同一节点内认证/角色/状态校验与任务领取在同事务；不能拿目录镜像或 KV 缓存绕过撤销 |
| 心跳 | 每节点 DO 的独立观测字段 | 只影响新鲜度，不占用执行队列，不改变任务结果 |
| 指标最新快照与聚合历史 | M06/M08 的独立 `NodeTelemetry` DO | 与任务存储分开，指标写失败不阻断/重放部署；历史允许缺测 |
| 任务/管理审计 | 各权威写入所在 DO | 和对应操作一起提交；查询视图可以归并，但不能伪造跨对象全局顺序 |
| 执行意图/结果 | Linux 节点独占 journal | 先写盘后执行/回报；云端 DO 不代替节点崩溃恢复记录 |
| Core 资源 | 目标服务器本地 Mongo | 仅 Komodo 自身数据，不是 SpringBok 云任务数据库 |

`OwnerCatalog` 是首个要实现的新类。节点与指标类名暂属职责约定，实际创建分别归 N01/M06，不在目录任务提前挂空 binding。SQLite DO 的同步事务不能包含网络、D1 或其他 DO 的写入；约束依据见 [ARC-01 的官方来源](execution-architecture.md)。

D1（C05）暂缓，未来需要跨节点历史搜索/分析时作为有水位的查询索引，再设计可靠同步；KV（C06）暂缓，不存授权真相；R2（C07）暂缓，待日志/备份确需对象归档时接入。三者不得成为当前服务器目录的隐含必需依赖。

## 2. 所有权和 ID

- 首版 `ownerId` 使用 `accessSession()` 已验证的 issuer/sub 派生 actor 散列，不使用可变邮箱或请求体自报 owner。改变 Access subject 不会自动接管旧目录；未来转移/多管理员授权属于 C08 的独立任务。
- 目录 DO 名称固定为 `catalog/v1/<ownerId>`，每次 RPC 再校验持久 owner 一致。Worker 只用服务端认证上下文路由；浏览器不能指定 DO 名称。
- `serverId`、未来 `serviceId` 由服务端生成小写 UUID；名称仅展示，允许重名，不可作为执行寻址。每行显示稳定 ID，禁止通过猜名称选目标。
- 一个目录服务器 ID 对应未来一个节点 ID。节点 DO 名称固定包含协议版本、ownerId 和 serverId；ID 仍只是定位信息，不是认证材料。
- 当前 `pc2-test` 不自动进入新目录，不将旧测试资源冒充已登记的用户服务器。

## 3. C04 的最小持久结构

### 3.1 服务器目录先行（C04-S01）

| 表 | 最小字段 | 约束 |
| --- | --- | --- |
| `catalog_meta` | 单行 `schema_version=1, owner, revision` | owner 不变；revision 每个成功修改加 1；未知版本拒绝，不重建空库 |
| `servers` | `id, name, state, created_at, updated_at` | v1 只允许 `draft/archived`；仅元数据，不含地址、凭据、在线标志或执行配置 |
| `catalog_requests` | `request_id, input_json, result_json` | 保存规范化输入和原结果，事务内去重；结果是历史修改回执，不冒充最新目录 |

整个目录首版最多 64 条服务器记录（包括归档）、1024 条修改回执。达到上限拒绝新修改但继续允许读取和原请求重放，不自动删除记录。上限是本产品保守边界，不是 Cloudflare 配额或费用承诺；扩容/审计归档需要另行设计。

名称 NFC 规范化并去首尾空白，1–64 个 Unicode 字符、最多 256 UTF-8 字节，拒绝控制/格式字符；不执行或链接名称里的内容。requestId 使用 UUID，revision 是非负安全整数。错误只返回固定分类，不回显秘密、SQL 或原始请求。

接口复用现有 Access / 同源 / CSRF 保护：

| 接口 | 输入/输出 | 权限与行为 |
| --- | --- | --- |
| `GET /api/admin/servers` | `{mode:'server-catalog-only', executionReady:false, revision, servers}` | 已验证管理员读取自己的目录；不列其他 owner；无线上状态推断 |
| `POST /api/admin/servers` | `create: {id, revision, action:'create', name}` | id 是请求 ID，服务器 ID 由 DO 生成；要求同源 JSON + 同会话 CSRF |
| 同上 | `rename: {id, revision, action:'rename', serverId, name}` | 只能改本目录草稿记录，不修改节点配置 |
| 同上 | `archive: {id, revision, action:'archive', serverId}` | 只能归档草稿；不卸载、不停止服务、不删除任何数据 |

所有输入严格限定字段。先检查已有请求：相同 ID/完整规范化输入返回原回执，不再增加 revision；不同输入拒绝。新请求再比较当前 revision，在同一事务更新服务器、revision 与回执。并发旧 revision 只能有一个成功。归档不可逆恢复暂不提供，不能靠重新使用旧 ID 复活记录。

启用独立 `ENABLE_CATALOG=no` 默认开关；关闭时 UI 不展示可操作目录，API 拒绝。管理员登录模式和 fixture 模式保持原行为。只增加目录功能，不将“创建服务器条目”标成“服务器已接入”。

### 3.2 服务目录（C04-S02）

服务记录使用 `id, server_id, name, state, created_at, updated_at`，引用本 owner 目录里的有效服务器；真实产品/组件/制品绑定由 D06/D07 解析，不在目录里存可执行 shell 或伪造 ready。增加服务表后，归档服务器必须先检查仍有关联的有效服务/加入流程；不能级联删除。

C04-S02 的源码实现见 [服务目录](service-catalog.md)：服务仍仅 `draft/archived`，服务器引用创建后不变；共用目录 revision/1024 条回执，最多 256 条服务（含归档）。v1 完整校验后事务扩展为 schema v2，保留旧行/原回执；旧实现遇到 v2 拒绝该功能，不降 schema 或清表。加入流程尚不存在，未来 N02 的中间态必须另经版本化迁移，当前严格 `draft` 检查不提前允许未知状态。

C04-S01 只实现服务器目录与 UI，C04-S02 再实现服务目录和引用约束。父任务 C04 在两者都通过前保持部分实现；N01 的服务器前置改为 C04-S01，不必等待尚不需要的服务字段。

## 4. 加入与撤销：跨 DO 用可恢复步骤，不假装分布式事务

这些步骤属于 N01–N05，C04-S01 不提前开放其状态或接口。

1. 目录以 compare-and-set 将草稿转为 `enrolling`，记录唯一 enrollment ID；进入后不能走普通草稿归档。随后初始化对应节点 DO，绑定不可变 owner/server ID。
2. 节点 DO 记录加入挑战摘要、期限及消费状态。节点本地生成并保存 `execute/observe` 两套高熵凭据，只提交摘要供校验；持久存储不保存明文 secret。具体 token 编码在 N03 固定，不能从 ID/密码派生低熵令牌。
3. 同一加入请求、同一凭据摘要可幂等取得原结果；响应丢失不得重新生成秘密或凭据身份。冲突停下核对。节点 DO 激活提交后，目录才标记 active。
4. 最后一步目录写失败时显示“待核对”，重试只能核对同 enrollment ID。目录不是节点权限真相，不能因为目录显示 active 就绕过节点 DO 鉴权。
5. 撤销先在节点 DO 的事务中禁止新领取并废止凭据，再更新目录显示。第二步失败也不能恢复权限。已领取操作不承诺可撤回；保留精确任务，走 D18 的核对流程。
6. 被撤销令牌不能凭旧缓存继续提交任务回执；遗留结果由获授权的恢复流程处理。不得以清空 DO/journal 来解除 unknown。

加入前置目录变更可能中断；因此需要显式中间态及只读 reconciliation。不得通过定时删除“过期服务器”来补偿失败。C04 v1 的 SQLite 状态约束须在 N02 通过版本化迁移后才能扩展，不允许旧代码解释未知状态为 draft。

## 5. 任务、指标与撤销时序

新节点 DO 将角色鉴权、凭据 epoch、active/revoked 校验、任务领取及 claimed 持久化放在同一同步事务。跨 DO 的目录检查只能提供辅助数据，不能取代这一步。任务计划绑定 server/service/environment、actor、配置/制品摘要和协议版本；同节点只允许一个未完成有副作用任务。

M06 实施将原“节点 DO 先记录接收序号再转发”调整为：节点 DO 在最终同步事务验证当前 joined 的 observe 凭据、enrollment 和功能开关，仅返回内部限定 owner/node/enrollment 的授权上下文；其事务和并发 block 完全结束后，Worker 才调用独立指标 DO。接收代次/序号、限频、latest 和原回执由指标 DO 同事务保存，避免给任务 DO 增加观测水位和跨对象中间态。`receivedAt` 是指标首次成功持久接收时间，不是节点鉴权时间；写前失败尚未接收，写后丢 ack 的精确重送返回原时间。设计与验收见 [M06](node-telemetry.md)。

内部上下文不是签名 capability；和目录 RPC 一样信任 Worker/DO 的服务端调用边界，公网不得绕过节点鉴权。当前 generation 是指标会话 CAS，不是尚未实现的凭据 epoch。未来撤销之后的新验证失败；**撤销之前已获准的在途样本可能晚到**，不得声称跨 DO 即时原子撤回。指标写入丢失可以形成缺测，不能阻塞执行或重新派发任务。

心跳分别显示执行角色与采集角色的 `receivedAt`，在线判定使用云端接收时间与阈值，不信任客户端的未来时间。样本保留 `sampledAt, receivedAt, bootId, sequence`，节点重启与乱序样本不能倒写最新值；CPU/内存/磁盘/网络的未知值与 0 分开。

M06 先只存有界最新快照，单包最多 8 KiB、上报间隔不短于 30 秒；M08 再增加 5 分钟聚合、最多 7 天/2016 个时间桶。缺测保留空洞，不插值成健康。以上为初始产品上限，需在对应实现的测试和容量核查中确认，不是已上线留存策略。

M02-S02 在同一对象/两张表内做保留式扩展：meta schema1 只允许旧 CPU-only latest，schema2 允许旧/新版 union。首次成功记录显式 `sampleVersion: 2` 的 CPU+memory 样本时，meta1→2 与 state 写入同一同步事务；read/start/deferred/失败不提前升级，schema2 接收旧客户端也不降级。schema1 配新版 latest 视为损坏并拒绝，不自动修复。旧 reader 遇 schema2 失败关闭且保留数据，切回新版可重新读取；不是可用性无损的旧代码回退，也没有 schema 降级/清表。名称、binding、Wrangler 类迁移和任务/心跳库不变，验证见 [指标协议](node-telemetry.md)。

日志不混入指标 JSON 或任务回执。M10 首先提供授权服务的限量尾部读取，不做全盘日志采集；R2 是否归档由实际留存需求决定。无界离线缓冲、全量环境变量、完整 Core 响应、私钥和凭据均不得上传。

## 6. 迁移、回退、备份与验证

- Wrangler 只追加新类迁移；旧 TargetMailbox binding/类/SQLite 行保持原样。关闭新功能不能删除新目录，重新启用后仍须可读。
- 每个新类都有 schema_version；读到高版本或缺失关键字段就拒绝，而非覆盖为默认空数据。升级在事务中执行并验证行数/所有权；跨对象迁移没有原子承诺。
- 回退版本前先停止新写入并核对在途任务；旧版本不认识新 schema 时只能拒绝该功能，不能抹掉记录恢复“可用”。
- 不把运行中的 SQLite 文件复制或 Worker `/tmp` 当备份。V06 负责逻辑导出/恢复、schema/owner/数量/摘要核对和真实恢复演练；没有演练前不宣称已备份安全。
- 本轮不执行任何删除、归档云对象、购买资源或真实迁移。源码迁移定义的本地 workerd 测试不等于账户上线。

C04-S01 的验收矩阵：未登录/错误角色拒绝；owner 隔离；创建/改名/归档及重启持久化；同请求重放；同 ID 冲突；旧 revision 并发冲突；额外字段/超长名称/假 ID 拒绝；上限不清数据；默认关闭；页面反复刷新不重复创建；创建目录不触发 fixture/部署请求；桌面与窄屏可操作。

ARC-02 完成后立即提交推送，再以 C04-S01 开始真实 workerd/SQLite/API/UI 的最小目录切片，不再新增一轮总体架构规划。
