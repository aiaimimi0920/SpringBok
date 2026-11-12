# 部署连接、资源与运行边界

本页保留当前控制面配置与恢复约束；DC-01–DC-05 的历史规划和发布过程通过 Git/PR
追溯。应用声明以 [共享部署参考](../ai-docs/deployment.md) 为准，不在此维护旧版字段表。

## 使用与权限

SpringBok 聚焦部署：添加连接 → 选择应用固定版本 → 配置目标和资源 → 审阅确认 →
受控执行器运行应用 SBA → 查看认证回执。监控面板不是部署前置，应用迁移由应用负责。

- GitHub/Cloudflare 连接属于当前 owner；只读验证成功不代表部署写权限已验证。
- 连接容量、字段和 CAS 以 `cloud/connections-store.mjs` 为准。连接 revision 变化使
  绑定旧版本的计划失效；重新验证失败不继续展示旧成功状态。
- 停用连接仅改变平台可用状态，不撤销供应商 token、不删除远端资源，也不是撤回已批准任务。
- 浏览器不持久化凭据，输入提交后清空；API/日志不得回显明文、密文或 token 片段。
- 资源登记、只读发现与实际资源创建是不同操作。Worker 是运行目标，D1/KV/R2 是应用
  资源；混合套件、创建/绑定和生命周期条件见共享参考，不能套用首版“仅已有资源”限制。

## 连接保险库

`ENABLE_CONNECTIONS=yes`、绑定及合法 `CONNECTIONS_ENCRYPTION_KEY` 是启用前提。
该 secret 为 32 字节随机密钥的 64 位十六进制表示，保存在服务端；
`cloud/connections-crypto.mjs` 使用 AES-GCM、随机 IV，以及 owner/连接/provider/target
绑定的 AAD。数据库保存密文和公开元数据，不把 key 或凭据写入仓库、页面导出和日志。

没有可直接替换 key 的无损轮换流程。错误 key 无法解密旧密文，不能通过清库、重建连接
或静默覆盖密文伪装恢复；发布和恢复必须保留原 key，轮换另行设计并验收。

## 发布、兼容与恢复

- 固定 policy 的旧任务链与 connected 链独立存在；新连接设置不自动迁移旧任务、
  NAccount 配置或环境密钥，不覆盖历史 policy、执行器 pins 和一次性许可。
- 发布须读取实际线上配置并保留 vars、secret bindings、DO namespaces、迁移、域名、
  调度及固定执行器身份。不要把仓库默认模板整体覆盖线上动态配置。
- 回退须先检查代码与持久 schema 兼容，必要时关闭功能入口；保留数据、任务和 UNKNOWN，
  不删除 DO/迁移或重放任务来解锁。配置备份不等于业务数据备份或完整恢复演练。
- 是否已发布、真实账号登录及应用业务验收分别核对。本页不是生产执行或凭据开通授权。

相关实现：`cloud/connections-api.mjs`、`cloud/connections-store.mjs`、
`cloud/deployment-api.mjs`、`cloud/connected-api.mjs`。
操作验收参考 [连接手测](deployment-connections-testing.md)；管理鉴权见
[私有管理](private-cloud-management.md)，现行进度见 [开发接续](development-plan.md)。
