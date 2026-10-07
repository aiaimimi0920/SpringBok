# SBA 云端首次部署控制链

任务：SBA-04-S02-B；负责人：主 AI；日期：2026-10-06。

## 范围与安全前提

本项只实现服务端批准的单个应用 SHA/环境首次 deploy。复用 SBA v2 契约和执行器；不实现 update、rollback、任意配置编辑，不改变历史 fixture 身份。管理员确认、SQLite DO 写前 claim、单次 dispatch、GitHub OIDC、一次许可、Windows 执行、可信制品回收组成整链。

固定 SHA 的应用代码必须预先审阅并可信。子进程环境过滤不是操作系统沙箱，不能用于安全执行恶意第三方代码。秘密不放 GitHub environment secrets，不进入 dispatch、DO、浏览器状态或应用原始日志；只有固定执行身份通过服务器核验并消费许可后才一次性返回。

## 配置契约（本项不启用生产）

`cloud/wrangler.jsonc` 和 `cloud/wrangler.launch.json` 默认 `ENABLE_SBA=no`，新增 `SBA_TASKS` / `SbaDeployment` SQLite Durable Object 与 additive `v5-sba-deployment` migration。旧 binding/migration 保留。

启用需管理员另行核查以下条件，不能直接把示例占位符部署：

- `ENABLE_SBA=yes`。
- Worker secret `SBA_GITHUB_TOKEN`：只授予所选仓库所需源码读取、Actions dispatch/run/artifact 权限。
- Worker secret `SBA_APPLICATION_SECRETS`：JSON 对象，键为 manifest/policy 声明的 secret 名称，值为非空字符串；不要把秘密写入配置仓库。
- `SBA_POLICY`：JSON 字符串，精确包含 `github, sourceSha, environment, configuration, secretNames, runnerOrigin`。`configuration` 仅公开配置；`sourceSha` 为应用完整 40 位 SHA。
- `github` 精确包含 `repository, repositoryId, applicationRepository, workflowId, workflowPath, ref, executorSha`；repository 为 owner/name，repositoryId/workflowId 使用真实 GitHub 身份；workflowPath 固定 `.github/workflows/sba-execute.yml`；ref 必须为 `sba-executor-<executorSha>`，executorSha 为已审阅完整 SHA。
- 部署前创建并保护该不可移动 executor tag，核查其精确 workflow SHA；OIDC 核验不能取代仓库权限和 ref 保护。
- `runnerOrigin` 为独立 HTTPS origin，不能等于 `ADMIN_ORIGIN`。该 origin 仅允许 `POST /sba/v2/source` 和 `POST /sba/v2/permit`，拒绝 cookie、Origin、query；不可为此放宽管理 Access。
- 执行仓库公开 variable `SBA_RUNNER_ORIGIN` 与 policy 一致。workflow 仅手动 dispatch，使用 windows-2025、PowerShell 5.1、Python 3.12、Node 22；固定 Actions，只有执行 job 获得 id-token:write。

准确验证规则以 `cloud/sba-control.mjs`、`src/sba/github.mjs` 和 `.github/workflows/sba-execute.yml` 为准。

## 状态与不可重放

`GET /api/admin/sba/state` 只读取。preview 返回固定计划和 120 秒会话确认；submit 要求 Access/同源/CSRF，并重新从固定 Git tree 读取可信 manifest。会话 HMAC 不是 manifest 的服务端来源证明。DO 在任何 dispatch 前先持久化 claim；并发确认、刷新、重启不产生第二次 dispatch。

permit 核验 GitHub issuer/JWKS、仓库数字 ID、workflow SHA/ref/tag、hosted runner、首次 attempt，再查精确 run title 绑定 task/digest。秘密齐全后才原子消费许可。许可响应丢失不重发，dispatch 未知不重发，超时/unknown 不解锁。管理 reconcile 是显式动作，临时网络失败保留 running，可信终态失败才转 unknown。

SBA-05-S07 兼容当前普通 job 的 signed self-workflow 身份：`job_workflow_ref` 和
`job_workflow_sha` 仅允许同时缺失，或同时精确匹配批准的 workflow ref 与 executor SHA。
缺一、foreign/reusable 身份、错误 SHA、null 和空字符串仍失败关闭，不忽略这组字段。
只读诊断的 `matchesSelf` 是相对于已独立验签核验的诊断 run 身份的布尔事实，
不输出原始字段，也不能代替执行 workflow 的 source/permit 验核或应用发布证据。

### SBA-05-S09：管理员显式批准的 unknown 归档

`recover-unstarted` 仍绝不接受已消费许可。独立 `POST /api/admin/sba/recover-authorized`
只在用户另行批准后使用，默认无 `SBA_OPERATOR_RECOVERY` 即关闭。短期批准严格绑定
原 task/run/request/result/旧 policy、操作者核验资源的 evidence digest，以及已审阅的新
executor/application SHA；有效期最多一小时。Origin/CSRF、原 owner 和精确 GitHub
终态/制品/envelope 必须重新验证，服务端不接受浏览器任意下一 policy。

