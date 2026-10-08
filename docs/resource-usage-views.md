# 双视角资源用量与规划容量（UI-06）

日期：2026-10-07（接口与额度规则核实日期为 2026-10-08 UTC）。
接续 Session `01a11670-ced0-7dd2-aae8-987b0029b397` 的最后四轮资源展示需求。

## 可见流程

资源页保留品牌添加入口，新增随时切换的两个视图：

- 账户视图：品牌 → 账户 → 资源类别 → 实例。
- 资源视图：资源类别 → 账户 → 实例。

每一级父行在收起时显示用量、所属额度、进度和剩余/超出；展开只增加子级，父行汇总
不会消失。不同类别、指标、单位和周期分行，不制造一个混合总容量。两种视图使用
同一数据模型，实例详情、显式“用于部署”、分页状态与权限结果一致；切换不请求供应商。
两种视图分别保留展开状态，列表内部滚动，支持键盘、窄屏及弹窗焦点恢复。

实例显示自己的用量，不给每个实例复制一份账户免费额度；详情明确标为“账户共享套餐
额度”，并显示套餐 ID、规则核实日期、采样时间。GitHub 仓库只有目录和数量，未提供
仓库存储、Actions 分钟数或账单 API，不编造对应容量。

## 只读计量与来源

`cloud/resource-usage.mjs` 使用现有加密连接，仅访问固定 Cloudflare 官方 subscriptions
GET 和固定只读 GraphQL query。每次上游请求保留 8 秒、262144 字节、拒绝重定向、
错误脱敏的限制；每组最多 1000 条，触顶视为不完整。没有付款、套餐修改或资源创建 API。

| 类别 | 展示指标 | 数据集与计量边界 | 已识别标准套餐的账户额度 |
| --- | --- | --- | --- |
| D1 | 存储 · 今日峰值 | `d1StorageAdaptiveGroups`，当前 UTC 日每库 `max.databaseSizeBytes`；汇总为所列数据库观测峰值之和，不称当前瞬时总占用 | 5 GB |
| KV | 存储 · 今日峰值 | `kvStorageAdaptiveGroups`，当前 UTC 日每 namespace `max.byteCount`；无样本不是零 | 1 GB |
| R2 | 存储 · 最新采样 | 最近 24 小时 `r2StorageAdaptiveGroups`，每 bucket/存储类别最新 `payloadSize`；Standard/IA 分开读取后显示 bytes，类别缺失不当零 | 不把 10 GB-month 填成当前存储硬上限 |
| R2 | 标准存储 · 账期累计 | 标准存储每天的观测峰值除以 30 后累加，单位 GB-month，始终标“估算”；缺天/截断保留不完整 | 10 GB-month / 账期，仅 Standard |
| Workers | 请求 · 本账期 / 今日 | `workersInvocationsAdaptive` 的请求估计值；已知 Paid 账期拆为最多 7 天、不重叠的窗口，否则只读当天 | Paid 且账期已知：1000 万次/账期；明确 Free：10 万次/日 |

额度数值不是声称由 subscriptions API 直接返回：先识别唯一、account scope、非合同、
非外部托管的标准 `workers_paid/free` 或 `r2_paid/free`，再应用本次核实的公开规则。
试用、企业合同、多个冲突订阅、没有读取权限或未识别套餐均不猜额度。Paid 账期未知
时不把按月 Workers 额度用在当日。D1 entitlement 的账户存储硬限制不是套餐免费额度。

R2 的当前占用和累计 GB-month 是两个不同指标。Infrequent Access 不享有 Standard
免费存储层，实际账单另有取整、最低存储时长等规则；这里不是发票、应付金额或实时
计费权威。R2 目录仍限定默认管辖区；查询发现其他管辖区样本时标记相关账户汇总不完整，
不将其挂到同名默认 bucket，也不忽略后计算确定的账户余量。

Workers 同名有效分组累加，历史 `__unknown__` 分组保留为未归属量；它们不伪装成
当前实例。未归属、已删除或目录外实例存在时，展示可归属部分并保留不完整状态。

## 汇总约束

`public/cloud-admin/resource-model.mjs` 从唯一 provider/account/kind/metric/period scope
聚合。一个账户的多个凭据、多个数据库以及重复向父级汇总都不重复计算共享额度。
资源实例按所属账户和真实 ID 去重，不能把两个账户中同名数据库视为同一实例。

已完整读取且可比较时：

```text
总用量 = Σ 各账户用量
总额度 = Σ 各唯一账户额度
剩余 = Σ max(账户额度 - 账户用量, 0)
超出 = Σ max(账户用量 - 账户额度, 0)
```

