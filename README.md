# SpringBok

个人多服务器部署工作台，第一步是可运行、可审查的发布流程契约。
Production integration, production execution and license selection remain pending evaluation. M3 provides a loopback-only demo UI, not a production control panel. This repository does not fork or bundle Komodo.

## M14：基线与候选发布差异

同一配置检查页可额外选择基线JSON，对比镜像、双环境目标、端口、卷和密钥引用，
识别服务增删及迁移风险，下载绑定两份配置摘要的差异草稿。基线只是用户文件，
不代表当前部署或已批准的回滚版本。[差异语义与下一接入边界](docs/config-change-review.md)

## M13：本地配置检查页面

运行 `node scripts/config-ui.mjs` 后，打开 http://127.0.0.1:3211 。选择最大64KiB的
服务JSON，检查目标、端口、卷和未解析项，再明确点击下载草稿；输入不保存，
未连接服务器，也不会执行部署。[页面操作与边界](docs/config-review-ui.md)

## M12：填写自己的服务部署配置

Linux / Node.js 22+可运行 `node scripts/config.mjs examples/config/services.json`。
支持1–4类服务的不可变镜像、测试/生产目标、结构化端口、命名卷与未解析密钥引用，
校验冲突后输出确定性配置草稿和未完成项；不连接服务器或执行部署。
[用户配置格式与使用步骤](docs/user-configuration.md)

## M11：发布记录查询

已有持久记录按请求归并，支持固定服务筛选、每页10条、展开目标/镜像/回执与关联事件。
准备独有记录和执行记录使用独立序号，不编造跨日志时间；原始日志不修改。
本轮仅普通测试与假后端浏览器回归，当前UI改动不继承M10真实通过声明。
[记录语义和验证边界](docs/release-history.md)

## M10：合并后的真实联调已通过

已在一次性 GitHub Linux 机器验证 M7确认、M8只读诊断与M9固定资源检查，
并完成四服务样例的部署、更新、失败阻断和回滚。测试资源与临时凭据已清理。
[真实运行与精确源码证据](docs/combined-console-evidence.json)。仍不代表生产接入或身份认证。
[验收断言、权限边界和当前状态](docs/combined-console-verification.md)

## M9：固定资源只读检查

控制台新增固定8资源检查，展示完整配置匹配情况、已知服务器的 Core 缓存状态和
未决执行记录。支持截止时间、取消及重新检查；始终不授予发布权限、不改变记录。
此轮使用假后端及普通浏览器回归。[语义、取消与验证范围](docs/resource-readiness.md)

## M8：看清执行证据与阻断原因

临时测试控制台新增只读证据说明：区分排队、执行中、配置不一致、错镜像、
OOM、暂停和健康检查状态，并给出明确下一步。查看不会写记录、重发部署或
自动解除阻断，未知回执仍保持未知。[使用方式与验证范围](docs/execution-diagnostics.md)

## M7：执行前核对目标和版本

临时真实测试控制台新增执行确认面板：测试、晋级和回滚之前，先看清确切目标、
不可变镜像与配置摘要，再确认执行。取消不写入，旧计划、重启和重复点击受到
服务端校验。此轮用假后端与普通浏览器回归验证，尚未重新运行真实 Komodo；
M6 历史成功证据保留并单独核验。[操作方式与验证边界](docs/execution-confirmation.md)

## M5：看清离线发布计划

本地演示新增“离线计划预览”：选择固定服务、合成场景与操作，查看目标、镜像和配置
摘要、已知状态差异、回滚条件与阻断原因。复用 M4 契约，只读展示；提交结果未知时
明确显示不可发布。预览不写历史、不授予验收、不连接服务器。
[预览使用方式与连接数据边界](docs/plan-preview.md)

## M4：固定执行与中断恢复

新增独立执行协调库：把固定候选与目标、提交前持久意图、Komodo 执行 ID 和结果证据
关联起来。提交结果未知时阻止重复部署；已知 ID 可在重启后只读核对；未使用的验收
在重启时撤销。通过注入 transport 和本地假 HTTP 服务验证故障，不接入演示按钮。
本阶段仅协调预配置资源，还没有真实登录、服务器连接或自动写入部署配置。
[执行接口、恢复策略与真实接入前的限制](docs/execution-recovery.md)

## M3：打开本地演示界面

```sh
node scripts/demo.mjs
```

目前仅支持 Linux、Node.js 22+（Windows/macOS 暂不支持）。
打开 `http://127.0.0.1:3210`，无需安装运行时依赖。四个中文服务卡支持
模拟测试、模拟验收、晋级、回滚与持久历史；重启撤销未使用的模拟验收。
界面显著标注 DEMO，未连接真实服务器。
[使用、安全边界和崩溃恢复](docs/demo-console.md)

## M1：离线契约检查

需要 Node.js 22+，无需安装依赖：

```sh
node scripts/lab.mjs
node --test tests/*.test.mjs scripts/ci/security-baseline.test.mjs
```

第一条命令读取四个无密钥服务模板（Gateway、论坛、在线游戏、账号服务），
输出带序号的离线状态事件，停在“等待人工验收”。输出明确标注 OFFLINE。
这里的成功证据是合成数据，没有部署任何服务器，也没有真正验证四个业务应用。

- `examples/services.json`：固定服务、测试/生产目标 ID 和不可变制品/配置摘要
- `src/contract.mjs`：固定操作、验收绑定、失败状态、已知成功版本回滚契约
- `tests/contract.test.mjs`：流程、拒绝越权、过期验收、失败与回滚回归测试
- `examples/fixture/`：四类业务共用的无状态健康检查样例，不是实际业务实现
- `scripts/ci/container-smoke.sh`：仅隔离 runner 容器冒烟；v1→v2→v1 重建并检查响应

容器冒烟需 Docker：`bash scripts/ci/container-smoke.sh`。容器无对外端口、
无网络、无持久卷、不推送镜像，不部署 Komodo。此检查与离线状态机是两项
独立验证，不是 Komodo 或真实生产发布的端到端验证。

[流程和安全边界](docs/deployment-contract.md) ·
[Komodo 适配评估](docs/komodo-evaluation.md) ·
[仓库安全检查](docs/security-quality-baseline.md) · [安全政策](SECURITY.md)

## M2：真实 Komodo 集成验证

已用真实 Komodo 2.3.3 跑通8个部署映射、4个测试Procedure、四服务样例更新与回滚。
只允许明确授权后的 GitHub 临时测试机运行，需授予临时 Docker 管理权限；
不是可用于生产的安装脚本。[真实集成通过记录](https://github.com/aiaimimi0920/SpringBok/actions/runs/36715595686)
覆盖样例容器与失败阻断；M3另提供演示UI，真实业务、多机及生产人工验收仍待实现。[范围、授权和验收](docs/komodo-integration.md)

## M6：临时单机真实执行测试

新增独立测试控制台，把固定界面操作、配置准备、持久执行记录接到真实
Komodo 测试资源。运行仅限明确授权的 GitHub 临时 Linux 机，已在临时机通过四服务真实浏览器发布、更新、失败阻断、回滚与恢复测试。
准确测试状态见 [真实测试控制台](docs/real-test-console.md)。M3演示入口保持
独立，不连接真实服务器。生产登录、配置所有权与用户服务器接入仍待决策。