只改变 executor SHA/tag 和 application SHA，其余配置、资源、secret names 完全不变。
SQLite 同事务保存完整旧 unknown、已消费许可、原 policy、批准和证据摘要，追加为
`operator-authorized-retry` 后批准精确下一 policy；该标签不表示“未执行”或“已恢复数据”。
原 legacy 未执行历史继续校验，混合历史沿用 count/head/digest 链；旧 ID 不得复用。
旧 policy 在过渡期间失败关闭。操作本身不 dispatch，新独立 task 仍须 preview/submit。

目标资源和实际副作用的核验由应用 owner 与获授权操作者负责，平台不推断数据库迁移，
也不声称能够根据一个摘要独立证明无副作用。该批准是明确风险决定，不是自动重试机制；
缺批准、缺可信结果、过期/不匹配、网络/制品错误或历史损坏均不解锁。切换成功后撤下
批准变量，不把这次窄批准扩展为其他 unknown 的恢复授权。

### SBA-05-S10：限时 Service Token 委托

测试自动化使用 Cloudflare Access 的 `CF-Access-Client-Id` / `CF-Access-Client-Secret`，
边缘 policy 只接受专用 token，原邮箱策略保持。Worker 不信任客户端头中的身份，仍从
`cf-access-jwt-assertion` 验 RS256、固定 issuer/audience、时间和 signed service shape：
`type=app`、`sub=""`、无 email、`common_name` 等于批准 client ID。
官方契约见 [Service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)
及 [Application token](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/)。

默认没有 `SBA_AUTOMATION_ACCESS` 和 `SBA_AUTOMATION_PROOF_KEY` 时服务身份拒绝。
前者只含 `clientId`、`ownerActor`、`issuedAt`、`expiresAt`，最长 24 小时，时间用 epoch
milliseconds；后者是 Worker secret，64hex。ownerActor 是显式机器委托的原操作者，不能
由客户端选择或从 service 空 sub 推导。真实启用后先调用 session/state 核对持久任务
owner；若身份不匹配即失败关闭，不改账本来迁就配置。

服务身份只允许 GET `/api/admin/sba/session`、`/api/admin/sba/state` 及既有五个 POST
SBA 操作的精确路径，不能读取管理静态页面、fixture/catalog/node 等接口；cookie、查询
参数和跨域请求拒绝。session 返回 csrf、ownerId、机器认证方式与期限，不返回任何 secret
或 JWT。服务 proof 使用独立 secret 并绑定 clientId、批准窗口、origin、owner、purpose
和内容，使 Access 每次刷新 JWT 不会使确认失效；每请求仍重新验身份及批准有效期，
旧 csrf 不独立授权。原用户 proof 格式与全部 preview/submit/回执/单次许可约束不变。

凭据应只放受控环境变量或 OS 加密存储，不进入 Git、URL、日志、浏览器 storage 或普通
JSON。可禁用/撤销边缘 token，或撤下委托配置及 proof secret；凭据过期不自动续期。
机器访问不是人类邮箱登录，也不是 CI 例外、业务验收或 unknown 恢复的单独批准。

制品回收先核验 run/artifact 关联，下载跳转只接受受限 Azure Blob HTTPS 主机，绝不转发 GitHub bearer。ZIP 限 64 KiB、解压限 32 KiB，只接收一个 receipt.json，并验证 SHA-256、CRC、envelope 和应用结果。应用报告成功不等于用户业务验收。

## SBA-05-S03 私有源码通道

执行端先核对自身固定 executor SHA，再以同一 OIDC/task/digest/run 身份请求 `/sba/v2/source`。
Worker 复用既有任务与 GitHub run 核验，只向 policy 批准的应用仓库发送固定 SHA、
`depth=1` 的 Git smart-HTTP upload-pack 请求。GitHub token 留在 Worker；不进入执行器、
应用环境、Git 配置、dispatch inputs 或制品。该接口不是任意 URL、命令或凭据代理。

源码请求不消费部署许可、不发放应用秘密；许可未消费且任务/run 仍有效时，可以重新
读取相同源码。一次调用内无自动重试、拒绝跳转，响应最多 8 MiB、网络超时 15 秒。
执行器校验 shallow SHA、pkt-line/sideband、pack header 与 SHA-1 checksum，随后在新目录
由原生 Git `unpack-objects --strict` 导入、检出固定 SHA，并复用干净 checkout/manifest
边界检查。只有全部通过后才申请一次部署许可；读取、framing 或 Git 对象失败均不能
进入应用执行。Git 命令沿用 120 秒超时；网络限额不是解压后源码大小的硬上限。

