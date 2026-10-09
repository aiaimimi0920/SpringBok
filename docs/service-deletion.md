# 普通服务删除 · SV-06-S01

服务条目的“删除”操作不是隐藏登记项。用户先查看账户、Worker、自定义域名、
D1、KV 的精确身份清单，再确认永久删除服务及其数据。当前支持普通成功部署、
`deployed-unverified` 和有可用连接的导入实例；预升级测试仍使用原清理合同。
运行中、失败/unknown、读取失败、缺少连接或含未支持资源时不启用普通删除。
R2 非空清理及其他供应商尚未实现，不部分删除这些实例。

## 执行与归属

- 控制面已有资源供应接口负责固定 Cloudflare API 的删除，不要求旧应用新增执行动作，
  不改写旧 GitHub SHA、执行器授权或应用结果；这是平台资源管理，不是应用迁移。
- 管理请求要求真人 owner、Origin、CSRF。两分钟确认绑定 operationId 与完整计划摘要；
  提交重新检查源实例最新任务、连接 revision、资源身份与供应商元数据。
- 当前 Worker settings、Pages 当前配置与公开返回绑定信息的保留部署发现共享 D1/KV
  即拒绝。Pages Functions 部署未返回绑定字段、分页未完整读取、权限不足、额外未登记
  数据绑定或资源漂移均失败关闭。读取有界，不把不完整列表当不存在。
- 检查不等于整个账户的任意外部消费者审计；历史 Worker 环境、其他账户/供应商或
  应用通过 HTTP/API 使用资源的依赖不能由当前接口完整证明。Cloudflare 的删除不是
  compare-and-delete，外部管理员并发改名/重建仍需避免；不使用 `force=true`。
- owner SQLite DO 在任何云写前保存意图；逐账户占用原资源归属和执行 lane，
  并阻止同实例升级/预升级。按域名、Worker、数据存储顺序执行，逐项先记 deleting。
- 2xx 空正文合法，仍必须独立 GET 列表读回 absent；全部再次读回后释放精确归属，
  清理已删除资源的目录登记。同名新建使用新实例 ID 与新资源 ID，历史回执保留。
- 删除过的导入身份保留 tombstone，不静默重新登记成活实例；需要新的身份/明确后续
  代次流程，不能复用旧 claim 伪造资源占用。

## 失败语义

云请求响应丢失、部分删除、锁或持久化故障保留 `delete-unknown` 与逐项进度，
不自动重放 DELETE，不移除历史条目伪装成功。重复 operationId 只读原记录。
中断遗留 deleting 超过两分钟显示删除未确认；本项没有自动恢复/重试 unknown 能力。
只对全部资源确认不存在的实例显示“已删除”。

## 验证入口

- `tests/cloud/service-deletion.test.mjs`：工作流与 SQLite 重启、普通/导入/KV、
  共享绑定、过期源、篡改/CSRF/owner、并发、丢响应不重放、同名重建再删除。
- `tests/browser/service-deletion.mjs`：真实 Chrome + workerd、精确清单、取消与焦点、
  共享拒绝、确认、窄屏和刷新后结果；供应商和业务数据为合成夹具。
- 真实 NAccount 不作为破坏性验收夹具；上线核验只打开删除预览后取消。

API 语义已于 2026-10-08 联网查 Cloudflare OpenAPI：Worker DELETE 可空正文，
KV 删除包含键值，D1 删除数据库；R2 Delete Bucket 仅删除空桶，不能替代对象清理。
Pages 绑定字段另以真实只读 API 响应形状核实，OpenAPI 未保证的缺省不当空绑定。
