# SpringBok 产品开发计划与逐功能进度

更新日期：2026-10-05（当前任务开始于 2026-10-04）。代码盘点基线：`52178c7b829af194b7a128d9229c1f4f9194c7ae`，默认分支 `main`。
本页是后续 AI 的总入口；源码、测试及精确版本运行证据优先于描述。每次实施只推进一个可验收子任务，并同步本页。

## 1. 产品目标与本轮边界

SpringBok 部署在 Cloudflare Workers 上，提供两个相互连接、缺一不可的产品部分：

1. **服务部署平台**：接入服务器 → 选择服务 → 填写必要配置 → 审阅变更 → 确认部署 → 查看结果 → 更新或安全恢复。
2. **服务器监控管理平台**：集中查看多台服务器的在线状态、资源用量、服务健康和日志，逐步支持告警及受控管理操作。1Panel/宝塔是能力与交互参照，不是第一版完整复制范围。

Cloudflare 负责界面/API、身份授权、任务协调、状态和数据管理；业务容器、主机指标采集及受控执行在目标服务器上进行。不是“只部署到 Workers”，也不是“在每台服务器单独装一个互不关联的面板”。

首批真实部署场景沿用 [自有服务要求](owned-service-deployment.md)：Gateway、Platform、AssetLibrary、独立 Rauthy、可选 Crow 只读查询。Hook/Loom 不作为服务器负载。未来可增加服务模板，但不以任意 shell 执行或重命名历史 fixture ID 代替适配。

**DOC-01 规划轮只交付开发文档和接续规则。** 用户随后已明确继续开发，实施记录见第 7 节；仍不创建云资源、不安装节点、不配置真实凭据、不执行生产部署。“每子任务提交推送”已获用户明确要求；它不等于所有远程部署、付费或破坏性操作均已获授权。

## 2. 架构基线与存储原则

### 2.1 已存在与尚需产品化的部分

```text
浏览器
  → Workers + Static Assets + Cloudflare Access 验签 [已有固定管理页代码]
  → SQLite Durable Object 任务记录/操作者关联        [已有固定单节点代码]
  ← Node 出站轮询和回执桥                            [已有单次/前台常驻 Linux CLI]
  → Komodo Core / Mongo / Periphery / Docker          [已有固定 fixture 适配]

待补齐：通用服务器目录、节点生命周期、真实服务部署适配、持续指标采集、
        多服务器总览、历史与告警，以及真实 Cloudflare/用户服务器验收。
```

当前不是 SSH 模式，已有单角色控制客户端前台常驻入口，但没有通用业务 Agent、系统服务或持续监控。先复用已有出站桥和已测试契约；是否长期保留 Komodo/Core/Mongo、执行端的资源和许可取舍由 `ARC-01` 决定，不能在后续实现中悄悄换成新栈。

### 2.2 Cloudflare 存储按用途选择

| 组件 | 当前事实 | 拟承担的职责与限制 |
| --- | --- | --- |
| SQLite Durable Object | `cloud/wrangler.jsonc` 已绑定 `TARGET`；`TargetMailbox` 用事务保存任务和操作者关联 | 保留现有每节点串行、先持久化再交付、未知结果不重放语义；扩容前设计版本兼容 |
| D1 | 未配置 binding，未实现 schema/迁移 | 可用于服务器/服务目录、查询索引等关系数据；采用前明确与 DO 的唯一写入职责及一致性 |
| KV | 未配置 namespace，未接入 | 可选非权威配置分发/缓存；不得作为部署互斥、批准消费、幂等判定的唯一真相 |
| R2 | 未配置 bucket，未接入 | 可选归档日志、部署产物或备份对象；必须做访问控制、大小/保留期限制与恢复验证 |

D1 是关系数据库，KV 是键值存储，R2 是对象存储；用户允许按需使用，不要求全部接入。监控指标的频率、聚合、保留期及存储方案由 `ARC-02` 明确，不能把高频样本无限追加到当前最多 100 条的任务邮箱。这里不承诺价格或配额；真正部署前联网核实当时官方限制、实际账户计划与预算。

SpringBok 的存储与被部署应用的数据库是两个边界。Platform、Rauthy、AssetLibrary 的业务数据不能因为平台运行在 Cloudflare 就擅自迁移到 D1/KV/R2。

## 3. 进度与证据口径

### 3.1 状态定义

| 状态 | 含义 |
| --- | --- |
| 已完成 | 该行限定范围已验收、文档已更新、提交已推送；不自动代表生产上线 |
| 已实现 | 已有代码和匹配测试入口；不是本轮全量复验或真实环境通过声明 |
| 部分实现 | 有可复用实现，但尚不满足该行产品验收条件 |
| 待开发 | 尚无该功能的完整实现；表内入口可能只是可复用依赖 |
| 待实测 | 需在明确授权的真实环境完成验证，不用模拟结果替代 |
| 待决策 | 需要先明确方案/是否采用；不是默认增加成本或扩大范围 |
| 进行中 / 阻塞 | 必须另记负责人、精确停点；阻塞要写缺失输入及可继续工作的范围 |

交付状态另记 `待提交 / 待推送 / 待合并 / 已合并`。本次盘点继承的已实现代码已经存在于基线历史，不补造提交。没有可靠工时或统一产品验收，不计算“总完成百分比”，也不以历史 M 编号推算进度。

### 3.2 可复用证据索引

| 编号 | 代码、测试与说明 | 能证明什么 / 不能证明什么 |
| --- | --- | --- |
| E01 | `src/contract.mjs`、`tests/contract.test.mjs`；[部署契约](deployment-contract.md) | 四个固定样例的离线状态机与批准绑定；不是真实人类身份 |
| E02 | `src/config/`、`tests/config*.test.mjs`、`public/config/`；[配置](user-configuration.md)、[差异](config-change-review.md) | 配置编译/审阅/差异；只支持旧四类 ID，草稿不能直接执行 |
| E03 | `src/execution/`、`tests/execution*.test.mjs`；[恢复](execution-recovery.md) | Linux 原子日志、幂等、已知 ID 核对与未知阻断；不是 Workers 本地文件持久化方案 |
| E04 | `src/test-console/`、`public/test-console/`、`tests/test-console.test.mjs`；[M10 证据](combined-console-evidence.json) | 精确旧版本曾在一次性单机跑真实 Komodo/样例容器；不是用户服务器或当前完整树验收 |
| E05 | `cloud/worker.mjs`、`cloud/protocol.mjs`、`tests/cloud/protocol.test.mjs`；[节点协议](cloud-node-protocol.md) | workerd/SQLite 测试与一次领取协议；固定 `pc2-test`，不是多节点注册 |
| E06 | `cloud/access.mjs`、`cloud/admin.mjs`、`public/cloud-admin/`、`tests/cloud/admin.test.mjs`；[管理页](private-cloud-management.md) | 合成 JWT/JWKS 下的身份/CSRF/确认与静态资产保护；没有真实 Access 登录证据 |
| E07 | `src/node-bridge/`、`src/fixture-node/`、`deploy/node-fixture/`、`tests/fixture-node.test.mjs`；[节点执行器](node-fixture-execution.md) | 固定一次 v1→v2→bad→v1 与持久回执；不是任意业务部署、常驻安装器或 PC2 已部署 |
| E08 | `catalog/owned-services.json`、`src/owned-catalog.mjs`、`tests/owned-catalog.test.mjs`；[自有服务](owned-service-deployment.md) | 静态目录与缺口检查；选中四项始终 blocked，`executionReady=false`、`executable=false` |
| E09 | `src/test-console/readiness.mjs`、`diagnostics.mjs`；[资源检查](resource-readiness.md)、[诊断](execution-diagnostics.md) | 固定 8 个资源配置与 Core 缓存状态、单次容器诊断；不是持续主机监控 |
| E10 | `public/test-console/history.mjs`、`tests/history-view.test.mjs`；[发布历史](release-history.md) | 测试控制台记录归并/分页；不是通用云端服务历史 |
| E11 | `.github/workflows/`、`scripts/ci/security-baseline.test.mjs`、[当前安全报告规则](../.github/DEVELOPMENT_SECURITY.md) | 已有功能/安全自动化定义；报告成功不等于无漏洞或已部署，最新结果应按 SHA 查询 |

历史 M2/M6/M10 JSON、文件哈希与 evolution 记录不得覆盖。旧报告及截图可能有保留期限，引用前核实；本轮没有重新执行真实 Komodo、获取真实 Access 身份或连接用户服务器。

## 4. 逐功能子任务进度表

所有 ID 稳定保留。下面每一行是一项独立交付；若实施中发现一行仍过大，先新增带后缀的子任务、拆分验收，再编码，不能拿整张表当一个大提交。依赖列是技术前置，另受安全授权和真实环境条件限制。

### 4.1 规划与云端基础

