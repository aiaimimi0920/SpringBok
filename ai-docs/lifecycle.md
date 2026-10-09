# 请求、回执与生命周期

## RequestPath：平台输入

| 字段 | 定义 |
| --- | --- |
| schemaVersion | 与 manifest 相同，新接入为 3 |
| taskId | 本次唯一任务标识；控制台生成 dc- 加 32 位小写十六进制 |
| action | manifest 声明的动作 |
| repository | owner/repository，不是任意源码 URL |
| sourceSha | 40 位小写十六进制固定提交 |
| applicationId、applicationVersion | 与当前固定提交的 manifest 一致 |
| environment | 小写字母开头的 2–63 字符标识，可包含数字与连字符 |
| configuration | 公开配置对象；合同 JSON 字符数上限 32768，部署配置还检查 UTF-8 编码上限 |
| previous | deploy 为 null；其他动作包含 sourceSha、applicationVersion |
| context | 仅 preview、destroy-preview、repair 需要；字段按动作严格限制 |

update、preview、repair 必须比 previous 版本更高且 SHA 不同。verify、destroy-preview 必须使用所选部署同版本同 SHA。

## ResultPath：应用输出

用 UTF-8 原子写入 ResultPath，成功写完再结束进程。stdout/stderr 不是协议，不能包含秘密。结果身份必须与请求相同。

| 字段 | 定义 |
| --- | --- |
| schemaVersion、taskId、action、sourceSha、applicationVersion | 原样匹配请求身份 |
| status | succeeded / deployed-unverified / failed / unknown |
| checks | 最多 30 个唯一 `{id, passed}`；id 为小写标识，passed 为布尔值 |
| errorCode | 可选安全错误码，匹配 `[A-Z][A-Z0-9_]{1,79}`；不得添加原异常文本 |
| lifecycle | 仅预升级动作可用，结构见下文 |

succeeded 必须至少一项检查且全部为 true。退出码 0 并不能单独证明成功；非零、缺失、身份不符或格式错误均不能接受为成功。deployed-unverified 不等于业务验收通过，verify 和 repair 不允许该状态。

failed 用于能确定失败边界的情况；有写入且结果不确定应为 unknown。unknown 不自动重放，原回执保持不可变。

## 动作责任

| 动作 | 应用必须承担的行为 |
| --- | --- |
| deploy | 使用确认的配置与资源进行首次部署，验证真实可用性 |
| update | 保留同实例业务数据；succeeded 或 deployed-unverified 必须含 backup-created、data-preserved 两项通过检查 |
| verify | 只验证选定的已部署版本，不借机发布或初始化 |
| preview | 从源数据副本在独立资源演练候选版本，验证迁移并隔离外部副作用 |
| destroy-preview | 只清理批准的预升级资源，不修改源服务 |
| repair | 可选；基于明确父证据实施声明的修复，不重放原任务、不篡改历史 |

## 预升级 context 与 lifecycle

preview context 恰好包含 source、resources、urls。source 包含 instanceId、taskId、sourceSha、applicationVersion、environment、configuration、resources、resultDigest。源 environment 必须不同；新资源不能与源资源身份重叠。

destroy-preview context 恰好包含 instanceId、previewTaskId、resultDigest、resources。资源清单 1–20 项，每项包含 key、kind、accountId、remoteId、name；kind 可为 d1、kv、worker、r2、domain。urls 是 1–8 个唯一 HTTPS origin，须匹配域名资源。完整预升级请求编码不超过 48 KiB。

preview lifecycle 包含 resources、urls、snapshot；resources 各项为 key/status，状态为 created、absent、unknown。snapshot 为 null 或 `{id, createdAt}`，id 是 64 位十六进制摘要，createdAt 是正的安全整数时间值。

preview 成功要求所有资源 created、所有批准 urls、非空 snapshot，并通过 snapshot-copied、migration-verified、source-unchanged、side-effects-isolated 四项检查。destroy-preview lifecycle 仅含 resources，状态可为 removed、absent、failed、unknown；成功必须全部 removed/absent 且 status 为 succeeded。失败可无 lifecycle；只要提供就仍需满足结构与清单匹配。

## 修复 context

repair context 恰好包含 repairId、parentTaskId、parentRunId、requestDigest、resultDigest、errorCode。父任务必须不同，GitHub run 为正整数，两项摘要均为 64 位小写十六进制；操作与错误码必须匹配 manifest.repairs。

repair 成功必须通过 repair-completed、data-preserved、unchanged-resources-verified、service-ready。service-ready 证明应用声明的配置就绪范围，不自动证明用户已完成 Access、邮箱验证或后台登录。

平台普通服务删除不是 manifest 中的第七个 destroy 动作；不要自行发明接口。当前删除流程核对平台持有的资源身份并由用户明确确认，R2 非空清理等未实现路径不能靠文档声称支持。

事实来源：[contract.mjs](https://github.com/aiaimimi0920/SpringBok/blob/main/src/sba/contract.mjs)、[preview.mjs](https://github.com/aiaimimi0920/SpringBok/blob/main/src/sba/preview.mjs)、[repair.mjs](https://github.com/aiaimimi0920/SpringBok/blob/main/src/sba/repair.mjs)。
