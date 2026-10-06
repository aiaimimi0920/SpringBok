# SpringBok → NAccount：Cloudflare 真实部署与更新计划

日期：2026-10-06。规划任务：`SBA-DOC-01`；负责人：主 AI。

本页记录用户已确认的联合项目目标，是当前优先执行路线。总入口为
[开发计划](development-plan.md)，历史服务器与监控路线保留，但不是本路线的全部前置条件。
规划轮只交付文档，不开发功能、不读取实际密钥、不创建云资源或执行部署；后续实施
及实际完成边界见第 9 节，不以规划轮限制覆盖后续明确授权。

## 1. 目标、授权与停止条件

以真实使用结果驱动最小必要开发，依次完成：

1. SpringBok 部署到 Cloudflare，具有受保护、可实际访问的管理入口。
2. 用户通过云端 SpringBok，部署 GitHub 上的 NAccount 到 Cloudflare。
3. GitHub 上出现 NAccount 新版本后，SpringBok 能识别候选版本并执行更新。
4. 更新保留业务数据；需要迁移时，调用 NAccount 提供的迁移实现。
5. 用真实初次部署和一次带既有数据、真实 schema 变化的升级证明链路可用。

用户已明确目标部署及两个仓库必要修复的方向；本轮要求先落地计划。
后续开始实施时按本表逐项推进，不把历史“仅规划、禁止真实部署”的旧备注
当作这条新路线永久禁止部署的依据，也不把本页当作新增付费、扩大权限、
删除数据或覆盖既有无关服务的授权。遇到此类操作先说明并确认。

**最终停止条件：** 首次部署与有数据升级均有真实证据，用户可以在 SpringBok
查看版本、任务进度和结果，NAccount 核心业务可用。达到后交付，不继续自动扩展
监控面板、通用迁移引擎、多供应商适配、全量重构或无关优化。

## 2. 位置与本轮核实的基线

| 项目 | 本地开发仓库 | GitHub 源码仓库 |
| --- | --- | --- |
| SpringBok | `C:/Users/Public/nas_home/SpringBok` | <https://github.com/aiaimimi0920/SpringBok> |
| NAccount | `C:/Users/Public/nas_home/NAccount` | <https://github.com/aiaimimi0920/NAccount> |

凭据检查入口：`C:/Users/Public/nas_home/aikey`。只在实施需要时最小范围读取；
文档、日志、源码、CI 产物和提交不得包含实际凭据。临时证据优先放到
`C:/Users/Public/nas_home/AI/GameEditor/linshi`；敏感备份不能进入公开产物。

本轮读取证据，不代表部署或完整源码审计：

- SpringBok 本地 `main` 与本轮 fetch 后 `origin/main` 同为
  `9a8922bd175da76ddfb234ce56e588a611eed997`，开始时工作区干净。
- NAccount 本地 HEAD 为 `3c6ba3ad5720e224ee2ac8c12fe474a69b6c0751`；
  尚未核对其远端同步、未提交修改及实际云资源。
- SpringBok 总计划列有 Worker、鉴权、SQLite Durable Object 任务能力及历史节点路线；
  这些记录不等于真实 Cloudflare 部署或 NAccount 接入已通过。
- NAccount `.sba/manifest.json` 当前 `schemaVersion=1`，入口为 `deploy.ps1`，
  声明 PowerShell 5.1、Python 3.11、Git、Node.js/npm；有 `plan`、`prepare`、
  `build`、`bootstrap-keys`、`publish`，尚不能视为 SpringBok 已接受的统一标准。
- NAccount `.sba/README.md` 声明 `publish --migrate` 先导出 D1 再迁移；
  `publish` 回执是 `deployed-unverified`，并非业务验收成功。实际实现待后续读代码核实。
- 当前 NAccount 文档要求 server/admin 独立自定义域名、外部准备 D1/KV、邮件配置，
  并明确初始化密钥不能在日常更新时轮换；这些是待核实的实际前置，不可忽略。

## 3. 产品边界：SpringBok 是执行器

**应用仓库声明并实现“怎么做”；SpringBok 按统一契约执行、记录并报告。**

