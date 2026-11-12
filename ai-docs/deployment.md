# deployment.json：自助部署声明 v2

此处 schemaVersion 是 2，与 manifest 的 3 不同。声明是纯数据，不执行其中的表达式、命令或 URL。target 支持 cloudflare-workers，以及显式混合目标 cloudflare-suite；后者是新增代码能力，不代表控制面或业务已上线。参见 [Pages 与 Actions 套件](cloud-suite.md)。

## 顶层字段

| 字段 | 定义 |
| --- | --- |
| schemaVersion | 整数 2；历史手动资源声明 1 仍由代码显式处理 |
| target | cloudflare-workers；v2 还可使用 cloudflare-suite |
| accountPath | 配置中的运行账号写入路径，须与 accounts 第一个元素的 path 一致 |
| accountMode | single 或 multiple；single 恰好一个账号 |
| accounts | 1–12 个账号描述；第一个 key 必须是 runtime；key 与 secret 各自唯一 |
| defaults | 公开配置对象，不是环境秘密存储 |
| fields | 最多 32 个公开配置输入 |
| resources | 最多 12 个 D1/KV/R2 资源绑定 |
| targets | 1–8 个实际写入目标；套件另支持 Pages 项目与 GitHub Actions 工作流环境 |
| administrator | 可选，仅 v2；首次管理员邮箱路径及独立密码秘密引用 |
| github | 可选，仅 cloudflare-suite 且有 github-actions 目标时必需；来源仓库和令牌引用 |
| applicationSecrets | 可选，仅 v2；1–20 个业务秘密名称，全部秘密引用合计不超过 manifest 的 20 个 |

所有对象严格白名单。路径是 1–6 个普通对象键的数组，不支持数组下标、原型键、重复或父子重叠路径。声明总编码上限 32 KiB。公开值最多 8 层，数组最多 100 项，字符串最多 8192 字符；业务格式仍要应用自行校验。

## 子对象逐字段

| 对象 | 字段 | 定义 |
| --- | --- | --- |
| accounts[] | key、label、path、secret | 逻辑账号名、显示名、配置写入路径、云账号秘密名称 |
| fields[] | path、label、type、required、template | 路径、显示名、text/json、布尔必填、null 或字符串模板；只有 text 可用模板 |
| resources[] | key、label、kind | 唯一资源键、显示名、d1/kv/r2 |
| resources[] | idPath、namePath | 云 ID 写入路径；名称路径可为 null，R2 使用 bucket 名称作为 ID |
| resources[] | account、nativeAccount | 所属逻辑账号；nativeAccount 可为 null，否则要求原生绑定同账号 |
| resources[] | nameTemplate | 必须包含 `{instance}` 的资源名称模板 |
| targets[] | kind、path、account | worker/domain/email-routing；套件另可 pages/github-actions。普通 path 引用必填 text 字段；邮件目标见下文。github-actions 的 account 必须为 null，其余引用逻辑云账号 |
| targets[] | workerPath | 仅 email-routing 必需；引用同一逻辑 account 下已声明的 worker target 路径 |
| administrator | emailPath、secret | 邮箱公开配置路径；密码秘密名不能复用账号 secret |
| github | repositoryPath、secret | 平台写入已核验来源仓库的路径、来自该 GitHub 连接的秘密名称；不得与其他路径或秘密名重叠 |

模板只支持 `{instance}` 与 `{subdomain:账号key}`，不是任意插值程序。模板最长 256 字符。字段 label 最多 100 字符。账号、资源及路径键使用普通标识符，禁止 prototype、constructor 等原型键。

Worker 名称匹配 `[a-z][a-z0-9-]{1,62}`。域名目标必须为 HTTPS origin，无尾部斜线、路径、端口或凭据。Zone 是共享域名资源，不能随服务删除；部署配置引用域名不等于授权任意 DNS 更改。

选择已登记 Zone 的子域部署时，计划和确认提交均重新核对归属及 DNS。完整列表中的同名
MX/TXT 可保留，与 HTTP Worker Custom Domain 共存；平台不删除或修改这些邮件/验证
记录。A/AAAA/CNAME、其他类型、返回外部主机名、不完整列表或超过 100 项仍拒绝，不
覆盖已有 HTTP 地址。应用仍须自行核对 Custom Domain 占用和部署后的绑定/业务结果。

