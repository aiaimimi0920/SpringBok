# N02：服务器注册与一次性加入

本页限定 [开发计划](development-plan.md) 的 N02。实现基线为 `eabe5ee1716a3547036b6387b0ae3c4b909c40fb`；当前交付 SHA、PR 和 main 检查以关联 PR 回执为准。本功能完成加入登记，不代表真实服务器已安装、在线或可以部署。所有回执始终包含 `executionReady: false`。

## 用户可见流程

1. 管理员在服务器目录创建条目；服务器 ID 由服务端生成，不信任节点自报名称或 ID。
2. 点击“准备一次性加入”。浏览器使用 `crypto.getRandomValues` 生成独立 256-bit challenge，分配本次 `enrollmentId`，不从 Access JWT、CSRF 或其他会话值派生秘密。
3. 点击“保存加入材料”，确认文件已保存后才能“授权一次性加入”。下载只是保存材料，尚未赋予加入权限；取消、Escape 或身份刷新不会隐式注册。
4. 授权请求只提交绑定摘要、服务器 ID、原请求 ID 和目录 revision。云端保存摘要及自服务端准备起算的 10 分钟期限，不保存 challenge 明文。
5. 获准目标上的 Linux 一次性客户端先保存独立 execute/observe 随机秘密，再将其 SHA-256 摘要提交给仅加入的端点。
6. 节点成功消费挑战后，目录显示“已完成加入登记（不代表在线或部署就绪）”。如目录收尾不确定，管理员先 GET 核对，再显式恢复；刷新不会自动重发加入或部署。

下载文件包含 `protocolVersion/origin/ownerId/nodeId/enrollmentId/challenge`。它是一次性能力，不是无敏感信息的普通配置：只交给该目标、不得提交 Git/日志或公开存储。浏览器不写 localStorage/sessionStorage；云端无法恢复未保存的 challenge。默认关闭不生成材料或注册数据。

## 接口与授权边界

| 路由 | 权限与职责 |
| --- | --- |
| `POST /api/admin/enrollments` | 验证 Access 管理员、owner 归属、同源与 CSRF；目录 CAS 授权摘要，并准备目标 NodeMailbox |
| `GET /api/admin/enrollments/<serverId>` | 验证管理员和目录归属；只读取目录/节点状态，不隐式修复 |
| `POST /api/admin/enrollments/reconcile` | 同源/CSRF；固定原 server/enrollment，只恢复准备或完成已加入节点的目录登记 |
| `POST /node/v2/join/<ownerId>/<nodeId>` | HTTPS、严格路径和 schema、Bearer challenge；拒绝 cookie、异源、query 和旧 `NODE_TOKEN`，由节点持久能力验证并一次消费 |

`ownerId/nodeId` URL 只是寻址提示，不是可信认证上下文。NodeMailbox 检查 DO 名称、持久 owner/node、域绑定摘要、期限与原 enrollment。challenge 摘要域为 `['springbok-join/v2', ownerId, nodeId, enrollmentId, challenge]`。绑定成功后只能精确重放相同 requestId、executeDigest 和 observeDigest，不能换另一组秘密重新消费。

所有加入功能需同时启用 `ENABLE_ADMIN/ENABLE_CATALOG/ENABLE_NODE_MAILBOX/ENABLE_NODE_ENROLLMENT` 并具备 `REGISTRY/NODES`。`cloud/wrangler.jsonc` 的新开关仍是 `no`。没有新增云 binding、DO class migration、依赖或实际线上配置。`enrollment.js` 和其他管理资产一样先过 Access；没有开放 probe、deploy 或任意命令通道。新角色摘要尚未成为任务鉴权凭据，接入由 N03/N01-S02 负责。

## 持久状态、幂等与跨 DO 恢复

```text
OwnerCatalog draft
  → 目录 prepare：enrolling + 原请求回执
  → NodeMailbox prepare：pending + 挑战摘要/期限
  → NodeMailbox join：joined + 固定输入/加入时间
  → 目录 finalize：active + 内部收尾回执
```

目录和节点不是跨对象原子事务。API 暴露 `202`、`reconciliationRequired` 及不确定状态；不能把目录准备成功冒充节点已加入。目录 prepare 后响应丢失可能返回 409，此时仍应保留原材料并核对，不能用新的 requestId/challenge 猜测重试。

- 目录 prepare 原请求重放不重新分配期限；固定最终回执键为 `enrollment/<enrollmentId>/joined`，不与用户 UUID 请求碰撞。
- NodeMailbox 未准备时，公开 join 不初始化空库；正确能力也不能跳过授权准备。
- 节点 join 写入成功后丢 ack，客户端重启复用原 requestId 与两个秘密。精确重放可取原回执，即使其原加入期限已经过去；它不是新消费，不能改变身份绑定。
- 节点已 joined 但目录 finalize 失败：保持节点证据，GET 可看到差异；显式 reconcile 收尾，不重新执行任务或生成秘密。
- 新准备已经过期、未知版本、缺表或记录损坏时失败关闭；不删旧行、重置 revision 或自动重新加入。

### 1024 回执与收尾容量

目录仍共用最多 1024 条回执。每条 `enrolling` 记录保留一个 finalize 槽，所有新写共同遵守容量不变量：

```text
revision + pendingEnrollmentCount <= 1024
prepare：revision + pendingEnrollmentCount + 2 <= 1024
普通目录写：revision + pendingEnrollmentCount < 1024
finalize：revision + 1，pendingEnrollmentCount - 1
```

