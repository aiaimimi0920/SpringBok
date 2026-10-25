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

## PERF-01-SEC 发布前安全复核

性能 PR #107 通过精确 head 检查后正常合并。main 的动态 Dependabot 安全更新单独失败：
Miniflare `5.20261001.0-alpha` 固定 undici `7.29.1`，不能自动解析到修复版。
2026-10-25 联网 npm audit 确认 `GHSA-4qv8-2p9j-2685`、`GHSA-f72v-6w45-q472` 和
`GHSA-xjj6-f33q-929c` 适用。官方 registry 的 `7.30.1` 支持 Node `>=20.18.1`，与本项目 Node 22 一致。

最小修复仅在 tests/cloud 增加 `miniflare.undici: 7.30.1` 精确 override，并更新实际解析条目的
version/URL/integrity；不修改已发布 Miniflare 包的原依赖声明、不降级/升级 workerd，不改 audit 阈值或忽略名单。
该依赖用于本地/CI workerd 测试，不被控制 Worker bundle 引入；仍需实际 dispatcher、响应体和关闭路径回归，
不能只凭同一主版本或纯 transport 单测宣称兼容。发布在新精确版本的门禁完成前保持暂停。

此追加修复不改变用户界面、SBA 字段、接入或部署生命周期，因此没有新增 ai-docs/Pages 协议或使用说明变更；
原 PERF-01 人类入口的截止/恢复说明继续适用。

隔离安装实际解析 `miniflare → undici 7.30.1`；包含 dev/optional/peer、阈值 low 的联网 npm audit
返回零漏洞。基于该新安装运行时，聚焦合同/workerd/安全 39/39、读取预算/资源/用量/四页 Neuro
四套真实 Chrome 回归通过；Pages 6/6、示例及九页构建通过。完整 Linux 套件仍由新精确 PR/main CI 验证。

PR #108 首轮 Linux 新读取预算回归失败，原错误数量断言为 `4 !== 3`。原因是虚拟时钟推进期间
另一路真实 workerd I/O 尚未结束，也被测试时钟触发了截止。测试现增加正常 fetch/JSON 计数屏障，
仅在未被挂起的读取全部完成后推进时钟，并对普通合成传输增加 40ms 延迟覆盖慢 runner。
原截止、错误数量、partial/unknown 和零重放断言均保留，不修改生产超时。修正后隔离新运行时连续三次通过。

## PERF-01-OIDC 发布门禁的时间夹具修复

PR #108 精确 head 七工作流通过，main `198aaacb89dc49e22d34a727a952ef5f74189484` 的既有
OIDC 拒绝诊断测试暴露 `Missing expected rejection.`：数组创建时计算 exp，循环内重新计算 iat，
异步签名跨秒后预期 601 秒变成合法的 600 秒。生产 `exp - iat > 600` 校验正确，不做修改。
测试改为复用同一 payload 并从其 iat 构造 exp，另加 600 秒接受、601 秒以 time 类别拒绝的边界回归。

隔离复现对旧/新测试的 time 场景都增加 1100ms 延迟，旧版出现相同错误，新版通过；该延迟只在
临时证据中，不进入正常测试。OIDC 28/28、Pages 6/6、安全合同 12/12、示例及九页站点构建通过。
这仅修复测试时间取样，不改变 SBA 字段、实际有效期、诊断类别、用户操作或权限，两种公开文档入口
无新增合同或操作说明需要同步。新精确 PR/main CI 和生产发布仍需分别完成。