Pages 项目名沿用同一保守名称规则。github-actions 目标值为 `.github/workflows/name.yml@instance`
或 `.yaml`；文件名只接受字母、数字、下划线、连字符，环境后缀必须等于当前实例环境。
repositoryPath 由平台填入已批准应用仓库，不能作为普通字段传入。凭据仅来自用户的来源
连接，不是平台执行器 token。声明不是 token 权限沙箱，用户需按实际部署需求授权。

## 公开配置与秘密

公开配置会进入计划、执行请求和回执关联流程。不要放 token、password、private key 等值；敏感键过滤不是内容识别器，普通文本字段中的秘密也会泄漏。允许的 secretNames 是名称数组，不是密钥。

账号秘密通过保险库和一次性许可注入环境。管理员密码也是独立秘密，不进入公开 defaults。平台按动作限制可交付秘密；repair 只需要修复描述声明的集合，不能顺便取得管理员初始化密码。

applicationSecrets 是业务秘密名称数组，不含值，不得与账号、GitHub 或管理员秘密重名。
它与其他秘密名称的并集必须恰好等于 manifest.secrets。首次计划通过 applicationSecrets
输入引用已保存的集合 `{id, revision}`，值只提交至 owner 的加密保险库。集合绑定来源
仓库与应用 id，名称必须完全匹配；公开计划和服务状态不包含秘密值或秘密摘要。每个值
为 1–512 UTF-8 字节的单行字符串；轮换须显式设计，不能在普通更新中替换集合。

首次部署会保存不可变的加密任务快照，更新/预升级/清理继承同一引用。禁用集合阻止新
计划，不撤销已经批准任务的单次许可或改写历史快照。verify 保持不交付任何部署写秘密。
repair 沿用原实例的业务秘密集合，只为修复声明 secretNames 选中的名称建立独立加密
任务快照；不能替换集合、扩大名称或借用 administrator 初始化通道。未选中的业务秘密
不会交付真实值。完整授权与许可语义见 [生命周期](lifecycle.md)，不另设一套修复规则。

声明中列出所有实际写入的资源和目标；它不是不可信代码的沙箱。预览不执行部署，但用户确认后的资源创建与发布会产生真实副作用。

服务部署、升级和修复预览沿用两分钟签名有效期。界面在过期后禁用确认，并在提交入口
再次检查；需返回修改后重新预览，不自动延长、重建或发送过期请求。网络提交后结果不明
仍按 UNKNOWN 核对原任务，不能把该界面检查当作重放未知提交的许可。

v2 资源归属检查按所属账号核对 resources 的名称/真实 ID 和 targets 的解析值。
配置中的外部身份 issuer、客户端 ID 等调用依赖不占用该服务的资源身份；多个应用可共享
同一认证服务，但不能声明覆盖其 Worker 或域名。历史 v1 仍采用保守的配置检查。

## 根域 Email Routing 目标

源码支持 v2 的显式 `email-routing`，不是 HTTPS `domain`，也不是可创建/删除的 Zone。
目标 `path` 必须引用 `type: json`、`required: false`、`template: null` 的字段，且 defaults
中该字段明确为 `null`。`workerPath` 必须指向同 account 已声明的 Worker，不能引用任意
文本字段、域名或另一个逻辑账号的 Worker。字段通过现有 JSON 配置入口填写。

```json
{
  "kind": "email-routing",
  "path": ["routing"],
  "account": "runtime",
  "workerPath": ["server", "name"]
}
```

配置值为 `null` 时不产生邮件写目标，不占用收信身份；非 null 时恰为
`{"zoneId":"00000000000000000000000000000000","domain":"example.com"}`。
域名须为 Zone 根域，不接受 URL 或将子域假作独立 catch-all。平台以
`email-routing:<zoneId>` 作为账号内单例占用键，不因接收 Worker 不同而绕过冲突。

