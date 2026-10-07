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
| DC-01 | 设置页、Cloudflare/GitHub 连接添加、只读验证、加密保存、重新验证及停用 | PR #68，main f1e6692；52 项本地、PR/main 六工作流通过；尚未启用线上 | 源码已交付 |
| DC-02 | 基于 Cloudflare 连接列举并登记已有 D1/KV/R2 | 权限/账号核验、分页有界、资源归属与刷新状态；不创建云资源 | 已实现，待交付 |
| DC-03 | `.sba` 驱动的应用版本、目标和资源绑定界面 | 不写死 NAccount 表单；固定 SHA、资源引用/revision、可审阅计划 | 已实现，待交付 |
| DC-04 | 将连接和资源引用接入既有一次性执行许可链 | source/permit owner 与配置摘要绑定；停用连接阻止新部署；在途/unknown 不重放 | 已实现，待交付 |
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

后续授权更新：用户要求完成 DC-02 至 DC-05 全流程并发布后再手测。主 AI 继续负责，
逐个 scoped 子任务交付；允许发布 SpringBok 的本功能与必要服务端加密配置，不创建
付费云资源、不重跑现有 NAccount 首次部署、不改其数据或旧 unknown 历史。

### DC-02 领取

基线 f1e6692，分支 `feat/dc-02-cloud-resources`，主 AI。
复用 ConnectionVault，只读列举已有 D1/KV/R2，显式分页（每页最多 100）与账号/连接
revision 绑定；只登记最近五分钟列表中的真实 ID，不接受浏览器伪造名称/账号归属。
独立追加本地资源表，不改已有连接密文或部署任务。权限不足/连接停用/过期列表拒绝
登记；不自动创建、删除或修改云资源。资源界面与真实 workerd/browser 回归为停止条件。

DC-01/02 源码子任务不发布、不改线上 secret。DC-05 启用时由独立发布子任务读取当前线上配置，保留已有
SBA policy/secret、五个 DO 和历史 migration，再追加 `CONNECTIONS` / `v6-connections`。
不能直接用仓库默认 launch 配置覆盖线上动态 policy。服务端先安全生成并保存
`CONNECTIONS_ENCRYPTION_KEY`（不得回显），再明确启用 `ENABLE_CONNECTIONS=yes`。
回退首选关闭该开关；保留新 DO、原加密 key 和全部旧绑定，不删除数据、不撤销供应商
密钥、不重放应用部署。新/旧页面重叠时新 API 默认关闭或仅接受严格 v1 连接输入，
旧 SBA 仍读取原 env secrets，DC-04 前没有双写或自动迁移。

## DC-02 验证

61/61 聚焦 Node/workerd 检查通过；Chrome + workerd 的连接设置、资源登记、旧 SBA
三条流程通过。覆盖 owner/CSRF、过期列表、伪造 ID、停用/修订、并发读取代际、
失败读取失效、128 条容量、存储部分缺失、D1/KV 满页和 R2 start_after。
身份失效会清除页面资源并禁用操作；390px 无横向溢出。只读代理审阅的两项中等
问题均已修复并补回归。actionlint 通过（未运行 shellcheck/pyflakes）。
证据目录：`linshi/springbok-dc-02-20261007/`；供应商与 Access 为合成测试，不是线上验收。
官方 API 文档已联网核实：D1/database、KV/namespaces 的 page/per_page 与 R2/buckets
的 start_after/order=name；当前 R2 只支持默认管辖区。后续安全扫描及 PR/main 按 SHA 留档。

## DC-03 领取与契约选择

