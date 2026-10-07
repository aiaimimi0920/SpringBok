# 应用部署表单声明 v1

应用在 `.sba/deployment.json` 声明公开部署配置，独立于严格的 manifest v2。
SpringBok 只从选择的 GitHub 连接和精确 40 位 SHA 读取两个正常 Git blob；不会执行
声明中的表达式、命令或 URL。尚无声明的应用不能使用自助表单；原固定 policy 链不受影响。

```json
{
  "schemaVersion": 1,
  "target": "cloudflare-workers",
  "accountPath": ["accountId"],
  "defaults": {"vars": {}, "server": {"name": ""}},
  "fields": [
    {"path": ["server", "name"], "label": "Worker 名称", "type": "text", "required": true},
    {"path": ["vars"], "label": "公开变量 JSON", "type": "json", "required": true}
  ],
  "resources": [
    {"key": "database", "label": "数据库", "kind": "d1", "idPath": ["database", "id"], "namePath": ["database", "name"]}
  ]
}
```

所有字段严格白名单。最多 32 个公开输入、12 个资源绑定；路径为 1–6 个普通对象键，
不支持数组下标、原型键、父子重叠路径。公开 JSON 最多 8 层，整个配置最多 32KiB。
`defaults` 提供应用固定值和初始值；`text` 返回字符串，`json` 返回解析后的 JSON。
`required` 的 text 不接受空白，json 不接受 null；业务格式仍由应用部署入口验证。

资源 kind 为 `d1`、`kv`、`r2`；`idPath` 由服务端写入云端 ID，R2 使用 bucket 名称。
`namePath` 为 null 或另一个不重叠路径，写入云端名称。账号写入 `accountPath`。
浏览器仅传资源登记 ID/revision；服务端校验 owner、连接和资源 revision、账号、kind
及五分钟观察有效期。浏览器不能把任意 ID 冒充已登记资源。

配置是公开数据，将进入 GitHub Actions inputs。已知秘密键（Token/password/API key/
authorization 等及大小写下划线变体）递归拒绝；`secretNames` 仅允许大写名称数组。
这不是秘密内容识别器：无法识别用户放在普通文本字段中的秘密，用户仍不得填写秘密值。
当前自助执行接入仅支持 manifest 声明单个 `CLOUDFLARE_API_TOKEN`；密钥由连接保险库
及一次性许可通道交付，不纳入表单、plan 或 dispatch。GitHub 应用 PAT 只读源码；
平台另用固定执行仓库凭据派发、查看运行与回执，不要求应用 PAT 具备执行仓库权限。

预览不部署。后续确认时必须重新读取同 SHA 声明及校验所有引用，不能只信任客户端
计划或会话确认签名。应用完整源码受操作者信任：表单声明不是应用代码的沙箱。
