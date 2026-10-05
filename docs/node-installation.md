# N06-S01：固定版本控制客户端与单角色私有安装

本项接续 [执行架构](execution-architecture.md)、[角色凭据](node-credentials.md) 和 [认证控制通道](node-channel.md)。总进度见 [开发计划](development-plan.md)。这是仅依赖预装 Node.js 22+ 的 Linux 非 root 控制客户端，不是完整业务执行环境或自动远程安装器。

## 包、可信引导与版本

在可信审阅的 Git checkout 中构建本地开发包，输出目录必须尚不存在：

```text
node scripts/build-node-package.mjs --output <new-package-directory>
```

构建器从 `git rev-parse HEAD` 和 `git show <revision>:<allowed-path>` 读取已提交内容，而不是把 dirty 工作区当版本。包内仅 17 个固定允许的源文件及 `manifest.json`，不包含凭据、测试、浏览器资产、node_modules、Node 本体或 Komodo/Core/Mongo。所有文件按 UTF-8/LF 规范化；manifest 保存完整 40 位 revision、平台、最低 Node 主版本、每文件字节数和 SHA-256，总源文件不超过 1 MiB。相同提交生成相同 manifest 字节和摘要。缺失文件、新增文件/空目录、symlink、非法清单/路径或摘要不符均拒绝。

构建 stdout 返回 revision 和 **manifest 的 SHA-256**。从独立可信的审阅/交付渠道取得该摘要，不能把待安装包自带的摘要当信任依据。该摘要不是数字签名，不提供公钥发行链或自动升级。

**先信任校验器，后校验包。** 使用已审阅、可信 checkout 中的安装器和直接依赖；不要先执行来自待校验包的脚本，再希望它验证自己。因此安装器显式接收 `--package`，包内不分发 `scripts/node-install.mjs`。安装器只读取包字节，不 import/执行候选包代码。可信 checkout 的获取/审阅和 Node 运行时的来源是前置条件，本项不自动下载它们。

## 单角色安装与运行

先按 N03 导出原 joined journal 的角色文件，再由获准安装者安全交接给对应 Linux 账户。每个账户只接收自己的角色材料，文件归该 uid 所有且无 group/other 权限；原 grant、双角色 journal 和另一角色文件不得交给运行账户。程序不创建账号、执行 sudo/chown、申请凭据或开通真实接入。

以目标非 root Linux uid 运行：

```text
node <trusted-checkout>/scripts/node-install.mjs --package <package-directory> --sha256 <trusted-manifest-sha256> --credential <private-role-file> --expected-origin <independently-confirmed-https-origin> --role <execute|observe> --directory <private-new-installation>
```

`expected-origin` 必须独立确认，不从角色文件或包内自动接受。校验运行时、包、origin 和角色文件在创建目标目录之前完成；文件按 `O_NOFOLLOW | O_NONBLOCK` 描述符读取并检查类型、uid、私有权限和大小，FIFO 不会卡在等待写端。目标父目录须已存在、路径真实且可信；不递归创建未知父路径，也不接管任意既有目录。

安装布局：

```text
<installation>/              0700，本角色 uid
  install.json               0600，固定安装意图/uid/版本/身份/摘要
  release/                   0700，固定版本只含允许文件
  credential.json            0600，只含本角色 token
  state/                     0700，保留 N01-S02 journal/lock
  complete.json              0600，全部文件核对后发布的完成标记
```

安装后从独立目录运行，不要求 npm 安装或原项目工作目录：

```text
node <installation>/release/scripts/node-run.mjs --installation <installation> --action version
node <installation>/release/scripts/node-run.mjs --installation <installation> --action identity
node <installation>/release/scripts/node-run.mjs --installation <installation> --action probe
```

入口先核对自身所在 release、完成标记、私有文件树/摘要、角色及 origin 绑定。`version` 不联网；`identity` 仅身份核对；`probe` 只允许 execute，一次调用既有控制探针桥。observe 在创建 journal/联网前拒绝 probe。没有 shell、Docker、业务部署或长期轮询入口；所有成功结果保留 `executionReady=false`，错误为固定脱敏文本。

## 重复、半完成和未知结果

