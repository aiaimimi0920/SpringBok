# SpringBok 当前范围与开发接续

核对日期：2026-11-12。本页保留当前架构、未完成边界和协作规则，不再累积已完成任务的
领取记录、测试次数、临时故障与逐次发布流水。历史过程使用 Git 与对应 PR 查询；源码、
精确版本测试和真实运行回执优先于文档描述。代码已实现不等于已部署或业务验收通过。

## 当前任务

**CLEANUP-06：历史分支与过期文档清理；负责人：主 AI。**
用户已同意删除核实已合并、无活跃用途的本地/远端分支，以及已被替代的调研、阶段计划
和过程记录。分支删除前保存名称/SHA，核对远端 tip、打开 PR、保护规则与 worktree；
不改写 Git 历史、不删 tag、不处理未确认分支或生产数据。文档删除同步修正链接和入口。
既有 Access 工作树改动不纳入本任务。完成文档、安全合同、示例和构建检查后 scoped
提交、推送、精确 PR 审阅及 main 核验；最终结果记于本任务 PR，不循环追加自身 SHA。

## 1. 产品范围

SpringBok 控制面运行在 Cloudflare Workers，当前聚焦部署，不以大运维面板为前置。

- **SBA 部署主链**：连接 GitHub/云账号 → 选择应用固定提交 → 配置目标、资源和公开字段
  → 审阅确认 → 固定 GitHub Actions 执行器运行应用 SBA → 收取认证回执。
  已有同实例更新、独立验证、隔离预升级、显式修复、受控清理及只读删除核对；支持条件
  以 [共享生命周期](../ai-docs/lifecycle.md) 和 [部署声明](../ai-docs/deployment.md) 为准。
- **外部服务器路线**：目录、加入、分角色凭据、出站控制客户端、systemd 用户服务、心跳
  及有限指标上报已有实现；不等于任意业务部署 Agent、多服务器业务验收或完整监控产品。
- 应用负责构建、备份、迁移、发布和业务验证；平台认证、编排并记录，不推断应用数据结构。
  旧 fixture 的 gateway/forum/game/account ID 不是真实应用部署配置，不隐式重命名或复用。
- Gateway、Platform、AssetLibrary、独立 Rauthy、可选 Crow 只读查询的目标见
  [自有服务接入边界](owned-service-deployment.md)；Hook/Loom 是桌面访问方。
  某个 SBA 应用成功不证明这些独立接入已完成。

历史授权不是当前生产操作许可。开发任务、部署、购买、凭据开通与破坏性操作分别核对。
本轮不部署、不安装节点、不操作业务数据，也不自动启动下文未完成工作。

## 2. 当前源码架构

```text
管理页 → Worker / Access / owner / Origin / CSRF
  → ConnectionVault：连接、业务秘密、资源登记、计划与任务索引
  → DeploymentLocks + ConnectedDeployment：占用、执行任务、一次性许可
  → 固定 GitHub Actions executor → 应用 SBA → 认证 artifact / 回执

独立保留：
  SbaDeployment：固定 policy 的既有任务链
  OwnerCatalog + NodeMailbox：服务器目录、加入、角色控制与心跳
  NodeTelemetry：独立角色授权、有限 latest 指标
  TargetMailbox + Node 出站桥 + Komodo fixture：固定联调
```

入口：`cloud/worker.mjs`、`cloud/admin.mjs`、`cloud/deployment-api.mjs`；
派发：`cloud/connected-api.mjs`；执行与回执：`src/sba/`。
SBA 主链不依赖 Komodo、节点加入或 NodeTelemetry。功能默认值不代表实际线上启用状态。
旧固定 policy 链不随连接设置自动迁移，不能改写旧任务、许可或未知回执来获得新执行机会。