| ID | 独立功能/交付 | 状态 | 现有证据 / 责任入口 | 验收条件或下一缺口 | 依赖 |
| --- | --- | --- | --- | --- | --- |
| DOC-01 | 产品总计划、逐功能进度与提交接续规则 | 已完成 | 本页、根 `AGENTS.md`、`README.md` | 定位一致；任务有状态/证据/验收/依赖；文档检查通过并提交推送 | 无 |
| ARC-01 | 目标节点执行架构决策 | 已完成 | E03/E05/E07；[执行架构决策](execution-architecture.md)；负责人：主 AI | 已明确首版隔离拓扑、只读采集分权、旧协议保留、资源/许可边界；仅设计完成，安装和运行代码按 N/D/M 任务实施 | DOC-01 |
| ARC-02 | 控制面与监控数据模型/存储决策 | 已完成 | E05；[存储设计](storage-architecture.md)；负责人：主 AI | 明确 owner 目录 DO、节点授权/任务原子边界、独立观测存储、跨对象中间态和兼容策略；D1/KV/R2 暂缓按需接入 | ARC-01 |
| C01 | Worker 同源静态资源和 API 骨架 | 已实现 | E05/E06；`cloud/wrangler.jsonc` | 资产先过 Worker；默认关闭；产品页面扩展仍待后续任务 | 无 |
| C02 | Cloudflare Access 服务端管理员鉴权 | 已实现 | E06 | 验签与固定名单已编码；真实账号/策略验收由 V01 承担，不等于多角色系统 | C01 |
| C03 | 固定任务的 SQLite DO 事务持久化 | 已实现 | E05；`TargetMailbox` | 当前单节点 100 条上限；保留同 ID 同输入幂等、未知不重投；多节点由 N01 扩展 | C01 |
| C04 | 持久服务器/服务目录 | 已完成 | 服务器目录见 C04-S01；服务目录见 C04-S02 | 两类持久元数据、owner 隔离和关联约束已验收并合并；不代表节点/业务接入 | ARC-02 |
| C04-S01 | 持久服务器目录与管理页 | 已完成 | [实现与验收](server-catalog.md)；负责人：主 AI；PR #33 已合并 | owner 隔离、创建/改名/归档、幂等/revision、SQLite 重启、失败关闭、默认关闭与页面验收通过；main 合并后 CI 通过，不等于节点已接入 | ARC-02 |
| C04-S02 | 持久服务目录与服务器引用 | 已完成 | [实现与验收](service-catalog.md)；负责人：主 AI；PR #34 已合并 | 创建/改名/归档、owner/reference、服务器归档关联阻断、共享 revision/幂等、保留式迁移和页面验收通过；main 检查通过，不生成可执行配置 | C04-S01 |
| C05 | D1 数据访问与迁移（按需） | 待决策 | 当前无 D1 binding | ARC-02 采用后才实现 schema、隔离测试与迁移恢复；不采用则记录理由，不阻断无关任务 | ARC-02 |
| C06 | KV 非权威缓存（按需） | 待决策 | 当前无 KV binding | 明确陈旧数据容忍度、失效规则；关闭缓存不影响部署安全 | ARC-02 |
| C07 | R2 对象归档（按需） | 待决策 | 当前无 R2 binding | 受权上传/下载、对象归属、大小/配额、保留和恢复验证；不公开原始日志或凭据 | ARC-02 |
| C08 | 操作权限与资源所有权校验 | 部分实现 | E06 仅固定管理员/固定节点 | 每条部署/监控/管理 API 校验 actor、服务器、服务和操作；先满足单管理员，不强造租户系统 | C02/C04 |
| C09 | 通用操作审计查询 | 部分实现 | E06 仅任务 ID→actor 散列 | 关联主体、动作、目标、时间、结果和配置摘要；分页、脱敏；失败和拒绝不能伪造成功 | C04/C08 |
| C10 | 云端配置与 secret 引用管理 | 部分实现 | E02/E08 仅未解析符号 | 安全配置入口、权限/轮换边界、日志脱敏；浏览器和 Git 不含实际 secret；节点映射见 D06 | C08 |

### 4.2 服务器接入与节点生命周期

| ID | 独立功能/交付 | 状态 | 现有证据 / 责任入口 | 验收条件或下一缺口 | 依赖 |
| --- | --- | --- | --- | --- | --- |
| N00 | 固定节点出站任务桥 | 已实现 | E05/E07；`src/node-bridge/bridge.mjs` | 单次 Linux CLI、HTTPS 固定 origin、写前日志与回执重送；非后台 Agent | C03 |
| N01 | 多节点任务寻址与隔离 | 已完成 | 内部持久隔离见 N01-S01；认证控制通道见 N01-S02 | 双节点/双 owner 的已加入身份、独立 mailbox、领取/回报隔离与旧协议回归通过；仅控制 probe，不等于真实多机、业务执行或 V03 验收 | ARC-01/C04-S01 |
| N01-S01 | 独立节点邮箱与内部只读协议 | 已完成 | [实现与验收](node-mailbox.md)；负责人：主 AI；PR #35 已合并 | 版本化独立 DO、owner/node 不可变绑定、双节点只读 probe、一次交付/幂等/重启/未知阻断已验证；main 检查通过，公开任务通道保持不可用 | ARC-01/C04-S01 |
| N01-S02 | 认证节点通道与出站桥接入 | 已完成 | [实现与验收](node-channel.md)；负责人：主 AI；交付进度见第 7.9 节 | 已加入 execute 身份、事务内认证/领取、管理员 API→Linux 桥→SQLite 回执与双节点隔离通过；不复用旧 NODE_TOKEN，PR/main 检查另记回执 | N01-S01/N02/N03 |
| N02 | 服务器注册与一次性加入流程 | 已完成 | [实现与验收](node-enrollment.md)；负责人：主 AI；交付流程见第 7.7 节 | 保存后授权、一次性加入、过期/冲突拒绝和跨 DO 恢复已通过本地验收并提交推送；PR 合并检查另记回执，不代表真实服务器已接入 | N01-S01/C08 |
| N03 | 每节点独立凭据 | 已完成 | [实现与验收](node-credentials.md)；负责人：主 AI；交付进度见第 7.8 节 | joined 角色摘要、独立角色材料和本地 workerd 身份核对已验证并提交推送；PR/main 检查另记回执，任务通道仍归 N01-S02 | N02 |
| N04 | 节点凭据轮换 | 待开发 | 当前无轮换流程 | 有界切换窗口、旧凭据失效、在途任务不重复执行、全链路不回显秘密 | N03 |
| N05 | 节点撤销接入 | 待开发 | 当前无撤销流程 | 撤销后不能领取新任务；保留历史/未知证据，不隐式卸载或删除业务数据 | N03/C09 |
| N06 | 执行端可重复安装包/引导 | 部分实现 | 控制客户端见 N06-S01；执行依赖装配见 N06-S02；E07 保留 | 非特权角色安装与完整执行依赖分开验收；不覆盖现有服务，不将控制 probe 当业务执行环境 | ARC-01/N03 |
| N06-S01 | 固定版本控制客户端包与非特权单角色安装 | 已完成 | [实现与验收](node-installation.md)；负责人：主 AI；PR #39，交付见第 7.10 节 | 固定清单/摘要、私有安装、不覆盖/半完成恢复、不同 Linux uid 隔离、安装后 CLI/workerd 控制 probe 已验并提交推送；PR/main 最终状态按回执 | ARC-01/N03/N01-S02 |
| N06-S02 | 隔离执行依赖安装与真实测试机装配 | 待开发 | E07；[执行架构](execution-architecture.md) | 明确依赖许可/来源与容量，在获准独立 rootless 环境装配 Core/Mongo/Periphery 并验收；不由 S01 提前完成 | N06-S01 |
| N07 | 常驻运行与开机启动 | 部分实现 | 进程生命周期见 N07-S01；系统服务见 N07-S02 | 前台常驻和系统开机启动分开验收；业务执行仍受 N06-S02 限制 | N06-S01 |
| N07-S01 | 控制客户端常驻循环与安全退出 | 已完成 | [实现与验收](node-daemon.md)；负责人：主 AI；PR #40，交付见第 7.11 节 | execute/observe 单角色常驻、至少 30 秒间隔、有界退避、单实例、安全退出、unknown 不重放已验收并提交推送；PR/main 最终检查见回执，不含开机启动 | N06-S01 |
| N07-S02 | 非特权系统服务与开机启动 | 待开发 | 后续按真实 Linux service manager 单独验收 | 可信 unit/安装路径、显式启停、重启策略与开机启动；不盲删锁、不自动扩大权限或创建用户主机账号 | N07-S01 |
| N08 | 节点心跳与离线判定 | 待开发 | E09 的 Core 缓存不能替代心跳 | 带采样/接收时间与过期阈值；断网显示离线/陈旧，时钟偏差不伪造在线 | N07 |
| N09 | 节点运行环境预检查 | 部分实现 | E07 手工 rootless/容量要求、E09 固定资源检查 | OS/架构/版本/权限/磁盘和资源余量结构化上报；不满足时阻止部署 | N07 |
| N10 | 节点程序安全升级 | 待开发 | 尚无发行升级链 | 校验固定产物/版本，兼容协议，失败可恢复；在途未知任务不自动重做 | N06/N07 |
| N11 | 固定 fixture 生命周期执行器 | 已实现 | E07；`src/fixture-node/executor.mjs` | 固定一次 v1→v2→bad→v1，核对容器/镜像/卷/回执；不是实际业务执行器，真实链由 V02 验收 | N00 |

### 4.3 服务部署功能

