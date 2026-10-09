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
