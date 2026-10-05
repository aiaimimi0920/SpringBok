# N03：每节点独立角色凭据与身份核对

本项接续 [一次性加入](node-enrollment.md)、[独立节点邮箱](node-mailbox.md) 和 [存储设计](storage-architecture.md)。它只实现已加入节点的独立 execute/observe 材料与 `identity:self` 核对，不开放任务领取、回报、部署、批准、指标或心跳。总进度见 [开发计划](development-plan.md)。

## 能力和授权真相

N02 在节点加入前将两个独立的 256-bit 随机秘密持久保存到 Linux journal；加入只向云端提交 SHA-256 摘要。N03 复用原秘密，不生成替代值、不更改 joined input、不新增 schema、binding、迁移或依赖。云端不存角色 token 明文。

新增接口为：

```text
POST /node/v2/identity/<execute|observe>/<ownerId>/<nodeId>
Authorization: Bearer <本角色的 64 位小写十六进制 token>
Content-Type: application/json

{"protocolVersion":2}
```

URL 的 owner/node 只是寻址，不是调用者权限证明。Worker 定位独立 NodeMailbox 后，由节点 DO 核对实际 DO 名称、持久 owner/node、当前合法 joined 记录及对应角色摘要。摘要计算在事务外；最终当前记录读取、角色摘要恒定时间比较和响应构造在同一同步事务内。不同 owner、节点或角色的 token 不能串用，加入 challenge 与旧共享 `NODE_TOKEN` 不能用于此端点。

身份成功仅返回以下固定结构，不含 token、摘要、challenge、另一角色材料或完整 enrollment 输入：

```json
{
  "protocolVersion": 2,
  "ownerId": "<本节点 ownerId>",
  "nodeId": "<本节点 nodeId>",
  "enrollmentId": "<原 enrollmentId>",
  "role": "observe",
  "status": "authenticated",
  "capabilities": ["identity:self"],
  "executionReady": false
}
```

身份成功不等于服务器在线、执行就绪或 observe 指标通道已接入。任务通道仍归 N01-S02，轮换/撤销归 N04/N05；当前没有 epoch/revoked 模型，不能宣称这两项已安全实现。

## 默认关闭和只读边界

`cloud/wrangler.jsonc` 新增 `ENABLE_NODE_CREDENTIALS=no`。请求同时要求节点邮箱开关和凭据开关为 yes，但不要求加入、目录或管理员开关继续开启。关闭加入只阻止加入行为，不隐式撤销既有身份；关闭凭据开关拒绝核对，不清除原存储。

身份核对不初始化空库、不将 schema 1 升级、不写 enrollment/任务 ledger。空库、schema 1、pending、缺表、未知版本或损坏记录均失败关闭并保留已有证据。节点 joined 而目录收尾 uncertain 是合法可达状态：节点是权限真相，目录不是；原加入期限约束首次消费，不是已 joined token 的有效期。

HTTP 必须为 HTTPS、无 query/cookie、无 Origin 或同源 Origin；role、路径、Bearer 编码和 JSON 字段严格受限。响应禁止缓存。未启用为 503，未知路径/方法为 404，基础请求安全拒绝为 403，格式/身份/存储无法确认统一为 409；不回显任意底层错误或秘密。客户端不自动重试、禁止 redirect，5 秒超时，身份响应最大 4096 字节并严格校验全部字段。

## 从原 joined journal 导出

安装者使用原 grant、原 state 和**独立确认**的规范 HTTPS origin：

```text
node scripts/node-credential-export.mjs --grant <private-file> --state <joined-state> --expected-origin <independently-confirmed-https-origin> --output <private-role-directory>
```

原 journal 的绑定包含完整 grant；回执本身没有 origin。因此不能只找到 prepared token 就导出，也不能从 grant.origin 自动填 expectedOrigin。导出经原绑定和严格事件 projector 验证，必须同时有 prepared 材料和 joined receipt。目录 uncertain 的 joined receipt 允许导出；prepared-only、云端 joined 但本地 ack 丢失尚无 receipt 时均拒绝。丢 ack 后由原加入客户端精确重放原 requestId/摘要，取回并保存 receipt，再导出；不得删除 journal、重建秘密或重新申请能力绕过。

导出方法不联网，不执行 step，不重建秘密，也不追加 journal 事件。CLI 复用既有 journal 的锁定打开流程；指定不存在的 state 可能初始化空 journal 后拒绝，不能将“导出拒绝”描述为任何情况下都零本地写入。正常导出已有 joined state 的 ledger 字节保持不变。

导出两个私有文件 `execute.json`、`observe.json`，各自只含 protocolVersion、origin、ownerId、nodeId、enrollmentId、role 和本角色 token。成功 stdout 只含节点/enrollment ID、role 与文件路径；固定 stderr 不含秘密或底层异常。

### 文件安全、半完成恢复与不覆盖