因此 6 GB / 5 GB 与 1 GB / 5 GB 汇总显示 7 GB / 10 GB，同时保留剩余 4 GB、
超出 1 GB，不能用后一账户的余额抵消前者超额。超出仅显示，不禁用部署按钮。
缺失为 `—`；已知部分用 `≥` 和简短状态；不完整用量/额度不画确定进度或确定余量。
只有完整空目录且相应读取成功、没有未归属数据时才可显示零。

## 手工规划与兼容

用户可在账户的 D1/KV/R2 分组编辑“规划容量 (GB)”。这是按 account + kind 共享的
独立规划指标，不修改供应商套餐、物理容量、实例配置或部署绑定，也不办理付费。
同账户不同凭据看到同一规划；只接受非负整数 bytes（最多 `10^15`）或显式清除。

`cloud/resource-budgets.mjs` 在现有 ConnectionVault 内保留式增加 `usage_budget_meta`
与 `usage_budgets`，不新增 DO binding，不改旧密文/AAD/资源登记。普通 usage 读取不
创建规划表；首次显式保存才在事务中创建。按 owner、当前连接 revision 和规划 revision
校验；并发仅一方 CAS 成功。清除写入 `value: null` 并增加 revision，不删除记录。
表缺失一半、版本未知/较新或连接失效均拒绝，不重建、降级或覆盖原数据。

旧客户端忽略新表且继续使用原目录/部署接口；UI-06 客户端要求对应的新后端。
必要回退保留现行父连接授权和所有数据，仅回退视图或向前修复；不回退到不认识
UI-03 parentId 的后端，不清表，不自动重放 unknown 或已有部署。

`/api/admin/resources` 新增严格的 `usage` 和 `budget` action，仍使用原 Access 用户
鉴权、同源/CSRF 与机器身份拒绝；浏览器不能提交任意上游 URL/query。只读返回前
再次验证连接 revision，防止在途停用后泄漏旧结果。前端最多两条并发读取，保留旧
403 generation fencing、密钥清理和显式部署确认。

## 验证与证据

- `tests/resource-usage.test.mjs`：固定官方请求、套餐边界、单位/周期、R2 类别/管辖区、
  Workers 分窗/未归属、原型安全、上游失败，以及显式 CI 测试入口。
- `tests/resource-model.test.mjs`：所有父级的共享去重、超额不抵消、未知、不同周期隔离。
- `tests/cloud/resource-usage.test.mjs`：实际 workerd/SQLite、只读不建规划表、重启持久化、
  密文/登记不变、双凭据并发 CAS、owner/CSRF/revision/损坏及较新表版本拒绝。
- `tests/browser/resource-usage.mjs`：实际 Chrome/workerd 合成完整流程、两视图/逐层
  汇总/同实例详情、规划保存/清除与焦点、超额仍可选用、权限失败、5 种宽度及身份失效。
- 保留并复验品牌添加、连接、声明、执行、旧 SBA、四页 Neuro 流程；新 workerd 与
  相关品牌/机器身份测试进入 `tests/cloud/package.json`，新浏览器流程进入原工作流。

本轮真实只读 provider 核实已返回 D1 4 个、R2 16 个、Workers 9 个实例样本；KV
成功返回空样本，不能称 KV 使用量为零。Workers 历史未归属仍明确不完整。该探测
直接调用实际 provider 实现，不是用户身份的线上资源页面验收。

证据目录：`linshi/springbok-ui-06-20261007/`，保留初轮 DO RPC、旧 stub、测试身份
恢复方式，以及收尾阶段 CI 入口、表版本、R2 遗漏和焦点回归的原始失败与修复后日志。
`local-proof.json` 绑定源码指纹；精确 PR/main 检查与保配置发布分别写独立回执。
本任务不 dispatch NAccount，不改变其数据、Access、旧任务或现有凭据。

## 官方资料（本轮联网核实）

文档正文和官方 SDK 通过 Cloudflare 官方 GitHub 源取得，原始材料保存在证据目录
`research/`。定价规则后续变化必须重新核实并显式更新日期，不能按未知套餐默认免费。

- https://developers.cloudflare.com/r2/pricing/
- https://developers.cloudflare.com/r2/platform/metrics-analytics/
- https://developers.cloudflare.com/d1/platform/pricing/
- https://developers.cloudflare.com/d1/observability/metrics-analytics/
- https://developers.cloudflare.com/kv/platform/pricing/
- https://developers.cloudflare.com/kv/observability/metrics-analytics/
- https://developers.cloudflare.com/workers/platform/pricing/
- https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-workers-metrics/
- https://github.com/cloudflare/cloudflare-docs
- https://github.com/cloudflare/cloudflare-python
