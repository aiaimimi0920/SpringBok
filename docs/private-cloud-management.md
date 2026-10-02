# 私有云管理页：普通 Workers + Static Assets

本切片延续现有Worker/SQLite DO/Node桥，增加同源管理页与服务器端Cloudflare Access
身份检查。使用普通Workers & Pages产品，不使用Containers、Workers for Platforms、
多租户平台或Sites。**代码测试不等于已创建Access应用/已启用真实身份或已部署PC2**。

页面显示持久任务与节点四阶段回执，并可确认一次固定fixture-cycle。该测试覆盖
部署v1、更新v2、受控失败、回滚v1及卷证据；真实Gateway/Platform/AssetLibrary/
Rauthy/可选Crow仍按owned-service-deployment.md逐项接入，不能把fixture当最终交付。

## 默认拒绝与身份边界

默认ENABLE_ADMIN=no、ADMIN_EMAILS=[]；缺配置不能进入页面或管理API。
所有静态资产先经过Worker（assets.run_worker_first=true），不是隐藏URL。
启用需要ADMIN_ORIGIN精确HTTPS origin、ACCESS_ISSUER精确团队cloudflareaccess.com
HTTPS地址、ACCESS_AUD应用64hex audience、ADMIN_EMAILS仅一个已明确允许的小写邮箱。
本阶段没有多管理员编辑功能；未来扩名单必须另行明确授权，不能通过前端输入添加。

Worker使用锁定jose6.2.12（MIT，官方npm包）验证RS256签名、固定issuer/audience、
exp/iat/nbf与app类型；必须有可信签名的sub/email，邮箱符合服务端名单才授权。
不信任自报email/actor、仅一个Access邮件头、URL携带身份或浏览器localStorage。
服务token不会替代人的身份。Token最多8KiB、最长24小时；Access部署策略宜设短会话。
JWKS只从固定团队/cdn-cgi/access/certs获取，3秒/64KiB限制，不跟随重定向，
不接收JWT提供的jku作为地址。公钥缓存最多5分钟，未知kid有30秒冷却；网络故障在
无有效缓存时拒绝。有效Access会话/缓存的撤销不是瞬时发生，不能宣称即时全局登出。

管理员模式关闭旧/control测试令牌入口。浏览器静态包、API响应、日志和本地存储
不包含CONTROL_TOKEN/NODE_TOKEN/JWT；前端仅拿会话绑定的CSRF和短期确认凭据。
节点/node/poll、/node/report仍用独立NODE_TOKEN，不能管理页面、准备或提交任务。

## 固定操作与持久化

GET /api/admin/state读取记录；POST /api/admin/preview只计算计划、不写任务或审计。
POST /api/admin/submit要求同源JSON、会话+origin绑定CSRF、两分钟内的确认凭据。
确认以当前Access会话派生HMAC，绑定操作者、origin、请求ID、节点、操作、配置摘要、
revision和期限；不用新增持久签名secret。换会话、改计划、过期或状态变化都会拒绝。

DO在同一SQLite事务写入任务和管理员subject的稳定散列。客户端不提供actor。
同ID同输入同操作者重试不增加任务；不同身份/输入冲突拒绝。固定fixture生命周期
只允许一次，不给已用节点开启无界重跑。未知任务继续阻断，页面刷新不会重发部署。
已有A/B领取一次、过期unknown、节点回报重试和持久日志语义保留。

页面显示明确联调范围，原生dialog支持取消/Escape/返回；过期确认自动撤销。
迟到preview不覆盖新页面；提交中禁双击，响应不确定时要求先刷新记录，不自动再发。
刷新身份失败清空旧视图，离页清空内存；无自动轮询/下载/外部脚本/分析统计。

## 实际配置仍需的明确步骤

1. 选择已允许的管理域名，确认ADMIN_ORIGIN；核实Access团队issuer与该应用AUD。
2. 用户确认唯一管理员邮箱，并批准创建/配置Access应用和只允许该身份的策略。
   页面及全部管理API必须在策略保护下；不能给它们设Bypass。
3. 节点入口必须能以NODE_TOKEN访问而无需浏览器登录。可由单独节点hostname映射到
   同一个Worker，管理hostname整体受Access保护；或采用经过独立检查的精确/node/*
   Access层路径配置。任何例外只影响Access外围，Worker节点鉴权不可关闭。
   本切片未创建任何hostname/路由/Access策略，模拟测试不验证真实外围策略部署。
4. 后端配置名单/issuer/AUD等，按已授权安全流程注入节点secret；不把管理token交给
   浏览器，不扩大Wrangler OAuth范围或自动购买计划。ENABLE_ADMIN与fixture/node开关
   分别检查，默认关闭不表示已接入。
5. 实际核验未登录/错误账户访问静态文件和API均失败，允许账户能打开页、确认固定
   任务；PC2能独立领取与回报，并验证云端/节点重启。然后才报告真实链路验收。

旧/control调用者在启用管理员模式后必须停止使用；Node A/B路径与协议无需变化。
Worker新增admin_audit表保留既有mailbox，不覆盖记录。不能通过删DO/删日志解除unknown。
采用run_worker_first后静态请求也调用Worker，受现有CPU/请求计费影响，不承诺零费用或
账单硬上限；本改动没有改变账户计划或部署配置中的10ms CPU限制。

## 验证及来源

cloud/package-lock.json锁运行依赖；tests/cloud锁本地workerd与测试专用esbuild。
本地实际workerd/SQLite用临时RSA合成身份、固定模拟JWKS测试所有资产/API权限、
错误签名/算法/issuer/aud/邮箱/期限、CSRF、篡改与过期确认、重复提交、重启、节点
角色分离；不请求真实Access账户。浏览器CI在实际workerd上测试取消/返回/刷新竞争、
双击、持久回显、390px布局，截图文件名标明synthetic。没有当前真实Access登录证据。

运行前分别npm ci --ignore-scripts --prefix cloud与--prefix tests/cloud；
npm test --prefix tests/cloud。原普通Node合同继续运行，不要求安装Worker认证依赖。

官方依据：
- https://developers.cloudflare.com/workers/static-assets/routing/worker-script/
- https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/
- https://github.com/panva/jose
