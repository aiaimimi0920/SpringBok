# 控制面存储与数据保留

本页说明当前职责，不再保留 ARC-02 的未来实现顺序。绑定与类迁移以
`cloud/wrangler.jsonc` 为准；范围见[总计划](development-plan.md)，执行隔离见
[执行架构](execution-architecture.md)。默认开关不是线上启用证明。

## 权威存储

| binding / SQLite DO | 职责 |
| --- | --- |
| `CONNECTIONS` / `ConnectionVault` | owner 的连接与秘密保险库、资源登记、准备记录、计划和服务索引 |
| `CONNECTED_TASKS` / `ConnectedDeployment` | connected 不可变任务、执行身份、一次性许可与回执 |
| `DEPLOYMENT_LOCKS` / `DeploymentLocks` | 账户及 GitHub 锁域的资源归属、串行执行 lane |
| `SBA_TASKS` / `SbaDeployment` | 既有固定 policy 任务和受限恢复历史 |
| `REGISTRY` / `OwnerCatalog` | owner 的服务器/服务目录与加入投影 |
| `NODES` / `NodeMailbox` | 节点身份、加入、角色鉴权、控制 probe 与心跳 |
| `TELEMETRY` / `NodeTelemetry` | 独立观测会话、有限 latest 样本及重送回执 |
| `TARGET` / `TargetMailbox` | 固定协议/Komodo fixture 的历史任务链 |

控制面没有 D1/KV/R2 binding；应用部署资源使用它们不等于平台存储已迁移。
KV 不作授权、互斥或批准消费的权威来源；指标 latest 不是趋势历史库。未来引入查询索引、
日志归档或备份时须另定可靠同步、水位和恢复合同，不能假装已经实现。

## 所有权、事务与未知状态

owner 来自经过验证的服务端身份，不由请求体、邮箱展示名或资源名决定。
目录、节点、连接和任务按服务端上下文寻址，ID 是定位信息，不是认证材料。
目录记录不证明节点在线、执行授权或业务已部署；详见[服务目录](service-catalog.md)、
[节点邮箱](node-mailbox.md)、[加入流程](node-enrollment.md)和[凭据](node-credentials.md)。

同一 SQLite DO 内用同步事务保存状态、revision 与幂等回执。跨 DO、GitHub 或云 API
调用不是分布式事务：先记录意图，再执行，最后核对；中断保留中间态、归属和原回执。
部分账户占用、资源创建未知、许可丢失和删除未知不能通过清表或换 task ID 重做。
服务准备、导入、更新和删除的具体步骤集中于[服务生命周期](service-lifecycle.md)。

NodeTelemetry 与任务存储分离：节点鉴权事务结束后 Worker 才转发受限内部上下文；
观测 DO 原子保存代次/序号、限频、latest 和回执。内部上下文不是公网签名凭据。
`receivedAt` 是首次持久接收时间，精确重送返回原时间；鉴权与写样本不是跨 DO 原子操作。
未来凭据撤销也不能承诺撤回先前已获准的在途样本。指标故障不伪造部署失败或触发重放。
版本化样本、schema 扩展、旧客户端及未知值边界统一见[指标协议](node-telemetry.md)。

## 迁移、回退与备份

- Wrangler 类迁移只追加；不能删除旧 binding、类或任务数据以“回退”。
- 未知 schema、缺失关键表/字段、owner 错配或损坏记录拒绝处理，不重建成空库。
- 版本化扩展在本对象事务内保留旧记录；旧 reader 不认识新版本时失败关闭，不降低 schema。
- 关闭功能不删除记录；重新开启仍按原身份与摘要核对。回退前核对在途任务和 reader 兼容性。
- 旧节点本地 journal 保存写前意图与结果，云端状态不替代节点崩溃恢复；不搬运旧 claimed
  为新 queued，不将重送回执当成重新执行业务。
- Worker 临时目录和运行中 SQLite 文件复制不是已经验证的备份方案。平台逻辑导出、恢复
  以及 owner/schema/数量/摘要核对仍需独立恢复演练，不能用 workerd 重启测试代替。

历史 M2/M6/M10 JSON 和 fixture ID 保留原身份；文档去重不删除持久记录，不执行云迁移。
