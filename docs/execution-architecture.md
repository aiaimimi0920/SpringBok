# 当前执行架构与隔离边界

当前范围以[总计划](development-plan.md)为准。本页替代早期“每台服务器安装
Core/Mongo/Periphery 作为首条产品链”的设计，不再将该方案作为 SBA 部署前置或安装承诺。

## SBA 主链

```text
管理页 → Worker / Access / owner / Origin / CSRF
  → ConnectionVault：连接、资源、秘密与不可变计划
  → DeploymentLocks + ConnectedDeployment：资源占用、任务和一次性许可
  → 固定 GitHub Actions executor → 应用 SBA → 认证回执
```

入口为 `cloud/worker.mjs`、`cloud/deployment-api.mjs`，connected 派发入口为
`cloud/connected-api.mjs`。平台不运行应用迁移，不推断数据库结构；应用执行合同见
[共享生命周期](../ai-docs/lifecycle.md)，控制面操作见[服务生命周期](service-lifecycle.md)。

执行器固定来源、可信传输和身份前置见 [runner](sba-runner.md)、
[GitHub 传输](sba-github.md)、[控制链配置](sba-cloud-control.md)。应用固定 SHA 必须可信且
经过审阅；环境过滤不是恶意代码沙箱。GitHub run 成功不等于业务成功；unknown 不自动重放。

## 独立保留的路线

- `SbaDeployment` 保存固定 policy 的既有任务；不随连接配置自动迁移或清空。
- `OwnerCatalog`、`NodeMailbox` 支持目录、加入、角色控制和心跳；`NodeTelemetry`
  支持独立观测授权和有限 latest 指标。见[加入](node-enrollment.md)、
  [凭据](node-credentials.md)、[通道](node-channel.md)、[指标](node-telemetry.md)。
- `TargetMailbox`、旧 Node 出站桥与 Komodo fixture 仍是固定联调，不是任意远程执行器。
  不放宽旧协议以冒充真实业务接入，不重命名 fixture 身份，不改写历史 JSON 证据。

节点 `execute` 与 `observe` 身份隔离；观测不持有部署凭据，不用容器自己的指标冒充宿主。
Linux 采集受当前 namespace 限制，详见各指标说明。节点本身是受托证据来源，不能承诺抵抗
恶意节点伪造。只读诊断不解除任务阻断，网络恢复只恢复核对，不自动重做未知写操作。

## 持久化与权限

八个 SQLite DO 的职责和兼容边界见[存储架构](storage-architecture.md)及总计划。
Worker 临时文件不作为持久任务真相；跨 DO 或网络写入不是同一 SQLite 事务。
先持久化意图再发外部写，回退不删除新记录、不将旧 claimed/unknown 任务重新排队。

历史集成的 Docker socket 是对应 daemon 的管理权限，容器名或 label 不构成隔离。
Komodo 的生产接入、依赖容量、来源和许可须独立评估，本仓库不捆绑其实现；不因本页授权
安装、开放端口、创建凭据或运行特权测试。真实服务器业务部署和恢复演练的未验边界见总计划。
