# Cloudflare → 执行节点：协议切片 A

本切片提供可运行的 Worker / SQLite Durable Object 与 Node 出站桥，先验证真正的
运行时、持久记录、一次领取与回报协议。**只接受 protocol-probe，不操作容器**。
observed 表示节点观察了挑战值，不代表任何服务部署成功。没有 deploy、rollback、
promote、人工审批、任意命令、动态模块或 URL 执行入口。B 才接固定 fixture 的部署
证据；该 fixture 验收也不能代替 Gateway/Platform 等业务验收。

## 本地验证与代码入口

- cloud/worker.mjs：固定单节点 pc2-test 的 API，SQLite DO 保存任务
- cloud/protocol.mjs：严格输入与状态转换；最多100条任务，满时拒绝，不自动删审计记录
- src/node-bridge/bridge.mjs：HTTPS 客户端及复用 Linux 原子日志的协议桥
- scripts/node-probe.mjs：显式执行一次轮询/回报；不是常驻服务安装器
- tests/cloud：锁定官方 Miniflare 5.20261001.0-alpha / workerd 1.20261001.1，用真实 SQLite 存储重启测试

`npm ci --ignore-scripts --prefix tests/cloud` 后 `npm test --prefix tests/cloud`。
普通 CI 运行同一套测试，使用临时合成认证值，不连接 Cloudflare 账户或 PC2。
Miniflare 是测试专用依赖，不打包进 Worker；该精确 alpha 版本用于取得已修复的
sharp/undici，Node要求22+，锁文件审计是门禁。未使用有已知高危依赖的旧稳定版。
Miniflare 是本地 Cloudflare 运行时验证，不是已发布 Cloudflare 的实测证据。
普通 Node 回归：`node --test tests/*.test.mjs scripts/ci/security-baseline.test.mjs`。

cloud/wrangler.jsonc 默认 ENABLE_PROTOCOL_TEST=no、workers_dev=false，无账户、域名
或凭据。缺任一认证值或 control/node 值相同也拒绝服务。不存在自动发布 workflow。
部署前仍须核定账户、测试域名/路由、当前计划和接入授权，由操作者单独配置。

## 协议和失效语义

控制侧使用 CONTROL_TOKEN，节点仅使用 NODE_TOKEN，二者独立且要求64位小写hex。
这只是受限测试控制客户端与节点认证，不是生产人类登录或自动人工批准。操作权限
分离：控制端 GET /control/state、POST /control/submit；节点 POST /node/poll、
POST /node/report。节点不能提交任务。token 不写入DO或节点日志，不回显或上传。

提交字段为 id、node、operation、challenge、revision，node固定pc2-test，operation
固定protocol-probe，challenge为64位hex。摘要式挑战值只关联本次协议请求，不是
秘密/镜像/发布批准。revision必须匹配当前记录；同ID必须同完整输入，否则拒绝。
每节点只允许一个未完成任务。请求体最多2KiB；HTTPS、Bearer认证与同源Origin检查
在边界执行，不开放CORS，拒绝cookie请求。无外部API转发和任意目标寻址。

DO先持久化claimed再交付一次。之后轮询只返回状态，**不会重投命令**。领取响应
丢失可能导致任务从未实际观察；它仍阻断新任务，120秒后轮询将其标unknown。
入队120秒未领取则expired。已领取的过期回报不能变成observed。unknown没有本轮
自动解除入口，需要后续有证据的恢复设计，不能通过等待租约到期再做一次。

节点先写started，再观察；结果先持久落盘，再回传。丢回传响应允许重送同一结果，
不重新观察。重启看见只有started的记录，转unknown并回报，不再次观察。两次节点
进程不能共享同一目录锁；崩溃残留锁按现有执行日志规则fail closed，不盲删。
云端DO重启由SQLite恢复，节点进程重启由本地日志恢复，角色各自明确；日志损坏或
写入不确定不报告成功。节点返回observed后，云端仍明确deploymentVerified=false。

单步CLI需显式 SPRINGBOK_ENABLE_PROTOCOL_PROBE=yes、SPRINGBOK_CONTROL_ORIGIN
（精确HTTPS origin）和 SPRINGBOK_NODE_TOKEN，再给一个专用日志目录作为唯一参数。
本切片不提供真实值、批量注册或后台自启动；未来30秒轮询由受审服务管理配置完成。
UI与真实操作者认证、人工验收仍是后续切片，不把控制token伪装成人类身份。

## PC2装配和费用边界

目标节点已有其他运行服务，不能修改或清理它们。采用专用无宿主Docker权限账户
与独立rootless daemon时，需要核实实际账户、daemon和权限隔离结果；原本能访问
宿主daemon的用户不能被宣传为仅限测试容器。
A不安装工具、创建账户、修改网络、连接PC2或发布Cloudflare。

B拟使用专用目录/网络/持久卷，Core+Mongo+Periphery仅在测试daemon内部通信；
Docker/数据库/管理端口不公开，不需要Tunnel或云端访问PC2私网IP。业务公网入口
与控制通道分离。Core/Mongo/Periphery是本地执行依赖，并未由A替代。

旧临时harness硬上限为Mongo1GiB、Core1GiB、Periphery512MiB；拟另给桥128MiB和
一个fixture128MiB，总约2.75GiB。这是拟上限，不是PC2实测占用或容量保证；逐项
测量内存、OOM、CPU和已有负载，余量不足就暂停新增。不可并行启动四套fixture或
在PC2构建大镜像。Mongo改专用磁盘持久卷才可验证重启数据保留，不能沿用临时tmpfs。
不自动全局prune、删除卷或覆盖现有服务；清理也只能针对明确归属的本轮资源。

Workers+SQLite DO可用Free计划；官方说明超免费限额会报错，不自动升级订阅。
实际账户可能已是Paid计划，不能据Free可用性推定零费用；本代码不会改变现有计划。
默认配置限制Worker每请求CPU为10ms；单节点最多100条任务，每次请求体2KiB、
上传截止5秒。Node CLI只走一次；未来常驻服务须限定至少30秒一次轮询（约2880次/日），
不得忙循环。另有UI/提交/回报用量，不保证账户总用量不超限，也不是费用硬上限；
公网未授权请求仍可能产生平台用量，实际发布前另核访问边界和账户预算。
启用付费计划、云资源发布、持久认证配置按明确范围审批，不在本切片内发生。

官方依据（2026-10-02核查）：
- [Workers静态资源](https://developers.cloudflare.com/workers/static-assets/)
- [Workers VFS临时文件边界](https://developers.cloudflare.com/workers/runtime-apis/nodejs/fs/)
- [SQLite DO事务持久存储](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
- [DO计划与限额](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [Containers默认临时磁盘](https://developers.cloudflare.com/containers/concepts/architecture/)

本轮停止条件：本地与CI真实workerd通过、独立审查、精确树合并并复验主干。
之后提供B的固定fixture执行适配与装配差异，再审批实际安装/发布；不将本轮协议
通过表述成“云端已经部署到PC2”或业务服务已经可用。