主 AI；基线 DC-02 PR #69 main `861ce47`；分支 `feat/dc-03-deployment-plans`。
新增独立 `.sba/deployment.json` v1 公开表单声明，不修改 manifest v2。声明和 manifest
都从选择的 GitHub 连接及精确提交 SHA 的正常 Git blob 读取；不接受 symlink/浮动 ref。
仅支持 Cloudflare Workers 目标、公开文本/JSON、账号及已有 D1/KV/R2 字段，禁止任意
表达式/命令/JSONPath。资源 ID、名称、账号由服务端登记记录构造，不信任前端填写。
本子任务交付读取应用、配置与只读审阅，不 dispatch。DC-03-B 在 NAccount 独立仓库
添加声明；DC-04 再接一次性执行。执行器仍是服务端固定可信仓库，应用连接只负责读源码。

DC-03 本地 80/80 聚焦检查通过；声明表单、连接、资源、旧 SBA 共四条 Chrome/workerd
流程通过，含 390px 布局、取消/编辑失效、身份失效清理。公开秘密键审阅发现已修复；
契约见 [部署声明](sba-deployment-declaration.md)。证据 `linshi/springbok-dc-03-20261007/`。
DC-02 主干首轮旧 telemetry-daemon 网络采样返回 unknown 而断言 available，保留失败日志，
仅针对失败 job 复验；不得以本地或 PR 通过覆盖该记录。后续 main 回执另存。

DC-02 main `861ce47` 的 Cloud Node Protocol attempt 2 通过，六工作流最终通过；
首次失败未修改产品代码，尚不能确定网络采样瞬时 unknown 的具体环境原因。

## DC-04 领取

主 AI；基线 DC-03 PR #70 main `0a6957d`，分支 `feat/dc-04-connected-execution`。
独立 ConnectedDeployment 持久每任务 policy/owner/引用，复用旧 SBA begin/permit/settle；
旧 SbaDeployment 默认 policy 和对象名称不变，原 NAccount 任务完全不迁移。
新增账号级串行锁与首次部署资源/环境占用；unknown/失败不释放，成功回执才释放执行
串行锁，既有资源/环境仍禁止作为另一个首次部署复用。保留原固定 policy 资源保护。
先持久连接授权和索引，再 claim/一次 dispatch；任何不确定结果都不得自动重新执行。
停用阻止新的批准；已经批准的在途任务仍可在既有有限许可期限内使用其固定连接，
停用不是撤回在途执行。secret 不进入 DO 任务、浏览器、dispatch 或日志。
machine 仅从任务 ID 找持久 policy，严格 OIDC+run/task/digest 校验，不接受 owner 输入。


DC-03 PR #70 已合并 main `0a6957d`，六工作流通过；PR CodeQL 汇总有主干
JavaScript configuration 比较不可用的 neutral 提示，各语言实际 Analyze 成功，main
实际语言分析亦通过；不称该 PR 差异告警比较已被证明完整。

DC-03-B NAccount PR #5 已推送 `009b3de`，标准 52 项通过，新增 targets 后应用入口
15 项再次通过、跨仓库实际 declaration 校验通过。私有仓库 push/PR hosted jobs 均在
runner 启动前失败（runner_name 空、steps 0）；当前 Token 读取 check-runs 返回 403。
已请求用户确认外部限制，不假定账单原因、不豁免、不合并、不部署该应用。

DC-04 本地 98/98 聚焦检查，执行/声明表单/连接/资源/旧 SBA 五条 Chrome/workerd
流程通过。仅合成供应商，非实际应用发布。审阅发现的目标保护缺口已修复并补回归；
目标声明、最终配置中的已知旧身份与跨环境永久身份占用共同校验。未知准备状态可
从索引读取 preparation-unconfirmed，禁止新任务重试。证据 `linshi/springbok-dc-04-20261007/`。

增量迁移仅新增 `v7-connected-deployments` 的两个 SQLite DO 与 Vault 新表；不改旧
表，不删除数据。混合版本期间旧 Worker 不认识新路由，新 Worker 默认执行开关关闭；
回退优先关闭 ENABLE_CONNECTED_DEPLOYMENTS，保留绑定/migration/加密 key，不回退
为缺少新 DO 的配置。DC-05 发布必须从线上当前变量及 secrets 名称构造配置，不能用
launch 默认值覆盖实际 policy。
