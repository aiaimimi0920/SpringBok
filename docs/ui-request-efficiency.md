# UI-06 全界面主题与状态请求预算

2026-10-23，本地实现及验证通过，主 AI 负责；发布进行中，尚未部署。用户授权覆盖 SpringBok、AssetLibrary、NAccount 全界面，并已明确授权提交推送及升级。

正式管理后台继续使用原 cloud-admin tokens、布局和权限流程。本地 demo、配置审阅和执行控制台新增两个固定静态路径
`/neuro.css`、`/local-neuro.css`，只映射现有文件，未放宽 CSP、同源检查或路径白名单。历史列表、字段值、错误 phase、
预览标签、配置差异代码块分别映射语义色，避免旧浅底与暗色文字混搭；Pages 使用同值中性色，不从受保护控制面加载样式。

服务页保留五秒活动查询，但周期请求仅包含删除、派发/未知派发、执行、提交或独立验证仍活动的实例。
不重复取 services、不查终态实例，全部终态后停止。首次进入、操作完成、恢复可见会完整读取。
其他浏览器新建的实例不再在活动轮询期间每五秒自动发现，需重新加载页面或恢复可见后读取。
隐藏时不发送周期查询，后台 reconcile、unknown、锁/许可和回执保持，不重放 submit/dispatch。

验证命令：

```powershell
rtk proxy node tests/browser/service-polling.mjs
rtk proxy node tests/browser/connected-execution.mjs
rtk proxy node tests/browser/service-verification.mjs
rtk proxy node tests/browser/neuro-ui.mjs
rtk proxy node tests/browser/config-review.mjs
rtk proxy node tests/browser/local-neuro-ui.mjs
rtk proxy node --test pages/docs.test.mjs
rtk proxy node pages/check-example.mjs
rtk proxy node pages/build.mjs <新的空输出目录>
```

浏览器使用实际页面与 workerd、隔离合成身份/provider，无生产访问；请求计数、终态停止、验证活动、隐藏/恢复及零派发通过。
四页主题、五种宽度、焦点/弹窗/错误/禁用等既有浏览器回归通过。配置审阅使用真实本地回环 server。
Windows 下 demo 报 `UNSUPPORTED_PLATFORM`，配置 CLI 两项分别受 Linux-only 文件边界和 symlink EPERM 限制；未标绿、未放宽保护。
新增本地主题浏览器保护使用真实 demo/test-console HTML、CSS、控制器和合成只读状态，四种宽度、面板/历史/错误/焦点/弹窗 Escape 与零写操作通过；这不是 Linux 持久化或真实执行验收。
Pages 文档 6 项、示例校验及隔离静态构建通过；实际静态产物在 GitHub project 子路径下验证五种宽度、深色背景、绿色品牌且没有外部请求或写操作。

本轮三个项目的 68 个新增/修改文本文件经过 UTF-8 无 BOM 与各仓库 `git diff --check` 检查；固定版本 Gitleaks 8.30.1 扫描变更文件快照未发现泄漏，不代表全历史或运行时渗透测试。

双入口影响：没有 SBA 清单/字段、CLI 或生命周期合同变更，因此不修改 ai-docs 协议说明；人类入口补充实际控制台刷新方式。
发布仍需原精确版本和独立 verify；UI 与本地请求减少不等于部署成功，也不承诺云费用下降的实测比例。
