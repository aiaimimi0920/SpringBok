# 自有服务接入目标与未实现边界

SpringBok 当前以 [SBA 接入](../ai-docs/README.md) 为部署主链，应用负责迁移与业务验证。
本页仅保留自有服务的特定目标，不是可执行配置、当前部署清单或生产授权。
旧调研的本地路径、版本快照及交付过程通过 Git 查询，不据其推定当前应用源码。

## 服务职责

| 目标 | 要求 |
| --- | --- |
| Gateway | 核实实际运行模式、上游、访问控制、固定制品与真实路由验收；健康端点不等于业务成功 |
| Platform | 身份认证与业务账户/权限分离；核对 OIDC issuer/回调/会话、业务数据库、组件及迁移顺序 |
| Rauthy | 独立机器或平台上的身份服务，不开发其本体；固定审阅版本与不可变制品，独立登录域名/TLS、数据库、密钥和恢复 |
| AssetLibrary | 轻量应用配合托管 PostgreSQL/对象存储；核实现行拓扑，不照搬旧重型 Compose，也不默认再部署一套数据库 |
| Crow（可选） | 仅授权数据源的只读查询，不安装采集器或写入链路；未启用不阻断其他服务 |

Hook/Loom 是桌面访问方，不安装到服务器。调用关系以各仓库事实为准，不能假定所有服务
都依赖 Gateway 或已支持 Rauthy。用户此前确认的旧账号无数据仅免除那批旧账号迁移，
不免除新身份/业务权限关联验证，也不授权丢弃未来数据。

## 静态目录不是部署适配器

`node scripts/owned-catalog.mjs` 读取 `catalog/owned-services.json`；退出码 0 仅表示结构
检查通过。`src/owned-catalog.mjs` 对选中产品仍返回 blocked，`executionReady` 和
`executable` 始终 false。Crow 默认 not-selected；Hook/Loom 不在该目录中。

目录中的 source pin/path 是历史源码声明依据，不是当前稳定版本、可信在线库存、镜像
构建证明或实际资源绑定。完整 SHA 以 JSON 为准，不在 Markdown 重复维护；更新 pin
前必须重新核实对应源码、依赖与运行契约。bindings 保持 null，secretRefs 只是符号，
不能手填 ready、目标 ID 或秘密值绕过认证 resolver。

多组件迁移与常驻服务的依赖顺序、可信资源解析、制品/数据兼容和整组计划适配尚需独立
实现与验收。原 gateway/forum/game/account fixture 身份和回归继续保留，不能改名冒充
真实应用，也不能用任意 shell 绕过单 Deployment 与多组件之间的差异。

## 身份与数据隔离

Rauthy 使用独立运行目标与外部托管 PostgreSQL；目录 policy 要求 `hiqlite=false`、
`tls=require`、`verifyCertificate=true`、`caRef=rauthy.postgres-ca`。这些不是可直接启动
的配置，实际键名和 CA 必须按所选版本验证，禁止关闭证书验证或回落明文。
Rauthy 独占身份库、初始化材料、签名/加密私钥与备份；Platform 不访问或挂载身份数据，
不复用其数据库凭据；公开 JWKS 只提供验签公钥。

Platform 目录固定源码对应的接入边界是：Web 持有自身 OIDC client secret、独立本地
会话密钥和内部服务 token；account-api 使用业务数据库及内部服务鉴权，不持有身份库
凭据或 OIDC client secret。Web/account-api 的 issuer 必须逐字一致，包括尾斜线。
TLS、代理头、客户端登记和回调须按实际域名验证；本地退出不等于上游全局退出，上游
撤销也不自动证明本地会话立即失效。会话时限以实际应用版本核实，不沿用调研数值。

## 接入验收

取得固定镜像/架构、独立目标、完整配置及秘密引用后，验证测试与生产隔离、迁移顺序、
业务功能、数据库/卷/对象备份恢复。组件成功不等于产品成功，镜像回滚不等于数据回滚；
失败或未知结果阻止晋级和自动重放。目录结构测试与合成协议测试不能代替这些验收。
购买、配置凭据、真实部署与破坏性数据操作仍须对应授权。

## 应用专有接入边界

### NAccount

NAccount仅首次 deploy 在迁移后、Worker发布前创建用户，并按真实 super_admin 角色赋权。
规范化同邮箱（含软删除）已存在时拒绝，不覆盖密码。emailVerified和MFA验证状态仍为初始值。
用户创建和赋权是两次D1 REST写入，不声称事务：部分写入或回执不确定会停止为unknown，禁止自动重试。
实际管理员登录、邮件和MFA必须单独验收；初始化读回成功不是登录验收。

历史 admin-only 修复只补发管理后台，不重建资源、迁移、改密码、提权、轮换密钥或更新认证 Worker；发布前拒绝未知漂移。SV-08-S04（2026-10-09）已记录固定 3.0.3 修复回执和用户实际登录成功，原 unknown 保留；详细任务/run/源码身份通过 `git log -- docs/service-repair.md` 查询，不将该验收当作当前全部功能完成。

### EasyProxy

将 EasyProxy 云端整体接入 SBA：Aggregator 定时刷新、MiSub Pages/Functions、ECH Worker
以及 D1/R2 属于同一云套件；本地 EasyProxy 是消费者，不在此云部署任务内。
保留现有 Pages 架构，不隐式接管、覆盖或删除当前生产资源。

EasyProxy 的 .sba 必须实现 deploy/update/verify/preview/destroy-preview；更新先保留
加密备份，再做 expand-only 迁移并读回原数据；预升级使用数据副本和独立资源，默认禁用
定时刷新及外部副作用。Actions 的周期刷新必须从实例批准 SHA 取代码，不以默认分支漂移
代替版本升级。现有生产迁移/导入和控制面上线独立验收，不包含在本地合成测试中。