| 责任 | SpringBok | NAccount / 应用开发者 |
| --- | --- | --- |
| `.sba` 标准 | 定义版本化文件语义、参数、动作、结果与兼容规则 | 按标准提供清单、入口及实现 |
| 获取代码 | 从获准 GitHub 仓库解析并固定 SHA，关联任务与产物 | 提交、推送完整可构建源码及锁定依赖 |
| 部署流程 | 校验契约，按显式顺序调用入口 | 实现构建、资源准备、发布、验证及组件次序 |
| 数据迁移 | 调用约定入口，消费结果，失败停止后续步骤 | 判断 schema 版本、选择和执行迁移、维护迁移记录及幂等 |
| 数据保护 | 不擅自删除/重建资源；保留任务与资源关联 | 复用持久资源，实现备份、恢复、兼容检查和非破坏性更新 |
| 失败恢复 | 记录已完成步骤、失败或未知状态；仅按契约处理 | 提供可安全核对/恢复的入口，声明可重试与不可逆风险 |
| 成功判定 | 严格依据退出状态、结果协议及约定验证结果 | 实现业务验证，不以发布成功假冒业务成功 |

SpringBok 不分析业务表结构、不生成 SQL、不设计迁移路径、不硬编码 NAccount
业务、不读取 README/AGENTS 自由文本后“智能决定”生产步骤。开发阶段 AI 可以修复
两个仓库，但不能把临场人工操作伪装成产品已具备的执行能力。

“确定性”指固定源码版本、配置摘要、契约版本和执行输入后，步骤及判定规则明确；
不意味着网络永不失败。外部失败也必须得到明确结果，不能进入无限修复/重试循环。

## 4. GitHub 源码与执行拓扑

```text
本地修复 → 提交/推送 → GitHub 确定 SHA
                              ↓
Cloudflare 上的 SpringBok → 持久任务/授权/部署请求
                              ↓
受控构建发布执行端 → 检出相同 SHA → 读取 .sba → 调用约定入口
                              ↓
Cloudflare 上的 NAccount ← 发布/迁移/验证
                              ↓
SpringBok ← 可信回执、版本、阶段、结果与脱敏日志
```

- NAccount 的实际发布源码必须来自 GitHub，不能上传本地工作区后称为 GitHub 部署。
  若有 submodule、上游基线或补丁，还须固定其版本并记录组装后的构建来源。
- SpringBok 首次上线允许使用受控引导发布，不要求它在尚未运行时部署自己；
  仍要记录提交、配置和部署版本。随后 NAccount 必须由云端 SpringBok 发起和跟踪。
- 执行位置必须显式确定。现有 PowerShell/Python 入口不是可直接塞进 Worker 的能力。
  `SBA-02` 联网核实 Cloudflare 与 GitHub 的当前支持、账户权限和运行限制后，
  优先选择 GitHub 关联构建或受控 GitHub Actions 等可用路径，不在本页虚构已接通。
- 若采用 Actions，云端 SpringBok 负责精确版本授权、触发、任务/run 关联及可信结果回收；
  仅提供 GitHub 链接、由人手动运行 workflow 不算完成。不得直接授信伪造回调或
  仅凭 workflow 名称认定成功；也不得自动执行不受信 PR 代码并注入部署凭据。
- 第一期不依赖开发者本机持续在线，不为历史 Docker/Komodo 路线强装无关节点；
  如现有条件确实需要其他执行端，先记录理由和必要批准再调整路线。
- 本计划不承诺自动购买资源或零成本；当前官方能力、限额和账户状态由实施时联网验证。

## 5. `.sba` 最小统一契约的设计要求

此节是 `SBA-02` 的验收要求，**不是已经发布的 schema**。正式字段、文件名和动作名
应复用实际代码后确定；不得把 NAccount 当前 manifest 直接宣布为跨项目标准。

统一机器入口至少表达：

1. 契约版本、应用标识、应用版本来源、支持的部署目标和运行环境。
2. 可用动作、入口路径、参数与配置结构、是否外部写入及所需 secret 引用。
3. 首次部署与更新的显式步骤、必要前置、超时和失败终止规则；
   SpringBok 不推断迁移必须在发布前还是发布后。
4. 结构化结果协议、退出码约定、任务关联和脱敏日志；
   分清 `deployed-unverified`、验证成功、失败、部分完成和结果未知。
