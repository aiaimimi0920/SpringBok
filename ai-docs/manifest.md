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
| repairs | 仅声明 repair 动作时必须出现，1–8 个修复描述；否则禁止出现 |

| runtime 字段 | 当前唯一允许值 |
| --- | --- |
| runner | windows-2025 |
| powershell | 5.1 |
| python | 3.12 |
| node | 22 |

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

事实来源：[contract.mjs](https://github.com/aiaimimi0920/SpringBok/blob/main/src/sba/contract.mjs)、[repair.mjs](https://github.com/aiaimimi0920/SpringBok/blob/main/src/sba/repair.mjs)。完整可校验样例见 [验证](validation.md)。