`cloud/wrangler.jsonc` 绑定八个 SQLite Durable Object：TARGET、REGISTRY、NODES、
TELEMETRY、SBA_TASKS、CONNECTIONS、CONNECTED_TASKS、DEPLOYMENT_LOCKS。
控制面未接入 D1/KV/R2 binding；应用部署可使用这些资源，两者不可混淆。未来采用新存储
须明确唯一写入职责、事务和恢复边界，不因整理移除旧类/迁移或丢失持久任务与幂等语义。
KV 不作为互斥与批准消费的权威来源，指标 latest 不是无限历史库；详见
[存储边界](storage-architecture.md) 与 [执行隔离](execution-architecture.md)。

## 3. 现行文档入口

| 读者/主题 | 入口 |
| --- | --- |
| 应用接入、文件、字段与可测试示例 | [AI 接入入口](../ai-docs/README.md)；Pages 渲染同一参考源 |
| 连接运行、秘密与回退边界 | [连接与资源](deployment-connections-plan.md) |
| 管理鉴权与启用 | [私有管理](private-cloud-management.md) |
| 执行器与可信传输 | [执行器](sba-runner.md)、[GitHub 传输](sba-github.md)、[固定任务控制](sba-cloud-control.md) |
| 服务发现、配置与更新 | [生命周期](service-lifecycle.md)、[导入](service-import.md)、[自动部署](automatic-deployment.md)、[升级预览](upgrade-preview.md) |
| 修复、删除和身份初始化 | [修复](service-repair.md)、[删除](service-deletion.md)、[管理员初始化](admin-bootstrap.md) |
| 界面与请求预算 | [Neuro 规范](ui-design-system.md)、[请求效率](ui-request-efficiency.md)、[用量视图](resource-usage-views.md) |
| 节点路线 | [加入](node-enrollment.md)、[凭据](node-credentials.md)、[通道](node-channel.md)、[安装](node-installation.md)、[用户服务](node-user-service.md)、[指标](node-telemetry.md) |
| 安全与发布检查 | [安全质量基线](security-quality-baseline.md)、[报告规则](../.github/DEVELOPMENT_SECURITY.md) |

协议事实以源码为准；新增字段同步共享参考及源码合同测试，不维护第二套历史字段表。
历史 M2/M6/M10 集成 JSON 与 fixture 回归仍有消费者，本轮不删除、覆盖或冒充当前验收。
Komodo 仍需独立评估，不捆绑上游实现或作未经审阅的许可结论。

## 4. 未完成与需重新核实的边界

下表不是自动开发队列，也不把旧计划中的“待办”当成今天仍然缺少代码。
接续时先查对应源码、PR 和实际实例；不得因删除过程文档把未验收事项改为已完成。

| 范围 | 接续边界 |
| --- | --- |
| NAccount | 历史 SV-11 / PR #103 已记录同实例 3.2.5 更新及独立 verify 成功，不再保留早期“尚未首次部署/升级”的过时停点。该记录不证明当前版本或所有登录场景；真实收件、账户登录、短信/外部 OAuth 的后续验收需查应用项目新证据。 |
| EasyProxy | EP-OPS-04 已记录旧登记退役；EP-OPS-06 / PR #147 已记录 1.0.23 原回执认证成功及单次 1.0.24 update 提交。1.0.24 最终应用回执与线上版本需查应用侧后续证据，本轮没有重新核验云端。不得重放旧恢复或以删除文档代替任务核对。 |
| EasyEmail | EMAIL-10/11/12 的部分清理恢复、精确删除核对与邮件 DNS 边界已有代码；原测试副本/旧实例真实清理、正式重建、邮件收发是否完成，须查询新鲜应用与平台记录。不能把早期 unknown 当无副作用，也不能将合成 provider 回归写成实际删除成功。 |
| 外部节点凭据与维护 | N04/N05/N10 的轮换、撤销、安全升级尚无完整产品流程；N06-S02 隔离执行依赖装配、N09 完整环境预检查须独立设计/验收。已有控制 probe 和用户服务不能代替这些工作。 |
| 外部服务器业务部署 | D06–D22 中的真实资源 resolver、多组件执行、业务备份恢复、任意业务启动/停止等并未因 SBA 云部署完成而全部完成；自有目录仍非可执行计划。继续前重新限定所需切片，不照搬旧路线整表开发。 |
| 监控扩展 | CPU/内存/磁盘/网络采集及 latest 小详情已实现；M05、M07–M13 的完整主机信息、多机总览、趋势、持续健康、日志和告警不属于已完成的部署主链，也不是当前部署前置。 |
| 真实环境与恢复 | V01/V02 固定节点链、V03 多机隔离、V04 外部业务全链、V05 跨端故障演练、V06 平台自身数据备份恢复仍需独立证据。Worker 发布/回退已有实际历史，不再称“尚未发布”；长期恢复保障不能由 DO 重启测试替代。 |
| 可选能力 | 控制面 D1/KV/R2、终端、文件/数据库/主机管理及广泛多角色系统按需求决策，不是清理任务的附带开发。 |

