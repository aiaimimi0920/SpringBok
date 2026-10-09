# SBA 文件结构

SBA 是一个接入目录与运行时协议，不是单个扩展名为 `.sba` 的文件。

| 文件 | 必需性 | 责任 |
| --- | --- | --- |
| `.sba/manifest.json` | 执行契约必需 | 应用身份、版本、固定运行环境、动作、秘密名称及可选修复声明 |
| `.sba/deployment.json` | 自助部署表单必需 | 账号、公开配置、资源和 Worker/域名目标的声明 |
| `.sba/springbok.ps1` | 示例入口名；实际由 entrypoint 指定 | 接收请求并原子写入结果；必须是 `.sba` 下简单 `.ps1` 文件名 |
| `.sba/*.py` 或其他辅助文件 | 应用自选 | 内部构建、发布、迁移逻辑；平台不规定 Python 模块名字 |
| 应用构建锁文件、迁移脚本 | 按应用需要 | 固定依赖和数据迁移，不属于 SpringBok 自动生成的业务代码 |
| RequestPath 指向的 JSON | 由执行端生成 | 一次任务的公开输入，不能作为仓库里的真实凭据配置提交 |
| ResultPath 指向的 JSON | 由应用生成 | 严格匹配任务的业务结果，不是 stdout 文本 |

入口调用形式如下；路径由执行端提供，不能改成自己的硬编码路径。

```powershell
powershell.exe -NoProfile -NonInteractive -File .sba/springbok.ps1 -RequestPath <absolute-request-path> -ResultPath <absolute-result-path>
```

工作目录是应用 checkout 根。entrypoint 不支持绝对路径、目录跳转或命令串；执行端还检查实际路径和符号链接边界。不要依赖开发者本机上的未提交文件。

执行端要求固定 HEAD、匹配的 HTTPS origin 和干净 checkout，连 ignored/untracked 内容及特殊索引标志也不能用来夹带本地实现。仅检查 JSON 形状不等于检查了这些来源约束。

应用写入的 ResultPath、执行器归一化的 result.json、GitHub artifact 中的 receipt.json 是不同层次。应用不要自行生成 permitId 或 GitHub 运行身份；receipt 封装由可信执行链生成和核验。

教学骨架位于 `ai-docs/examples/minimal/.sba/`，它故意返回 `EXAMPLE_NOT_IMPLEMENTED`，证明协议形状而非部署能力。示例目录内的 request.json 只用于离线测试。

事实来源：[contract.mjs](https://github.com/aiaimimi0920/SpringBok/blob/main/src/sba/contract.mjs)、[runner.mjs](https://github.com/aiaimimi0920/SpringBok/blob/main/src/sba/runner.mjs)、[deployment-contract.mjs](https://github.com/aiaimimi0920/SpringBok/blob/main/cloud/deployment-contract.mjs)。
