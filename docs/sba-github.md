# SBA GitHub 传输与身份适配

任务 `SBA-04-S02-A`；实现 `src/sba/github.mjs`，测试 `tests/sba-github.test.mjs`。
这是受控执行链的传输模块，不是授权 API、持久任务队列或应用发布入口。

## 可信配置与来源

`createGithubExecutor(configuration, { token, fetchImpl })` 的配置只能由服务端维护：
执行仓库的名称和数字 ID、workflow 数字 ID/路径、ref、已审阅 executorSha，以及唯一
获准 applicationRepository。浏览器不得提供这些配置。token 仅在固定 GitHub API origin
的 Authorization header 中发送；拒绝 redirect，不跟随响应中的 download_url/run_url。
网络/HTTP/JSON 错误只输出固定错误码，不回显上游 body 或 token。

`readManifest(sourceSha)` 从完整 SHA 的 Git commit → 根 tree → `.sba` tree → manifest blob
读取 v2 清单；核对 Git tree mode，拒绝符号链接、gitlink、截断树及未知契约。
不直接依赖 Contents API 的 type，因为该接口可能解引用仓库内的符号链接。
全部响应有 10 秒 abort deadline 和 256 KiB 流式上限；清单最多 64 KiB、严格 UTF-8。
目录树超过传输上限会拒绝，不通过无界递归或截断结果猜测文件身份。

`prepare(request, manifest)` 复用 v2 校验，按递归排序键的 JSON 计算 SHA-256，绑定
任务/action/应用版本与 SHA/环境/配置/previous。公开请求限制为 48 KiB UTF-8；
不接收任何 secret 值。应用清单的可信来源、精确版本审阅和最终批准仍由调用方负责；
传入任意 manifest 不等于已获授权，configuration 的业务字段约束也仍归配置入口。

## 一次触发与精确核对

调用方**先提交不可重放的持久 claim，再调用 `dispatch`**。一次调用只有一次 POST；
它不是跨调用幂等器，绝不能以重调此方法实现恢复。当前没有公开调用路由。
使用 `return_run_details=true`；仅接受 200、正整数 workflow_run_id 及完全匹配的
GitHub run URL。204、超时、断网、非 200 或畸形响应均为 `unknown`，即使 403/422
也不会自动重试或降级回旧接口。未知时不能建立新的任务再发布相同版本。

workflow 的 inputs 固定为 `request_json`、`request_sha256`、`executor_sha`。
后续接真实凭据前必须采用受保护、不可移动的执行 ref；仅在 POST 前查询 ref SHA 仍有竞态。
后续受控 workflow 还必须在接触部署秘密或应用代码前核对自身 `github.sha`、run_attempt=1、
请求摘要和获准应用版本，并取得一次性持久执行许可。ref 可能移动，**事后发现 SHA
不符不是阻止错误代码执行的安全措施**；本项不声称已经解决该 workflow 侧前置闸门。
run-name 必须为 `sba:<taskId>:<request_sha256>`；这是核对字段，不是单独的信任凭据。

`inspectRun(runId, request, manifest)` 只读取已保存的精确 run ID，核对执行仓库
数字 ID/名称、head 仓库、workflow ID/路径、event、executor SHA、ref、首次 attempt、
标题中的任务和完整摘要及无 PR 关联。没有名称搜索、重新 dispatch 或自动 rerun。
活动 run 返回 pending；非成功终态为 unknown；这两种情况不读取制品。

成功 run 还须有恰好一份 `sba-result-<taskId>-<digest>` 制品，其 run/repository/
head_repository/SHA/ref 均匹配、未过期、1..65536 字节、有 sha256 摘要。
制品列表最多 100 项且必须完整；更多项明确拒绝，不选择部分分页中的第一个匹配。
通过后仅返回 `receipt-available` 和有限元数据，**不是 succeeded 或业务已部署**。

## 下一项与不能省略的验收

`SBA-04-S02-B` 仍须实现持久化/互斥/会话绑定批准、workflow 执行许可与秘密隔离、
可信下载（安全处理 GitHub 制品下载跳转且不转发 token）、压缩包与哈希校验、
run attempt/任务绑定 envelope、`validateResult`、API/UI 及 workerd 重启/并发回归。
实际 workflow 和真实管理员身份仍需验收；只有随后 SBA-05 才执行 NAccount 业务上线。
本模块不暴露外部回调，也不把 GitHub workflow success 当作应用成功。

## 验证与外部接口依据

本项聚焦命令：`node --test tests/sba-contract.test.mjs tests/sba-github.test.mjs`。
模拟 HTTP 覆盖固定 SHA tree、链接拒绝、跨仓库、run/attempt/摘要错配、响应丢失、
不重试、限长、元数据错配及假成功。精确 PR/main 结果见本项交付回执。

2026-10-06 读取 GitHub 官方 REST 文档，页面 HTTP 200：

- [workflow dispatch](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event)：
  API 2026-03-10，return_run_details=true 的 200 返回 workflow_run_id/run_url/html_url。
- [workflow runs](https://docs.github.com/en/rest/actions/workflow-runs#get-a-workflow-run)：精确 run 身份。
- [artifacts](https://docs.github.com/en/rest/actions/artifacts)：run 制品元数据与下载边界。

另只读核对既有 SpringBok main CI run 37465898669 的字段形状；未创建新部署 run、
未读取发布秘密、未变更云资源。模拟测试与既有 CI 字段读取不等于真实 SBA dispatch 验收。