详细历史可从提交任务 ID、PR 或 `git log -- docs/development-plan.md` 追溯；不在当前树
复制整个交接日志。历史应用源码 pin 仅是当时依据，不代表当前稳定版本或部署许可。

## 5. 子任务交付规则

1. 读取真实工作树、直接相关源码/测试及前置条件，保留其他人的修改；一次领取一个
   可独立验收子任务，记录 ID、负责人、范围、验收条件与不做事项。
2. 做最小完整变更，保留权限、secret 边界、写前记录、取消、幂等及 UNKNOWN 不重放语义。
   合成测试身份不是人类批准，健康端点不等于完整业务验收。
3. 运行与改动相称的已有验证；记录真实失败/跳过和未验证边界，不重复无变化的已通过检查。
4. 按实际 diff 检查 AI/Pages 双入口影响；共享参考更新即同时更新两种阅读入口。
   文档删除同步修正链接和导航，不为凑文件数复制定义。
5. 立即 scoped commit/push，提交信息包含任务 ID，核对远端 SHA。不得批量暂存其他人的
   修改或等整个阶段完成再提交。精确 PR head 审阅和适用 CI 通过后正常合并，复核 main。
   不绕保护、不重写他人历史；受阻时明确记为待推送/待合并。
6. 本页只保留当前停点与有效边界，最终 SHA/验证回执放对应 PR；任务结束后不再增加
   大段过程记录，也不为引用自身 SHA 循环提交。生产部署与业务验收单独报告。

| 改动层 | 验证入口 |
| --- | --- |
| 文档与示例 | `node --test pages/docs.test.mjs`、`node pages/check-example.mjs`、`node pages/build.mjs <新的空输出目录>`；相对链接/锚点、UTF-8 无 BOM、`git diff --check` |
| 本地契约/执行 | Node.js 22+；`node --test tests/*.test.mjs scripts/ci/security-baseline.test.mjs`，Linux-only 日志测试在 Linux 验证，不删除平台保护来求绿 |
| Worker/身份/持久化 | 锁定依赖安装后 `npm test --prefix tests/cloud`；真实 workerd + 合成身份不是线上 Access 登录 |
| UI | `.github/workflows/demo-browser.yml` 中受影响脚本；共享布局跑四页 Neuro 回归，合成 provider 不是生产业务 |
| 自动化/安全 | 仓库合同、固定版本 actionlint/Gitleaks、现有依赖/CodeQL/OSV 流程 |
| 真实节点/云操作 | 明确授权、精确版本、对应专题流程；不自动 dispatch 特权集成或执行公开示例中的云操作 |

临时脚本、日志和产物优先放 `C:/Users/Public/nas_home/AI/GameEditor/linshi`。
应用接入期间新增或修改的源码、配置、文档使用 UTF-8 无 BOM；不提交秘密或私密部署日志。
