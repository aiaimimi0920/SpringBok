# SBA v2：仓库部署契约与 GitHub 执行路径

任务 `SBA-02`。实现入口：`src/sba/contract.mjs`；验证：`tests/sba-contract.test.mjs`。
本契约不包含业务迁移算法；应用实现如何构建、备份、迁移、发布与验证。

## 执行拓扑与信任边界

云端 SpringBok 鉴权 → 持久任务 → 受控 GitHub Actions `workflow_dispatch` → Windows
runner 检出应用固定 SHA → 读取 `.sba/manifest.json` → 调用仓库入口 → 可信结果回收。
选择 Windows 是为了复用 NAccount 现有 PowerShell 5.1/Python 编排，不引入 Linux
迁移重写或常驻本机依赖。runner 镜像与其软件会维护更新，不宣称机器映像位级可复现；
Actions 固定 commit、应用 SHA/锁文件/构建回执保证来源可追踪。

SpringBok 只允许已配置的仓库和执行 workflow，管理员不能通过请求指定任意脚本或
runner。应用仓库及其 `.sba` 属于可信部署代码，必须审阅精确版本后才授予部署凭据。
不运行不受信 PR/fork、不使用 pull_request_target。后续新增部署 workflow 时单独
补齐安全合同；既有测试 workflow 不能因新增发布通道获得部署秘密或扩大默认权限。

平台通过 GitHub API 触发、查询和下载指定 run 的结果；不用一个公开匿名回调接收
“成功”。workflow/run/任务 ID/目标仓库 SHA 和结果身份必须全部匹配。外部触发结果
未知先核对，不能重新 dispatch；任务互斥、写前记录和未知不重放保留。

## 标准文件与调用方式

唯一机器清单是 `.sba/manifest.json`，v2 示意如下（示例不是可直接部署的应用）：

```json
{
  "schemaVersion": 2,
  "id": "sample-app",
  "name": "Sample App",
  "version": "1.2.0",
  "entrypoint": "springbok.ps1",
  "runtime": { "runner": "windows-2025", "powershell": "5.1", "python": "3.12", "node": "22" },
  "actions": {
    "deploy": { "timeoutSeconds": 3600 },
    "update": { "timeoutSeconds": 3600 },
    "verify": { "timeoutSeconds": 120 }
  },
  "secrets": ["CLOUDFLARE_API_TOKEN"]
}
```

版本是无前缀的稳定 `x.y.z`，数值比较而非字符串比较。更新必须版本严格递增且
SHA 不同；相同版本不同 SHA 不视为正常更新。回滚、预发布和无人值守自动晋级不在
v2 首期范围。候选版本从 GitHub 固定 SHA 的 manifest 读取，不信任浏览器自报版本。

`entrypoint` 必须为 `.sba` 下的简单 `.ps1` 文件名，不接受路径跳转、绝对路径或
命令串。执行端还须核对实际文件/realpath 和符号链接边界。运行目录是应用 checkout 根。
统一参数是 `-RequestPath <绝对输入 JSON 路径> -ResultPath <绝对输出 JSON 路径>`，
采用参数数组启动 PowerShell，禁止拼接 shell。超时上限一小时；超时后的外部状态按
unknown 处理，不因本地进程退出便推断云端没有变化。

输入 JSON 字段：`schemaVersion=2`、`taskId`、`action`、`repository`、`sourceSha`、
`applicationId`、`applicationVersion`、`environment`、`configuration` 和 `previous`。
deploy 的 previous 为 null；update/verify 的 previous 包含前一已知部署的 sourceSha
和 applicationVersion。verify 必须绑定当前选定部署，不能验证另一个候选版本冒充通过。
configuration 是应用解释的公开配置，最大 32 KiB；平台不推断业务字段。

秘密仅按 manifest 的符号名称由受控执行端注入环境；不得放入输入 JSON、Actions
inputs、日志或制品。禁止引用 GITHUB_/ACTIONS_/RUNNER_/SBA_ 保留变量。构建与发布
秘密隔离由 runner 和应用实现共同约束，不能仅靠 manifest 声明获得保证。

应用内部可以调用既有脚本，但必须由统一入口封装并返回结果。NAccount 现有 v1
`deploy.ps1`/`cloudflare.py` 可作为内部实现继续使用；v1 到 v2 是显式适配，不将
原 v1 动作清单静默重新解释，也不由平台追加 NAccount 专属 bootstrap 或 SQL 调用。

## 结果协议

应用原子写入 ResultPath；stdout/stderr 只作受控诊断，不当机器协议。结果字段严格为：

- `schemaVersion`、`taskId`、`action`、`sourceSha`、`applicationVersion`：与输入相同。
- `status`：`succeeded`、`deployed-unverified`、`failed` 或 `unknown`。
- `checks`：最多 30 个唯一 `{id, passed}`；succeeded 至少有一项且全部通过。
- 可选 `errorCode`：有限长度大写代码；不得附原始异常、秘密或无限日志。

只有进程退出码为 0、结果完整匹配且通过验证才能接受 succeeded/deployed-unverified；
非零退出、缺结果、格式错误或未知状态不能推进发布成功。deployed-unverified 不等于
核心业务验收通过。应用对 checks 的真实性负责；首次联合验收仍以真实业务测试核对，
不把应用自报的几个布尔值当作独立证明。

数据 schema 版本、迁移表、备份恢复与幂等全部归应用。平台负责部署任务串行与去重；
重复调用迁移入口是否安全由应用证明。代码恢复不等于数据库恢复；本契约不自动提供
回滚，也不授权删库重建或破坏性迁移。

## 当前交付边界

本项实现纯契约校验与测试。GitHub workflow、执行端文件边界/超时/退出码校验、任务
持久化、可信回执下载、UI 和 NAccount v2 适配由后续任务实现；不得以校验测试成功
宣称已经能部署。相关当前 API/runner 支持由实施时联网核实并记录，不依赖旧记忆。

2026-10-06 联网核实：GitHub 官方 [workflow dispatch REST 文档](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event)
及 [Windows Server 2025 runner 镜像说明](https://github.com/actions/runner-images/blob/main/images/windows/Windows2025-Readme.md)
均返回 200。该事实仅证明所选接口/镜像文档存在，实际仓库 Actions 权限、运行环境、
受保护环境和部署额度在首次运行时另行核验，不提前宣称已运行。