5. 已部署/目标版本、固定 Git SHA、构建产物身份、配置摘要及持久资源引用。
6. 对有副作用步骤的重入/核对声明；应用负责迁移级幂等，平台负责任务级去重与互斥。
7. 若支持恢复，明确提供恢复入口和限制；缺少入口不生成虚假的自动回滚能力。

入口必须位于允许范围、以参数数组调用而非拼接任意 shell 文本；未知 schema、非法路径、
缺必要配置、缺凭据或不支持动作均明确拒绝。构建阶段不应拿到不必要的发布密钥。
现有 manifest 的版本兼容/迁移方式在 `SBA-02` 写明，不能静默改变 v1 含义。

更新候选以应用声明的版本来源识别，以 commit SHA 固定执行内容。相同版本不同 SHA、
旧版本、缺失版本的处理规则必须显式定义，不盲目按字符串排序。第一期提供明确查询/
刷新和人工发起更新；无人值守自动上线、轮询与 webhook 并非本次必需范围。

## 6. 按顺序实施的独立子任务

下表是当前优先队列。每次只领取一行；若仍过大，先拆后缀子项，不扩展原任务边界。
以下是规划时拆分的任务，实施状态与证据见第 9 节，不以本规划的存在标记实现完成。

| ID | 范围 / 主要仓库 | 可独立验收的交付与停止条件 | 依赖 |
| --- | --- | --- | --- |
| SBA-DOC-01 | 本计划 / SpringBok | 记录职责、目标、证据、任务、验收与停止条件，接入总计划；文档验证及 Git 交付 | 无 |
| SBA-01 | SpringBok 真实上线 / SpringBok | 核对代码与凭据权限、既有资源；仅修阻塞上线的问题；受保护管理页可访问，授权 API/持久任务有效；记录 URL、SHA、部署 ID 和登录验证 | SBA-DOC-01 |
| SBA-02 | 统一契约与执行路径 / SpringBok | 读两个项目调用点；确定最小 schema、版本规则、结果协议、执行运行环境和 GitHub 触发/回执方案；给出 NAccount v1 兼容方案，不开发通用迁移引擎 | SBA-01 |
| SBA-03 | NAccount 首次部署适配 / NAccount | 按统一契约完善 .sba；从干净的 GitHub 固定 SHA 完成构建/验证；资源初始化、密钥和组件顺序明确；提交推送可供调用 | SBA-02 |
| SBA-04 | 云端任务到执行端 / SpringBok | 最小页面/API 可发起 .sba 部署；固定 SHA、授权、任务持久化、互斥、可信结果/日志可追踪；重复请求不重复发布，未知不盲重试 | SBA-03 |
| SBA-05 | NAccount 首次真实部署 / 联合 | 从云端 SpringBok 发起，使用 GitHub 版本发布 server/admin；真实注册、邮件验证、登录/退出及后台授权等核心路径通过；记录资源身份与初始业务数据 | SBA-04 |
| SBA-06 | NAccount 更新/迁移契约实现 / NAccount | 实现新版本、兼容的实际 schema 迁移及升级验证；复用原资源与密钥；迁移记录/重入安全、失败停止、数据保留有针对性测试；提交推送 | SBA-05 |
| SBA-07 | SpringBok 版本更新执行 / SpringBok | 显示当前/候选版本，固定目标 SHA；用户发起更新后按契约调用，展示阶段与结果；无 NAccount 专属迁移逻辑，不默认自动上线 | SBA-06 |
| SBA-08 | 有数据真实升级与交付 / 联合 | 用 SBA-05 的数据，经云端 SpringBok 更新到新 GitHub 版本；执行真实迁移，核对旧数据、资源 ID、核心业务和版本证据；交付使用说明并停止 | SBA-07 |

`SBA-03` 的离线/构建验证不是绕过 SpringBok 的正式发布。`SBA-05` 若失败，
只修明确阻塞后再次执行，不回退为本机手工部署并宣布成功。`SBA-06` 选择最小、
真实且合理的 NAccount schema 演进，不为测试破坏用户数据或制造无关业务功能。

## 7. 真实验收矩阵

