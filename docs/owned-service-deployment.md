# 首批落地场景：可靠部署自有服务

> 2026-10-06 当前优先验收场景改为：云端 SpringBok 从 GitHub 部署 NAccount 到
> Cloudflare，并执行保留数据的版本更新。见 [联合交付计划](cloudflare-naccount-delivery-plan.md)。
> SpringBok 只执行统一 `.sba` 契约，NAccount 自行实现迁移和业务验证；下文保留原有
> Gateway/Platform/AssetLibrary/Rauthy 场景与历史边界，不作为本次链路的全部前置条件。

> 2026-10-04 产品范围更新：SpringBok 的总体目标是 Cloudflare 上的服务部署平台与
> 服务器监控管理平台，统一进度见 [开发计划](development-plan.md)。本页保留
> 2026-10-02 的自有服务需求、源码 pin 和安全边界，作为首批真实业务接入要求，
> 不再代表全部产品范围。下文“没有独立执行探针”等描述是当时的集成背景；现有
> 固定测试节点桥和执行器见 [节点切片 B](node-fixture-execution.md)，仍不是通用
> 常驻 Agent、真实用户服务器安装或业务验收证明。旧版应用源码 pin 未在本轮更新。

2026-10-02 用户确定：SpringBok 现阶段服务于自有品牌的定制部署需求，优先让
下面的服务能在选定服务器上稳定运行、可验证更新和安全恢复。通用部署平台是
可能的远期方向，不能挤占这条交付链路。本页是非执行目标清单；不含真实凭据、
安装命令、已选服务器地址或部署授权，也不代表下列集成已经完成。

## 实际服务清单

| 目标 | 本阶段职责与位置 | 必须明确的依赖/数据 |
| --- | --- | --- |
| Gateway | 选定服务器上的网关服务 | 明确上游、访问控制、健康检查和固定版本；具体路由由实际应用配置确定 |
| Platform | 保留现有账户业务，接入 Rauthy 身份登录 | 区分身份认证与业务账户/权限；明确 OIDC 客户端、回调、issuer、会话及业务数据库 |
| Rauthy | 独立机器/平台上的原版稳定身份服务，为已接入应用提供登录 | 固定稳定版本、登录域名/TLS、持久数据库及所需卷、密钥引用、备份恢复 |
| AssetLibrary | 新的轻量架构方向：应用服务配合托管 PostgreSQL 与对象存储 | 数据库和对象存储是外部依赖；供应商、实例、迁移实现与权限接入尚待落实，不默认在服务器再部署一套 PG/对象存储 |
| Crow（可选） | 只读查询服务 | 仅访问明确授权的数据源；不部署采集器、采集任务或写入链路，未启用时不阻断其他服务 |

Hook、Loom 是桌面访问方，不安装到服务器。服务之间的实际调用关系必须按各仓库
核实，不能因为共同列在这里就假设所有服务都依赖 Gateway 或已支持 Rauthy。

用户确认旧账号无数据，**不需要旧账号数据迁移或旧账号映射**，不把它作为首次
部署依赖。新登录身份如何关联 Platform 的新业务账户、权限如何校验仍需实现和
测试；这与迁移旧账号是两件事。

## Rauthy 固定来源与上线要求