计划和确认提交都重新读取 Zone 所属账号/根域/active 状态、Email Routing ready 状态
和 catch-all。首次部署只接受 source=api、disabled/drop 的中性规则；即便已有规则指向
同名 Worker，也不隐式收养或抢占。更新要求规则仍启用并指向本实例。平台不自动启用
Email Routing DNS，也不创建或改变 MX/SPF；DNS 准备属于显式前置。所需读取包括
Zone Read、Zone Settings Read 和 Email Routing Rules Read，实际绑定另需 Rules Write。
账号级邮件列表还需实际授权，单 Zone 的规则 GET 成功不证明账号列表权限已具备。

应用 adapter 负责在发布接收 Worker 后再次检查并绑定、读回和业务验证；声明不构成
账号级 token 沙箱。rehearse 强制将全部邮件配置置 null，只在 source.resources 中保留
只读身份；preview 可写清单和 destroy-preview 均拒绝邮件身份。应用仍须验证 null 并
隔离邮件/发信等外部副作用，不能把控制面合成回执当成应用执行已验。发布状态另见开发计划。

## 普通实例的 R2 删除边界

源码新增 R2 删除能力，复用现有删除计划、逐项持久回执和明确确认，不新增 SBA action。
目前只接受默认 jurisdiction、无 custom domain、关闭 r2.dev、无 bucket lock、无事件通知
的私有 bucket。Worker 与 Pages 当前配置中发现外部存储引用时拒绝删除；历史 Pages
Functions 部署缺少 R2 绑定字段时，作为单独风险进入签名计划，要求明确接受，不能当成空绑定。

计划读取对象元数据，不读取邮件内容或暴露私有对象 key；展示对象数量与字节数，并绑定
创建时间和对象 key、etag、大小、修改时间的摘要。单 bucket 最多 1000 个对象、单次
读取及批量删除请求均不超过 256 KiB。旧版列表省略 result_info 时，另读 start_after
尾部并要求为空，不把短页默认当成完整列表。通知 API 仅将 HTTP 404 且错误码恰为
11015 视作无配置，其他错误仍拒绝。分页未结束、权限不足或响应不完整时拒绝；更大
数据集、其他 jurisdiction 和公开 bucket 尚不在支持范围，不自动清空、修改配置或绕过锁。

确认提交时重新检查完整计划；先删除域名和 Worker 入口，再处理数据资源。R2 再次核对
元数据，只对批准的一批 key 发出一次 DELETE，读回空 bucket 后才删除 bucket，并最终
独立确认资源不存在。HTTP 200 的部分失败、响应丢失或晚到新对象均保持 delete-unknown，
不自动重放或追加清空。历史部署、删除回执与归属保护保留；共享 Zone、MX 和 Email
Routing DNS/settings 永不删除。显式 catch-all 的解绑流程见下文。

对象批量删除不是跨请求事务，独立 S3 客户端等写入方仍须在删除前停止；平台不声称能
阻止账号外部写入，也不会替用户禁用独立凭据。源码/合成 provider 验收不等于已发布控制面
或完成真实云删除，发布状态见仓库开发计划。

## 已不存在混合套件的登记退役

已终态的 `cloudflare-suite` 历史实例可通过“退役登记”从当前服务列表移除，部署任务和
原始业务回执仍可按原 ID 读取。它不是资源删除或新的 SBA action，不修改业务资源、
资源目录、账号 lane、历史 permit 或资源 claim，也不授予旧任务重放或同名重建权限。

当前仅支持同账号 D1/私有 R2、一个 Worker、一个 Pages 项目、一个 GitHub Actions
environment 及对应 provider origins；自定义域名或其他目标拒绝。计划和确认均从当前
持久 head 构造清单，以原 UUID/名称核实数据资源、Worker 和 Pages 不存在，完整 GitHub
环境列表证明指定环境不存在，并拒绝相关 workflow 的在途任务。权限错误、其他 404、
不完整列表、任一资源仍在或源/连接变化均拒绝，不能只勾选隐藏一个活跃服务。

