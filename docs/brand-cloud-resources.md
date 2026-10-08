# 品牌密钥与账户资源目录（UI-03）

用户确认范围：Cloudflare 账户、Workers、D1、KV、R2，以及 GitHub 可访问仓库。
云资源页以品牌凭据为入口，不再以 D1/KV/R2 类型作为添加入口；不增加其他云厂商。

## 用户流程

1. 云资源页右上角“添加资源”打开 dialog，第一行选择 Cloudflare / GitHub。
2. 填账户备注与 API Token / PAT，验证后加密保存。Cloudflare 默认识别全部可列举
   账户；也可填写可选 Account ID，指定有 Account Read 权限的账户。
   GitHub 不要求先输入仓库：读取 PAT 账户身份后列出可访问仓库。
3. 页面按品牌/账户分组自动读取目录；UI-06 增加可切换的资源视图与逐级用量汇总，见
   [资源用量与规划](resource-usage-views.md)。权限不足、网络异常、响应过大均显示读取失败，
   不能显示成空账户；各资源类型独立，R2 仍只支持默认管辖区。
4. 目录仅列举，不自动创建云资源、登记部署绑定或运行工作流。显式“用于部署”才核对
   资源并生成旧部署契约所需的连接/登记，再进入部署页预选；用户仍需手动选择其他
   所需资源、精确源码 SHA 和公开配置，审阅确认后部署。Workers 是已有服务目录，
   不提供覆盖按钮；不能把“可读取”说成“具备部署写权限”。

首次进入、保存成功、页面恢复及离开后重新聚焦超过 60 秒时自动读取；没有刷新按钮，
不做后台定时轮询。弹窗打开时不因窗口聚焦清除输入。关闭、切换品牌、提交和身份失效
清除密钥字段；不使用浏览器持久存储。目录每类型自动读取最多 5 页，剩余通过“加载更多”
明确标识，绝不声称未完整读取的列表为全部资源。

## 兼容和安全边界

- 保留 `/api/admin/connections` 与 `/api/admin/resources` 的原鉴权、同源、CSRF、机器
  身份拒绝及 query 拒绝。新增 `connect`、`use-repository`、只读 `inventory` 请求；
  inventory 使用 POST 携带严格字段和 CSRF，但不改变 Vault 记录或资源 revision。
- 复用现有 ConnectionVault/AES-GCM，旧记录 target/AAD 不变，无新 DO 或密钥轮换。
  Cloudflare 多账户原子保存；请求 ID + digest 幂等，超过 32 连接容量整批失败，
  不隐式保存半批。指定 Account ID 是显式限缩范围，不伪装成自动发现全部账户。
- GitHub 账户级 target 以 `@login` 区别旧 `owner/repository`，不会直接进入旧部署选择。
  用户显式选仓库后重新验证仓库及 Actions 读取，派生固定仓库子连接。子连接绑定
  parentId/parentRevision，父停用或修订后不接受新的资源/部署授权；已批准任务沿用
  既有在途授权规则，不把停用解释为撤销已签发执行许可。
- Cloudflare 目录与部署登记分离。“用于部署”重新读取对应页，服务端仍只接受五分钟
  内观察到的资源 ID。后台查看目录不会更改已审阅计划中的 resource revision。
  当前登记容量 128；超额明确失败，不删除旧资源或历史任务。
- 部署预选仅使用 URL fragment 内的非秘密连接/资源 ID，服务端仍以当前 owner、revision
  和真实登记校验。不能把 fragment 当作授权或精确源码版本。
- 目录只访问固定官方 GET；UI-06 用量补充固定只读 GraphQL，不能接受用户 query。
  拒绝重定向，沿用 8 秒/262144 字节限制；分页游标严格
  校验，公开响应只包含白名单字段。Workers 单页超过上限时显示读取失败，不静默截断。

兼容窗口：旧前端仍能创建/使用旧固定目标连接，新前端能展示旧连接。新增父子记录后，
不可把整套后端直接回退为不认识 parentId 的旧版本；必要回退保留新父授权校验，仅回退
视图或采用向前修复。不得重写旧密文、删除目录外数据、清空 DO 或自动重放部署。

## 外部接口核实（2026-10-07）

- GitHub 官方 REST 文档：`GET /user/repos`，按 full_name 排序，分页，表示 PAT 可访问仓库；
  https://docs.github.com/en/rest/repos/repos?apiVersion=2022-11-28#list-repositories-for-the-authenticated-user
- Cloudflare 文档站本轮返回 HTTP 403；改用联网读取的官方 Python SDK 核实：
  `cloudflare/cloudflare-python` 的 `resources/accounts/accounts.py`：`GET /accounts`、page/per_page；
  `resources/workers/scripts/scripts.py`：`GET /accounts/{account_id}/workers/scripts`、SinglePage。
  不把文档请求失败表述成已成功读取；下载证据在 UI-03 临时目录。

停止条件：品牌添加→自动目录→显式资源选用→既有固定 SHA 部署契约的合成回归；
真实用户账号资源与部署写权限仍需线上手测。此次不重部署 NAccount，不修改其数据。
