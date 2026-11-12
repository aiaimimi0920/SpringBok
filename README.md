# SpringBok

SpringBok 是运行在 **Cloudflare Workers** 上的部署控制平台。当前主链是连接 GitHub
与云账号、选择固定应用提交、配置目标与资源、审阅确认，再由固定 GitHub Actions
执行器运行应用 SBA 并收取认证回执。控制面持久任务使用 SQLite Durable Object。

应用负责构建、备份、迁移、发布和业务验证；平台负责认证、计划、互斥、一次性许可和
结果核对。已有同实例更新、独立验证、隔离预升级、显式修复与受控清理；支持条件以共享
参考为准，代码实现、线上启用与实际业务验收不能相互替代。

## 文档入口

- **应用和 AI 接入**：[SBA 接入入口](ai-docs/README.md)。manifest v3 与 deployment v2
  的文件、字段、生命周期和示例以此共享源维护，不在内部设计文档另抄字段表。
- **人类开发者**：[在线文档](https://aiaimimi0920.github.io/SpringBok/) ·
  [站点源码与本地预览](pages/README.md)。Pages 渲染同一参考源。
- **平台开发与接续**：[当前范围与开发计划](docs/development-plan.md)、
  [执行架构](docs/execution-architecture.md)、[服务生命周期](docs/service-lifecycle.md)。
- **连接和启用**：[连接与资源](docs/deployment-connections-plan.md)、
  [管理鉴权](docs/private-cloud-management.md)。文档不是生产执行授权。
- **贡献与安全**：[AGENTS.md](AGENTS.md)、[安全质量基线](docs/security-quality-baseline.md)、
  [安全政策](SECURITY.md)。提交前审查 AI/Pages 两个入口的实际影响。

## 本地验证

需要 Node.js 22+；具体环境和平台限制见开发计划及对应测试。文档检查：

```sh
node --test pages/docs.test.mjs scripts/ci/security-baseline.test.mjs
node pages/check-example.mjs
node pages/build.mjs <新的空输出目录>
```

源码检查、workerd 和浏览器回归按影响范围选取开发计划中的命令；不要把示例或测试中的
云操作当作授权，不自动运行带 Docker 管理权限的历史集成。

## 独立节点路线与历史证据

外部服务器的目录、加入、分角色凭据、控制客户端、心跳与有限指标仍独立维护，入口见
[节点安装](docs/node-installation.md)和[节点指标](docs/node-telemetry.md)。这不是 SBA 的
前置，不代表任意业务 Agent、多服务器部署或完整监控产品已经完成。

历史 M1–M14 离线/Komodo/demo 教程已退出当前文档集合，历史过程从 Git/PR 查询。
现存 fixture、测试及集成 JSON 仍保留；gateway/forum/game/account 是契约身份，不是真实
业务部署配置。历史 Komodo 路线的生产接入与许可需独立评估；本仓库不 fork 或捆绑 Komodo。
Docker socket 授予对应 daemon 的管理权限，容器名不是权限沙箱；历史临时集成授权不能复用。
旧演示程序仅为回环合成演示，其[锁恢复说明](docs/demo-console.md)不构成产品启动指南。