| 场景 | 必须观察的证据 | 不可替代为 |
| --- | --- | --- |
| SpringBok 上线 | 真实 URL、鉴权通过/拒绝、API 可用、持久任务证据、版本 | 本地 build、静态页面截图 |
| GitHub 源部署 | repo/ref/SHA、执行 run、构建来源、Cloudflare deployment 与任务关联 | 本地工作区上传、仅返回 accepted |
| NAccount 可用 | server/admin 访问，注册/验证邮件、登录/退出、后台权限、必要 token 流程 | 仅 /health 返回 200 |
| 更新识别 | 当前版本和目标版本/SHA，显式更新操作 | 只显示 GitHub 最新 commit |
| 数据保留 | 升级前创建测试账户及业务记录，升级后标识/字段/登录仍有效，持久资源身份未变化 | 空库迁移、重建数据库后注册新账号 |
| 实际迁移 | 新版本的真实 schema 变化、应用迁移记录、执行回执、新结构可用 | 空脚本、只改版本号、人工先迁移 |
| 失败与重复 | 有界故障验证；失败不继续、不假报成功；重复提交/回执不重复副作用，未知可见 | 无限重试直到绿色、吞掉迁移错误 |

失败/重复的危险分支优先用隔离测试环境或匹配层的自动化测试覆盖，
不要求在生产反复破坏数据。代码回滚不等于数据库回滚；不可逆或破坏性迁移
必须先明确批准及恢复条件，不能由 `--execute` 或一次普通更新点击替代。

## 8. 工程约束与反循环规则

- 先读真实代码和当前状态，再改最窄责任层；两个独立仓库各自 scoped commit/push，
  精确 head 检查/审阅后按现有 PR 流程正常合并，核实 main。每个验收子任务立即交付。
- 保留 dirty edits、历史 fixture ID、旧 evidence、SQLite DO 持久化/幂等语义；
  不把 NAccount 冒充历史 `account` fixture，不为此默认新增 D1/KV/R2 到 SpringBok。
- 只跑改动层与邻近风险的检查，真实里程碑再跑匹配的集成验收；不反复重跑无关全套。
  修改自动化时保持固定 Actions、校验 CLI 下载、只读默认权限及既有安全检查。
- 第一次失败先保存原始错误并定位；同一原因不重复付费/发布。未知外部结果先核对，
  不能清空任务或迁移标记来解锁重试。不停止其他 owner 的构建/服务。
- 每次只处理阻塞本路线的缺口；不阻塞的问题记待办，不悄悄扩展验收范围。
- Windows 使用本地或既有 `Z:` 对应路径，避免 UNC 命令链创建临时映射。
  文本 UTF-8 无 BOM，日志脱敏；高风险删除遵循用户明确批准边界。

## 9. 接续记录与当前停点

每个子任务更新以下信息（可直接复制）：

```text
任务 ID / 负责人 / 起止时间：
两个仓库的起始 SHA、dirty 状态、改动文件边界：
本项验收条件 / 明确不做事项：
实际修改与执行：
本地检查 / 精确 PR head 检查 / main 检查：
云端地址、目标环境、任务 ID、run ID、源码 SHA、部署 ID（不含密钥）：
数据迁移与旧数据核对证据：
提交 / 推送 / PR / 合并状态：
失败原文、未验证项、是否存在外部部分完成或未知状态：
下一项及唯一直接下一步：
```

当前领取：`SBA-DOC-01`，负责人主 AI；文件范围为本页、总计划与历史自有服务页的
优先路线提示。不改 NAccount 文件、runtime 或 workflow，不接触密钥/云资源。
文档内容已编写；检查及提交/推送/PR 的最终状态以本任务交付回执为准。
本轮验证：三份改动文档的 UTF-8 无 BOM、代码围栏、相对链接及本表九项任务的唯一性/
依赖顺序已检查；`git diff --check` 通过。总计划第 6.3 节的聚焦检查在 Windows
工作区为 40/41 通过，唯一失败是既有 `repository-quality.yml` CRLF 与安全测试
LF 正则不匹配（索引 LF，`core.autocrlf=true`）；未修改工作流或放宽断言。
相同基线用单次 `core.autocrlf=false` 导出的 LF 快照运行同组检查，41/41 通过。
快照在 `linshi/springbok-sba-doc-01-20261006`，仅作既有代码检查，不冒充部署验证。
下一任务为 `SBA-01`：先核实 SpringBok 实际 Worker 配置、上线阻塞及 Cloudflare
账户/现有资源，再完成第一条真实上线，不先开发完全部 `.sba` 能力。

