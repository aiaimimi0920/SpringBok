# PERF-01 资源只读请求性能与生命周期

2026-10-25，负责人主 AI。用户授权审阅、优化并发布 SpringBok 控制平台；本轮不更新业务应用。

## 机制与最小改动

- D1/KV 的 analytics 查询不依赖订阅元数据，却原先等待订阅读取结束才启动。现在两者并行，
  仍等待两份结果后返回相同的用量和 allowance；订阅不可用时 allowance 保持未知，不缓存权限或密钥。
- Workers 账期仍拆为最多五个不重叠的七天窗口，但从逐个等待改为最多两路请求，
  完成后按原窗口顺序汇总。单窗失败保持 partial，全部失败保持 unavailable；未知归属、
  prototype-safe 累加、单位与配额定义不变。不增加上游请求总数。
- 资源页 GET、inventory 和 usage 各自使用 AbortController。账户/清单截止 15 秒，usage 45 秒；
  45 秒覆盖订阅上游 8 秒和最多三波 analytics 的有界等待并保留网络余量。
  计时覆盖 fetch 和响应 JSON 消费。超时清单为错误/不完整，用量未知，不伪造零或完整列表。
- pagehide 和失效身份主动取消浏览器待决只读请求；generation 隔离保留，迟到旧 403 不影响新页面。
  discover 会创建 listing，不属于只读白名单。connect/register/budget 等写操作不附读取截止，
  不自动取消或重放。客户端 abort 不证明服务端停止或回滚。

owner、CSRF、返回前连接 revision/disable 复核、执行许可及 partial/unknown 均不改变。
没有整树 DOM 重构、跨请求缓存、自动重试或权限放宽。重复渲染仅作为后续待量化候选，
未凭代码次数推定真实长任务或本轮收益。

## 验证

新增确定性 transport gates 在修复前失败：D1/KV analytics 未启动、Workers 最大并发仅一；
修改后证明独立启动、最多两路、反序完成及全失败/部分失败语义。
新增真实 Chrome/workerd 页面回归在旧前端因没有 signal 失败；修复后用虚拟时钟和合成
挂起读取验证 15/45 秒、响应体挂起、离页 abort、BFCache 恢复、迟到 403、写操作无 signal/无重放、
键盘与 320px 布局。它不访问生产，也不将合成挂起当线上耗时或服务端取消证明。

```powershell
rtk proxy node --test tests/resource-usage.test.mjs tests/cloud/resource-usage.test.mjs tests/cloud/brand-resources.test.mjs tests/cloud/connections.test.mjs scripts/ci/security-baseline.test.mjs
rtk proxy node tests/browser/resource-read-budget.mjs
rtk proxy node tests/browser/resources.mjs
rtk proxy node tests/browser/resource-usage.mjs
rtk proxy node tests/browser/neuro-ui.mjs
rtk proxy node --test pages/docs.test.mjs
rtk proxy node pages/check-example.mjs
rtk proxy node pages/build.mjs <新的空输出目录>
```

双入口影响：没有 SBA 文件/字段、接入、许可或执行生命周期变化，ai-docs 协议定义不需变动；
Pages 首页人类入口补充实际资源页截止/恢复与写操作边界。内部机制和验证集中在本文，不向管理 UI
加入常驻解释。CI Demo Browser 加入新增回归，保留原四页 Neuro 与资源/用量回归。

当前精确测试与发布证据见总计划。生产发布前需 clean exact-main、完整静态资产、原配置/Access
只读快照及 CI；发布后回读并实际只读验收。不得将本地通过写成已上线。

本地结果：聚焦合同/workerd/安全 39/39、Pages 6/6、示例校验及九页构建通过；
读取预算、原资源、用量和四页 Neuro 浏览器四套通过。固定版本 actionlint 1.7.12 通过，
Gitleaks 8.30.1 对八个变更文件快照未发现泄漏，UTF-8 无 BOM 与 diff whitespace 检查通过。
这不是全历史秘密扫描、全量 Linux 验收或线上加速比例。
