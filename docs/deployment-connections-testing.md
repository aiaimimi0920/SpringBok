# 连接与部署手测指南

2026-10-07。设置、资源及部署执行链已发布；真实用户整链手测仍待完成。

## 入口

- 设置：https://springbok-test.aiaimimi.com/settings
- 云资源：https://springbok-test.aiaimimi.com/resources
- 新建部署：https://springbok-test.aiaimimi.com/deploy
- 旧部署历史：https://springbok-test.aiaimimi.com/

继续使用原 Cloudflare Access 管理员登录。NAccount 业务登录与 SpringBok 的 Access
登录是两个身份入口；本轮未将两者改为同一登录系统。

## 操作顺序

1. 在设置页添加 Cloudflare 连接：名称、Account ID、API Token。只读验证需要指定
   账号的 Account Settings Read；后续列举需要对应 D1/KV/R2 读取权限。实际部署还需
   所选应用所要求的写权限，保存成功不等于写权限已验证。不要填写 Global API Key。
2. 添加 GitHub 连接：名称、`owner/repository`、PAT。NAccount 仓库为
   `aiaimimi0920/NAccount`。PAT 须能读取该仓库源码、metadata 和 workflows；执行器的
   dispatch 使用平台独立凭据，不要求把该凭据填入应用连接。
3. 在云资源页选择 Cloudflare 连接，分别读取需要的 D1、KV、R2，再显式登记已有资源。
   平台不自动创建资源；R2 是对象存储，不是数据库。NAccount 声明只要求 D1 和 KV。
4. 在新建部署页选择 GitHub 连接、输入完整 40 位 commit SHA，点击“读取应用声明”。
   NAccount 当前已合并且 main CI 成功的声明版本为：
   `06fdb8b99e5941a6b899bdc76991beedefc5087a`。
5. 选择 Cloudflare 连接、环境标识和资源，填写声明生成的应用公开配置。NAccount
   要求两个不同 Worker 名称及两个不同 HTTPS 自定义域名，其他变量按应用需要填写。
   不要在公开配置放密码或 Token；这些配置会进入 GitHub Actions 任务。
6. 点击“审阅部署计划”，检查固定 SHA、账号、资源和配置。到此不执行任何部署。
   若登记读取超过五分钟，按提示返回资源页重新读取并登记。
7. 只有确认全新目标获得授权且资源可用于首次初始化，才点击“确认部署”。已有
   `naccount-auth`、`naccount-admin`、`auth.aiaimimi.com`、`accounts-admin.aiaimimi.com`
   及原 D1/KV 不得当新实例重跑。升级不是首次部署，此界面不替代升级流程。
8. 在部署任务列表打开任务、查看 Actions 链接，点击“读取执行结果”。Actions 的绿色
   成功不等于应用成功，以平台验核后的应用回执为准；unknown/failed/准备不确定时
   保留任务 ID 与错误，不另建任务重复运行。

## 预期与限制

保存后不显示密钥；刷新后只显示公开连接元数据。连接停用阻止新批准，不撤销供应商
Token，也不撤回已批准的在途许可。当前仅支持声明驱动的 Cloudflare Workers 首次部署，
不包含 SSH/VPS 添加、GitHub App 安装、自动创建数据库或现有实例升级。

仓库转为公开解决本次托管 CI 限制，不代表所有 Secrets 或工作流应公开。只能执行信任
的固定应用版本并使用最小权限 Token；声明冲突检查不是对任意应用代码的隔离沙箱。

本次已验证本地合成流程、精确 CI、线上发布和访问拒绝边界；没有声称已完成新连接驱动
的真实应用发布。现有 NAccount 保持原实例和数据，原 unknown 回执与四条历史未覆盖。