- Linux-only；私有普通文件同 uid、无 group/other 权限，拒绝最终 symlink、超过 4096 字节和非法 UTF-8；类型、权限与读取使用同一个 `O_NOFOLLOW` descriptor。
- 输出目录同 uid、0700 私有权限、非 symlink；新文件 0600。先独占创建随机临时文件并 fsync，再 hardlink 原子且不覆盖地发布目标，随后 fsync 目录；清理仅限本次实际创建的临时文件。
- 两个文件不是一个原子事务。先 execute 后 observe；第二个失败时保留已成功文件和原 journal。重试对既有文件核对私有属性、严格 schema 与完整规范材料，相同则不改写，不同或损坏则停止，绝不覆盖冲突证据。
- 父路径、主机和安装者必须可信；不提供恶意同 uid 写入者或管理员隔离，也不宣称抵御所有本地路径/inode 竞争。文件系统须支持本地 hardlink/fsync，不支持时拒绝，不能回退到覆盖式 rename。

两个独立文件不意味着同 uid 下的强 OS 隔离。当前原 journal 仍有两套秘密，导出安装者需要访问它和原 grant；权限、不同进程/OS 账户交接及可重复安装在 N06 验收。不要把材料提交 Git、放浏览器持久存储、复制到公开目录或通过命令行参数传 token。

## 单角色核对客户端

```text
node scripts/node-identity.mjs --credential <private-role-file> --expected-origin <independently-confirmed-https-origin>
```

`openCredentialClient` 只读取指定角色文件，不读取另一角色、grant 或 journal。它先严格验证文件和独立 expectedOrigin 匹配，再向固定地址发送本角色 token；成功只输出严格 identityResult，失败固定错误。token 发送到已确认控制面是此 Bearer 身份协议的必要数据流，不能改成发送摘要来“消除告警”（那会将摘要本身变成可重放凭据）。CodeQL 文件到 HTTP 的 advisory 必须按精确 SARIF 源/汇审阅，不能自动 suppress/dismiss 或以扫描成功宣称零漏洞。

## 验证与未验证边界

证据根：`C:/Users/Public/nas_home/AI/GameEditor/linshi/springbok-credentials-20261005/`。Linux 使用固定 Docker 镜像 `sha256:fee853fafa59550d162cef52bca02d907694b44ebf6ef9fb075bcc0c65d8dedb`、Node.js 24.18.1；相同 lockfile 的既有依赖只读挂载，POSIX 私有状态和临时产物使用 tmpfs。源码快照按 LF 哈希核对，不修改 Windows Git 换行配置或历史证据。

测试覆盖双节点/双 owner/双角色、错误寻址/角色/旧 token、默认关闭和独立开关、并发只读及重启、目录 uncertain/原加入期限已过、prepared-only/丢 ack恢复、部分导出/不覆盖、权限/symlink/固定 origin、单角色读取、严格响应/模拟 307，以及空库/schema 1/缺表/未知版本/损坏记录不改证据。重定向验证是注入 fetcher 的 redirect:error 参数与模拟 307 拒绝，不是实际跨站服务器实验。

| 检查 | 实际结果/日志 |
| --- | --- |
| Windows `node --test tests/node-credentials.test.mjs tests/enrollment-contract.test.mjs tests/cloud-admin-boundary.test.mjs` | Node.js 22.22.2，7/7，0 失败/跳过 |
| Linux `node --test tests/cloud/credentials.test.mjs` | 7/7，0 失败/跳过；`snapshot/.tmp/linux-credentials-final.log` |
| Linux `node --test tests/*.test.mjs scripts/ci/security-baseline.test.mjs` | 183/183，0 失败/跳过；`snapshot/.tmp/linux-unit-final.log` |
| Linux `npm test --prefix tests/cloud` | 34/34，0 失败/跳过；`snapshot/.tmp/linux-cloud-final.log` |
| Linux `node tests/browser/cloud-admin.mjs` | 管理页/服务器目录/服务目录/加入四条 Chrome 场景通过；`snapshot/.tmp/linux-browser-final.log`；本项未修改 UI |

独立只读 dirty 实现审查未发现可证实的高/中严重度阻断，主 AI 按源码与运行证据核对；精确最终 head 的审查/CI 另记 PR，不将 dirty 审查当作最终提交审阅。重新 checksum 验证下载的 actionlint 1.7.12 已通过全部 workflow 语法，未额外执行 ShellCheck；Gitleaks 与文档/编码检查结果按精确提交记录。

第一轮 workerd 7 项中 5 通过、2 失败，原因是测试 RPC 辅助函数将 role/token 额外字段传给严格 nodeContext；修正仅测试寻址参数，不放宽生产契约，原失败日志 `snapshot/.tmp/linux-credentials-first.log` 保留。精确最终验证、源码哈希、独立审查、提交/PR/main 检查记录在开发计划和交付回执，未运行的检查不预报成功。

未验证：真实 Cloudflare/Access、外部服务器/多机网络、运行资源限额、不同 OS 账户安装隔离、任务通道、轮换/撤销、持续采集及业务部署。没有创建云资源、配置真实账号/凭据、执行远程安装或生产迁移，也没有清理持久业务数据。
