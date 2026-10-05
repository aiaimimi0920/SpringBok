# N07-S02：非特权 systemd 用户服务与启动关联

本项接续 [私有安装](node-installation.md) 与 [前台常驻](node-daemon.md)，总进度见 [开发计划](development-plan.md)。复用已安装的 v2 daemon；不改变包格式、节点协议、身份、ledger 或云端开关。服务只执行现有控制客户端，始终 `executionReady=false`，不是业务部署执行器或主机监控采集器。

## 可信生成与显式操作

前提是获准的 Linux 非 root 角色账户、预装 Node.js 22+、systemd user manager，以及已通过 N06-S01 验证的完整私有 v2 安装。Node 可执行文件、安装、unit 目录及其父路径必须来自可信来源、不可由其他不可信 uid 改写；不抵御恶意同 uid/root，也不承诺全路径竞争隔离。生成器检查 Node 文件本身的类型、owner 和写/执行权限，不遍历所有父路径。

在可信审阅的 checkout 中，以该角色 uid 运行；下面只是使用说明，开发轮不会对用户主机执行：

```text
mkdir -p ~/.config/systemd/user
# unit 目录须已存在、属于当前 uid 且为私有目录；不自动 chmod/接管既有服务目录。
node <trusted-checkout>/scripts/node-user-service.mjs --installation <canonical-absolute-installation> --unit-directory <canonical-absolute-private-systemd-user-directory>
systemctl --user daemon-reload
systemctl --user start springbok-control-execute.service
systemctl --user status springbok-control-execute.service
systemctl --user stop springbok-control-execute.service
systemctl --user enable springbok-control-execute.service
systemctl --user disable springbok-control-execute.service
```

observe 使用 `springbok-control-observe.service`。将 unit 放入该账户的实际 systemd 用户搜索目录；若使用自定义 `XDG_CONFIG_HOME`，须由操作者明确核对其搜索路径。生成器不猜测或修改 manager 配置、不执行 systemctl、不自动 start/enable/linger。已有目录不是私有目录时拒绝，不擅自更改其中其他服务的权限。

CLI 唯一两个参数是安装和 unit 目录。绝对路径必须等于 realpath，且只包含 ASCII 字母、数字、`/._-`；空格、换行、`%`、`$`、引号、symlink 和非规范路径拒绝。这里有意不提供 systemd/shell 转义模式。入口读取完整安装核对摘要、身份及私有权限，不复制 token、不读取运行期 ledger、不清锁。

unit 固定按角色命名，同一账户不能用同名 unit 悄悄切换另一安装。私有 0600 文件经临时文件 fsync、hardlink 非覆盖发布与目录 fsync；完全相同的 unit 只核对，不改 inode/mtime。冲突、损坏、symlink/FIFO/权限异常失败关闭，保留现场，不覆盖、不自动修复或卸载。崩溃遗留临时文件不自动批量清理。

## 生命周期与自启动边界

- `Type=exec` 直接执行固定 Node 和已验证安装内的 `scripts/node-daemon.mjs`，没有 shell、任意参数或秘密环境变量。
- `Restart=no`：身份/协议/持久化错误、退出码 2、unknown、SIGKILL 不自动重启；也不重置 daemon/journal 锁。
- `KillSignal=SIGTERM`、`KillMode=control-group`、`TimeoutStopSec=30s`：正常 stop 由 daemon 停止新轮询并收尾在途 step；超过 30 秒 systemd 可能强制终止，留下的未知结果/锁必须保留，不能报告已安全完成。
- `UMask=0077`、`NoNewPrivileges=yes`；stdout/stderr 进入该账户的 journal，沿用 daemon 的固定脱敏事件。不宣称已经隔离任意恶意代码或建立完整 sandbox。
- `WantedBy=default.target`：enable 只建立用户 manager 的启动关联，disable 不等于 stop；需要停止时显式 stop。启用状态也不等于节点在线或业务就绪。

用户 manager 通常随登录启动。**宿主开机且未登录时启动 manager 需要系统级、单独获准的 linger/等效配置。** 本轮不在用户服务器设置 linger，不创建账号、不安装系统级 unit、不重启宿主；CI 验证的是真实用户 manager 重建，不是用户服务器重启。Node 路径被移除或版本变化时服务可能失败，生成器不是运行时下载器/升级器。

## 验证与证据

