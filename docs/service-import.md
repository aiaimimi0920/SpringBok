# SV-03 服务导入

负责人：主 AI；基线 `3181bdff1ab4e935f1809e12079d0cd175739580`。用户已授权开发，
并明确要求登记现有 NAccount。SV-04 的自动新建和多账户声明另行实施，不将本项
只读导入表述成已经支持自动创建资源。

## 用户路径

服务页右上角分别为“部署服务”和“导入服务”。复用同一服务目录、不可变声明版本
读取与稳定弹窗。导入选择服务、声明版本、账户和现有 Worker；D1/KV/R2 由实际
绑定读取，在预览中只读显示。确认仅登记，不 dispatch、不创建资源、不执行迁移、
不修改应用代码/域名/配置、不读取业务数据或秘密值。

当前兼容 v1 `cloudflare-workers` 声明，从 `targets` 的 Worker 路径取得组件。
单账户内绑定必须真实可读，缺失必需资源类型、部分权限或读取不确定时拒绝登记。
固定 SHA 是所用声明的来源，不是实际部署版本。没有可信部署证明时显示“版本未知”，
`canUpdate=false`；不能把 GitHub 最新声明版本冒充线上版本或开启版本更新。

## API 与持久边界

- 普通用户：`POST /api/admin/deployments/import-preview`、`import-submit`。
  复用 Access owner、Origin/CSRF 和 ConnectionVault 的有效连接/密钥隔离。
- 预览不写实例或占用；2 分钟确认签名绑定输入、可信读取摘要和到期时间。
  提交重新读取固定声明及供应商元数据，摘要变化必须重新预览，不接受客户端改写。
- 只请求 Cloudflare 官方 API：Worker settings、Worker domains、D1 元数据、
  KV namespace 分页、R2 bucket 元数据。采用有界 JSON/超时/禁止重定向；不请求
  应用返回的 URL，不读取 KV values、D1 rows、R2 objects、secret values。
- 实例 ID 绑定 owner、账户与排序后的 Worker 集合。独立 `service_imports` 表与
  version 1 标记保留导入快照；同 ID 重试返回原记录，不隐式刷新或覆盖原来源。
- 账户 DO 原子登记资源占用，再保存 owner 索引。中断后保留占用，由同一身份重试
  补全；不因存储超时释放不确定占用。跨 owner/服务的资源争用拒绝，导入不占执行 lane。
- 导入键同时登记到旧 `deployment_keys`，使旧控制面回退后仍拒绝抢占。原连接密文、
  资源、部署索引、任务和回执均不重写；不增加 DO 绑定或破坏性迁移。回退隐藏新实例，
  不删除记录；恢复新控制面可继续读取。没有自动清理和解锁接口。

## 原固定 NAccount 的有界导入

专用 `POST /api/admin/sba/import-preview` / `import-submit` 只接受原 task ID 与
声明 SHA，账户/目标/资源从已消费 permit 且有结果的原任务取得。再次核对实际
Worker/资源和原配置，保存 `legacy-task` 来源，原 `unknown`/错误/历史保持原样。

机器身份仍不能访问普通管理 API 或静态页面。除原有有效授权外，需临时非秘密变量
`SBA_IMPORT_APPROVAL`，精确包含 `taskId`、`definitionSha`、`jobDigest`、`issuedAt`、
`expiresAt`。摘要覆盖原 request/status/runId/result，时限最多 15 分钟且不超过
原机器授权期限；过期、缺失、变更均拒绝。不能通过该入口自选 owner/账户/资源/密钥。
完成后撤下该临时批准，保留原 Access 配置和授权期限。它不是重新部署授权。

## 证据与未验证项

`tests/cloud/service-import.test.mjs` 覆盖只读、缺权限、版本未知、CSRF/owner/签名、
摘要漂移、幂等/重启、锁后中断、资源冲突，以及有界机器批准和原 unknown 保留。
`tests/browser/service-import.mjs` 覆盖预览/确认、只读绑定、失败、Escape/恢复焦点、
窄屏、持久回读、重复导入及回到原部署模式。复跑原服务发现/更新与四页 Neuro 回归。
合成 Access/供应商不冒称线上用户 UI 验收。精确 head/main、安全检查、保配置发布和
实际 NAccount 导入回执分别写入 `linshi/springbok-sv-03-20261007/`，以最终回执为准。

已联网核对 Cloudflare 官方 TypeScript SDK：Workers domains 为 SinglePage，支持
service/environment 过滤；R2 bucket get 使用 `cf-r2-jurisdiction`。读取的官方源码
保存为上述证据目录的 `cf-domains.ts`、`cf-buckets.ts`，不将其当作真实服务运行证据。
