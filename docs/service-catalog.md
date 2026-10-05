# C04-S02：持久服务目录与服务器引用

任务日期：2026-10-04；负责人：主 AI；基线 `2116c9f`。设计依据为 [存储设计](storage-architecture.md)，进度和交付状态见 [总计划](development-plan.md)。

## 最小可见链路

已验证的 Access 管理员 → 同源服务目录 API → 同 owner 的 `OwnerCatalog` SQLite DO → 页面选择服务器稳定 ID、登记/改名/归档服务。

服务记录只有 `id, serverId, name, state, createdAt, updatedAt`，ID 由服务端生成，状态仅 `draft/archived`。`draft` 表示“仅登记，尚未部署”；名称不是产品绑定或执行寻址，不接受地址、凭据、镜像、命令、owner、在线状态或 ready 标志。没有将旧 gateway/forum/game/account fixture 改名或映射为真实产品。

创建只能引用本 owner 目录中的 `draft` 服务器；服务的服务器引用创建后不可改。改名/归档只操作未归档服务。有关联的 `draft` 服务时拒绝服务器归档；服务全部归档后允许归档服务器，保留服务器、服务和回执，不级联删除。归档不触发停止、卸载、部署或业务数据操作，暂不提供取消归档。

## API 与事务边界

| 接口 | 输入/输出 | 行为 |
| --- | --- | --- |
| `GET /api/admin/services` | `{mode:'service-catalog-only', executionReady:false, revision, services}` | 仅当前认证 owner 的服务元数据，无线上状态或执行就绪推断 |
| `POST /api/admin/services` 创建 | `{id, revision, action:'create', serverId, name}` | 请求 id 为 UUID；服务 id 由 DO 生成；同事务检查服务器引用 |
| 同上改名 | `{id, revision, action:'rename', serviceId, name}` | 不接受 serverId，不能将服务迁到其他服务器 |
| 同上归档 | `{id, revision, action:'archive', serviceId}` | 只修改目录状态，保留历史 |

所有输入严格限定字段；名称、请求 ID、同源 JSON、Access 和同会话 CSRF 校验复用服务器目录。RPC 再校验持久 owner。认证失败为固定 403、关闭为 503、目录拒绝/陈旧/持久结果不确定为固定 409，不返回 SQL 或原始请求。

服务器和服务共用一个 revision、一个最多 1024 条的修改回执表。同请求同完整规范输入返回原回执，不增加 revision；跨资源复用同请求 ID 拒绝。服务输入在内部存储加固定 `resource:'service'` 域，旧服务器规范输入及原回执不重写。新修改要求当前 revision；引用检查、状态修改、revision 与回执在同一同步事务中提交，服务创建和服务器归档不能并发产生孤立关联。

每 owner 最多 64 条服务器、256 条服务（归档也计数）。服务上限是首版保守产品边界，不是 Cloudflare 配额声明；达到记录或共享回执上限后拒绝新修改，仍可读和重放有效旧回执，不清理历史来释放容量。

## v1 → v2 扩展与回退

目录 DO 名称继续为 `catalog/v1/<ownerId>`；路径版本不是 SQLite schema 版本。不创建新 DO 类、binding 或 Wrangler migration tag，既有 `TargetMailbox/v1` 与 `OwnerCatalog/v2-catalog` 声明保持原样。没有线上 migration 已执行的声明。

首次读或写完整 v1 目录时，在外层同步事务中验证 owner、表/列、服务器记录、revision/回执数量，以及所有历史回执的规范输入、结果结构和连续唯一 revision，然后增加服务表并将 schema_version 更新为 2。不改变服务器数据、原回执或 revision。验证/DDL 失败回滚整个事务；v1 数据损坏、v2 缺表/列、服务引用/名称/时间无效或未知版本均拒绝，不补空表或重置数据。

所有重放另校验命中回执的请求 ID、revision、资源类型和记录结构，避免把合法但不合契约的 JSON 当成功结果返回。v2 普通读取/新写入不扫描全部历史回执；不能据此声称任意历史回执损坏都会立即禁止整个目录的新写入。

精确旧实现遇到 schema v2 会失败关闭，不能绕过新增服务约束归档服务器。回退前关闭目录写入并核对操作；允许旧版本拒绝目录功能，不降 schema、不删除服务表。真正备份/恢复、线上切换和配额验收仍属于 V01/V06/V07。

## 页面和验证入口

页面继续使用既有登录、刷新与 generation 生命周期。服务器/服务两次 GET 必须取得相同 revision 才展示可修改目录；不同版本失败关闭并提示刷新，不把跨请求读取伪装成原子快照。所有目录修改共用 busy 锁；服务器归档按钮显示关联阻断。响应丢失、陈旧写入或读取失败后清空可写快照，展示请求 ID 并要求核对，不换 ID 自动重投。身份刷新/离页忽略旧响应，名称使用文本节点，不存浏览器凭据。

在 `linshi` 的一次性 LF 副本中，以锁定依赖安装、隔离 TEMP/TMP/TMPDIR 和本地 workerd 运行：

```text
node --test tests/catalog.test.mjs tests/cloud-admin-boundary.test.mjs
node --test tests/cloud/catalog.test.mjs tests/cloud/services.test.mjs
npm test --prefix tests/cloud
node tests/browser/cloud-admin.mjs
```

最后一项依次覆盖旧管理页、服务器目录和服务目录。测试是合成 Access JWT + 真实本地 workerd/SQLite/浏览器，不是线上登录、用户服务器或业务部署。旧实现冻结在测试专用 `tests/cloud/catalog-v1-fixture.mjs`，生产 Worker 不导入；故障注入仅操作测试临时库。

本轮证据目录：`C:/Users/Public/nas_home/AI/GameEditor/linshi/springbok-service-catalog-20261004/`。具体通过数、精确提交、PR 和 main 结果在总计划/最终回执记录；未完成 CI 不预报成功。独立审查发现的 v1 回执校验缺口已修补，并加入迁移故障回归；最终运行结果以实际日志为准。