### SBA-01 领取与上线核查（2026-10-06）

本项拆为两个独立交付，避免把配置验证冒充真实上线：

| 子任务 | 负责人 | 边界与验收 | 状态 |
| --- | --- | --- | --- |
| SBA-01-S01 | 主 AI | 独立发布配置、保留式迁移约束测试、固定 Wrangler dry-run、精确 PR/main 检查 | PR #52 已合并，main 六项 CI 通过 |
| SBA-01-S02 | 主 AI | 发布已审阅 GitHub 版本、绑定已有 Access 保护的 hostname、真实登录与持久化验收 | 真实发布与未登录拒绝已通过；允许身份登录/持久化验收待完成，不关闭 SBA-01 |

- 负责人：主 AI；用户已要求执行完整联合计划。本项边界为 SpringBok 上线配置、
  最小必要发布工具、相关验证与部署证据，不提前实现 NAccount 业务迁移。
- `SBA-DOC-01` 的 PR #51 已按精确 head 审阅且六项 CI 通过后正常合并；
  main 为 `3e24935e2c2c09e58423a6cf099c2a8913bfc12d`，该 SHA 的六项 main CI 亦通过。
- Cloudflare 只读核查发现已有 `springbok-test` Worker，以及
  `springbok-test.aiaimimi.com` 的 `SpringBok Private Admin` Access 应用；
  优先核对并保留这些资源，不直接创建重名服务、覆盖数据或撤销访问策略。
- 提供的 Cloudflare 凭据在 account token verify 端点为 active，accounts/zones/
  workers/access 只读查询成功；user token verify 返回 401 属于端点类型差异，
  不能据此报告整个凭据失效。真实密钥未写入仓库或日志。
- 当前等待现有 Worker 配置、Access 策略和运行版本核对；管理员身份和最终域名
  不按账单账户推定。尚未发布新版本，尚未证明允许身份登录或持久任务线上可用。
- 随后只读核实：既有 Access 策略为 `SpringBok sole administrator`，明确只允许
  `vmjcv666@gmail.com`，1 小时会话。现有 Worker 版本为
  `0c760cd9-2642-47ff-9c09-d5fe3ac45fcf`，迁移 tag `v1`、仅 `TARGET` binding、
  `ENABLE_PROTOCOL_TEST=no`。账户自定义域名和 aiaimimi.com zone 的 routes/DNS 查询
  未发现该 hostname 已关联 Worker，不能把 Access 应用存在当作站点上线。
- 已新增独立 `cloud/wrangler.launch.json`，复用既有 Worker 身份、管理员策略参数和
  10ms CPU 限制；启用 admin/catalog，关闭 fixture 和 node 执行、workers.dev/preview。
  原默认关闭配置不变；四段 SQLite 新建类迁移沿用原历史，不删除或重命名类。
  `tests/cloud-launch-config.test.mjs` 两项通过，`git diff --check` 通过；尚未发布。
- 发布工具 npm registry 在线核实 Wrangler `4.147.0`、Node >=22，安装固定版本到
  `linshi/springbok-sba-01-tools`。首次下载因 `ECONNRESET` 失败；改为单连接和有界
  重试，缓存也放到该临时目录。Cloudflare 官方 DO migrations 页面在线返回 200；
  environments 页面本次 TLS 请求失败，不引用为已核实依据。
- 单连接重试后固定 Wrangler 安装成功；npm lock 固定完整性摘要，运行时依赖按
  `cloud/package-lock.json` 安装。dry-run 成功构建 Worker 和 8 个静态资源，
  上传包 147.50 KiB / gzip 31.17 KiB。独立配置明确只绑定已有 Access 应用的
  `springbok-test.aiaimimi.com`；不开放 workers.dev，也不改其他域名或 Access 策略。
- PR #52 的初次安全扫描将配置中的公开 Access audience 标识误报为
  `generic-api-key`。已从 CI artifact 核对唯一 finding 的文件/行/提交；
  `.gitleaksignore` 只列该精确历史指纹，不排除文件、规则或真实 token。
  该 AUD 已由 Access 应用 API 核实，用于验签绑定，不具有授权能力。

