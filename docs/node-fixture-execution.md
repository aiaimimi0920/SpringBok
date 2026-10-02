# 固定节点验收执行器（切片 B）

B把已合并的云任务协议接到一个固定 Komodo fixture-cycle，供独立测试节点装配。
这是可运行代码与装配模板，**尚未发布到 Cloudflare、安装到 PC2或完成新链路的
真实 Komodo 验收**。普通 CI 的 workerd/SQLite 是真实运行时，Komodo调用是模拟；
另一个CI任务只运行真实fixture容器和卷，不挂daemon socket，不运行Periphery。
二者不能合称“云端已部署PC2”。原M10证据及其源文件保持不变。

## 唯一远程动作

一个任务固定执行 v1 → v2 → bad → 已知成功v1回滚。只有一个测试Deployment和
一个 springbok-fixture-data named volume，无业务数据、公开端口或人工晋级。
远程请求仍只有id/node/operation/challenge/revision；operation=fixture-cycle，
challenge必须是本地完整配置目录摘要去掉sha256:前缀后的64位值。不能传镜像、
命令、URL、路径、资源ID或actor。固定目录在节点上由操作者核实后只读提供。

Worker须显式ENABLE_FIXTURE_CYCLE=yes并配置相同FIXTURE_BINDING；缺省关闭。
CONTROL_TOKEN和NODE_TOKEN沿用A的分权测试渠道，不是生产登录。节点被授权作
测试执行证据来源，云端检查结构、绑定与顺序；这些回报不是防恶意节点的远程证明。
fixture-verified只表示本次固定测试回执齐备，不是业务/生产验收或人的批准。
顶层deploymentVerified仍为false，以免旧客户端将其当整体部署认证。

每阶段：先读完整配置并比较 → 先记写意图 → 固定UpdateDeployment → 再读配置 →
Deploy → 按精确Update ID/operation/target/status/success查完成 → 验证实际镜像、
四个不同的实际Container ID、容器健康、唯一named-volume挂载与健康回执。bad必须真实exit1且无OOM/暂停，
不能以部署API失败或超时代替；意外失败立即unknown，不能继续回滚或记通过。
v1/v2/回滚v1须健康且卷marker一致，rollback的镜像与配置须与已成功v1完全一致。
marker是fixture生成的无秘密随机测试数据，不是用户数据或登录凭据。

节点一个目录只允许一个cycle。每阶段至多60秒、每API至多5秒，云任务10分钟过期；
过期后晚到成功回报只能保留unknown。写入或调用中断后不重发配置/Deploy，重启
只返回已持久化终态或unknown。丢失回报响应可重送相同回执，不能重做容器操作。
bridge和execution各自有独占、原子落盘的日志；残留锁必须保留并核对进程/记录，
不自动删锁。满额、不确定写入或损坏都拒绝继续。没有自动恢复/解除unknown入口。

## 装配边界与输入

源码入口：cloud/fixture-contract.mjs、src/fixture-node、scripts/node-fixture.mjs；
使用已有journal、matchesResource、matchesUpdate、containerMatches。
旧四业务contract/coordinator带合成human审批且目标数固定，不能把它当真实操作者
接入；B只复用底层已测持久化/校验，独立固定测试顺序不产生生产批准。

部署模板：deploy/node-fixture/compose.yaml。要求先验证专用账户不能访问宿主daemon，
当前Docker context确实为该账户rootless daemon，socket在/run/user/该UID/docker.sock。
模板路径本身不证明rootless或权限隔离。Periphery能控制该独立daemon全部资源，
不是只靠容器名获得隔离。不要在现有mjc宿主daemon上使用模板。

Core、Mongo、Periphery只在internal网络；不映射管理端口。bridge无socket、cap-drop
且只通过固定Core地址与指定HTTPS控制origin通信；它的outbound网络用于出站。
没有Tunnel、SSH或任意shell入口。容器日志关闭，错误固定；凭据仍会在Core/Mongo
环境及Docker元数据存在直到删除容器，不能称为仅内存。Compose secrets本地文件由
独立授权的装配步骤提供，本仓库不生成真实凭据或保存其值。