使用用户的 [Rauthy fork](https://github.com/aiaimimi0920/rauthy)。当前 personal
分支基线为稳定版 v0.36.2，精确提交
[dd61ac3c84d6b238108dc8438b53043b5177a662](https://github.com/aiaimimi0920/rauthy/commit/dd61ac3c84d6b238108dc8438b53043b5177a662)。
main 保持 upstream 跟踪用途，不能将浮动 main/personal 分支或 latest 镜像当发布锁定。
这是源码基线，不是已经构建、签名或验证可部署的镜像；发布还需绑定构建来源、
不可变镜像 digest 和目标架构。升级稳定版本也须单独测试再更新锁定记录。

首次接入应落实独立登录域名、HTTPS/TLS 终止和受信反向代理边界，核对 issuer、
回调 URI、代理头及安全 cookie。不能将现有仅 loopback 的测试控制台直接公开。
具体配置键、端口、数据库选项和存储路径必须以固定版本源码/文档验证，不在此
猜填。数据库与必要卷持久化，容器替换不得清空用户、客户端或身份服务关键数据。
管理员初始化、数据库连接、客户端密钥、加密材料等只记录 secret 引用标识，真实
值通过另行授权的安全配置渠道管理；不得进入仓库、页面导出或 CI 日志。

## 执行依赖和 Cloudflare 控制面边界

现有临时集成已验证 SpringBok Node UI/API → Komodo Core 2.3.3 → Periphery →
Docker 的样例链路，Mongo 8 是 Core 的数据库。它们来自一次性 GitHub 测试环境，
并非已经安装到用户服务器。SpringBok 自身记录另用 Linux 本地 JSON、独占锁和
原子落盘，不在 Core 的 Mongo 中。没有独立可安装的 SpringBok 执行探针。

目标是服务器承载业务与受控执行端，Cloudflare 承载 SpringBok 界面和部署流程。
这仍需适配：用户认证/授权、控制面到执行端的可信通信、固定操作/目标校验、
超时与重复请求处理、持久事务记录及重启恢复。静态托管只解决页面分发；Workers
或 Containers 不自动提供现有本地日志的持久语义，也不能自动控制目标服务器。
Core/Mongo 的长期位置、执行端安装与升级方案、备份位置尚待设计；不能把它们
省略成“只装一个已完成的探针”。长期连接或 Docker 管理权限需明确授权。

## 交付流程与完成条件

1. 核实每项真实应用的启动方式、版本/镜像、健康检查、端口、数据卷和依赖。
   形成测试/生产隔离的固定目标与 secret 引用清单，禁止猜造资源 ID 或健康结果。
2. 将用户配置接入可信资源目录：取得真实 Deployment ID、完整配置及默认值，
   验证 registry manifest/index digest 与目标平台本地 image ID 的对应关系。
   当前 M12–M14 仅审阅/比较草稿，不能直接发送给执行器。
3. 预览确定变更 → 固定测试环境部署 → 健康与业务验收 → 人工批准 → 晋级 →
   复验。批准绑定确切服务、环境、不可变制品与配置；变更使旧批准失效。
   真实人工身份不能用测试 UI 的 actor=human 或一个确认按钮替代。
4. 验收覆盖 Gateway 实际路由、Rauthy 登录/注销与 Platform 业务权限、AssetLibrary
   数据库和对象读写、可选 Crow 只读查询。各服务失败要可定位；未知执行结果阻断
   重试/晋级，不能把收到请求或进程启动视为成功。
5. 发布前验证数据库和卷备份可恢复；涉及 schema 变更或对象格式变化，先验证前后
   版本兼容和恢复顺序。应用镜像回滚不等于数据回滚，不能自动将旧镜像指向不兼容
   的新数据库。只回滚到已知成功、数据兼容的版本；否则停止并要求明确恢复方案。
6. 健康/验收失败不记成功；保留精确请求、制品、配置与执行结果。服务重启、控制面
   中断、重复点击和失败恢复须测试。旧账号无需迁移不代表未来业务数据无需保护。

优先顺序是明确真实服务目录及配置适配，再接通可恢复的测试部署和人工验收链路，
最后验证目标服务器上的安装/更新。不得用更多离线展示替代这些接入缺口，也不得
因本规划跳过生产执行、购买或凭据开通的授权。

## 与现有样例的关系

src/contract.mjs 的 gateway/forum/game/account 及 examples/fixture 是历史契约/
集成测试样例。forum/game/account 不是实际部署清单，不将它们强行改名映射为
Platform/AssetLibrary/Rauthy；现有 compiler 也尚不接受本页的全部真实服务 ID。
真实目录适配须单独设计并回归测试，保留已有样例和历史证据的可复现性。

参见 [配置差异及适配缺口](config-change-review.md)、
[真实联合测试范围](combined-console-verification.md) 和
[持久执行与恢复](execution-recovery.md)。本页更新不声称新增运行时验证。

## 非执行目录与接入检查器

运行 `node scripts/owned-catalog.mjs` 读取固定的 `catalog/owned-services.json`，输出
规范化目录、摘要和逐产品阻断原因。它是后续真实多组件 resolver 的输入边界，
不是现有四样例 `createCatalog` 的替代品，不生成 Deployment、命令或批准记录。
有效输入返回退出码0表示结构检查通过，**不是可部署**；所有选中产品仍是 blocked，
executionReady/executable 始终 false。无效目录返回固定错误，退出码1。

目录精确绑定核查时源码：Gateway 28a3e3d、Platform 6512fd2d、AssetLibrary 9b287d28、
Rauthy dd61ac3c、Crow 3753c240；JSON 存完整40位提交。sourcePath 是该版本的声明
依据，不是镜像构建证明、在线探测或动态源码校验。更新源码 pin 要重新核查相关
路径和语义。摘要随源版本、组件、依赖、健康路径和选择变化；不把摘要当授权。

每个产品拆为 service/migration 组件，dependsOn 是同产品内先后关系，requires
关联外部依赖。Platform 依据 release compose 保留六个常驻组件与三个迁移任务；
required migration 边不可删。AssetLibrary 的 api/web 是目标轻量轮廓，不是已完成的
运行拓扑；其他 worker 取舍仍未确定。Crow query-api 尚无独立实现，sourcePath=null。
Gateway 的 /healthz 只表示存活，/readyz 也不能替代真实路由验收；Rauthy 未在本轮
确认完整健康契约，保留 null，不能因存在 Dockerfile 自动判健康。

依赖列表是初始接入要求，**不是已核实完整运行配置**；每项保留 dependency-inventory-
incomplete 阻断。例如 Gateway 运行模式尚未选定，Platform 仍需核对具体功能对
Gateway/Tea 等外部服务的需求，AssetLibrary 不能直接照搬旧重型 compose，Rauthy
当前目标采用外部托管 PostgreSQL，实例与备份方案仍未绑定。secretRefs 只是未来解析器用的
符号名称，不是应用环境变量映射；不得填真实值，合法标识符也不能证明其中未夹带
秘密。所有 binding 必须 null；测试/生产 ID、镜像制品和可信完整配置要由后续
经认证 resolver 取得，不能通过手填“ready”或任意 ID 绕过。

Crow 默认 not-selected、无阻断原因，启用它才产生只读运行时缺失等原因；其格式
仍接受检查。Hook/Loom 不进入此目录。此轮只读 CLI 没有网络、动态执行或写盘接口。

下一步设计边界是多组件执行适配器：按目录识别迁移与常驻组件，解析可信资源和
不可变制品，检查数据兼容及依赖顺序，再生成绑定整组配置的测试计划；必须区分
组件成功与整个产品验收，失败/未知不允许晋级。现有单 Deployment 的四样例合同
不能直接套用，也不能新增一个任意 shell 执行入口来绕过这个差异。该设计尚未实现，
本轮到目录输入与阻断检查为止。

## Rauthy 独立部署目标（2026-10-02 更新）

用户要求只部署上游原版稳定 v0.36.2，不开发 Rauthy 本体。上述 fork 精确源码基线
保持不变。Rauthy 与主业务服务器分开机器或平台部署；目录中的 independent-runtime
是待绑定的独立目标要求，不是已购实例。运行机器、登录域名、托管 PG 实例和实际
凭据尚未提供，不能购买资源、创建凭据或据此执行部署。

数据库方向为外部托管 PostgreSQL，减少自行维护。目录 policy 仅约束未来解析器：
hiqlite=false、tls=require、verifyCertificate=true、caRef=rauthy.postgres-ca。
它不是可直接启动的 Rauthy 配置。固定 v0.36.2 的对应配置是 HIQLITE=false、
PG_TLS=require、PG_TLS_NO_VERIFY=false；PG_TLS_ROOT_CA 在需要提供者 CA 时通过
已核实的 CA 引用解析，使用公开可信 CA 时也必须验证证书和主机名。不得照抄
上游示例中的 pg_tls_no_verify=true，也不允许 prefer 回落明文。HIQLITE=false
只用于本次明确选择的外部 PG 方案，不自动修改其他服务或现有实例。

Rauthy 独占其数据库、管理员初始化材料、签名私钥和加密材料，独立备份与恢复。
Platform 不持有这些数据或挂载身份服务的卷；公开 JWKS 仅提供验签公钥。
管理员、加密密钥轮换、邮件方案、连接权限与 CA 可信来源仍待安全配置和验收。
所有 secretRefs 只有符号名，不能填值，也不能将 Rauthy 的数据库凭据复用给 Platform。

Platform 依据 [6512fd2d 的跨机器合同](https://github.com/aiaimimi0920/Platform/blob/6512fd2d1f8781001dc83500a65d134b32907a62/docs/40-engineering/rauthy-oidc-integration.md)：

- Web 通过独立 HTTPS issuer/discovery/token/JWKS 完成登录和验签，持有本应用的
  OIDC client secret；还需独立本地 Auth.js 会话密钥、内部服务 token 和业务回调域名，
  三类材料不可复用。当前目录的 oidc-client 引用不代表完整环境配置已齐备。
- account-api 需要精确 issuer 配置、自己的业务数据库和 Redis 登录写入预算，
  接受经过内部服务鉴权的 Web 身份请求；不持有 OIDC client secret，不访问身份库。
  issuer-config 是配置要求，不是本机身份容器或数据库依赖，不能作为同机 dependsOn。
- Web 与 account-api 的 issuer 要逐字一致，包含尾斜线。登录域名与 Platform 回调
  域名可分属不同平台；TLS、反向代理边界和客户端登记必须按实际域名验证。
- 登录后验证 Platform 本地 Auth.js 会话，不逐业务请求远程调用 IdP；JWKS 更新和
  新登录仍需 IdP 可用。当前最长15分钟或 ID token 到期（取较早值），本地退出不等于
  上游全局退出，上游撤销不即时使已有本地会话失效。这些上线限制仍须明确验收。

此 pin 的合成协议/数据库/Redis测试不等于真实跨机器 Rauthy 部署验收。
下一实际部署前仍需固定镜像、绑定两处运行位置、数据库/TLS、独立密钥配置及可恢复
数据方案；本次目录/文档变更继续保持 blocked，不建立连接或生成可执行计划。