| ID | 独立功能/交付 | 状态 | 现有证据 / 责任入口 | 验收条件或下一缺口 | 依赖 |
| --- | --- | --- | --- | --- | --- |
| D01 | 固定四样例部署/验收/回滚契约 | 已实现 | E01 | 继续保留 fixture ID 与回归；不能改名冒充真实服务 | 无 |
| D02 | 离线服务配置编译 | 已实现 | E02；`compileConfiguration` | 不可变镜像、端口/卷冲突和 secret 引用校验；输出只读草稿 | D01 |
| D03 | 配置文件审阅页 | 已实现 | E02；`public/config/` | 本地文件输入、错误展示、显式下载草稿；不是生产配置保存/执行入口 | D02 |
| D04 | 基线/候选配置差异审阅 | 已实现 | E02；`compare.mjs` | 展示增删、版本/环境/端口/卷/引用差异；文件基线不冒充当前部署 | D02 |
| D05 | 自有服务静态目录与阻断检查 | 已实现 | E08；`inspectOwnedCatalog` | 分组件/依赖、校验 pin；保持所有真实 binding 未解析时不可执行 | 无 |
| D06 | 真实运行配置与 secret 映射 | 待开发 | E02/E08 仅符号和声明 | 按产品固定版本核实环境变量、端口、卷、健康契约；引用在授权执行端解析，不能凭名称猜配置 | D05/C10 |
| D07 | 可信资源与镜像解析器 | 待开发 | E03/E07 有固定目录校验可复用 | 取得真实服务器/Deployment 所有权、完整默认配置、digest 与架构；失配/缺失拒绝生成可执行计划 | D06/N09 |
| D08 | 简单交互的服务部署向导 | 待开发 | E02/E06 分离的固定页面 | 选服务器/服务、必要配置、错误提示、确认页和返回修改；不要求用户手写旧 fixture JSON | C04/D07 |
| D09 | 云端真实服务部署计划与差异预览 | 部分实现 | E02/E03/E06 只有离线或固定 fixture 预览 | 绑定真实主体/目标/制品/整组配置/revision；取消不写任务，变更使旧确认失效 | D07/C08 |
| D10 | 云端发起单服务首次部署 | 部分实现 | E03/E04/E07 仅固定样例执行 | 从管理页到已接入节点跑真实服务；一次提交、精确回执、失败可定位，不能只返回 accepted | D08/D09/N07 |
| D11 | 业务就绪验证 | 部分实现 | E07 有 fixture 健康/卷，E09 有容器诊断 | 区分进程启动、容器健康、依赖就绪、业务验收；按实际应用验证，不把 `/healthz` 当业务全通过 | D10 |
| D12 | 测试验收与生产晋级批准 | 部分实现 | E01/E03 合成人工；E06 仅 fixture 确认 | 真实身份批准绑定确切版本/配置/目标；失效/过期/跨服务拒绝；AI 不能伪造人工验收 | D09/D11/C08 |
| D13 | 多组件顺序与迁移任务编排 | 待开发 | E08 已记录 Platform 迁移依赖 | 拓扑顺序、组件级回执、迁移失败阻断；组件成功不等于产品成功；中断不重复迁移 | D07/D10 |
| D14 | 已部署服务版本更新 | 部分实现 | E04/E07 有 v1→v2 固定样例 | 选择不可变新版本、审阅差异、执行/验收；失败保留旧成功记录 | D10/D11 |
| D15 | 已知成功版本回滚 | 部分实现 | E01/E03/E07 有 fixture 回滚 | 只回滚到该服务/环境的已知成功版本；先检查数据兼容，不任意指定旧镜像 | D14/D16 |
| D16 | 业务数据备份与恢复前置检查 | 待开发 | [自有服务恢复要求](owned-service-deployment.md) | 数据库/卷/对象恢复演练，记录兼容与恢复顺序；镜像回滚不能伪装成数据回滚 | D06/D11 |
| D17 | 部署进度与失败诊断页 | 部分实现 | E06 固定阶段；E09 固定诊断 | 显示真实任务阶段、时间、精确失败与可操作下一步；原始秘密/任意 backend 错误不直接回显 | D10/C09 |
| D18 | 部署中断后的安全核对与恢复 | 部分实现 | E03/E05/E07 已阻断未知 | 重启核对已知执行 ID；未知有明确取证/人工处理流程，不删日志/重置标记自动重试 | D10/N07 |
| D19 | 云端服务发布历史 | 部分实现 | E10 本地分页；E06 固定任务列表 | 按服务器/服务/环境查询版本、配置、批准、执行结果；审计关联不串服务 | D10/C09 |
| D20 | 服务启动操作 | 待开发 | 尚无产品入口 | 仅对已登记且授权的服务启动，显示状态结果并留审计；与部署动作区分 | D10/C08 |
| D21 | 服务停止操作 | 待开发 | 尚无产品入口 | 明确影响与确认，停止不删数据；结果未知不能报告已停 | D10/C08 |
| D22 | 服务重启操作 | 待开发 | 尚无产品入口 | 明确影响与确认、幂等/未知语义和审计；不提供任意命令字段 | D10/C08 |

### 4.4 服务器监控功能

监控不是所有部署功能完成后才开始：注册、常驻和心跳形成后，即可推进只读指标切片。每个指标的“未知/陈旧/采集失败”必须与数值 0 分开。

| ID | 独立功能/交付 | 状态 | 现有证据 / 责任入口 | 验收条件或下一缺口 | 依赖 |
| --- | --- | --- | --- | --- | --- |
| M01 | CPU 使用率采集 | 待开发 | 当前 CPU 字段仅容器限额配置 | 固定间隔差分、核数/单位明确、空闲和负载下与主机工具对照；最小读取权限 | N07 |
| M02 | 内存用量采集 | 待开发 | 当前无主机内存采集器 | 总量/可用/已用口径明确；容器限额与宿主用量不混淆；与主机对照 | N07 |
| M03 | 磁盘容量采集 | 待开发 | 当前无磁盘采集器 | 明确挂载点、总量/可用/使用率，过滤伪文件系统；不能为测量写满或清理磁盘 | N07 |
| M04 | 网络吞吐采集 | 待开发 | 当前无网络采集器 | 网卡累计计数差分、单位、重启/计数回绕处理；不抓取业务内容 | N07 |
| M05 | 主机基础信息与运行时间 | 待开发 | N09 预检查可复用 | OS/架构/内核/运行时间/版本与时间戳；仅采集必要元数据，不上传完整环境变量 | N09 |
| M06 | 指标上报与最新快照存储 | 待开发 | E05 任务回执不是指标协议 | 节点鉴权、schema/大小/频率校验、乱序去重、采样/接收时间；不堵塞任务通道 | ARC-02/N03/N08/M01 |
| M07 | 多服务器状态总览 | 待开发 | 当前管理页只有固定任务列表 | 在线/离线/陈旧、CPU/内存/磁盘/网络与更新时间；至少两节点数据隔离，空值不假绿 | C04/N08/M02/M03/M04/M06 |
| M08 | 服务器详情与历史趋势 | 待开发 | 当前无指标时序 API/UI | 时间范围、聚合/保留期、缺测间隙和时区明确；容量与查询耗时有界 | M06/M07 |
| M09 | 服务/容器持续健康状态 | 部分实现 | E09 只在执行时单次读取 | 周期采集已授权服务状态/健康/OOM/重启次数，带新鲜度；不把 Core 缓存视为实时 | D10/N07/M06 |
| M10 | 受控服务日志查看 | 待开发 | 当前只有结构化任务/诊断记录 | 限定已登记服务、分页/尾部与大小限制、敏感信息脱敏、访问审计；禁止任意文件路径 | C08/M09 |
| M11 | 告警规则与触发/恢复判定 | 待开发 | 当前无告警引擎 | 离线、资源阈值和服务异常独立规则；持续时长/去抖/恢复、重复事件归并 | N08/M06/M09 |
| M12 | 告警通知投递 | 待开发 | 当前无通知通道 | 先接一个获准渠道；安全凭据、失败重试上限、去重、投递结果；不承诺必达 | M11/C10 |
| M13 | 告警列表与人工确认 | 待开发 | 当前无告警页面 | 按节点/服务筛选、确认与恢复分开、操作者审计；确认不伪造故障已恢复 | M11/C09 |

### 4.5 首批真实业务接入

下列工作先核对对应仓库的新鲜源码与产物，不按旧 pin 推定当前可部署。每个产品的开发改动仍由其独立仓库 owner 负责，SpringBok 不顺手修改其他项目。

| ID | 独立接入场景 | 状态 | 现有证据 / 责任入口 | 验收条件或阻断 | 依赖 |
| --- | --- | --- | --- | --- | --- |
| B01 | Gateway 部署模板与业务验收 | 部分实现 | E08 仅目录 | 明确运行模式/依赖、真实路由、认证、固定镜像、测试目标；不是健康端点返回 200 即完成 | D06/D07/D10/D11 |
| B02 | Rauthy 独立部署模板与登录验收 | 部分实现 | E08、[独立身份边界](owned-service-deployment.md) | 独立目标、核实稳定版本/制品、托管 PG/TLS/备份、登录注销；不开发 Rauthy 本体 | D06/D07/D10/D16 |
| B03 | Platform 多组件部署与身份集成验收 | 部分实现 | E08 仅组件/迁移/OIDC 要求 | 迁移顺序、独立业务库、issuer/回调/密钥边界、真实登录及业务权限 | D13/B02 |
| B04 | AssetLibrary 轻量部署与数据验收 | 部分实现 | E08 仅目标轮廓 | 先核实轻量运行拓扑，再验证托管 PG/对象读写和恢复；不照搬旧重型 Compose | D06/D07/D10/D16 |
| B05 | Crow 可选只读查询部署 | 待决策 | E08 默认 `not-selected` | 明确启用后实现独立只读运行时与授权数据源；不安装采集器；未启用不阻断首版 | D06/D07/D10 |

### 4.6 真实环境验收、交付与维护

| ID | 独立验收/交付 | 状态 | 现有证据 / 责任入口 | 通过条件 | 依赖 |
| --- | --- | --- | --- | --- | --- |
| V01 | 真实 Cloudflare/Access 管理面验收 | 待实测 | E06；所有启用开关仍关闭 | 获准账户/域名/策略/管理员；未授权资产/API 均拒绝，合法身份可读写固定任务；核实费用边界 | C01/C02/C03 |
| V02 | 云端到单台外部测试服务器 fixture 全链验收 | 待实测 | E07 模板；无新链真实通过证据 | 获准隔离节点、真实 Core/Periphery、四阶段/卷及双端重启；不动原有服务 | V01/ARC-01 |
| V03 | 两台服务器并存与权限隔离验收 | 待开发 | 当前只有固定单节点 | 独立加入/凭据/任务/指标；A 故障不误报或操作 B，错节点回执拒绝 | N01–N08/M07 |
| V04 | 真实服务从向导部署到监控可见 | 待开发 | 尚无完整产品链 | 至少 B01：用户从页面部署，验证业务，查看持续健康/资源、更新与恢复记录 | B01/D08/D14/D15/M07/M09/V02 |
| V05 | 控制面/节点故障恢复演练 | 待开发 | E03/E05/E07 仅局部恢复测试 | 云端重启、节点重启/离线、丢 ack、重复点击、过期批准；不重复有副作用操作 | D18/N07/V03 |
| V06 | SpringBok 自身数据备份恢复 | 待开发 | 仅有局部日志/DO 重启测试 | 目录、任务/审计、指标/归档分别定策略；恢复后身份/任务关联不丢不串，不删数据解锁 | ARC-02/C04/C09 |
| V07 | Worker 版本化发布与回退说明 | 待开发 | 当前无自动部署 workflow | 锁定源码/依赖、绑定说明、迁移兼容、上一版本回退与验收入口；生产发布另核授权 | V01/ARC-02 |
| Q01 | Windows 检出换行兼容性 | 待开发 | 本轮发现 `core.autocrlf=true`；安全测试包含 LF 精确断言 | 独立修复换行约定/测试读取兼容并验证 Windows/Linux；不在文档任务混改 CI 或降低门禁 | DOC-01 |

