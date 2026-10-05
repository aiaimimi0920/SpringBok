# C04-S01：持久服务器目录

任务日期：2026-10-04；负责人：主 AI。设计依据为 [ARC-02](storage-architecture.md)，进度与交付状态见 [总计划](development-plan.md)。

## 已实现的最小链路

已验证的 Access 管理员 → 同源目录 API → 该 owner 的 `OwnerCatalog` SQLite Durable Object → 管理页显示持久目录。

目录支持创建、改名、归档和刷新；显示服务端生成的稳定 UUID。`draft` 显示“尚未接入服务器”，`archived` 只表示目录归档，不卸载服务、不停止服务器、不删除业务数据。当前不提供取消归档。

目录不接收地址、凭据、owner、执行命令或客户端生成的服务器 ID，不触发旧 fixture/节点任务。服务目录、关联约束属于 C04-S02，节点接入属于 N01–N03；本项没有将父任务 C04 或真实环境 V01/V02 标为完成。

## 数据、权限和故障边界

- `GET /api/admin/servers` 只读取当前 Access issuer/sub 派生 owner 的目录。返回 `mode='server-catalog-only'`、`executionReady=false`、revision 和服务器记录。
- `POST /api/admin/servers` 严格使用 [ARC-02 第 3 节](storage-architecture.md#3-c04-的最小持久结构) 的 create/rename/archive 字段，复用真实 Access 验签、同源 JSON 和同会话 CSRF。
- 目录、revision、规范化请求和原回执同事务提交。同 ID 同输入返回原回执，同 ID 不同输入拒绝；新请求必须匹配当前 revision。历史回执不是最新状态，页面成功后再次 GET 目录。
- 每个 owner 最多 64 条服务器记录（归档也计数）、1024 条修改回执；超限拒绝新写入，允许读取和原请求重放，不自动清理历史。
- 首次建表与 owner 绑定同事务完成。已有目录的未知 schema 版本、缺表、缺关键字段或缺 metadata 均拒绝，不自动补空表、重置 revision 或“修复”为全新目录。
- 默认 `ENABLE_ADMIN=no`、`ENABLE_CATALOG=no`；关闭目录不会删除持久数据。新增 `REGISTRY/OwnerCatalog` 与 `v2-catalog` 迁移声明，保留原 `TARGET/TargetMailbox` 与 `v1`。
- 页面使用文本节点显示名称，无本地凭据存储；重复点击不会并发发起目录写入。写入响应丢失时禁用修改、展示请求 ID，要求刷新核对，不自动换 ID 重试。身份刷新/离页时清空目录并忽略旧响应。

配置声明不等于线上 migration 已执行。本轮没有创建 Cloudflare 资源、启用真实账户或连接用户服务器，`cpu_ms`、实际账户配额与线上 Access 验收仍由 V01 验证。

## 可复跑的验证

在一次性副本中安装 lockfile 指定的依赖，`TEMP/TMP/TMPDIR` 指向测试目录，禁止在真实持久数据目录运行故障注入测试。Windows 按 RTK 规则加命令前缀。

```text
npm ci --ignore-scripts --no-audit --no-fund --prefix cloud
npm ci --ignore-scripts --no-audit --no-fund --prefix tests/cloud
npm ci --ignore-scripts --no-audit --no-fund --prefix tests/browser
node --test tests/catalog.test.mjs tests/cloud-admin-boundary.test.mjs tests/cloud/catalog.test.mjs tests/cloud/admin.test.mjs
node tests/browser/server-catalog.mjs
```

Linux 另运行：

```text
node --test tests/*.test.mjs scripts/ci/security-baseline.test.mjs
npm test --prefix tests/cloud
node tests/browser/cloud-admin.mjs
```

`tests/browser/cloud-admin.mjs` 在原固定链回归完成后执行新目录回归，因此现有 Demo Browser workflow 会继续覆盖两条链。测试使用合成 JWT、真实本地 workerd/SQLite、隔离 Chrome；旧固定执行链使用模拟 Komodo transport，不能宣称真实业务部署。

本次结果：Windows Node.js 22.22.2 聚焦 11/11；Linux Node.js 24.18.1 契约 172/172、Worker 15/15，均无跳过；两个浏览器场景通过，桌面 1280px 与窄屏 390px 截图已检查。Linux 使用已有 Playwright 容器镜像 `sha256:fee853fafa59550d162cef52bca02d907694b44ebf6ef9fb075bcc0c65d8dedb`，不改变仓库的 Node.js 22 CI 配置或锁定依赖。

故障注入只存在于 `tests/cloud/catalog-storage-fixture.mjs`，不被生产 Worker 导入；通过测试 Worker 在 workerd 内 await RPC，再把 JSON 返回 Node，避免把 Miniflare 的远程代理对象误当结果或错误证明。

本机日志和截图：`C:/Users/Public/nas_home/AI/GameEditor/linshi/springbok-storage-20261004/` 下的 `catalog-tests.log`、`catalog-browser.log`、`linux-unit.log`、`linux-cloud.log`、`linux-browser.log` 和 `snapshot/test-results/`。这些不是运行依赖，CI 将重新生成当前 head 的证据。真实部署、备份恢复、跨服务器隔离仍未验收。
