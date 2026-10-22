# 为自己的服务接入 SBA

## 1. 调查应用

读实际启动、构建、锁文件、数据库迁移、部署脚本和健康检查。列出目标 Worker、域名、D1/KV/R2、对外副作用及需要的秘密。不要为适配而换业务栈，也不要在 SpringBok 写应用专用 SQL。

## 2. 建立接入目录

在应用仓库根目录建立 `.sba/`。从 [文件结构](files.md) 和教学示例开始，保持 manifest id 稳定。使用稳定 `x.y.z` 应用版本；普通更新必须新版本严格递增且提交 SHA 不同。manifest schema 版本、部署声明 schema 版本和应用版本是三件事。

## 3. 实现统一入口

入口接收 RequestPath 和 ResultPath，工作目录是应用仓库根。先验证请求身份、配置和动作，再决定是否允许写入。秘密从执行端环境获取，不从公开配置读取。内部可调用 Python、Node 或现有工具，但不得拼接不可信 shell。

deploy、update、verify、preview、destroy-preview 在 v3 中都必须声明。repair 是可选的独立恢复动作。按 [生命周期](lifecycle.md) 返回真实检查，不要为了让页面显示成功而补几个恒为 true 的字段。

## 4. 让平台理解资源

在 deployment v2 中声明账号、公开字段、资源与写入目标。平台创建资源并将 ID 写入声明路径；应用使用这些已有 ID，而不是再次创建同名资源。声明所有实际修改的目标。资源清单不是账号 token 的沙箱，仍须审阅固定提交的完整代码并使用最小权限。

如果服务支持首次管理员初始化，可声明 administrator。账号邮箱是公开配置，密码是独立秘密；更新与修复不得重置既有密码或给同邮箱账号隐式提权。邮箱登记不等于邮箱验证或 Google OAuth 授权。

## 5. 验证并接入控制台

先做离线合同与假后端测试，再验证真实数据保留、失败状态和可恢复边界。推送已审阅版本，使用 SpringBok 已连接的仓库选择固定 SHA，检查预览中的账号、资源、域名与秘密引用，确认后只提交一次。

检查执行 run 的业务回执、实际云资源和用户登录，不只看 Actions conclusion。测试未覆盖的部分必须列明；不能拿空数据库更新代替真实有数据的迁移验收。

## 固定实例的限时机器更新委托

默认仍要求正常管理员身份。经 owner 明确批准，可为已有成功部署的单实例启用最长
24 小时的 Access Service Token 委托。批准精确绑定实例、原 parent task、仓库与完整
新 commit SHA；不接受浮动引用。机器 plan 仅提交实例与原 parent，平台从原任务复用
配置、资源和连接，再按正常确认、一次性派发/许可、业务回执执行 update。

该模式只包含 session、本次更新计划/提交/结果查询及独立 verify；不包含全量索引、
源码目录、连接/资源管理、新部署、预升级、删除、repair、导入或 unknown 恢复。
同一实例的其他历史任务也不在查询权限内。旧版 SBA 委托不会自动获得这些新权限。
完整 scope 绑定 CSRF/confirmation；刷新有效 Access JWT 不改变 proof，修改批准使旧 proof
失效。原 owner、邮箱策略和 Access 验签保持；撤销或到期后旧 proof 不独立授权。

委托不是 CI 例外或业务验收。凭据仅放受控环境或 OS 加密存储，禁止进入源码、URL、
日志及公开制品；无需继续使用时禁用专用 token，且不能自动续期。

### 单个未接受任务的额外取消批准

网络断开、计划过期、state 409 或没有 GitHub run 都不能证明请求未被接受。不得据此重发。
仅在 owner 另行明确批准后，`deployment` 可增加 `cancellation: { taskId, planDigest }`，
绑定精确的原 task 与 server-issued plan digest；原实例、parent、仓库、SHA、24 小时上限不变。
该字段额外开放带 CSRF 的 `POST /api/admin/deployments/cancel-unstarted`，输入只有 taskId。

取消先在原 owner vault 的 reservation 事务内要求该 task 无 reservation、实例最新头仍为
批准 parent，再持久写入不可改写的 fence；随后在该 Connected DO 同步事务内要求无
bootstrap 和任何 SBA 表并写同一记录。迟到 reserve/initialize/begin 均拒绝。两份 fence
全部一致前，不能创建新计划；任一步不确定都保留已写记录，不自动回滚或继续更新。
原 head 未变化时重复精确取消仅确认同一记录，不派发；新任务推进后仍可经 state 查询
原取消记录。已存在 reservation 即停止，即使尚无 run/permit；
不移交实例头、不释放锁、不删除历史，不扩展成一般 unknown 恢复。两侧完成后，仍须为
同实例、同 SHA 从原 parent 新建短时计划，正常确认、一次派发并独立核验回执。

## 完成清单

- 文件、字段及示例通过当前源码校验器。
- 所有必需动作有真实实现；失败不会伪装为无副作用。
- 更新前备份，更新后证明数据保全。
- 预升级使用独立资源和数据副本，隔离邮件、支付等副作用。
- 清理只能处理批准的测试资源，不能删除源实例或共享 Zone。
- 秘密不进入公开请求、标准输出或结果制品。
- CI、真实发布、业务验收分别有证据。