### SBA-01-S02 真实发布回执（2026-10-06）

- PR #52 精确 head `8b4723a754fc42d4a143896c658d01fb484549ed` 的六项检查全部
  通过并审阅后正常合并。发布 main 为 `297dc7efb6ec6a07519e71c95ec32c12ba7f6cdd`，
  其六项 main CI 同样全部通过。未绕过保护或重写历史。
- 固定 Wrangler `4.147.0` 发布到现有 Worker `springbok-test`，真实 URL：
  <https://springbok-test.aiaimimi.com>。首次 `--yes` 在 CLI 参数解析阶段被拒绝，
  未进入上传；按实际 help 去掉该参数后成功发布，不属于未知写入后盲目重试。
- Cloudflare version：`019b75a8-f912-4873-8a7a-19f5e7412c6c`；deployment：
  `7ec84882-aa24-4d2e-9aa6-b8579aabe066`，2026-10-06 09:43:52 UTC，100% 指向此版本。
  已通过账户 API 独立复核 deployment、custom domain 与 DO bindings，而非只信 CLI 输出。
- 原 `TARGET` namespace 仍为 `afa8ca0cf0a945928c89aa8ee63d1606`，未重建；
  新增 `REGISTRY`、`NODES`、`TELEMETRY` 类按既有迁移历史创建，节点入口仍关闭。
  上一 Worker 版本仍在部署历史中，未删除数据或旧版本。
- 对 `/`、`/app.js`、`/api/admin/state` 的无凭据 HTTPS 请求均返回 302，
  目标为 `aiaimimi.cloudflareaccess.com/cdn-cgi/access/login/springbok-test.aiaimimi.com`。
  证明外围 Access 生效，不证明允许管理员已登录、管理 API 成功或线上 DO 写入持久化。
- 当前工具没有可用浏览器，创建 IAB 返回 `Browser is not available: iab`；
  已请求用户用现有获准邮箱登录或提供可连接浏览器，不要求提供密码、验证码或 token。
  不引入 Access Bypass、假 JWT 或机器身份来冒充管理员验收。
- `SBA-01` 保持部分验收。等待身份交互时可领取不依赖它的 `SBA-02` 契约/执行端工作，
  但正式 NAccount 发布仍须有真实授权调用与回执；不能因登录待验收而退回无限离线优化。

### SBA-02 领取（2026-10-06）

- 负责人主 AI；文件范围：统一契约文档、纯函数校验与针对性测试。不修改 NAccount
  业务逻辑，不在此子项创建部署 workflow、注入 GitHub secrets 或触发业务发布。
- 选择受控 GitHub Actions Windows runner 调用仓库 `.sba`，复用现有 PowerShell 5.1 /
  Python 部署工具。SpringBok Worker 只创建持久任务、触发及核对回执，不运行 shell。
- 正式协议采用 `.sba/manifest.json` v2；现有 NAccount v1 保留直调能力，但不能直接
  当作 v2 执行。应用提供 deploy/update/verify 三个固定动作，内部构建、备份、迁移和
  组件次序完全归应用实现，平台不定义业务步骤 DAG。
- 交付条件：版本/路径/动作/运行环境/结果协议可验证，旧版明确拒绝、输入不可变，
  目标 SHA 与任务/版本绑定。真实 Actions 和 NAccount 接入在后续子项验收。
- 已实现 [SBA v2 契约](sba-contract.md) 及 `src/sba/contract.mjs`；
  `node --test tests/sba-contract.test.mjs` 5/5 通过，覆盖旧版拒绝、路径/运行环境限制、
  数值版本比较、版本/SHA/任务绑定、假成功与非法结果拒绝；`git diff --check` 通过。
  不是实际执行端或业务验收。精确提交/PR/main 状态按本项回执。

### SBA-03 交付与 SBA-04-S01 领取（2026-10-06）

- NAccount PR #1、#2 已正常合并，当前 main 为
  `661eb3505f573bb55cae63c57e2a10952b454bac`。统一入口及 Cloudflare 原生邮件
  binding 已入库；29 项部署测试、锁定补丁验证通过。没有远端 Actions workflow，
  不声称 NAccount 远端 CI 已通过。
