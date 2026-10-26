# Pages 与 GitHub Actions 云套件

适用于“一套云端、多个组件、多个本地消费者”的应用。manifest 仍为 v3，部署声明仍为
v2，但 target 显式选择 cloudflare-suite。旧 cloudflare-workers 的能力和行为不变。
此扩展及业务秘密保险库已合并，并于 2026-10-26 发布到项目正式控制面，兼容执行器也已
固定；这不代表 EasyProxy 等应用已经完成接入或部署。自建控制面仍须独立核对版本与 pin。

## 目标与凭据

- Pages 项目声明为 pages 目标，path 指向必填 text 字段，account 指向 Cloudflare 账号。
- 长期工作流声明为 github-actions，account 必须为 null，path 指向
  `.github/workflows/refresh.yml@{instance}` 模板生成的值。
- github 对象必须包含 repositoryPath 和 secret；平台将已批准的来源仓库写入前者，
  后者引用用户来源 GitHub 连接的令牌。禁止提交令牌值、平台执行器凭据或跨仓库地址。
- D1/KV/R2 仍由平台持久准备流程创建；Pages 创建/发布、工作流环境配置由应用执行，
  不应把工作流偷偷加入资源创建器或误报它们已创建。

GitHub 锁域为规范小写仓库身份，不依附 Cloudflare 账号。同一仓库在不同云账号上的
操作仍共享串行执行边界；同一工作流环境不能被第二个云实例占用。重复提交、重启和
部分失败沿用原有 unknown 保护，不自动发起第二次创建或派发。

## 生命周期要求

deploy/update 必须按批准 SHA 部署应用代码，周期性内容刷新不等同升级应用版本。
工作流 schedule 只由默认分支触发，因此应用必须确保每个实例运行的是已批准版本，
而不是默认分支任意新提交；旧发布流程与 SBA 发布流程不能同时写同一份稳定产物。
GitHub Actions enable API 只改变工作流状态，不能替代配置校验或业务验证。

preview 必须为 Pages、存储和工作流环境生成独立身份，复制源数据并关闭线上副作用；
destroy-preview 只清理回执列出的该测试环境，不能删除共享工作流文件或整个仓库。
平台现有通用“导入现有服务”和“删除正式服务”不支持混合套件，在 provider 写入前拒绝，
而不是只处理 Worker、静默遗留后台刷新。预升级清理仍由应用的批准动作完成。

业务密码与 R2 S3 凭据不是公开 configuration，也不是云账号令牌。使用部署声明的
applicationSecrets 名称数组，首次在部署表单保存或选择绑定当前仓库/应用的秘密集合。
明文只发给 owner 的加密保险库；公开计划只带引用，接受任务时复制不可变加密快照。
更新与预升级继承引用，不重新输入或默默轮换；verify 继续不取得部署写凭据。

受限 repair 可在 manifest.repairs[].secretNames 显式包含相应名称时继承原实例的业务
秘密引用；仅允许原 owner/仓库/应用及精确修订的活动 profile，不接受新的 profile 输入
或新增名称。接受任务时仅为本次声明的名称创建独立加密快照，其他名称不交付，bootstrap
密码仍禁止交付。禁用 profile 阻止新的计划/提交，但不会撤销已接受任务的不可变快照。
此扩展已随 SUITE-06 发布到控制面；其他未升级环境不能据本文假设支持。原父任务的 verified
artifact、相同资源声明/runtime、更高版本和共享锁域仍须成立，不自动重放 unknown 任务。
SUITE-06 同时补充终态 repair 的独立无写凭据 verify，仍绑定当前实例 head；详见
[生命周期](lifecycle.md)。验证不改写历史或解开 UNKNOWN 锁，不以修复权限代替验收。

首次表单的“导入 JSON”通过标准文件选择器读取一个 UTF-8 JSON 对象，属性必须恰好为
当前声明的全部 applicationSecrets；每个值为 1–512 UTF-8 字节且不含控制字符，文件
上限 32 KiB。页面内验证全部通过后原子填写密码框，不修剪值、不读取其他本地文件，
不使用浏览器持久存储或自动发起保存/部署。错误不包含文件内容或解析器原文；切换
秘密配置或关闭弹窗会清理输入并使未完成导入失效。保存仍走原 owner/CSRF 保险库接口。
此导入入口已由 PR #117 合并，并于 2026-10-26 发布到项目正式控制面；自建环境仍须
独立核对所部署版本。导入成功不等于保险库保存、任务提交或应用部署成功，后续步骤
保持原有显式确认与独立回执边界。

应用 API 可向受保护的 `/api/admin/resources` 提交 action 为 application-secrets，字段为
id（新 UUID）、repository、applicationId、values（名称到单行值的对象）。GET 只返回
applicationSecretProfiles 的名称与归属元数据，不提供明文读取。禁用动作
disable-application-secrets 仅接收 id/revision，阻止新任务使用，不破坏已批准任务快照。
这些请求仍须 owner/同源/CSRF；不能放进 Actions 的公开 inputs 或日志。

## 检查与上线

```sh
node --test tests/deployment-suite.test.mjs tests/sba-preview.test.mjs
node --test tests/cloud/cloud-suite.test.mjs
node --test pages/docs.test.mjs
node pages/check-example.mjs
```

实际可用性还需：部署支持该扩展的控制面、固定兼容执行器 SHA、配置用户连接权限、发布
应用实现，再执行真实云部署和独立验证。本地 workerd 使用合成 provider，不是云端验收。

## 需要 Linux Docker 的应用

按 [manifest](manifest.md) 选择完整 Ubuntu runtime。平台根据已校验 manifest 选择
固定 `.github/workflows/sba-execute-linux.yml`，不是由公开配置指定任意执行 workflow。
控制面 `SBA_CONNECTED_LINUX_EXECUTOR` 是仅含 workflowId 和 executorSha 的受信 JSON；
它继承原受信执行仓库和 runnerOrigin，且要求 `sba-executor-<SHA>` 的不可移动标签。
Windows `SBA_CONNECTED_EXECUTOR_SHA` 独立保留，Linux 不借用其 workflow 或隐式回退。

2026-10-26 项目正式控制面已发布 SUITE-03，Linux pin 固定到通过精确 PR/main 检查的
`4d6a8bcd8c52f0ada791729bafc2788a2cffb972`，准确 executor tag 禁止更新/删除；原 Windows
pin、历史策略、Access 和资源不变。这是平台能力上线，不是 EasyProxy 应用部署或真实
Docker 业务审计验收；自建环境仍须独立发布并核对本环境的 workflow ID 和固定 SHA。

source pack、GitHub OIDC、首次 attempt、单次许可和固定回执沿用原链路。应用应在同一
作业内持有自身套件许可，不把进程内句柄序列化到第二层 dispatch。超时终止普通后代进程组，
仍一律 UNKNOWN，不以 kill 请求成功推断云端副作用停止。此能力不自动提供 Docker 镜像、
应用工具安装、预升级数据安全或线上部署验收；控制面及 pin 的实际发布须分别记录。
原准备恢复仅接受单账号且未创建资源的保留任务；套件还占用 GitHub 锁域，不因 Linux
支持自动扩展成多锁域恢复。未知任务继续保留，不据此重派发或自动解锁。
