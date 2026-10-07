# SpringBok repository rules

## UI 设计规则

正式 cloud-admin 界面统一使用 Neuro 设计方案，先读 `docs/ui-design-system.md`。
本地跨项目规范位于 `C:/Users/Public/nas_home/AI/GameEditor/Neuro/docs/UI设计与颜色方案/`；
项目令牌入口为 `public/cloud-admin/tokens.css`。不得另造竞争黄/绿主色，不以视觉简化
删除权限、风险、unknown/回执语义；保留键盘、窄屏、错误和禁用状态。修改共享布局
需运行四页 Neuro UI 浏览器回归及受影响业务流程，合成截图不等于线上用户验收。

## 产品目的与接续开发

SpringBok 是运行在 Cloudflare Workers 上的统一控制平台，包含两条产品主线：
通过简单交互将服务部署到外部服务器，以及集中监控、管理这些服务器和服务。
2026-10-07 用户明确当前聚焦部署：优先连接设置、资源登记和目标选择，不以大运维
面板或监控 backlog 为部署前置；云运行目标包含 Cloudflare。见
`docs/deployment-connections-plan.md`；历史监控能力与证据保留。
D1、KV、R2 按实际用途选用；当前持久任务实现是 SQLite Durable Object，
不能把它表述成已接入 D1/KV/R2，也不能因新增存储而丢失任务的持久化和幂等语义。

开始任何开发前，依次阅读 `docs/development-plan.md` 和对应子任务引用的源码、
测试、专题文档。总计划是当前产品范围、逐功能进度和下一停点的入口。
真实业务接入还必须阅读 `docs/owned-service-deployment.md`；Gateway、Platform、
AssetLibrary、Rauthy 和可选的 Crow 只读查询是首批场景，Hook/Loom 是桌面访问方。
不要把历史 M1–M14 的样例或单机联调通过，等同于真实 Cloudflare、多服务器或业务验收。

一次领取一个可独立验收的子任务，开始前记录任务 ID、负责人和边界。完成相关验证后，
同步更新进度、证据、未验证项和下一步，立即做该子任务的 scoped commit 并 push，
核对远程 SHA；不得等所有任务或整个阶段完成才提交推送。提交信息带任务 ID。
按仓库既有 PR 流程审阅精确 head、通过检查后正常合并并复核 main，不绕过保护。
如果推送或合并受阻，明确保留为“待推送/待合并”，记录原始错误，不能称为已交付。
详细完成定义、提交步骤和接续模板见总计划；本轮规划不授权执行未来功能或生产部署。

保留其他人的修改，不执行无关 reset、清理或批量暂存；新增和修改的文本统一 UTF-8 无 BOM。
测试和临时产物优先放在 `C:/Users/Public/nas_home/AI/GameEditor/linshi`。

The existing gateway/forum/game/account IDs are contract and fixture identities,
not evidence that the real applications are configured or deployed. Do not rename
or repurpose those IDs implicitly: a real-service catalog adapter needs a separate
reviewed design and regression coverage. Preserve historical integration evidence.
Production execution, infrastructure purchases, credentials/access provisioning
and license selection are not authorized by this planning document. Do not
introduce them, a new application stack or a fork without applicable approval.

Preserve the repository checks described in `docs/security-quality-baseline.md`.
Use pinned Actions and checksum-verified CLI downloads. Keep default workflow
permissions read-only; only CodeQL SARIF publication receives the necessary
job-scoped security-events permission. Never use pull_request_target to run
untrusted contribution code with elevated permissions.

Validate changed automation with the repository contracts, actionlint and
Gitleaks. Review and test an exact PR head before merge, then check main. Do not
claim application tests, builds, vulnerability-lock coverage, or deployment
verification when the corresponding product files do not exist.
