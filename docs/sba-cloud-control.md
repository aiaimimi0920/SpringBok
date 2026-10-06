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
- `runnerOrigin` 为独立 HTTPS origin，不能等于 `ADMIN_ORIGIN`。该 origin 仅允许 `POST /sba/v2/permit`，拒绝 cookie、Origin、query；不可为此放宽管理 Access。
- 执行仓库公开 variable `SBA_RUNNER_ORIGIN` 与 policy 一致。workflow 仅手动 dispatch，使用 windows-2025、PowerShell 5.1、Python 3.12、Node 22；固定 Actions，只有执行 job 获得 id-token:write。

准确验证规则以 `cloud/sba-control.mjs`、`src/sba/github.mjs` 和 `.github/workflows/sba-execute.yml` 为准。

## 状态与不可重放

`GET /api/admin/sba/state` 只读取。preview 返回固定计划和 120 秒会话确认；submit 要求 Access/同源/CSRF，并重新从固定 Git tree 读取可信 manifest。会话 HMAC 不是 manifest 的服务端来源证明。DO 在任何 dispatch 前先持久化 claim；并发确认、刷新、重启不产生第二次 dispatch。

permit 核验 GitHub issuer/JWKS、仓库数字 ID、workflow SHA/ref/tag、hosted runner、首次 attempt，再查精确 run title 绑定 task/digest。秘密齐全后才原子消费许可。许可响应丢失不重发，dispatch 未知不重发，超时/unknown 不解锁。管理 reconcile 是显式动作，临时网络失败保留 running，可信终态失败才转 unknown。

制品回收先核验 run/artifact 关联，下载跳转只接受受限 Azure Blob HTTPS 主机，绝不转发 GitHub bearer。ZIP 限 64 KiB、解压限 32 KiB，只接收一个 receipt.json，并验证 SHA-256、CRC、envelope 和应用结果。应用报告成功不等于用户业务验收。

## 验收与仍开放的边界

证据目录：`C:/Users/Public/nas_home/AI/GameEditor/linshi/springbok-sba-04-s02-b-20261006/`。

- Linux 非 root 根测试：324 通过、3 跳过、0 失败；cloud suite：93/93。
- Windows 聚焦：56 通过、1 跳过、0 失败；不宣称 Windows 全平台 suite 通过。
- `node tests/browser/sba.mjs`：真实 Chrome/workerd，synthetic GitHub/OIDC/ZIP 的预览取消、单提交、刷新、许可与回执整链通过；截图有产物，未人工视觉审图。
- pinned upload-artifact 所用 archiver 7.0.1 的本地同版 producer ZIP 已被 parser 接受；不是实际 Actions artifact 验收。
- actionlint 本地通过；精确提交 Gitleaks 和 PR/main CI 需见交付回执，目录扫描的历史公开 Access audience 命中不能冒充新增秘密或忽略扫描失败。

下一步先交付精确 PR/main，再独立开展真实 Cloudflare/GitHub 配置和端到端部署验收。不得重复 dispatch 猜测结果，不把本地模拟、源码合并、真实部署与业务验收混为一谈。