### 4.7 暂不计入首版承诺的面板扩展

| ID | 候选功能 | 状态 | 进入开发前需要明确 | 依赖 |
| --- | --- | --- | --- | --- |
| X01 | Web 终端 | 待决策 | 实际需求、命令权限/审计、会话安全；不开放任意 shell 来绕过部署契约 | C08/N03 |
| X02 | 服务器文件管理 | 待决策 | 允许路径、上传下载边界、危险操作确认与数据保护 | C08/N03 |
| X03 | 业务数据库管理界面 | 待决策 | 支持哪些数据库、访问/写权限及备份；与 SpringBok 自身 D1 管理区分 | C08 |
| X04 | 域名/TLS 管理 | 待决策 | 管理范围、证书/域名授权及续期职责；不默认修改用户 DNS | C08 |
| X05 | 防火墙/主机级管理 | 待决策 | 明确高权限需求、失联恢复与审批；不默认提供全机管理权限 | C08/N09 |

## 5. 推进顺序：先做可用链路，不反复堆离线演示

| 阶段 | 目标 | 建议顺序与停止条件 |
| --- | --- | --- |
| R0 | 建立真实进度与交接入口 | DOC-01；文档交付后停止本轮，不自动开始实现 |
| R1 | 固定现有执行边界，拿到第一条真实云端测试链 | ARC-01 → ARC-02；具备明确授权后 V01 → V02；缺云账号/测试节点时推进不依赖它们的代码，不能伪造通过 |
| R2 | 可接入、可观察的服务器 | C04/C08 → N01/N02/N03 → N06/N07/N08；随后 M01/M06，再补 M02/M03/M04/M07；N04/N05 补齐凭据生命周期 |
| R3 | 用户可用的首次部署 | D06/D07 → D09/D08 → D10/D11 → B01；同步 M09/D17，让用户能看见真实结果 |
| R4 | 可靠更新与恢复 | D12/D14/D16/D15/D18/D19；补 D13 及其他选定业务；V03/V04/V05 形成产品验收 |
| R5 | 可持续运维 | M08/M10/M11/M12/M13、D20/D21/D22、N10、V06/V07；按实际需要接入 D1/KV/R2，不为数量堆栈 |

阶段不是提交单位。一个子任务通过就提交推送；业务与监控共享节点基础后，可按实际 owner 拆分推进。未获授权的远程配置/安装不影响继续完成安全的本地开发，但不能将相关实测任务关闭。

## 6. 每个子任务的完成、提交与推送规则

### 6.1 完成定义

1. 读实际工作区、相关源码/测试和该任务前置条件；确认没有其他 owner 正在做同一处修改。
2. 记录一个任务 ID、负责人、文件范围、验收条件和不做事项。超出该范围先拆新行。
3. 实现最小可见闭环；保留现有 fixture、密钥边界、写前记录、未知不重放和旧版证据。
4. 跑改动层及邻近风险的验证，记录命令、环境、通过/失败/跳过；测试产物放 `linshi` 或 CI 临时目录。Linux-only 不在 Windows 强行宣布通过。
5. 更新本页状态与交接记录，区分源码完成、测试通过、真实部署、业务验收。文档-only 不伪造构建，CI 配置存在不等于 CI 已通过。
6. **立即 scoped commit 并 push，核对远程 SHA。不得等待下一个子任务、整个阶段或所有功能完成。** 只暂存本任务文件，提交信息包含 ID，例如 `feat(N08): add bounded node heartbeat`。
7. 按仓库 PR 流程审阅精确 head，通过适用检查后正常合并；不绕过分支保护、不 force push。合并后同步并复核 `main`，最终报告提交/PR/验证/未完成项。
8. 推送失败保留本地提交并记“待推送”；已推送未合并记“待合并”。发现新问题另开子任务；确属本任务修复时追加可追溯提交，不重写别人历史。

### 6.2 Git 操作范式

以下是流程示例，不是要原样执行的部署命令；Windows 按用户 RTK 规则为外部命令加 `rtk` 前缀。

```text
git status --short --branch
git fetch origin
# 核对 main/远程/其他 owner 后，创建本子任务分支或继续已有归属明确的分支。
# 实现、相关验证、更新进度；审阅完整 diff，不能直接 git add .。
git diff --check
git add <本子任务文件列表>
git diff --cached --stat
git diff --cached
git commit -m "feat(N08): add bounded node heartbeat"
git push -u origin <本子任务分支>
git rev-parse HEAD
git ls-remote origin refs/heads/<本子任务分支>
# 建立/更新 PR → 审阅与检查精确 head → 正常合并 → 本地 ff-only 同步 main。
```

不要为了在自身提交里写入自己的 SHA 而循环 amend。任务 ID 放进提交信息；当前任务的最终 SHA/PR 在 PR 回执和本轮最终回复记录，下一次编辑本页时补入交接日志即可。

### 6.3 验证入口与执行限制

| 改动层 | 对应检查入口 | 限制 |
| --- | --- | --- |
| 文档、目录、纯契约 | `node --test tests/contract.test.mjs tests/config-compare.test.mjs tests/history-view.test.mjs tests/owned-catalog.test.mjs tests/cloud-admin-boundary.test.mjs scripts/ci/security-baseline.test.mjs`；链接/任务依赖/UTF-8/`git diff --check` | 本轮使用这组聚焦检查；换行问题见 Q01，不等于全产品通过 |
| Linux 本地部署/恢复 | `node --test tests/*.test.mjs scripts/ci/security-baseline.test.mjs` | Node.js 22+、Linux；`openJournal` 明确拒绝其他平台，不能删除这个保护来让测试变绿 |
| Worker 协议/身份 | 安装锁定依赖：`npm ci --ignore-scripts --prefix cloud`、`npm ci --ignore-scripts --prefix tests/cloud`；执行 `npm test --prefix tests/cloud` | 复用 Linux CI；部分用例调用 Linux 节点日志。Miniflare/workerd + 合成身份，不是 Cloudflare 线上/真实登录 |
| 页面交互 | `.github/workflows/demo-browser.yml` 对应浏览器脚本 | 真实浏览器回归不等于真实服务器部署；测试产物遵循临时目录约定 |
| 自动化/安全 | 仓库 contract、固定版本 actionlint/Gitleaks、现有依赖/CodeQL/OSV 流程 | 保留现有 findings 与执行错误的区分；不得为文档交付放宽门禁 |
| 真实 Komodo/节点 | 专题文档和已有手动 workflow 的精确 SHA/明确确认流程 | 需要明确运行授权，不能自动 dispatch 特权集成；固定容器烟测不替代完整链路 |

## 7. 当前交接停点

### 7.1 DOC-01 交付记录

- 任务：`DOC-01`；负责人：本轮主 AI；仅修改根 `AGENTS.md`、`README.md`、本页及 `docs/owned-service-deployment.md` 的定位说明。
- 代码盘点：基线 `52178c7`；已有固定 Worker/节点/部署链，不存在通用多节点或持续主机指标实现。`cloud/wrangler.jsonc` 仍关闭协议、fixture 和管理员功能；没有 D1/KV/R2 binding。
- 当前工作区 Windows/Node.js `v22.22.2` 聚焦测试：40 项中 39 通过、1 失败。唯一失败是 `scripts/ci/security-baseline.test.mjs:48` 对工作区 CRLF 的 LF 精确正则断言；`git ls-files --eol` 确认仓库索引为 LF、工作区为 CRLF，`core.autocrlf=true`。不归因为功能回归，不隐瞒失败，也不在本轮改源码或全局 Git 配置。
- 同一组测试在 `git -c core.autocrlf=false archive` 导出的 Git LF 快照上 **40/40 通过**，未改测试或工作区换行。普通 `git archive` 在当前设置下仍导出 CRLF，所以快照命令必须显式关闭该次转换。快照及日志保留于 `C:/Users/Public/nas_home/AI/GameEditor/linshi/springbok-plan-20261004`，仅供本机复查，不是仓库内交付依赖。
- 文档检查覆盖 UTF-8 无 BOM、相对链接、任务 ID 唯一/引用有效、依赖无环和代码围栏；精确提交/PR/main 的最终检查结果见关联 PR 回执，不预先宣称未运行的 CI 已通过。
- 历史 M10 只按仓库证据引用；本轮不重跑真实 Komodo/Access/用户服务器，不修改既有 evidence JSON。
- 交付提交定位：`git log --all --oneline --grep='docs(DOC-01)'`；包含本节的提交自身不嵌套记录自己的 SHA。推送和合并结果见关联 PR 与最终交付回执。

### 7.2 ARC-01 交付记录