操作者装配顺序（本PR不执行）：

1. 核实独立rootless环境、资源余量、现有名称无冲突；固定官方Core/Periphery2.3.3、
   Mongo8镜像的实际digest，记录架构；模板tag不是可重现的digest锁。
2. 单独预构建examples/node-fixture的v1/v2/bad并导入该daemon，记录三个不同的本地
   sha256 image ID、构建来源与扫描结果。不要在PC2大规模构建或引用latest。
3. 准备Core/Mongo授权配置和文件引用。Core环境文件需DATABASE_URI(authSource=admin)、
   INIT_ADMIN_PASSWORD、JWT_SECRET、WEBHOOK_SECRET对应KOMODO_变量；Mongo需独立
   MONGO_INITDB_ROOT_USERNAME/PASSWORD。节点登录用户固定springbok-node，Core密码
   文件必须与bootstrap密码一致。真实值不进入仓库/命令回显/CI artifact。
4. 仅启动模板执行依赖，先Mongo鉴权就绪，再Core版本/Periphery状态；核对CPU、
   内存、OOM与磁盘，保留Mongo、keys、journal命名卷。模板不设置自动重启/开机启动。
5. 显式本地调用catalog.mjs的prepareInventory(images, transport)，其中transport用
   fixtureTransport(password,{provision:true})。仅允许固定GetServer/GetServerState/
   CreateDeployment；不会创建凭据、改服务或部署容器。必须在空的专用Core初始化，
   固定名字创建失败/返回丢失就停下来检查，禁止自动重试或猜资源ID。
   审核输出version/deployment/server/images，保存为只读inventory.json；不得替换成
   手工编造ID。catalog(inventory).binding为双方需核对的FIXTURE_BINDING。
6. 为一次已授权验收配置云测试开关/绑定，提交一个fixture-cycle。启动模板acceptance
   profile里的bridge单次CLI。/config/inventory.json最多4KiB；两个secret文件各64字节
   小写hex、不含换行。单次完成后容器退出，不创建常驻轮询或长期节点注册权限。
7. 验证四阶段证据、云DO与节点记录重启、Mongo/Core重启后的资源保留。最后移除测试
   容器时保留卷作证据，删除数据另按授权处理；禁止全局prune或清理其他容器。

预算上限：Mongo1GiB/Core1GiB/Periphery512MiB/bridge128MiB/fixture128MiB，约2.75GiB。
CPU最大约3.5核（服务限额之和），不是预留或实测需求；4核机器还运行现有服务，
启动前及逐阶段监测，不能把有这些限额等同有容量。Mongo磁盘卷取代旧tmpfs，备份
方案仍须实际装配确定。首次rootless资源限额能否生效也要查cgroup支持，不能假设。

## 测试与剩余验收

普通Node回归覆盖写前日志、绑定漂移、错误Update、意外失败、OOM、坏卷/丢数据、
幂等与重启；实际workerd测试验证Node执行器四阶段（模拟Komodo）回报、丢ack/双端
重启后不重复动作。普通容器烟测验证v1/v2/bad/v1镜像/exit1/健康/卷标记保留，
Compose只解析不启动。真正的Core→Periphery→rootless Docker、完整配置默认值、
独立Mongo重启持久化、PC2容量和发布Cloudflare费用仍需实际受审装配验证。

C继续接现有UI与可信操作者授权，不以CI actor或测试token冒充用户。
固定fixture通过后才为Gateway等真实服务绑定制品/资源/数据兼容及业务验收。

Komodo schema依据：固定2.3.3源码
[DeploymentConfig](https://github.com/moghtech/komodo/blob/780ac68b992094a9fccd5fffb760e0c84fd3c3d1/client/core/rs/src/entities/deployment.rs)
（含conversions/labels尾换行规范化）与[TerminationSignal](https://github.com/moghtech/komodo/blob/780ac68b992094a9fccd5fffb760e0c84fd3c3d1/client/core/rs/src/entities/mod.rs)。
