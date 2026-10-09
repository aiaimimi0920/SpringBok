# SV-07-S03：域名资源与子域名部署

Cloudflare 云资源目录增加“域名”，通过账户限定的 active Zone 只读列表发现、分页并登记。
共享 Zone 不是服务拥有的数据资源，不自动创建，也不随服务删除。

自动新建表单按应用声明的每个 domain target 提供已登记域名和单层子域名选择。
选择域名后，后端核对登记与连接 revision、账户归属、Zone active 状态和名称，
并检查精确 hostname 没有 DNS 记录；公开配置中的 HTTPS origin 由后端生成。
计划与提交都重新读取，最终 URL 进入签名计划的 configuration 和 targets。
登记引用保留在签名草稿中，不作为可删除资源加入 plan.resources。

有默认模板时未选域名继续使用模板；没有模板的域名字段可手动输入 URL。
选择 Zone 时禁用对应手动输入，取消选择后恢复，不能把两种来源同时提交。
既有 API 显式 URL 配置继续保留：它不具有登记 Zone 路径的归属与 DNS 预检保证，
仍受目标合同、账户占用和应用发布预检约束。不能声称所有显式 URL 都已核验 Zone。

同实例升级保持原 URL；本项不提供域名迁移。NAccount 使用既有 Wrangler
custom_domain 配置完成 DNS 与证书部署，平台不另造应用部署入口。
provider 预检与后续发布不是原子 create-only；外部管理员并发修改仍可能产生竞态。
连接验证不等于已证明 Zone/DNS/Workers 的发布权限；真实绑定成功需单独验收。

验证入口：resources、automatic-deployment 的 Node/workerd 测试，以及
tests/browser/domain-deployment.mjs（默认模板和 DOMAIN_MANUAL_FIELD=1 两种模式）。
浏览器测试使用合成供应商，覆盖选择、取消零创建、窄屏、签名计划与单次执行，
不是实际 Cloudflare 域名绑定证据。