满库时精确回执重放先于新增容量检查；读与原请求核对仍可用。过期但尚未收尾的 enrollment 也保留槽，本项没有取消/重新签发流程。今后若需释放或更换，必须另行设计有审计的版本化操作，不得直接删记录、减少 pending 或借新服务器 ID 掩盖旧结果。

## 兼容与保留式迁移

- OwnerCatalog 从 schema 2 扩展到 3：新增 `server_enrollments`，不重建 servers/services。底层 server 状态仍 draft/archived，可见 enrolling/active 由加入记录派生。
- 原服务器、服务引用、revision 与回执保留；迁移前验证全部 schema 2 回执。普通 schema 3 读取验证 metadata、当前数据和容量，但不每次扫描所有历史回执；精确重放严格验证对应原回执。
- 已关联草稿服务可继续引用 enrolling/active 服务器；这些服务器不能普通改名或归档，避免绕开已固定身份。
- NodeMailbox 从 schema 1 扩展到 2：增加 `node_enrollment`，先验证原 probe ledger；原节点任务状态不清空、不解除 unknown。
- 测试冻结精确基线的旧目录 v2/节点 v1 实现。旧版本遇新 schema 拒绝且不清数据；不能宣称旧二进制可无条件回退读取新 schema。
- schema 2 节点允许尚未 prepare 的空 enrollment 表。不能检测所有外部删行或任意历史篡改；本页不作这种保证。

## Linux 一次性客户端

入口是 `scripts/node-join.mjs`，不是常驻 Agent 或安装器。以下只是获准测试环境的接口说明，不是执行真实服务器安装的授权：

```text
node scripts/node-join.mjs --grant <private-0600-file> --state <private-directory>
```

grant 必须是 Linux 同 uid 的私有普通文件，拒绝 symlink、超过 4096 字节或含额外字段。状态目录需要同 uid、0700 私有权限，已有 ledger 必须私有且不是 symlink。复用 `openJournal` 的独占锁、原子写入和 fsync；发送前落盘 prepared。父路径和主机本身仍须可信，不宣称抵御恶意管理员或所有本地文件竞争攻击。

本地 journal 包含两个真实角色秘密，应按凭据保护并保留；云端只有摘要。CLI 成功/失败仅输出脱敏状态与固定错误，不输出 challenge、token、digest、JWT 或任意上游错误。已保存 active 回执的本地重复运行不发网络请求。失败时保留同一 grant/state；不得删除 journal 强行重试。节点凭据读取/认证、轮换、撤销、常驻和心跳在后续任务实现。

## 实际验证与证据

本机证据根为 `C:/Users/Public/nas_home/AI/GameEditor/linshi/springbok-enrollment-20261005/`。Linux 在固定 Node.js 24.18.1/Chromium Docker 镜像中运行；依赖复用同 lockfile 的只读安装，测试目录使用 tmpfs，源码副本位于 linshi 并按 LF 哈希核对。Windows 的 Node.js 22.22.2 只跑可跨平台的契约，不冒充私有 POSIX journal 验收。

| 检查 | 实际结果/证据 |
| --- | --- |
| Windows `node --test tests/enrollment-contract.test.mjs tests/node-protocol.test.mjs tests/cloud-admin-boundary.test.mjs` | 8/8，0 失败/跳过 |
| Linux `node --test tests/*.test.mjs scripts/ci/security-baseline.test.mjs` | 180/180，0 失败/跳过；`snapshot/.tmp/linux-unit-final.log` |
| Linux `npm test --prefix tests/cloud` | 26/26，0 失败/跳过；`snapshot/.tmp/linux-cloud-final.log` |
| 新加入 workerd 聚焦 | 5/5；`snapshot/.tmp/linux-enrollment-capacity.log` |
| 新加入真实 Chrome + workerd + Linux client | 保存后授权、取消/双击、一次加入、显式恢复、丢响应、重启、迟到 owner、无浏览器持久凭据及 390px 通过；`snapshot/.tmp/linux-enrollment-browser-second.log` |
| 管理页/服务器目录/服务目录/加入组合浏览器 | 四条场景全部通过；`snapshot/.tmp/linux-browser-complete.log` |

新 DO 测试覆盖所有跨对象中断、双请求竞争、8 路精确重放、过期、缺表/未知版本/损坏记录、旧行/回执/服务/probe 保留、满容量及多个预留竞争。1280px/390px 截图仅含合成身份与脱敏状态，实际已查看；无横向溢出，加入/在线/就绪边界可见。旧管理页/两类目录和新增加入场景的组合浏览器结果另记总计划与 PR 回执。

第一轮新浏览器脚本错误地等待 `prepared`，而生产节点状态契约是 `pending`；只修测试期望后通过。旧浏览器回归的泛用 `dialog` locator 因新增第二个对话框产生 strict-mode 错误；改成精确定位 `confirm`，未削弱取消/确认断言。原失败日志保留。

独立只读审查发现原实现没有为 finalize 保留容量，已修并通过实际临界测试；增量核验未发现新可证实阻断。独立审查不代替运行验证，也不等于未来 PR head 审阅。UTF-8/文档链接/任务依赖、actionlint、精确提交 Gitleaks、PR/main CI 与远程 SHA 按本项交付流程记录。

未验证：真实 Cloudflare/Access、真实服务器安装或加入、多机网络、运行资源限额、凭据角色认证和业务部署。没有创建云资源、配置真实凭据、执行生产迁移或远程安装，没有选择付费方案或许可。后续安全本地子任务是 N03，随后 N01-S02；总计划仍未全部完成。
