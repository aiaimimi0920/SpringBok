# deployment.json：自助部署声明 v2

此处 schemaVersion 是 2，与 manifest 的 3 不同。声明是纯数据，不执行其中的表达式、命令或 URL。当前 target 仅支持 cloudflare-workers；不要将产品路线当作已有 provider。

## 顶层字段

| 字段 | 定义 |
| --- | --- |
| schemaVersion | 整数 2；历史手动资源声明 1 仍由代码显式处理 |
| target | cloudflare-workers |
| accountPath | 配置中的运行账号写入路径，须与 accounts 第一个元素的 path 一致 |
| accountMode | single 或 multiple；single 恰好一个账号 |
| accounts | 1–12 个账号描述；第一个 key 必须是 runtime；key 与 secret 各自唯一 |
| defaults | 公开配置对象，不是环境秘密存储 |
| fields | 最多 32 个公开配置输入 |
| resources | 最多 12 个 D1/KV/R2 资源绑定 |
| targets | 1–8 个实际写入的 Worker 或域名目标 |
| administrator | 可选，仅 v2；首次管理员邮箱路径及独立密码秘密引用 |

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
| targets[] | kind、path、account | worker/domain、公开配置路径、逻辑账号；path 必须引用必填 text 字段 |
| administrator | emailPath、secret | 邮箱公开配置路径；密码秘密名不能复用账号 secret |

模板只支持 `{instance}` 与 `{subdomain:账号key}`，不是任意插值程序。模板最长 256 字符。字段 label 最多 100 字符。账号、资源及路径键使用普通标识符，禁止 prototype、constructor 等原型键。

Worker 名称匹配 `[a-z][a-z0-9-]{1,62}`。域名目标必须为 HTTPS origin，无尾部斜线、路径、端口或凭据。Zone 是共享域名资源，不能随服务删除；部署配置引用域名不等于授权任意 DNS 更改。

## 公开配置与秘密

公开配置会进入计划、执行请求和回执关联流程。不要放 token、password、private key 等值；敏感键过滤不是内容识别器，普通文本字段中的秘密也会泄漏。允许的 secretNames 是名称数组，不是密钥。

账号秘密通过保险库和一次性许可注入环境。管理员密码也是独立秘密，不进入公开 defaults。平台按动作限制可交付秘密；repair 只需要修复描述声明的集合，不能顺便取得管理员初始化密码。

声明中列出所有实际写入的资源和目标；它不是不可信代码的沙箱。预览不执行部署，但用户确认后的资源创建与发布会产生真实副作用。

事实来源：[deployment-contract.mjs](https://github.com/aiaimimi0920/SpringBok/blob/main/cloud/deployment-contract.mjs)。
