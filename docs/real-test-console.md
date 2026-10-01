# M6：单机真实集成测试工作台

本里程碑把固定 UI 操作、M4 执行协调与持久记录接到真实 Komodo 2.3.3。
运行地点仅为本次明确授权的 GitHub 临时 Linux runner。界面持续标注
“临时集成测试 · 非生产认证”；不是用户服务器安装器或生产登录系统。
没有新增运行时依赖、实际业务系统或项目许可证选择。

## 可审查的验收范围

- 四类独立样例服务，各有固定 test/production-role 资源；production-role
  仍只是临时测试容器，不是实际生产
- 真正通过浏览器按钮运行 v1 测试、测试验收、晋级，再运行 v2 更新及回滚 v1
- 故意使用退出码 1 的坏镜像；测试失败阻断验收和晋级，已成功容器保持不变
- 已知 Update ID 的执行重启后只读恢复，不再次配置或部署
- 尚未消费的测试验收在重启后失效，必须重新点击测试验收
- 故意丢弃一次已发送 Deploy 的回执；保持 unknown，禁止重发与伪造成功

验收结果必须以准确提交的真实集成 workflow 为准。普通 unit/HTTP 测试使用
假 backend，不冒充真实 Komodo；浏览器自动点击的测试验收不冒充用户身份。

## 准备配置与持久执行

控制器只接收固定服务、版本标签、操作、当前 revision 和请求 ID。浏览器
不能传 actor、镜像 URL、命令、网络、挂载、目标 ID 或执行成功结果。版本目录
由专用 harness 创建八个实际资源后，读取完整配置及资源 ID 生成，包含固定
v1/v2/bad 不可变镜像 ID。完整配置和资源身份参与目录摘要。

新增 preparation journal 与原 execution journal 分开，均为原子持久写入。
控制器先通过现有契约验证阶段、验收绑定、已知回滚目标，再写 preparation
intent，才 UpdateDeployment；读取完整资源再次核对后记录 prepared，最后
进入 M4 的 preflight → durable intent → Deploy → receipt → evidence。
配置写入丢回执、读回不匹配或超时留下 preparation unknown，阻断该服务，
没有自动重写、强制清空或隐藏重试。两个 journal 不是跨文件原子事务：若只
prepared 而未生成执行 intent，重启后的明确操作仍须再次通过契约、审批和
M4 preflight，不能恢复旧审批继续晋级。已知执行恢复只有读操作。

M4 新增 `health-failure` 事件：只有最终成功 Update 的确切目标、完整配置
一致，且同不可变镜像的容器明确 exited、Running=false、Paused=false、
OOMKilled=false、ExitCode=1 时，记录容器失败。保留 updateSuccess=true，
不伪造 API 失败。OOM、暂停、错误镜像、缺失证据或仅尚未健康仍不能写成功
或确定失败；保留 accepted 等待证据。原来的 Update 明确失败分支不变。

M1/M2 八个已验证执行文件及其历史证据哈希不修改。M6 是新的独立测试链路。
目录锁、1 MiB/1000 事件限制、损坏 fail-closed、写不确定性和人工检查残留锁
仍遵循 [M4恢复说明](execution-recovery.md)。日志不是抗恶意篡改的审计存储。

## 隔离和授权

只允许明确批准的临时 runner 运行入口。检查 repo、GitHub-hosted 环境和本次
专用确认标志仅用于防误用，不是认证。每次新范围/新权限需重新确认。

- Core/Mongo/Periphery 使用独立 internal Docker 网络，无宿主根或 /proc 挂载
- 仅 Periphery 挂 Docker socket；它实际可管理此临时机的 Docker，不能说成
  Docker namespace 沙箱或只对几个容器有强制权限隔离
- Docker 不发布任何端口。harness读取本次Core容器在本次internal网络的确切
  私有IPv4，短期TCP桥接只监听 `127.0.0.1` 随机高端口，只转发该固定地址的
  9120端口；无任意上游或DNS。测试 UI 也只监听loopback，结束关闭桥接连接
- 样例容器 network=none、无发布端口、无持久卷；禁用远程终端
- 随机测试登录/数据库凭据及密钥的生成文件位于 tmpfs；容器环境变量也会
  保存在 Docker 守护进程的容器元数据中，可被有 Docker 权限的进程读取。
  不打印、不上传；结束删除本次容器与 tmpfs，随后销毁临时 runner，不声称
  Docker 元数据从未落盘或已经安全擦除。凭据不属于用户真实账号
- Node/Chrome都是受信任runner测试进程，没有另建阻止它们访问Docker的OS沙箱。
  实现代码仅通过确切loopback Core HTTP调用固定白名单API，拒绝重定向、限制
  响应大小与截止时间；浏览器拿不到 Core 登录信息
- UI 使用精确 Host/Origin、内存 CSRF、固定路由、CSP及请求大小限制；没有
  生产认证，也不防御同一 runner 上的恶意进程
- 正常结束和可捕获的失败均清理本次容器、internal 网络、tmpfs 凭据与测试记录，
  并验证清理；强制杀死 runner 或机器丢失可能阻止 EXIT trap，此时以 GitHub
  临时 runner 销毁为最后清理边界，不保证进程在强制中断后执行过清理代码
- 上传产物仅为无凭据的测试 UI 截图，保留三天；不上传原始日志、环境、数据库
  或 journal

镜像使用官方 Komodo 2.3.3 / Mongo 8.0 标签，运行时记录解析后的公开镜像 digest。
标签可被上游更新，因此不能把版本标签称为完全可重复的制品锁定；本次样例
发布则始终使用已构建的不可变本地 image ID。

测试实例仅由 harness 配置，普通用户/其他应用不共享这一个 Core。此测试
安排不构成生产中的独占配置所有权保证。Komodo Deploy 没有配置摘要 CAS；
其他写入者仍能在 preflight 后改配置，事后检测不能消除该竞态。接入用户
机器之前仍需明确身份认证、配置所有权、凭据与生产恢复策略。

## 运行与后续范围

无凭据校验：`node --test tests/*.test.mjs scripts/ci/security-baseline.test.mjs`。
真实入口为受审 `Real Test Console Integration` workflow，不能从普通 PR
自动获取 Docker 管理权限。开发期唯一专用分支 bootstrap 会在合并前删除。
最终入口只能 main、显式临时权限确认、reviewed SHA 与实际 GITHUB_SHA 一致。

当前用户不需要提供长期机器。等测试闭环与已声明范围全部通过，再决定真实
服务器接入。此阶段不承诺生产可用、任意业务、多机管理或真实人工身份。

首轮实测发现该runner的internal Docker网络未建立请求的published端口，
UI尚未启动即停止；保留internal隔离，用固定本机桥接修复，不改成外联网。
[Docker官方桥接说明](https://docs.docker.com/engine/network/drivers/bridge/)
说明宿主机可访问桥接网络容器；这不等于把端口公开到外部网络。

一次中间测试出现Mongo exit48（监听失败类别），但没有足够日志确认具体原因。
后续使用仅输出白名单类别的tmpfs诊断wrapper时未复现，UI全链和清理通过；
最终恢复官方Mongo入口，诊断脚本不接入正常启动。不宣称该偶发启动失败已
确定根因或通过改变配置永久修复。
