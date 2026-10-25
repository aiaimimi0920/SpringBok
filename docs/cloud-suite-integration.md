# 混合云套件接入

## 已授权目标与边界

将 EasyProxy 云端整体接入 SBA：Aggregator 定时刷新、MiSub Pages/Functions、ECH Worker
以及 D1/R2 属于同一云套件；本地 EasyProxy 是消费者，不在此云部署任务内。
保留现有 Pages 架构，不隐式接管、覆盖或删除当前生产资源。

## SUITE-01：声明与归属

扩展 deployment v2，新增显式 target `cloudflare-suite`，旧 `cloudflare-workers` 不变。
套件允许 `pages` 与 `github-actions` 目标。Pages 项目与 Worker 同样是应用发布目标，
由应用执行真实创建和发布；平台仍只自动准备 D1/KV/R2。GitHub 目标为
`.github/workflows/name.yml@instance`，账号为 null；声明通过 github 对象的
repositoryPath 与 secret 引用原有来源连接。配置仓库必须等于批准的应用仓库，不能向应用
交付平台执行器 token。目标只允许批准的实例环境，不支持任意路径、URL 或跨仓库写入。

GitHub 目标使用独立的 `github:owner/repo` 锁域，仓库名规范为小写；同仓库不同 Cloudflare
账号也不能绕过工作流占用。所有锁必须在任何资源创建或许可发放前取得；部分占用失败仍
保留原有未确认现场，不自动重放。Workers 历史锁域和任务记录不迁移。

预升级清单明确区分 Pages、GitHub 工作流环境与线上实例；应用必须隔离数据、副作用和
定时刷新。destroy-preview 只处理回执批准的清单。通用的现有服务导入及破坏性服务删除
尚不支持套件，必须在任何 provider 写入前明确拒绝，不能静默忽略 Pages/Actions。

本切片已通过旧基线反例、新合同、真实 workerd 和真实浏览器的合成 provider 验证；
不是生产 Pages/Actions 发布。平台执行器须固定支持新预升级清单的版本，旧 pin 不能
视为已兼容；旧控制面对显式 suite 声明会失败关闭，不迁移或重解释旧任务。

## SUITE-02 与应用实现

业务密码、ECH token、R2 S3 凭据不是公开配置，也不能假装成管理员初始化密码。
应用秘密使用独立的、按 owner/仓库/应用绑定的 AES-GCM 保险库及不可变任务快照；只有
一次性许可可取得声明的集合。verify 保持不授予写凭据。SUITE-02 已完成本地合同及浏览器验证，
不能以本地合成测试代替部署后的接入或业务验收。

EasyProxy 的 .sba 必须实现 deploy/update/verify/preview/destroy-preview；更新先保留
加密备份，再做 expand-only 迁移并读回原数据；预升级使用数据副本和独立资源，默认禁用
定时刷新及外部副作用。Actions 的周期刷新必须从实例批准 SHA 取代码，不以默认分支漂移
代替版本升级。现有生产迁移/导入和控制面上线独立验收，不包含在本地合成测试中。

## 联网依据（2026-10-25）

- Cloudflare 官方 OpenAPI：`https://github.com/cloudflare/api-schemas/blob/main/openapi.yaml`。
- GitHub 官方 schedule 说明：`https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule`。

已实时读取官方来源；后续实现时针对使用的 API 字段和权限继续核对。公开规范不能替代真实
账号权限及服务部署验收；原始规范快照仅留在 linshi，不提交私密运行材料。
