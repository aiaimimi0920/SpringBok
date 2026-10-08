# 服务实例与版本部署

任务 SV-01，负责人主 AI，2026-10-07；实施基线 `7c681a33b653e604cbabf91ede6e57add16ccf65`。

## 用户路径与边界

服务是默认页面；右上角“部署服务”打开稳定大小弹窗，首行横向服务 Tab，下方按
`.sba/deployment.json` 显示账户、D1/KV/R2 与公开配置。浏览和切换均不部署、不派生
GitHub 连接、不登记资源。点击部署时重新核对并登记选中的已有资源，生成固定计划，
显示当前实际后果确认，再提交一次；不创建远端资源、不在读取失败后自动重新提交。
列表一行一个实例，同仓库不同环境可以分别部署，详情内保留操作历史和原始回执。
所有统计默认可独立收起；绑定资源用量不等于服务独占用量，不能拿账户合计冒充实例。

遍历每个有效 GitHub 连接的所有仓库分页，以大小写无关的仓库名去重；账户级凭据
直接只读访问选定仓库，不批量派生连接。默认分支先解析为完整 commit，再核 Git tree
中的根 `.sba` 目录和普通 manifest/deployment blob。不存在目录不展示为服务；无效
声明、权限失败和分页未完成保持可见且不得部署。版本来源为默认分支与分页 tags，
选择后始终按返回的完整 SHA 读取和执行，不向执行器传浮动 tag/branch。

## 实例与增量兼容

- 复用 ConnectionVault、ConnectedDeployment 和 DeploymentLocks，不增加 DO 绑定。
- 原 `connection_deployments` 索引记录增量保存服务摘要；首次 task ID 即 instance ID。
  一次更新有新的 task ID，携带 instance ID、前一 task ID、前版本和绑定回执摘要。
- 旧记录缺摘要时从不可变 bootstrap 按 owner 核对读取，不清库、不重写密文/AAD。
  旧连接/资源/部署 API 继续可用；已有 fixture/service catalog ID 不改名、不复用。
- `/history` 保留旧固定部署、节点与历史记录界面，但普通导航不显示它；旧固定 SBA
  不自动纳入可更新实例，也不绕过其保护身份。只有明确记录的自助实例可在此更新。
- 回退控制面不会丢失新记录。旧代码不认识 update request 时失败关闭；已有目标键
  仍属于首次 task，新旧首次部署都不能抢占它。需要完成在途更新时应恢复新控制面，
  不能靠旧版本重新 dispatch。无破坏性收缩或自动反向数据迁移。

## 版本更新不变式

更新复用 SBA v2 的 `update`，而不是再次 `deploy`。manifest application ID、仓库、
账户、环境、资源实际 ID/名称、目标和完整公开配置保持一致。声明不兼容时失败关闭，
平台不推断业务配置迁移。业务数据迁移由新 SHA 的 `.sba` 实现，平台不写业务 SQL。
现有契约仅允许严格更高的 `x.y.z` 版本及不同 SHA；不提供未验证的数据降级/回滚。

前任务必须有核验回执且为 `succeeded` 或 `deployed-unverified`。后者仍显示“已部署，
待验证”，不能改成业务成功。进行中、失败、unknown、准备未确认都不能发起下一次
更新。服务行保留最近确认版本，并另显示更新目标版本与结果；失败不能抹掉前版本。
Vault 在同一事务中比较实例最新 task；账户锁在同一事务中比较前 claim、owner、
原始资源键与串行 lane。保留所有旧 claim；结果未知不释放锁。重复提交同一 task
只读取已有状态；许可/source/receipt 仍走既有 OIDC、digest 和一次性执行链。

## 官方资料核验

本轮已联网读取并保存官方页面及 SHA-256 至独立证据目录的 `research.json`：

- [List repositories for the authenticated user / List repository tags](https://docs.github.com/en/rest/repos/repos?apiVersion=2026-03-10)：账户仓库分页，tags 返回 commit SHA。
- [Get a reference](https://docs.github.com/en/rest/git/refs?apiVersion=2026-03-10#get-a-reference)：`heads/<branch>` 精确引用，读取需要 Contents 权限。
- [Git trees](https://docs.github.com/en/rest/git/trees?apiVersion=2026-03-10)：目录/普通 blob 类型与 mode 检查，不跟随 symlink。

以上仅用于实现传输合同，不是用户凭据或真实应用部署的验收。

### SV-02 发现性能修复

用户报告弹窗长时间显示查找 0 个服务。原实现按连接串行深读每个仓库，且只显示
找到数量；前序慢仓库会阻塞后排服务。已联网读取 NAccount 固定
`06fdb8b99e5941a6b899bdc76991beedefc5087a` 的真实 tree/blob，原契约校验通过。

现在先收集仓库分页并去重，再以全局最多 4 个并发逐仓库检查；已读服务立即显示，
显示已检查/总数和失败数量。目录列表单请求 15 秒、应用读取单请求 45 秒超时；关闭
重开不重复扫描，超时/失败保留错误，不伪装为缺目录。不同凭据作为同仓库后备而不
重复并发。目录请求使用 catalog 返回的 defaultBranch 仅作快速缺目录预检，旧客户端
未传该字段仍走原路径；选中候选后重新解析不可变 SHA 并核验全部 Git mode 和声明。
预检不是部署凭据，不能把浮动分支或目录存在性当成有效部署计划。

本轮已核实官方 Git Trees 的 tree_sha 接受分支/tag，并实际读取 NAccount 的 main tree。
无 `.sba` 时仅一次 tree GET，不再依次读取 metadata/ref/commit/tree。43 仓库/三页且首
仓库挂起的浏览器回归先红后绿，覆盖继续找到后排服务、全局并发上限、关闭重开、超时
收尾及零部署写入；真实 NAccount 响应重放也能在产品 UI 显示服务与 D1/KV 声明。
证据 `linshi/springbok-sv-02-20261007/`；真实响应重放使用合成 Access，不冒充用户线上
会话。本次不修改 NAccount，也不执行真实应用部署或升级。

## 验证与停止条件

验证发现分页/重复凭据/缺目录/坏声明/权限失败/固定版本；验证资源过滤、显式登记、
Tab 状态隔离、稳定尺寸、窄屏、键盘、焦点、折叠与无隐式写入。验证首次部署、重启、
同实例更新、并发/重放拒绝、资源/配置不变、旧 API/记录及 unknown 保留。跑仓库匹配
检查、精确 PR head 审阅与 CI，正常合并后核 main，并用原配置保留发布器发布控制面。
本地合成业务链、线上发布、用户实际部署/数据验收分别记录，不能互相替代。

本地已通过 147 项检查及 8 条浏览器流程，另 1 项平台跳过；包含原生 PowerShell
合成应用 v1 到 v2 更新并保留用户数据，不能据此声称已更新 NAccount。新增回归先后
复现 Tab 键盘切换焦点留在旧项、关闭更新框后旧请求错误污染新框，已在事件处理层
修复；失败与成功日志均保留。桌面及 320px 产品截图已检查。独立证据目录为
`linshi/springbok-sv-01-20261007/`，最终 PR/main 和控制面发布回执优先于本页提交前状态。
