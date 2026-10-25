# Pages 与 GitHub Actions 云套件

适用于“一套云端、多个组件、多个本地消费者”的应用。manifest 仍为 v3，部署声明仍为
v2，但 target 显式选择 cloudflare-suite。旧 cloudflare-workers 的能力和行为不变。
此扩展已进入源码及本地合同验证范围，不代表正式控制面或应用已经发布。

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

业务密码与 R2 S3 凭据不是公开 configuration，也不是云账号令牌。当前此目标扩展不提供
通用业务秘密管理；应用需要这些秘密时，必须先完成单独的保险库交付通道，不能冒充
接入完成。verify 继续不取得部署写凭据。

## 检查与上线

```sh
node --test tests/deployment-suite.test.mjs tests/sba-preview.test.mjs
node --test tests/cloud/cloud-suite.test.mjs
node --test pages/docs.test.mjs
node pages/check-example.mjs
```

实际可用性还需：部署支持该扩展的控制面、固定兼容执行器 SHA、配置用户连接权限、发布
应用实现，再执行真实云部署和独立验证。本地 workerd 使用合成 provider，不是云端验收。
