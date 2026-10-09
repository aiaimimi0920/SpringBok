# 一个不会误部署的教学骨架

下面的文件来自 ai-docs/examples/minimal，同一份内容同时接受源码合同测试与站点构建。账号与 SHA 是明确的合成值，不对应真实服务。

入口故意返回 EXAMPLE_NOT_IMPLEMENTED。通过校验只说明文件形状合法，不表示它具备任何部署、更新、预升级或修复能力。

## .sba/manifest.json

{{example:manifest}}

## .sba/deployment.json

{{example:deployment}}

## .sba/springbok.ps1

{{example:entrypoint}}

## 离线请求样例

真实请求由 SpringBok 执行端生成，不应在应用仓库提交真实账号配置或秘密。

{{example:request}}

## 如何验证

在 SpringBok checkout 中执行 node pages/check-example.mjs。它只读文件并调用当前合同校验器，不执行 PowerShell，也不连接云服务。之后按 [验证与排错](validation.md) 完成更高层级的测试。