- 用户已明确“继续推进开发”，进入按子任务实施阶段，不需要为每个安全的本地开发步骤重复请求授权；生产执行、资源购买和数据破坏仍须单独明确授权。
- 任务：`ARC-01`；负责人：主 AI；基线 `9c51e81`；修改本页并新增 `docs/execution-architecture.md`，不改 runtime、配置开关、依赖或历史 evidence。
- 已明确：第一条产品链复用现有出站执行桥及固定 Komodo 适配；首版每执行隔离单元管理一台目标服务器；宿主只读采集与部署角色分权；旧 fixture 协议/存储保留，新节点协议显式版本化。
- 已联网核对固定 Komodo 源码的 `GPL-3.0-or-later` 声明，以及 Workers 临时文件/SQLite DO 事务边界，来源见架构文档。不推导发行法律结论或云费用保证。
- 文档检查覆盖 5 文件、50 个本地链接、UTF-8 无 BOM、78 个任务引用和无环依赖；27 项契约/配置差异/真实目录/管理边界测试通过，0 跳过。关联 runtime 没有修改，测试不冒充新安装验收。提交/PR 最新检查以回执为准。
- DOC-01 已推送为 `9c51e8106d4b51b30aee3ceee7baf4c58798b541`，PR [#30](https://github.com/aiaimimi0920/SpringBok/pull/30)。本轮开始时仍待 CI/合并，合并状态以 GitHub fresh-query 为准，不重复提交该文档。
- 本任务提交定位：`git log --all --oneline --grep='docs(ARC-01)'`。先推送本子任务，不等待 ARC-02 或节点功能一起提交。

### 7.3 ARC-02 交付记录

- 负责人：主 AI；基线 `a39a44f`。新增 [存储设计](storage-architecture.md)，先独立提交推送，不与后续目录代码合成一个提交。
- 首版目录采用 owner 级 SQLite DO；节点授权与任务在节点 DO 中原子处理；心跳/指标与执行队列分开；D1/KV/R2 暂不作为首版必需依赖。
- 明确加入/撤销的跨对象中间态、在途指标的撤销边界、版本化迁移和有界记录保留，不假装有跨 DO 事务。
- C04 拆为 C04-S01（服务器目录）与 C04-S02（服务目录），总表现为 80 项；完成前者不提前关闭父任务 C04。
- 本任务只完成数据/接口设计，不创建线上 binding、不执行真实迁移；文档与任务依赖检查结果见对应提交/PR。

### 7.4 C04-S01 接续与验收记录

- 原 Session `01a109cf-4a0b-7ec2-bf07-90211807091d` 因额度/限流中断，非运行任务阻塞。本轮接管已领取的 C04-S01，负责人主 AI；基线 `5711d15`、分支 `feat/server-catalog-20261004`，保留原有改动。
- 范围：`cloud/` 的服务器目录契约/DO/API，`public/cloud-admin/` 的目录交互，以及相应测试/文档。不包含服务目录、节点注册、远程执行、凭据配置或真实云迁移。
- 实现与故障边界见 [服务器目录](server-catalog.md)。补齐缺表/未知版本失败关闭，并修正内部 owner 测试的目标及 Miniflare RPC 结果读取，防止测试只比较远程代理。
- Windows Node.js 22.22.2 聚焦测试 11/11；Linux Node.js 24.18.1 契约 172/172、Worker 15/15，均无跳过；原有管理页与新增目录浏览器场景通过。覆盖 owner 隔离、CSRF、重复点击、重放/冲突、容量、重启、开关、异常 schema、迟到响应、回执丢失和 390px 窄屏。
- actionlint 1.7.12 已按仓库 SHA-256 校验后运行全部 workflow 的语法检查（未额外运行 ShellCheck）；Gitleaks 8.30.1 已校验工具来源，精确提交扫描与远程 CI 结果见 PR 回执。未修改 workflow 权限、门禁或 lockfile。
- 证据根目录：`C:/Users/Public/nas_home/AI/GameEditor/linshi/springbok-storage-20261004/`。完整命令、环境、日志/截图和未验证边界见专题文档。独立审查代理因上游 503 未产出结论，不计为独立审查通过；主 AI 完成源码/diff 审阅与实际验证。
- DOC-01 PR [#30](https://github.com/aiaimimi0920/SpringBok/pull/30) 已正常合并为 `eb602710b82953e17005c93eb63d5cd57df114bf`；ARC-01 PR [#31](https://github.com/aiaimimi0920/SpringBok/pull/31) 已正常合并为 `95b42a3048d1efee37c5b8fc14efb22a2db85a07`。ARC-02 原提交 `5711d1586f14b8f40bd097e2bb062c2dfd367d02` 已补齐独立分支与 PR [#32](https://github.com/aiaimimi0920/SpringBok/pull/32)，等待其检查/合并，不重复开发。
- 当时停点为源码与本地验收完成、待 PR 合并；该交付链现已闭环，最终 SHA/检查/main 见第 7.5 节补入的 PR 回执，保留上述原验证证据。
- 当时未领取 C04-S02；用户后续已明确继续，当前任务见第 7.5 节。V01/V02 保持待实测，不重新触发旧 fixture 或清空持久记录。

### 7.5 C04-S02 接续与验收记录

- 任务日期：2026-10-04；任务 `C04-S02`；负责人：主 AI；基线 `2116c9f`，分支 `feat/service-catalog-20261004`。用户已明确继续推进。
- 范围：现有 `OwnerCatalog` 的服务元数据/服务器引用、版本化 SQLite 扩展、同源管理员 API、目录页面与匹配测试/文档。复用现有 owner、revision、幂等回执与默认关闭开关，不增加依赖或云 binding。
- 验收：服务创建/改名/归档、owner 隔离、有效服务器引用、有关联草稿服务时拒绝服务器归档；跨资源请求 ID 冲突与并发 revision 安全；v1 数据/原回执保留、重启和损坏 schema 失败关闭；页面可操作且响应不确定时禁写核对。
- 不做：节点加入、真实产品/制品绑定、可执行配置、部署/停止/卸载、数据删除、真实云 migration 或凭据开通。源码与本地验收已完成；交付按本项 scoped commit/push、精确 PR head 检查和正常合并推进，不预报未完成 CI。
- 前项最新回执：ARC-02 PR #32、C04-S01 PR #33 已合并；`main=2116c9f28711478ff19d744403103acf416cd255`，与功能 head `8732f1b7eeb59261a0574f21184730b08b381397` 的文件树一致。合并后 6 workflow/11 job 成功，见 [PR #33 闭环回执](https://github.com/aiaimimi0920/SpringBok/pull/33#issuecomment-5988673219)。不重复前项开发或 fixture 执行。
- 实现见 [服务目录](service-catalog.md)。服务上限 256（含归档），共用 1024 回执；v1→v2 同事务扩展，保留服务器数据、revision 和原回执。测试冻结精确旧实现并证明回退失败关闭；服务路由不新增执行入口。
- 实际验证：Windows Node.js 22.22.2 聚焦 4/4；Linux Node.js 24.18.1 契约 173/173、workerd/SQLite 19/19，失败/跳过均为 0；旧管理页、服务器目录、服务目录三条真实本地浏览器场景通过。测试覆盖迁移/旧版本拒绝、缺表/列/未知版本、v1 与 v2 损坏回执、服务行损坏、容量、引用竞争、双击、陈旧/混合 revision、丢响应、迟到 owner 响应和文本渲染；1280px/390px 截图已检查。
- 首次 Linux 副本的 3 个历史哈希失败来自两个 Dockerfile 的 CRLF，修正仅限临时副本并核对为原证据 LF 哈希；没有改历史源码/证据/断言。故障夹具早期试图在有效服务关联下 DROP 父表，被 SQLite 外键正确拒绝；已调整测试注入与检查，最终全量 Worker 测试通过，不删生产保护。
- 只读独立审查发现 v1 历史回执内容缺少校验，已补迁移前全面校验与全部重放严格校验，增量复核未发现其他明确问题。v2 普通读写不扫描所有历史回执，详见专题文档边界。主 AI 审阅精确源码/diff 并完成运行验收。
- 本机证据：`C:/Users/Public/nas_home/AI/GameEditor/linshi/springbok-service-catalog-20261004/`；`linux-unit-final.log`、`linux-cloud-complete.log`、`linux-browser-complete.log`、截图与 15 个源码/测试文件 LF SHA-256 匹配清单。19 个变更文本 UTF-8 无 BOM；32 个本地文档链接/80 个任务的唯一性和无环依赖检查通过。actionlint 1.7.12、Gitleaks 8.30.1 按仓库 SHA-256 验证下载；actionlint workflow 语法通过（未额外执行 ShellCheck），提交后的 Gitleaks 和精确 CI 结果见 PR 回执。
- 下一停点先完成本项提交/推送/PR/main 验证；下一独立功能 N01（多节点任务寻址与隔离）尚未领取。V01/V02 保持待实测，不配置云资源、不复跑有副作用 fixture、不清持久记录。

### 7.6 N01-S01 领取、边界与验收

- 日期：2026-10-04；负责人：主 AI；基线 `d9cae17715a86fed724faae2284cdada472a0a33`，分支 `feat/node-mailbox-20261004`。本地/远程 main 已 fresh-check 一致，工作区干净。
- 前项 C04-S02 提交 `d7ba6c994c3a6865a2880c1613d8d59875c51aeb`、PR [#34](https://github.com/aiaimimi0920/SpringBok/pull/34) 已正常合并；main 为上述基线，文件树 `8465cf886ab39ed5509782edfc5c0906c3e58672`。精确 head 6 workflow/13 check、main 6 workflow/11 job 成功，见 [交付回执](https://github.com/aiaimimi0920/SpringBok/pull/34#issuecomment-5989372575)。保留第 7.5 节当时的测试证据，不重复执行 fixture。
- 本轮仅负责 `cloud/` 新版本内部只读协议/独立 NodeMailbox、对应 Worker 默认关闭边界、测试入口和本任务文档。保留旧 TargetMailbox、pc2-test、固定 fixture、旧 bridge 和历史证据。
- N01 拆分的原因：认证上下文依赖 N02/N03，不能为先完成 N01 开放共享 token 或自报 owner/node。N02 改为依赖已可独立验收的 N01-S01；N01-S02 在加入/凭据基础后再接入 HTTP 与出站桥，避免前置关系循环。
- 验收：内部调用的 owner/node 与 DO 名称及持久身份严格一致；两个节点及不同 owner 各自有独立 mailbox；probe 绑定服务端生成的版本/目标/请求/摘要，只允许控制通道连通证明；跨节点领取/回执、fixture/deploy/额外字段拒绝；同输入幂等、竞争只交付一次、SQLite 重启保留、claimed/unknown 不重投、容量不清理、损坏/未知 schema 失败关闭。
- 不做：公开节点鉴权、加入/凭据生命周期、实际服务 resolver、常驻程序、指标、云资源或真实部署。内部 RPC 上下文是可信调用方的前置要求，不宣称完成真实身份验证；当前 Worker 不从 HTTP 构造或转发该上下文。
- 本轮先实现和验证 N01-S01，再独立提交/推送/审阅/正常合并及复核 main；完成后停止，不自动实施 N02。
- 实现见 [独立节点邮箱](node-mailbox.md)。Windows Node.js 22.22.2 聚焦 5/5；Linux Node.js 24.18.1 全量契约 177/177、workerd/SQLite 21/21，失败/跳过均为 0。实际 DO 验证包含 100 条满容量/重启/重放、双维 owner/node 隔离、8 路竞争仅一次交付、迟到成功不解除 unknown，以及开关关闭不删数据。新增测试已进入既有 CI，旧协议源码/bridge/fixture 未修改。
- 独立只读审查未发现明确身份绕过或重复交付问题；补入审查建议的满容量/实际 SQLite 超时场景和 Windows 临时根保护。不能宣称所有外部存储删除都可检测，或真实 Cloudflare 10ms CPU 限额已验收，详见专题文档。
- 首次 Linux 安装将宿主 loopback 代理原样传入容器，npm 返回 `ECONNREFUSED`；仅把容器代理改为 `host.docker.internal` 后锁定依赖安装成功，不修改 lockfile、源代码或测试门禁。
- 证据根目录：`C:/Users/Public/nas_home/AI/GameEditor/linshi/springbok-multi-node-20261004/`；最终精确源码测试日志在 `snapshot/.tmp/linux-unit-exact.log`、`linux-cloud-exact.log`。提交/PR/main 的最终 SHA 和检查结果按第 6.2 节写入 PR 回执及本轮最终回复，不循环 amend 自嵌套 SHA。
- 11 个变更文本的 UTF-8 无 BOM、32 个本地链接、82 个唯一任务及无环依赖检查通过。actionlint 1.7.12/Gitleaks 8.30.1 本轮按仓库固定归档 SHA-256 重新下载验证；全部 workflow 的 actionlint 语法检查通过，未额外执行 ShellCheck。临时 Git archive 不含 `.git`，首次无参数 actionlint 找不到项目；改用显式 workflow 文件列表后通过，未改 workflow。精确提交 Gitleaks 和远程 CI 另记交付回执。
- 下一独立任务 N02 尚未领取；N01-S02/N03 和 V01/V02/V03 继续保持未完成，不将本地 workerd 当真实节点鉴权或 Cloudflare 验收。

### 7.7 N02 领取与边界

- 日期：2026-10-05；负责人：主 AI；基线 `eabe5ee1716a3547036b6387b0ae3c4b909c40fb`；分支 `feat/node-enrollment-20261005`。用户已给出持续目标“完成整个开发计划中的内容”；按独立子任务逐项交付，不把单项完成当整体完成。
- 前项 N01-S01 功能 head `e9308be6864b7db6be960694f07c53b4d60c0589`、PR [#35](https://github.com/aiaimimi0920/SpringBok/pull/35) 已合并为上述基线；文件树 `fc6d4174b8e9aadb5ffddcb89fc6a00de290372c`；head 6 workflow/13 check、main 6 workflow/11 job 成功，见 [最终回执](https://github.com/aiaimimi0920/SpringBok/pull/35#issuecomment-5989983714)。不重复前项开发。
- 范围：`cloud/` 的目录 schema v3/注册 CAS、NodeMailbox schema v2/一次性加入、Access 管理员 API 与仅加入的公开端点；`public/cloud-admin/` 的准备/保存加入材料/授权/核对交互；Linux 一次性加入客户端及相应测试/文档。
- 方案：浏览器 CSPRNG 生成至少 256-bit 加入挑战，先显式保存材料，再由管理员授权其绑定摘要；服务端只存摘要和 10 分钟期限，不以 session JWT 派生秘密，不承诺服务器能恢复未保存的挑战。节点先持久保存独立 execute/observe 材料，再提交摘要；N02 仅固定这些摘要，实际角色鉴权和任务通道仍归 N03/N01-S02。
- 验收：owner/服务器归属、同源/CSRF、默认关闭、加入过期/伪造/一次消费/精确重放、双节点隔离、跨 DO 每阶段失败与丢响应后的相同 enrollment 核对；enrolling/active 不得普通归档/改名；旧行、回执、revision 和 probe ledger 保留，旧实现遇新 schema 拒绝；页面可操作，客户端重启不重建秘密。
- 不做：真实账户/服务器注册、云资源/生产迁移、远程安装、角色凭据认证/轮换/撤销、开放 probe/deploy 通道、业务执行或数据清理。整体目标保持 active，未授权真实环境任务留待明确条件，继续推进可安全本地实施的计划项。
- 实现与恢复说明见 [一次性加入](node-enrollment.md)。OwnerCatalog schema 3、NodeMailbox schema 2 保留式扩展；冻结精确旧实现证明回退失败关闭。管理员先保存浏览器随机加入材料再授权摘要，Linux 客户端先 fsync 两套独立秘密，再由节点持久能力消费；active 只表示登记完成，始终 `executionReady=false`。
- Windows Node.js 22.22.2 聚焦 8/8；Linux Node.js 24.18.1 全量契约 180/180、workerd/SQLite 26/26，失败/跳过均为 0。旧管理页、两类目录和新加入四条本地 Chrome 场景全部通过；涵盖保存/取消/双击、丢响应、实际 journal/client/DO 加入、显式恢复、重启、迟到 owner 和 390px。1280px/390px 截图已查看；仅合成身份，无真实服务器/Access 登录。
- 独立只读审查发现 finalize 容量可被抢占，已修为每个 enrolling 保留一个槽，所有普通写入遵守同一容量不变量；真实 1022→1023→1024、多 pending/竞争/重启/满库精确重放通过，增量审查未发现新可证实阻断。过期未收尾仍保留槽，无自动取消/重新签发/清理流程；角色摘要尚未用于任务认证。
- 修复目录刷新丢失加入会话配置和旧 generation 的 finally 按钮污染；新浏览器脚本第一轮误等 prepared，按实际 pending 契约修正。新增对话框使旧测试泛用 dialog locator 产生歧义，改为精确 confirm 选择器后四条组合回归通过；原失败日志保留，不降低断言或门禁。
- 证据根：`C:/Users/Public/nas_home/AI/GameEditor/linshi/springbok-enrollment-20261005/`；`snapshot/.tmp/linux-unit-final.log`、`linux-cloud-final.log`、`linux-browser-complete.log` 和 `test-results/`。依赖/lockfile 不变；Linux 复用相同锁定依赖的只读安装，私有测试状态放 tmpfs，源码按 LF 哈希核对。工具、文档/编码和精确提交/远程检查结果按 PR 回执记录，不能预报未完成 CI。
- 功能提交 `5c6f9b71185177cae0958566184d89707ce60902` 已推送，远程分支 SHA 核对一致；本次进度更新另作 scoped 文档提交，不重写历史。25 个变更文件 UTF-8 无 BOM/LF 快照哈希匹配；28 个本地链接、82 个唯一任务和无环依赖检查通过。actionlint 1.7.12/Gitleaks 8.30.1 按仓库固定归档 SHA-256 重新下载验证；全部 workflow 的 actionlint 语法检查通过，未额外执行 ShellCheck；精确提交 Gitleaks/CI 另记 PR 回执。
- 下一最小步骤是审阅精确 PR head、正常合并并复核 main；完成后领取 N03，再推进 N01-S02。V01/V02/V03 保持未完成，整体目标仍 active，不缩小为只交付 N02。尚未产生的 PR/main 结果不提前宣称通过。
- PR [#36](https://github.com/aiaimimi0920/SpringBok/pull/36) 初始 head `62332bdd0336b4e877ed47fdcd10349369517324` 六 workflow 执行成功，但 CodeQL finding check 有 4 个新增告警。下载并校验完整 SARIF 后，修复浏览器测试路径 TOCTOU，并补独立 `expectedOrigin` 信任锚，拒绝篡改加入材料把 challenge 发往其他 HTTPS origin；比对在目录/秘密/journal/网络之前完成。新增零写入/零请求与 redirect 拒绝测试；这属于 N02 内修复，追加提交而非改写历史。具体审阅和剩余协议所需数据流见专题文档，不绕过保护或隐藏告警，不预报最新 CI 结果。
- 追加修复验证：Windows 再次 8/8；Linux 加入聚焦 6/6、Chrome 加入场景再次通过；日志 `linux-enrollment-pinned-origin.log`、`linux-enrollment-browser-descriptor.log`。独立增量审阅确认固定 origin 缺口闭环；29 个本地链接/82 项依赖通过。首轮全量日志保留，最新 head 的完整 CI 和 advisory 明细另记 PR 回执，不把 scanner 运行成功当作零告警。

### 7.8 N03 领取与边界

- 日期：2026-10-05；负责人：主 AI；基线 `30da6a4a74917a85831cbd9a4995ee0d6d5db757`；分支 `feat/node-credentials-20261005`。前项 N02 PR [#36](https://github.com/aiaimimi0920/SpringBok/pull/36) 已正常合并；精确 head `fc6b908790b38758ef0077e0c69b0bd3ea52b1ae` 与 main 文件树 `4e03cd1cdc1586e2fab7a62477c6bf17b8500ab1` 一致。head 6 workflow/13 check、main 6 workflow/11 job 成功，契约 180/180、workerd 27/27，见 [最终回执](https://github.com/aiaimimi0920/SpringBok/pull/36#issuecomment-5991746502)。当前 main/远程一致、工作区干净，不重做加入任务。
- 范围：`cloud/` 的角色契约、NodeMailbox 内权威摘要验证、默认关闭的仅本节点身份核对路由；Linux 从原 joined journal 导出独立 execute/observe 私有材料、单角色只读核对客户端/CLI，以及对应测试/文档。保留旧 NODE_TOKEN/TargetMailbox、加入回执、目录与 probe ledger；不引入新云 binding、schema 或依赖。
- 方案：复用 N02 的两个 256-bit 随机秘密和服务端固定摘要，不再生成或替换秘密。角色文件只包含自身 token 和固定 owner/node/enrollment/origin；独立确认 expectedOrigin。身份核对在目标节点 DO 内以当前 joined 状态、角色与 token 摘要授权，URL ID 只是提示；不把 Worker 按调用者 ID 定位当认证。加入开关与角色核对开关独立，关闭加入不自动撤销已加入身份。
- 验收：默认关闭；未加入、错 owner/node/role/token、加入 challenge/旧共享 token、额外字段及不安全请求拒绝；双节点/双 owner/双角色隔离；正确凭据在节点/进程重启后可核对，结果不回显秘密/摘要；只读核对不改 journal/云状态或领取任务。导出重启/重复幂等，不覆盖冲突或损坏文件，权限/symlink/不可信 origin 失败关闭。
- 不做：任务领取/回报、用户批准、部署、指标/心跳、轮换/撤销、安装/常驻、真实 Cloudflare/服务器或账号配置。仅身份核对 capability 为 identity:self；N06 再验证不同进程/OS 账户及文件权限分离，不能把独立文件当作同 uid 下的强隔离。joined 是节点权限真相，目录收尾不确定不撤销它；active 仍不是执行就绪。
- 先实现可验收角色材料→真实 workerd 身份核对闭环，匹配验证后立即 scoped commit/push、精确 head 审阅和正常合并；整体目标继续 active，不缩小为本项。
- 实现见 [独立角色凭据](node-credentials.md)：原 joined journal 严格导出、hardlink 不覆盖发布、半完成精确恢复、单角色私有文件客户端；节点当前 joined/role 摘要事务内授权。独立 credentials 开关，不初始化或迁移身份库；只返回 identity:self 和 executionReady=false。
- 实际验证：Windows Node.js 22.22.2 聚焦 7/7；Linux Node.js 24.18.1 全量契约 183/183、workerd/SQLite 34/34、新凭据聚焦 7/7，失败/跳过均为 0；管理页、服务器目录、服务目录和加入四条 Chrome 回归通过。直接覆盖 schema 1 不迁移、云 joined 但丢 ack 无 receipt 拒绝导出，以及原 journal 精确恢复后才可导出。
- 第一轮新 workerd 5/7 通过，2 失败来自测试 RPC 寻址携带多余 role/token；修正测试辅助函数为严格 owner/node，不放宽生产授权，原失败日志保留。独立只读 dirty 实现审查未发现明确高/中严重度阻断；文档明确未知 state 的 CLI 可能初始化空 journal、可信父路径/同 uid 边界，不假称导出失败一律零写入或已完成 OS 强隔离。精确提交审阅另记交付回执。
- 证据根：`C:/Users/Public/nas_home/AI/GameEditor/linshi/springbok-credentials-20261005/`；`snapshot/.tmp/linux-credentials-final.log`、`linux-unit-final.log`、`linux-cloud-final.log`、`linux-browser-final.log`。相同 lockfile 依赖只读复用、POSIX 状态用 tmpfs；actionlint 1.7.12/Gitleaks 8.30.1 本轮重新按仓库归档 SHA-256 下载验证，全部 workflow actionlint 语法通过（未额外 ShellCheck）。精确提交 Gitleaks/PR/main 检查不提前宣称成功。
- 18 个本项变更文本 UTF-8 无 BOM、LF 源码快照哈希一致；根规则/README/总计划/新专题共 56 个本地链接、82 个唯一任务及无环依赖检查通过。未修改工作区换行配置、lockfile 或历史 evidence。
- 功能提交 `7d6f20197bf5a8f3a2aeef20a0a7ce09a3cdebec` 已推送、远程分支 SHA 核对一致；本次交付元数据另作 scoped 文档提交，不 amend 自嵌套 SHA。当前待精确 PR head 审阅/CI/正常合并及 main 复核，尚不宣称已合并。完成本项后下一独立功能为 N01-S02。N04/N05/N06、真实 Cloudflare/Access、多机网络/账号安装与业务部署继续未完成，不把身份成功当在线/执行就绪或整体计划完成。

### 7.9 N01-S02 领取与边界

- 日期：2026-10-05；负责人：主 AI；基线 `54d1c41af3822f466b8bc2d13d46183f51c8e586`；分支 `feat/node-channel-20261005`。前项 N03 PR [#37](https://github.com/aiaimimi0920/SpringBok/pull/37) 已正常合并；head `f8bf125c44847b61f260753719b7efd0b35fb5dc` 与 main tree `ab18e2577d97afbc2371ae6c6059655796f748ca` 一致。head 6 workflow/13 checks、main 6 workflow/11 checks 成功，契约 183/183、workerd 34/34、浏览器通过，见 [最终回执](https://github.com/aiaimimi0920/SpringBok/pull/37#issuecomment-5992716298)。当前本地/远程 main 一致，工作区干净，不重复前项身份/加入开发。
- 范围：`cloud/` 的管理员本人节点控制 probe 入口、默认关闭的 v2 execute 领取/回报通道、NodeMailbox 权威事务 seam；Linux 单角色客户端、独立版本化出站桥/journal 和一次调用 CLI，匹配测试及专题文档。保留旧 bridge/TargetMailbox/固定 fixture 和历史证据，不新增 schema、binding 或依赖。
- 方案：仅接入既有 protocol-probe 安全计划，不提供通用 dispatch。管理员 owner 由 Access actor 得出，目录约束只作辅助，节点当前 joined 为最终权威；角色认证、当前 ledger transition 和 claimed/result 写入在同一 DO 事务，响应带 owner/node/enrollment/role 绑定。execute 可领取/回报，observe 不可；加入/目录关闭不隐式禁用已加入通道，credentials 和新 channel 开关必须启用。
- 验收：双节点/双 owner 与 execute/observe 隔离、错 token/回执/摘要/上下文拒绝；并发仅一次 delivery；领取丢响应云 claimed/unknown 不重投；先保存 plan intent/result 后回报，ack 丢失只重送原 receipt；intent-only 重开固定 unknown，本地或云端 unknown 永久阻断并保留证据；默认关闭/损坏库/旧 schema 不初始化、不清记录。
- 不做：业务部署/fixture 经新通道执行、用户批准、指标/心跳、轮换/撤销、常驻/安装、真实 Cloudflare/服务器/账号配置。epoch/revoked 仍由 N04/N05 实施；只读 probe observed 不等于在线、业务健康或 executionReady。崩溃残留 owner.lock 不自动删除；正常 close 后重开不能冒称异常进程自动恢复。
- 先完成管理员提交→真实已加入角色→Linux bridge→节点 DO 回执闭环，再立即本项 scoped commit/push、精确 head 审阅/CI/正常合并及 main 复核。整体目标保持 active，不将本项或本地模拟结果当全部产品验收。
- 本轮接续原分支的 17 个未提交文件，没有重做 N02/N03 或撤销原修改。已 fresh-check 远程 main 仍为本节基线；197 个 tracked 文件与原测试快照逐一核对（文本仅规范化 LF），17 个改动文件与记录的 SHA-256 一致。
- 实现见 [认证节点通道](node-channel.md)。节点 owner/node/enrollment/execute 角色在持久 joined 权威事务内校验；管理员只提交控制 probe；桥保存 intent/result 后回报，丢 ack 只重送原回执，intent-only 与云端 unknown 保持永久阻断。没有新增 schema、依赖、云 binding 或业务 executor。
- 本轮 Windows Node.js 22.22.2 聚焦 7/7；Linux Node.js 24.18.1 原源码哈希匹配的全量契约证据 186/186、新通道专项 8/8 予以复用。完整 workerd/SQLite 本轮重新执行 **42/42**，失败/跳过均为 0，见 `snapshot/.tmp/linux-cloud-resume.log`。本项没有修改 UI，浏览器验收使用精确 PR/main 的既有 CI，不声称另做本地浏览器实测。
- 上次完整 Worker 日志实际上为 41/42：旧凭据导出测试的 5 秒 `spawnSync` 返回 `status=null`，断言 `null !== 0`；日志不足以确认具体终止原因。本轮保持源码/超时/断言不变，该用例独立复跑 1/1、完整套件 42/42。恢复测试挂载时曾漏挂 `cloud/node_modules` 导致 `Could not resolve "jose"`，补齐同 lockfile 只读依赖；PowerShell 包装曾将 npm notice 当作终止错误，修正仅临时包装的 stderr/exit-code 记录，未修改产品门禁。所有已有失败日志保留。
- 独立只读审查代理返回上游 503，未产出审查结论，不计独立审查通过。主 AI 已阅读实际源码、调用点、完整改动和匹配测试，重点核对身份隔离、事务领取、日志恢复与 unknown 不重放；精确提交审阅另记 PR。
- 证据根：`C:/Users/Public/nas_home/AI/GameEditor/linshi/springbok-node-channel-20261005/`；`verified-source-hashes.json`、`resume-snapshot-verification.txt`、`run-resume.ps1` 和 `snapshot/.tmp/`。原始测试证据不覆盖；actionlint 1.7.12/Gitleaks 8.30.1 按仓库固定归档 SHA-256 核验，最终工具结果和精确 PR/main 检查另记回执。
- 本项完成范围是源码与本地控制通道验收，交付按 scoped commit/push、正常 PR 合并和 main 复核推进；本提交不自嵌套最终 SHA，不预报尚未结束的远程检查。下一独立任务为 N06（可重复安装/引导），尚未领取；常驻/心跳、轮换/撤销、监控和真实业务链继续未完成，V01/V02/V03 保持待实测或待开发。

### 7.10 N06-S01 领取与边界

- 日期：2026-10-05；负责人：主 AI；基线 `032052acac5490dbc9e2e7dafd66036dd77ce73b`；分支 `feat/node-install-20261005`。本地/远程 main 一致，工作区干净。前项 N01-S02 PR [#38](https://github.com/aiaimimi0920/SpringBok/pull/38) 已正常合并，head/main tree 均为 `e9269f6deda11fd69d4c80b6b838252c1952dd4b`；head 6 workflow/13 check、main push 6 workflow/11 job 成功，见 [最终回执](https://github.com/aiaimimi0920/SpringBok/pull/38#issuecomment-5993910478)。保留已审阅的 2 条 CodeQL advisory，不重复前项开发。
- 范围：固定允许列表的本地版本包构建器、仅使用预装 Node.js 22+ 的 Linux 非 root 单角色安装器、安装后版本/身份核对与 execute 控制 probe 入口、匹配测试和文档。复用 N03 文件/身份校验与 N01-S02 bridge/journal，不新增 Worker API、schema、云 binding 或运行依赖。
- 验收：包绑定精确已提交 Git revision、规范文件列表和摘要；安装前验证独立提供的包摘要/HTTPS origin/角色材料；只写指定的私有新目录；相同安装可核对或恢复确定的半完成文件，不覆盖冲突、完整安装的缺失文件或既有 state；不同 Linux uid 不可读取对方角色材料/日志，observe 不能运行 probe；安装后实际入口可运行，错误脱敏。
- 不做：创建真实系统账号、sudo/chown 用户主机、远程安装、下载 Node/Docker/Komodo/Mongo、选择许可证、常驻/systemd、业务部署、轮换/撤销或清理旧目录。包是本地开发验收产物，不是公开发行授权；安装器源码及包摘要须来自可信审阅渠道，摘要本身不是签名。N06 父项保持部分实现，N06-S02 另验资源/许可和真实执行拓扑。
- 先完成此单项源码与验证、scoped commit/push、精确 head 审阅/正常合并及 main 复核，再接续 N07；不把本次本地安装测试当真实服务器/生产部署完成。
- 本轮接续 Session `01a10bc2-2037-72a1-af48-91d11121a346`，原任务因上游 `402 Payment Required` 中断且未运行；保留原分支安装器草稿，不重复前项开发。具体实现见 [控制客户端安装](node-installation.md)。
- 补齐可信 checkout 引导：`--package` 只作为待校验数据，安装器不从未校验包执行；固定 17 文件、精确 Git HEAD/UTF-8 LF 摘要，使用已预装 Node.js，不增加运行依赖。完整安装只验证，半完成仅补确定缺失且不覆盖，保留 state。
- 回归先复现并修复完整安装 ENOENT 被误吞及额外空目录问题；补 FIFO 非阻塞拒绝。安装/包测试 7/7，实际安装 CLI/workerd 链 1/1；本地全量契约 193/193。独立 uid 11001/11002 在一次性 Linux 容器安装并运行，互读角色凭据/日志为 EACCES，产品 root 安装拒绝。没有创建宿主账号或修改既有服务。
- 证据根：`C:/Users/Public/nas_home/AI/GameEditor/linshi/springbok-node-install-20261005/`，失败与最终日志分开保留。独立审查代理返回上游 503 未产出结论，不算独立审查通过；主 AI 负责实际源码和精确 diff 审阅。工具、编码/链接、精确构建包和 PR/main 检查按交付回执记录，不预报尚未完成结果。
- 当前为源码/本地验收完成，交付待本项 scoped commit/push、精确 head CI/正常合并/main 复核；下一独立功能 N07 尚未领取。N06-S02/真实 Cloudflare/多机/业务部署保持未完成，不将单角色控制安装当整体开发计划完成。
- 功能提交 `d5a3365ad3aee448f380b5b9941ff5980e435d13` 已推送且远程 SHA 一致，PR [#39](https://github.com/aiaimimi0920/SpringBok/pull/39)；真实 Git revision 包 17 文件/72,682 字节，manifest SHA-256 `56f7abd214aa6ea715fbc36228efadbd39223c249deb5ad97bdc42e6f69088bc`，非 root 安装/重装/版本入口实测通过。初轮 CodeQL finding check 有两条测试快照 TOCTOU，已按同一 descriptor 改正并增强 inode/device 保留断言，追加本任务修复而非 suppress 或重写历史；最终检查另核。
- TOCTOU 修复 `16beae82c18d4f004bf86af73d38aa35969fb484` 已推送、远程 SHA 一致，聚焦 7/7 再次通过。Windows 聚焦 9/9；15 个文本 UTF-8 无 BOM、62 个本地链接与 84 项无环依赖通过。actionlint 1.7.12/Gitleaks 8.30.1 归档按仓库固定 SHA-256 重新下载校验；全部 workflow actionlint 语法通过（未额外运行 ShellCheck），Gitleaks 完整 75 commits 无检出。CodeQL 初轮 ZIP 摘要已核对并读取相关 SARIF；保留历史告警，不把报告执行成功当零漏洞。
- N06-S01 的限定源码/本地验收与提交推送完成；本次仅同步交付状态，不开始 N07。PR 精确最终 head、全部适用 checks、正常合并及 main 的 SHA/运行结果写入 PR 最终回执，不在提交中自嵌套 SHA 或预报未完成的检查。

### 7.11 N07-S01 领取与边界

- 日期：2026-10-05；负责人：主 AI；基线 `b6ac813efc8c70ae92ba56786d767365dfe654fa`，分支 `feat/node-daemon-20261005`。本地/远程 main 一致，工作区干净。前项 N06-S01 PR [#39](https://github.com/aiaimimi0920/SpringBok/pull/39) 已正常合并，head/main tree `a582f9e4bb9a4a90e3a5bfcb1bb5600eab64d09b`；head 6 workflow/13 checks、main 6 workflow/11 jobs 成功，见 [最终回执](https://github.com/aiaimimi0920/SpringBok/pull/39#issuecomment-5994534182)。保留原包、失败记录和历史告警，不重复前项安装开发。
- N07 拆分为进程生命周期 S01 与系统服务/开机启动 S02。本轮只实现已安装角色客户端的前台常驻入口、固定最小轮询/退避、单安装单实例锁、SIGINT/SIGTERM 安全退出，以及必要的传输错误分类、版本包清单和匹配测试/文档。
- 验收：execute 使用原 bridge/持久 journal，observe 仅 identity:self（不伪造心跳或指标）；串行轮询、成功间隔至少 30 秒、网络异常指数退避加抖动且不超过 5 分钟；仅网络/选定暂时 HTTP 错误可重试，身份/协议/本地 journal 不确定必须停止；unknown 终止且不清记录；退出不发起新请求，保留在途 intent/result/ack 语义，正常释放自己的锁，异常残留锁失败关闭。
- 新包显式升级清单格式，旧安装保留自带旧代码，不原地迁移或覆盖旧 state。相同角色复制到不同安装目录的全局进程仲裁不在本轮承诺内，云端一次交付语义仍保留。
- 不做：systemd/开机启用、创建真实账号、修改用户主机服务、远程安装、自动清锁/重置 unknown、业务 executor、心跳/指标、凭据轮换/撤销、Cloudflare/真实多机部署。完成 S01 后立即 scoped commit/push、精确 head 审阅/正常合并及 main 验证，不把前台测试当 S02 完成。
- 实现：`scripts/node-daemon.mjs`、`src/node-daemon/`；复用 credential/channel client 的严格响应校验，仅在传输边界分类暂时错误，不把 journal 异常混入重试。新包为 `springbok-control-node/v2` / 20 个固定源文件，保留 node 协议/安装记录版本与旧 v1 包。stdout 固定脱敏事件且状态变化才输出。
- 实际验证：Windows loop/package 7/7；Linux loop/process/install/package 16/16，全量契约 202/202，完整 workerd 45/45，均无失败/跳过。专项 workerd 2/2；完整回归实际丢 ack 后等待 35,175ms、仅 1 次 poll/2 次同一 receipt report，SIGTERM 等在途 ack 完成后退出；真实 journal 写失败不重试/不 report，云保持 claimed。未改产品计时参数，未重复触发旧真实 fixture。
- 保留式兼容：前项 main `b6ac813` 的真实 v1 包由旧可信代码安装/运行 probe 后，新安装器分别拒绝旧格式和新包覆盖旧安装；旧代码仍可重装核对/运行 version，release、credential、state、标记的内容/inode/device/mtime 不变。只用一次性 Linux tmpfs，没有改用户安装。
- 证据根：`C:/Users/Public/nas_home/AI/GameEditor/linshi/springbok-node-daemon-20261005/`，含专项/全量日志、兼容脚本与结果。主 AI 已审阅源码和实际 diff；独立审查代理上游 503 未给出结论，不计独立审查通过。当前源码/本地验收完成，Git 版本包、精确 head/main 检查与远程交付另记回执；下一独立项 N07-S02 尚未领取。
- 18 个本轮文本 UTF-8 无 BOM、LF 快照哈希一致、73 个本地链接和 86 项无环任务依赖通过。固定 actionlint 1.7.12 / Gitleaks 8.30.1 归档重核仓库 SHA-256 后复用；全部 workflow actionlint 通过（未额外运行 ShellCheck），当前源码快照 Gitleaks 无检出。首次工具执行因临时 tmpfs 默认 noexec 被拒，改为仅一次性工具 tmpfs 可执行后通过，未修改仓库权限或门禁；失败日志保留。
- 功能提交 `4892dd4f29897a0940a3676db02c72a6d63d64dc` 已推送、远程 SHA 一致，PR [#40](https://github.com/aiaimimi0920/SpringBok/pull/40)。该真实 Git revision 包 20 个源文件 / 79,703 字节，manifest SHA-256 `efde956dea9aece7aa1155f91e35d614bff9deeda1c2ce586798166448799287`；逐文件与源码一致，非 root 双角色安装/重装、version 及常驻 CLI/安全退出实测通过。Gitleaks 完整 77 commits 无检出。
- N07-S01 的限定源码、本地验收与提交推送完成；本次仅同步状态，不开始 N07-S02。精确最终 PR head 的审阅/适用 checks、正常合并、main push 检查与固定 main 包在 PR 最终回执记录，不在提交中自嵌套 SHA 或预报成功。N07 父项保持部分实现，系统服务、真实部署和业务验收仍未完成。

### 7.12 后续交接记录模板

```text
日期 / 任务 ID / 负责人：
任务状态 / 交付状态：
基线 SHA / 分支 / 改动文件：
本次完成的验收条件：
验证命令 / 环境 / 结果 / 证据位置：
未验证项 / 阻断原因 / 是否需要用户批准：
提交 SHA / 远程核对 / PR / main SHA（可在下一轮补入）：
下一最小步骤 / 禁止重复的有副作用操作：
```

只写这一轮实际完成的事实，不把计划改成回顾、不覆盖历史证据、不把“用户说继续”解释为可以绕过生产和数据保护授权。