本项只交付源码读取实现与无凭据回归，不修改 SQLite schema、旧任务、policy、executor tag
或已部署 Worker，不触发真实 Actions 或 NAccount 发布。旧任务恢复必须另行证明许可未消费，
保留原记录后受控处理；不能通过重新运行 workflow、清空 DO 或替换任务逃避未知语义。

## 验收与仍开放的边界

### SBA-05-S04 未开始任务恢复与执行器过渡

此入口不是普通 retry/update/rollback。先把已审阅、已通过精确 head/main 检查且受保护
的 executor SHA 写入部署配置 `SBA_RECOVERY_EXECUTOR_SHA`；未配置时恢复默认关闭。
保持旧 `SBA_POLICY` 发布新的控制面代码，读取原任务，管理员通过已有 Access/同源/CSRF
调用 `POST /api/admin/sba/recover-unstarted`，请求仅为 `{taskId, executorSha}`。
管理员不能通过此接口指定任意仓库、应用 SHA、环境、配置、origin、秘密或未经部署配置批准的执行器。

Worker 只读核验旧 run 的完整身份、task/digest、首次 attempt、completed 和
failure/cancelled/timed_out。该事实本身不证明未执行：DO 在串行边界内再次验证 runId
及所有许可字段仍为空，拒绝缺少 runId 的 dispatch uncertainty、已消费许可、结果或不匹配任务。
60 秒内的核验事实才可用于事务；许可与恢复竞态最多成功一方。

同一 SQLite 事务向 additive `sba_unstarted_history` 追加完整旧状态、旧 policy、核验事实及
摘要链，再将活动槽设为无任务并把 metadata digest 切换到只改变 executor SHA/tag 的新 policy。
没有删除旧记录、旧表或 DO，没有重跑/dispatch。最多保留 20 条恢复记录，达到上限失败关闭，
不自动淘汰历史。原 schema v1 可原位读取，恢复事务标记 metadata v2 并保存历史条数和链头；
缺行、缺表、断链或损坏 history 拒绝继续授权，旧 task ID 永久不得复用。

事务后旧 policy 立即失败关闭；若响应丢失，不重复恢复或猜测 dispatch，先发布已批准的精确
新 policy，并读取 `GET /api/admin/sba/state` 的 history/task/proof/nextPolicyDigest 核对。
只有核对成功且 ready=true 才能按既有预览确认创建新任务；同一管理员 owner 关联保留。
控制面的 GET/history 与页面只显示公开摘要，不输出 permitId、GitHub token 或应用秘密。
此恢复不保证 Cloudflare 应用部署成功；短期 token 有效期、迁移和业务验收仍独立核实。

### SBA-05-S05 安全失败诊断

机器 API 拒绝仍为固定 JSON 403 / `SBA_PERMIT_DENIED`，只额外返回白名单的
`x-sba-denied-phase`、`x-sba-denied-reason`，源码上游失败时可含整数 HTTP status
及固定 MIME 类别。阶段区分 policy/request/oidc/body/pending/run/source/secrets/permit。
OIDC 只给固定条件类别；`jwt` 仍包含 JWKS/签名/JOSE 内的时效或 audience 错误，
`run` 仍不能进一步区别 GitHub 网络、身份或状态错误，不把类别当完整根因。

runner 仅在失败时输出 `SBA_SOURCE_DIAGNOSTIC` 的固定枚举/数字投影，忽略任意诊断
header 值，不读出正文、JWT、claims、cookie、密钥或源码。原 15 秒/8 MiB/单次 POST、
无 redirect、精确 Git/OIDC/run/task、先消费许可等保护不变；诊断不是新执行或重试权限。

证据目录：`C:/Users/Public/nas_home/AI/GameEditor/linshi/springbok-sba-04-s02-b-20261006/`。

- Linux 非 root 根测试：324 通过、3 跳过、0 失败；cloud suite：93/93。
- Windows 聚焦：56 通过、1 跳过、0 失败；不宣称 Windows 全平台 suite 通过。
- `node tests/browser/sba.mjs`：真实 Chrome/workerd，synthetic GitHub/OIDC/ZIP 的预览取消、单提交、刷新、许可与回执整链通过；截图有产物，未人工视觉审图。
- pinned upload-artifact 所用 archiver 7.0.1 的本地同版 producer ZIP 已被 parser 接受；不是实际 Actions artifact 验收。
- actionlint 本地通过；精确提交 Gitleaks 和 PR/main CI 需见交付回执，目录扫描的历史公开 Access audience 命中不能冒充新增秘密或忽略扫描失败。

下一步先交付精确 PR/main，再独立开展真实 Cloudflare/GitHub 配置和端到端部署验收。不得重复 dispatch 猜测结果，不把本地模拟、源码合并、真实部署与业务验收混为一谈。