- 已从该 GitHub SHA 干净克隆、重建上游加补丁，得到
  `67c0882f81bb25cd2cfb8ff18dca25a83506b36f`。server 构建及 Wrangler dry-run 通过，
  回执 `linshi/naccount-release-_t5g3c4f/release.json` 为 built/cloudWrites=false。
  正式发布必须由云端 SpringBok 发起，不能复用此本地构建冒充部署。
- 用户已确认 auth/accounts-admin 域名并授权使用现有 Cloudflare 能力；NAccount
  独立 D1/KV 已创建，资源 ID 和配置在其 `.sba/environments/cloudflare.production.json`。
  邮件送达、核心业务及有数据升级尚未验收。
- 当前领取 `SBA-04-S01`，负责人主 AI：实现执行端固定 SHA、干净 checkout、文件边界、
  凭据筛选、参数数组启动、超时和结构化结果校验。复用 SBA v2 校验器，不解释应用业务。
  本子项不直接发布应用；后续接入受控 workflow、云端持久任务/API/UI 和可信结果回收。

### SBA-04-S01 执行端验收记录（2026-10-06）

- 实现及调用边界见 [受控执行端](sba-runner.md)。读取固定 SHA 的干净 checkout，
  拒绝入口/目录链接、硬链接结果、ignored 污染与隐藏索引修改；Git 检查不继承
  `GIT_*` 注入，禁用 global/system config 和 fsmonitor。origin URL 匹配只是校验，
  不能证明代码已从 GitHub 获取；真实获取和版本授权仍由后续控制链负责。
- 应用只获得必要系统环境及 manifest 明确声明的秘密，不能覆盖系统路径或注入
  Node/Git/Python 配置。使用固定 Windows PowerShell 5.1 和参数数组；每次创建
  checkout 外的独立请求/结果目录，不转发应用原始 stdout/stderr。
- 结果必须绑定任务/action/SHA/version，成功须同时满足退出码和结果协议。超时、
  缺失、畸形、超限及假成功均为 unknown。超时会尝试终止本次进程树并有界结束等待，
  但没有独立证明复杂后代进程均退出，也不推断外部写入已撤销。
- 匹配源码的聚焦命令：`node --test tests/sba-contract.test.mjs tests/sba-runner.test.mjs tests/cloud-admin-boundary.test.mjs scripts/ci/security-baseline.test.mjs`。
  Windows Node.js 22.22.2：24 通过/1 平台跳过；Linux Node.js 24.18.1：23 通过/2
  平台跳过，均无失败。Windows 原生 PowerShell 与 synthetic 入口完整调用通过；
  Linux 单独验证 symlink 拒绝。没有使用真实部署秘密或执行 NAccount 发布。
- 已有 contract workflow 增加固定 Actions、`windows-2025`/Node 22 的无凭据 job；
  安全 contract 保留只读默认权限并禁止测试 job 获得部署秘密。固定下载并校验的
  actionlint 1.7.12 已通过；不额外宣称 ShellCheck/Pyflakes、生产或业务验收通过。
- 本地验证日志、源码指纹及接管原稿在
  `linshi/springbok-sba-04-20261006-continuation/`；本项 Git 交付先独立完成，
  精确提交的 Gitleaks、PR/main 检查及最终 SHA 以该项回执为准。代理 503 不计审阅。
- 下一独立项为 `SBA-04-S02`，先读 Worker/admin/DO 的真实接缝并联网核实 GitHub
  dispatch/run/artifact 接口，再接云端任务与受控 workflow。SBA-04 整体保持未完成；
  不以 S01 本地执行器代替用户通过云端 SpringBok 发起部署。
- PR #55 首轮 Windows 原生 CI 暴露超时返回早于进程 close 的目录占用问题。
  追加同任务修复：终止后等待 close，最多额外 5 秒；仍为 unknown，不自动重放。
  回归先红后绿；匹配 LF 快照复验 Windows 25 通过/1 跳过、Linux 23 通过/3 跳过。
  既有 Q01 工作树 CRLF 安全正则失败未混入本项修复；最终 PR/main 检查另记回执。
