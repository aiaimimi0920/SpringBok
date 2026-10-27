# manifest.json：执行合同 v3

新接入使用 schemaVersion 3。校验器只接受白名单字段；不要增加猜测的 description、capabilities、command 或任意 runtime 字段。

| 字段 | 定义与约束 |
| --- | --- |
| schemaVersion | 新接入为整数 3；源码仍显式接受历史 2，不代表两者动作集合相同 |
| id | 稳定应用标识，匹配 `[a-z][a-z0-9-]{1,62}` |
| name | 非空显示名，最多 100 字符，不含控制字符 |
| version | 无 v 前缀、无预发布后缀的稳定 x.y.z；每段最多 9 位且无多余前导零 |
| entrypoint | `.sba` 内简单文件名，匹配 `[a-zA-Z0-9_-]+\.ps1` |
| runtime | 恰好包含 runner、powershell、python、node，值见下表 |
| actions | v3 必须含 deploy、update、verify、preview、destroy-preview；可选 repair |
| actions.*.timeoutSeconds | 每个动作仅此字段，整数 1–3600 秒 |
| secrets | 最多 20 个唯一秘密名称；不是秘密值；匹配 `[A-Z][A-Z0-9_]{1,63}`，受保留名称约束 |
| repairs | 仅声明 repair 动作时必须出现，1–10 个修复描述；否则禁止出现 |

| runtime 字段 | Windows 组合 | Linux 组合 |
| --- | --- | --- |
| runner | windows-2025 | ubuntu-24.04 |
| powershell | 5.1 | 7.6.9 |
| python | 3.12 | 3.12 |
| node | 22 | 22 |

必须选择一整列，不能混用字段或填写 ubuntu-latest、7.x、任意命令或 workflow。入口在
两种 runtime 中都为 PowerShell `.ps1`，参数合同不变。Linux 使用固定官方发行版与摘要
校验的 PowerShell，不依赖 runner 预装的浮动 pwsh；运行于 Ubuntu 24.04 x64，应用内部
可以继续调用 Python、Node、Docker 等既有工具。完整业务工具链、镜像与依赖锁仍归应用。

Linux 支持须先发布兼容控制面、固定 Linux executor workflow 和受保护 SHA；未配置时
失败关闭，不降级到 Windows。现有实例的 update/preview/repair 不允许改变 runtime；
跨 runtime 迁移不属于本合同。verify 仍只获得占位秘密，不授予部署写凭据。

GitHub/Actions/Runner/SBA、Git/Node/npm/Python 等控制变量，以及 PATH、HOME、TEMP 等系统环境变量不能用作秘密名称。完整保留集合由源码校验器决定。

## 可选修复描述

每个 repairs 元素恰好包含以下字段：

| 字段 | 定义 |
| --- | --- |
| id | 唯一标识，与应用 id 同样的格式限制 |
| name | 非空显示名，最多 80 字符 |
| fromErrorCodes | 1–32 个唯一大写错误码，匹配 `[A-Z][A-Z0-9_]{1,79}` |
| secretNames | 唯一名称数组，必须是 manifest.secrets 的子集；可以为空 |

repair 是更高版本固定提交对原失败任务的显式恢复，不是 rerun。未声明的修复操作、错误码或秘密不能凭 UI 推断。

事实来源：[contract.mjs](https://github.com/aiaimimi0920/SpringBok/blob/main/src/sba/contract.mjs)、[runtime.mjs](https://github.com/aiaimimi0920/SpringBok/blob/main/src/sba/runtime.mjs)、[repair.mjs](https://github.com/aiaimimi0920/SpringBok/blob/main/src/sba/repair.mjs)。完整可校验样例见 [验证](validation.md)。
