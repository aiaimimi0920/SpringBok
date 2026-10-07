# 部署连接、资源与目标选择

日期：2026-10-07。用户已授权先制定计划，再实施软件；负责人：主 AI。

## 产品边界

SpringBok 当前优先是部署平台，而非大而全运维面板。连接与资源管理是部署的前置，
不以监控、终端或文件管理为前置。流程：添加连接 → 选择 GitHub 应用版本 → 选择
运行目标 → 绑定已有资源 → 审阅并确认 → GitHub Actions 执行 `.sba` → 查看回执。
Workers 是运行目标；D1 是数据库，KV/R2 分别是键值/对象存储。应用迁移仍归应用仓库。

已跑通的 NAccount 固定 policy、旧 unknown/许可和历史保持不变；新设置不隐式导入或
覆盖旧环境密钥，不声称添加连接后旧执行链已自动切换。用户已确认浏览器登录成功，
此前本地真实 MFA、管理员授权前 400/授权后 200、refresh token 撤销已验证；这些是
业务证据，不是新云端 verify 回执，也不是升级验收。

## 分步交付

| ID | 范围 | 验收及停止条件 | 状态 |
| --- | --- | --- | --- |
| DC-01 | 设置页、Cloudflare/GitHub 连接添加、只读验证、加密保存、重新验证及停用 | Access/CSRF/owner 隔离；密钥不回显；SQLite 重启保持；真实浏览器合成链；默认关闭；独立 PR | 进行中 |
| DC-02 | 基于 Cloudflare 连接列举并登记已有 D1/KV/R2 | 权限/账号核验、分页有界、资源归属与刷新状态；不创建云资源 | 待开发 |
| DC-03 | `.sba` 驱动的应用版本、目标和资源绑定界面 | 不写死 NAccount 表单；固定 SHA、资源引用/revision、可审阅计划 | 待开发 |
| DC-04 | 将连接和资源引用接入既有一次性执行许可链 | source/permit owner 与配置摘要绑定；停用连接阻止新部署；在途/unknown 不重放 | 待开发 |
| DC-05 | 发布设置与整链真实手测 | 保留现有 Worker secrets/policy/DO；用户自助添加 → 配置 → GitHub Actions → 回执；不重复部署现有 NAccount | 待实施 |

一次只领取一个子任务，验证后 scoped commit/push、精确 head PR 检查和正常合并。
DC-01 不构造资源自动创建、任意 URL 探测、密钥导出、凭据轮换或任意执行器配置。
首次只支持 API Token/PAT；GitHub App 安装、服务器接入复用及密钥轮换另按需求拆项。

## DC-01 设计与领取

基线 `cdcb38e`；分支 `feat/dc-01-connection-settings`；owner 主 AI。
文件范围 `cloud/connections-*.mjs`、管理员路由/Worker binding、独立设置页、匹配测试与本文。
复用已验签 Access 身份及 CSRF；机器服务身份不获得凭据管理权。

- 独立 `ConnectionVault` SQLite Durable Object，按 actor 分区并在对象内绑定 owner。
- Worker secret `CONNECTIONS_ENCRYPTION_KEY` 为 32 字节随机密钥的 64hex；AES-256-GCM
  随机 IV，AAD 绑定 actor/连接 ID/provider/target；数据库仅保存密文和公开元数据。
- 环境显式 `ENABLE_CONNECTIONS=yes` 且 binding/key 齐备才允许操作；密钥缺失失败关闭。
  密钥必须在服务端单独 bootstrap 与保管，不进浏览器/Git。首版不提供替换密钥操作；
  直接改 key 会令旧密文不可读，恢复必须使用原 key，不自动清库或重加密。
- 同一连接修订号 CAS；创建 ID 幂等；最多 32 个连接（含停用）；提交不自动重试。
  验证为有限超时/字节 GET，仅固定官方 host，拒绝重定向；不运行任何部署动作。
- Cloudflare 用指定 account 的 details 读取证明账号访问（需 Account Settings Read）；
  GitHub 用 `/user`、指定仓库 metadata 和 workflows 读取验证 PAT 与仓库读取能力。
  不将只读验证说成部署写权限已获验证；页面明确显示范围和最近验证时间。
- 保存新连接前须通过只读检查；已有连接重新验证失败记录失败/不可用，不展示旧绿灯。
  停用为本地不可用标记，不撤销供应商 token，不删除远端资源或原有部署任务。
- API 列表和错误只包含白名单字段/固定错误码，无明文/密文/token 尾号/上游原始响应。
  输入框提交后立即清空，无 localStorage/sessionStorage；导航与身份失效清理状态。

联网参考（2026-10-07）：
- https://developers.cloudflare.com/api/resources/accounts/methods/get/
- https://docs.github.com/en/rest/actions/workflows#list-repository-workflows
- https://github.com/kejilion/KPanel 和 https://github.com/1panel-dev/1panel/ 仅作产品参考，
  不引入其代码、依赖或整套运维功能。

## 验证与交付记录

DC-01 已实现设置页 `/settings`、两种连接与服务端密文存储；只读验证与部署权限明确
分开。聚焦 Node/真实 workerd 共 41/41 通过，包含原管理鉴权/机器身份/SBA 邻近回归；
Chrome + workerd 合成两供应商流程通过，桌面/390px 截图已检查，无横向溢出。
额外覆盖并发 create、在途 verify 与 disable、32 条容量、缺失 SQLite 表/owner、
错误加密 key、网络头/流超时、重定向拒绝和响应体上限。测试不使用真实云凭据。
后续最终 source 指纹、安全扫描、精确 PR/main 状态另记回执；不能把本地通过当上线。
证据：`linshi/springbok-dc-01-20261007/`。领取时工作区干净；不改 NAccount 仓库。

## 发布与恢复边界

本轮不发布、不改线上 secret。启用时由独立发布子任务读取当前线上配置，保留已有
SBA policy/secret、五个 DO 和历史 migration，再追加 `CONNECTIONS` / `v6-connections`。
不能直接用仓库默认 launch 配置覆盖线上动态 policy。服务端先安全生成并保存
`CONNECTIONS_ENCRYPTION_KEY`（不得回显），再明确启用 `ENABLE_CONNECTIONS=yes`。
回退首选关闭该开关；保留新 DO、原加密 key 和全部旧绑定，不删除数据、不撤销供应商
密钥、不重放应用部署。新/旧页面重叠时新 API 默认关闭或仅接受严格 v1 连接输入，
旧 SBA 仍读取原 env secrets，DC-04 前没有双写或自动迁移。