本机证据根：`C:/Users/Public/nas_home/AI/GameEditor/linshi/springbok-node-service-20261005/`。只读 LF 源码快照、Linux uid 1000、固定 Docker 镜像 `sha256:fee853fafa59550d162cef52bca02d907694b44ebf6ef9fb075bcc0c65d8dedb` / Node.js 24.18.1 / systemd 255.4。状态使用一次性 tmpfs，未修改宿主服务或账号。

本地 `node --test tests/node-user-service.test.mjs tests/node-daemon.test.mjs tests/node-install.test.mjs tests/node-package.test.mjs` **14/14 通过**，包括双角色真实 parser、私有/幂等/非覆盖 unit、安装/源码/凭据/ledger/锁的内容和 inode/device/mode/mtime 保留、注入/symlink/FIFO/完整安装缺标记拒绝。最初 parser 缺少 `XDG_RUNTIME_DIR` 失败；测试提供自身私有临时目录后通过，没有启动 manager 或降低断言。普通容器不能创建 `/init.scope` cgroup，本轮不使用 privileged 或可写宿主 cgroup。

本地 Linux 全量契约 **206/206 通过**，无失败/跳过；shell 和新增源码语法检查通过。文本 UTF-8 无 BOM/LF 快照、文档链接和任务依赖已核对。Worker/浏览器/安全与真实 manager 的精确最终 head/main 运行另查 CI，不用源码存在代替验证。

新增 `Deployment Contract Lab / user-service` job 在一次性 GitHub-hosted runner 创建全新合成账户，仅该账户设置 linger 并启动/重建真实 user manager；脚本拒绝自托管环境和既有同名账户，退出关闭该账户 linger/manager。使用 test-only drop-in/preload 注入合成 fetch，**生产 unit 和 20 文件包不包含这些测试材料**。验证双角色实际安装 daemon、SIGTERM 在途请求收尾、401 不重试、unknown ledger/零网络重开、enable 后 manager 重建启动、disable 后重建不启动，以及 SIGKILL 残留锁/显式重启拒绝。它不是公网 HTTPS/TLS、真实 Access 或业务部署验收。精确 PR head/main 的实际 CI 结果与 journal artifact 按交付回执核实，不预报通过。

独立只读源码审查发现 execute 测试 URL 错配，已按真实 channel 客户端修正；同时把 CI cleanup trap 提前到 enable-linger 之前。审查不等于实际 manager 运行通过。主 AI 负责精确提交审阅及运行验收。

PR #41 首轮 CI 的契约 204/206、manager 入口失败，原因是 runner setup-node 制品不满足产品 owner/写权限规则，以及新账户不能直接访问 runner 的 checkout。CI 改为同一可信 Node 的私有 owned 副本并 `cmp` 核对字节，合成账户源码来自同一 Git HEAD 的 archive；没有放宽产品权限检查或 runner 目录权限。首轮失败日志保留，最新精确 head 结果按 PR 回执核实。

后续实际 `exercise` 已通过，但 manager 重建曾在宿主预装的 dbus/SSH socket 控制进程超时，日志还显示 runner 的 XDG 路径污染。仅对本次新 uid 的 CI `user@<uid>` drop-in 明确自身 HOME/XDG、取消启动期会话 D-Bus/SSH 地址；不修改通用模板、生产 unit/超时，不宣称所有发行版/用户环境均已适配。失败诊断与原退出码作为 artifact 保留，完整重建结果仍以精确 CI 为准。

head `789b6a4b31eb757bc8db328efbd5798e37306d46` 的 **6 workflow/14 check 全部成功**。真实 user-manager 专项 run `37324383078` 完整通过双角色/drain/401/unknown、启用后重建启动、禁用后重建不启动、SIGKILL 残留锁和显式重启拒绝。artifact `11351760680` 已下载并匹配 GitHub SHA-256，两个角色 journal、exitCode=0 和成功记录经内容核对，不含 Bearer 材料。环境隔离后实际重建通过；没有逐变量对照，不把具体继承 bus 地址自等待当唯一已确诊原因。最终文档 head/合并 main 的新鲜检查和固定版本包另记 PR 回执。

未完成：用户主机安装/开机重启、完整执行依赖 N06-S02、真实 Cloudflare/Access/多服务器、心跳/指标、业务部署、凭据轮换/撤销与程序升级。不启用生产开关，不改云 schema、依赖/lockfile、历史 fixture 或既有固定包。