核验仅使用历史登记中相同连接 ID 的当前已验证版本，仍须匹配原 Cloudflare 账号与
GitHub 仓库权限；不替换连接、不修改历史部署的 revision。签名计划独立绑定本次实际
使用的连接 revision，核验结束、确认重读及事务提交时均复核，期间重新验证或禁用连接
会使旧计划失效。Actions scope 复用既有仓库小写规范，原仓库显示大小写保留。

owner 经原 Access/Origin/CSRF 和两分钟签名确认后，仅追加 `retired` 登记记录。活动列表
不再展示该实例，但历史服务状态仍显示原 job/history 及退役回执；后续升级、修复、预升级
和验证均拒绝。平台不承诺阻止外部独立凭据在核验后重新创建资源；外部写入者须先停止。
源码及合成 provider 通过不代表控制面已发布或真实云登记已退役。

## 普通删除结果核对

服务面板收到已确认的 `deleted` 状态后，将该实例移出当前列表；已清理的预升级副本同样
不再展示。后台任务、原回执及防重复登记记录保留，仍可按原精确 ID 核对。删除中、删除
未确认、失败和读取失败不会因此隐藏；列表移除本身不发送任何云资源删除请求。

普通删除的 D1 不存在证明读取原 immutable UUID，而非依赖账号列表的即时计数。仅 HTTP
404、success:false、result:null 且唯一错误码 7404 证明不存在；HTTP 200 必须是成功响应、
errors 为空且 UUID/name 与原记录相同。权限、其他 404、畸形或身份漂移都不能证明已删除。

持久状态为 delete-unknown 的普通实例可由原 owner 点击“核对删除结果”。此入口经原
Access/CSRF 校验，仅接收 instanceId/operationId，读取原删除记录的清单和连接；不接受
调用方替换清单，不执行 DELETE、不重试清理、不重建资源。任一资源仍存在或读取失败，
原 unknown、错误、逐项进度及账号占用均保留。只有原清单全部独立不存在，才用原
operationId/digest 经既有 finishDeletion 收尾、释放原占用并标记 deleted。原失败证据和
部署历史保留，附加核对观察；重复核对 deleted 幂等。仍在 deleting 的记录（包括界面超时
显示 unknown）不能借此中断在途删除；部分资源的实际后续清理仍需独立明确授权和身份核验。

本能力只需兼容控制面，不移动 executor pin；源码/合成 provider 回归不是云端清理证明。

## 普通实例的收信解绑

删除任何 Worker 前都按账号完整读取邮件规则（包含 catch-all 和 literal），不仅检查声明
了邮件目标的实例。未声明、其他 Zone 或 literal 规则仍引用所选 Worker 时拒绝；缺少
Email Routing Rules Read 权限或列表不完整也拒绝，不把 403/404 当成无引用。每页最多
50 项、最多 20 页/1000 项、单响应最多 256 KiB，校验总数、当前页和规则 ID 唯一性。

邮件删除计划绑定 Zone/账号/接收 Worker 和准确 catch-all 规则。确认时重读整个计划；
执行前再次比较快照，先单次 PUT 为 disabled/drop 并读回、确认再无邮件规则引用接收
Worker，之后才删除 HTTPS 入口、Worker 和数据。已经中性解绑的目标只读确认、不重复
写入。规则归属漂移、部分失败、丢响应或迟到引用持久为 delete-unknown，停止后续删除，
不重放。解绑需 Email Routing Rules Write，不更改其他规则或共享 Zone/MX/DNS。

这些跨请求检查不是 Cloudflare 原子事务。删除前必须停止独立路由/DNS/Worker 写入者，
平台不声称能阻止账号外部并发修改。源码/合成 provider 通过不等于真实云解绑或一键部署完成。

事实来源：[deployment-contract.mjs](https://github.com/aiaimimi0920/SpringBok/blob/main/cloud/deployment-contract.mjs)、[service-deletion-r2.mjs](https://github.com/aiaimimi0920/SpringBok/blob/main/cloud/service-deletion-r2.mjs)、[service-deletion-email.mjs](https://github.com/aiaimimi0920/SpringBok/blob/main/cloud/service-deletion-email.mjs)。
