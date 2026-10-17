# 验证与常见问题

## 离线合同检查

在 SpringBok 仓库根运行 Node.js 22；以下命令不联网、不执行入口、不创建资源：

```sh
node pages/check-example.mjs
node --test pages/docs.test.mjs
```

检查自己的接入目录时，可提供应用仓库路径。检查只读取 manifest、deployment 与入口，不代表发布脚本或云权限已验证。

```sh
node pages/check-example.mjs /absolute/path/to/your-service
```

教学文件包含合法 v3 manifest、v2 deployment、一个公开请求样例及 PowerShell 入口。入口只返回 failed / EXAMPLE_NOT_IMPLEMENTED，不执行云写，不为尚未实现的动作生成成功。需要在自己的仓库替换实现，不能直接拿它部署生产。

## 下一层验证

- 先测试各动作的请求、结果、退出码、超时、失败诊断和秘密不泄漏。
- 用有代表性的测试数据验证 update 的备份和保全；预升级核对源资源未变。
- 在授权的独立环境验证实际 provider 绑定、域名、凭据权限和业务登录。
- 只有实际验证过的层级才能标注通过；离线示例检查不检查网络或真实源码来源。

## 源码授权失败诊断

源码和一次性许可接口失败仍返回 HTTP 403 / `SBA_PERMIT_DENIED`。connected 和普通任务
均使用 `x-sba-denied-phase`、`x-sba-denied-reason` 的固定枚举区分请求、OIDC、任务、
GitHub run、源码传输和许可阶段；源码上游仅补充 HTTP 状态与 MIME 类别。
这些头不包含 token、claims、上游正文或异常原文，也不会绕过权限检查。
历史控制面可能未返回诊断头，缺失阶段不能作为鉴权失败原因的证据。
源码读取失败不消费部署许可；Actions 失败本身也不是应用执行回执。保留任务和锁，
不要重跑旧 run 或将其写成部署成功，恢复必须独立核实任务身份与许可状态。

## 许可前升级恢复

同实例 update 的任务在从未发放许可、已绑定 run ID 时可进入“恢复升级”确认。
这不代表任意等待中的任务都能恢复：计划与提交均重新核对 GitHub 的精确执行器、
请求摘要、run attempt=1，以及 failure/cancelled/timed_out 终态。
owner、CSRF 和两分钟确认绑定原 task/run/digest；其他用户或过期确认不得执行。
提交原子保留旧 job 与证明，再仅发起一次新的 Actions run。原 task ID、请求、应用版本、
配置、资源和账户锁不变；旧 run 不再获得许可。旧执行保留为 not-executed，不能当作应用结果。
每任务最多三次显式恢复；首次 deploy、已发放许可、无 run ID 的不确定派发均不支持。
派发响应丢失后保留 dispatch-unknown，不自动重试。恢复接口不修改扫描策略或业务数据。

## 常见误区

| 现象 | 核查方向 |
| --- | --- |
| manifest 被拒绝 | 是否把 v3 必需的 preview/destroy-preview 漏掉，或添加了非白名单字段 |
| 表单声明被拒绝 | 是否混淆两个 schemaVersion、路径重叠、缺 template，或把秘密放入 defaults |
| 版本无法更新 | 是否应用版本未递增、使用相同 SHA，或 previous 不匹配 |
| Actions 成功但服务未知 | 检查业务 receipt 身份、status、checks，不只看 workflow conclusion |
| HTTP 200 但后台不可用 | 可能只是 Access/认证页面；核实真正后台资源及登录后业务 |
| 任务 unknown | 保留证据并核对副作用；不能重新点击部署或手动清锁掩盖状态 |

不要把错误日志原文直接塞入公开 errorCode。应输出固定、安全、可归类的代码，将秘密留在受控环境中。