- 目标不存在时，先创建私有目录并持久化 `install.json`。已有目录必须有完全相同的意图；版本、角色、origin、token 摘要或 uid 不同立即拒绝，不覆盖绑定。
- 文件用独占临时文件、fsync、hardlink 不覆盖发布及目录 fsync。相同既有文件只读取核对，mtime 和内容不变。清理仅限本次创建的临时文件；崩溃遗留文件不自动批量删除。
- **存在 `complete.json` 时只验证，不修复。** 缺少凭据、release 文件/manifest、state 目录或任一损坏均停止并保留现场；内部 `ENOENT` 不能被当作完成标记缺失而进入恢复。
- 仅在完成标记确实不存在、原意图完全匹配时，补齐确定缺失的发布文件。冲突不覆盖；复制后重新验证包再发布完成标记。已有 state 内容不读取、清空或替换。
- 创建根目录后、意图尚未持久化就崩溃的无标记目录不自动接管。已完成标记丢失与真实半完成无法仅凭文件系统完全区分，禁止人工删除标记来强制“修复”。安装器不是任意损坏恢复/升级工具。
- 安装核对不验证每条运行期 ledger，也不承诺检测日志被外部删除。运行仍遵守 N01-S02 的 intent/result/ack、unknown 不重放和锁规则；版本核对成功不代表任务状态或节点在线。崩溃残留 `owner.lock` 不能自动删除。

操作系统账户和父路径必须可信；不抵御恶意同 uid 写入者、root 或全部 inode/path 竞争。单独两个文件不提供同 uid 隔离。不同 uid 的实际验收是 Linux 本地权限证明，不是容器逃逸、跨服务器或用户主机账号部署证明。

## 验证与交付证据

本机证据根：`C:/Users/Public/nas_home/AI/GameEditor/linshi/springbok-node-install-20261005/`。Linux 使用已有固定镜像 `sha256:fee853fafa59550d162cef52bca02d907694b44ebf6ef9fb075bcc0c65d8dedb` / Node.js 24.18.1，源码只读、临时状态放 tmpfs。普通安装/契约/workerd 测试以 uid 1000 运行；没有变更宿主账号或已有容器。

| 验证入口 | 覆盖与结果 |
| --- | --- |
| `node --test tests/node-package.test.mjs tests/node-install.test.mjs` | 7/7：确定性/完整 import 清单、摘要/额外路径拒绝、非覆盖安装、完整缺失拒绝、半完成恢复、权限/symlink/FIFO、observe 拒绝 |
| `node --test tests/cloud/node-install.test.mjs` | 1/1：实际安装 CLI → 两角色身份核对 → 管理员 probe → 安装后 CLI → workerd/SQLite 回执 → 重装/双端重启不改已完成 ledger |
| `node tests/node-install-isolation.mjs` | 一次性 Docker 中 root 仅作为测试调度者，两个子进程 uid 11001/11002 安装并运行；互读 credential/ledger 均 `EACCES`，跨角色入口拒绝，产品 root 安装拒绝 |
| `node --test tests/*.test.mjs scripts/ci/security-baseline.test.mjs` | 本地全量契约 193/193，0 失败/跳过；精确最终 head 全量 CI 另记 PR |

workerd 测试通过 test-only IPC fetch 转交真实本地 workerd，执行的是安装包内实际子进程 CLI；不是公网 HTTPS、TLS 或真实 Access 登录实验。包构建单元夹具使用明确标注的合成 revision；真正 Git HEAD 构建、摘要和远程 SHA 在提交后交付回执核对。uid 隔离脚本不属于普通非特权测试套件，必须显式在一次性 Docker 环境运行。

初始回归测试明确复现完整安装缺文件被补回、额外空目录被接受两项问题，修复后通过；原失败日志保留。新 workerd 测试初轮因未固定合成管理员 JWT 导致 CSRF 403，随后发现测试提交体漏 revision/challenge 产生 409；只修正测试夹具以遵守真实接口，没有放宽产品鉴权。独立审查代理返回上游 503，未产生审查结论；主 AI 审阅代码/完整 diff 并实际验证，不计为独立审查通过。

PR #39 首次 CodeQL 报告两条高等级测试代码 TOCTOU：凭据快照先按路径 stat、再按路径读取。已改为同一 `O_NOFOLLOW | O_NONBLOCK` descriptor 上 fstat/read，并比较重装前后 inode、device、mtime 和完整内容；保留且增强“不替换/不改写”断言，不禁用扫描或抑制告警。功能提交 `d5a3365` 的实际 Git 包已构建并逐文件匹配源码、非 root 重装和版本 CLI 通过；最新精确 head 的 CI 另记 PR 回执，不将初轮扫描工作流成功当 finding check 通过。

未完成或未验证：N06-S02 的完整执行依赖、真实账号安装、Cloudflare/Access/外部网络、多服务器接入、Node/第三方依赖发行许可、常驻/开机启动、心跳、升级签名、轮换/撤销和业务部署。N06 父任务保持部分实现；下一独立任务为 N07。没有修改云开关、schema、运行依赖、历史 fixture 身份或证据。
