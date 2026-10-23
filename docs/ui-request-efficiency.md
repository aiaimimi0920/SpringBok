# UI-06 全界面主题与状态请求预算

2026-10-23，主 AI 负责；代码、全套新静态资产与 Pages 已上线。用户授权覆盖 SpringBok、AssetLibrary、NAccount 全界面，并已明确授权提交推送及升级。

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

## 实际发布与生产核验

- PR #105 正常合并，代码 main `5b7d21e355a4f916f7d7c71acdd016c658c82828` 的全部 CI 成功，Pages publish 成功。
  PR 首轮 synthetic sba-windows 有一次 60 秒原生 PowerShell 超时，本地同套 4/4 通过，精确失败 job 重跑一次后成功；
  main 首轮即全通过。未改测试/超时边界，未重跑生产任务。
- 使用 exact-main bundle，SHA-256 `7504c467c7e94dd73dfea6337d2a936f4fc4364ee42bef9153a60fbbf0273f5b`，
  上传 26 个本轮静态资产；初次 UI 发布 Worker version `261d5d4a-03ce-43b5-b8e5-9823b759d4b4` /
  deployment `6c44a8b6-574a-42ac-90ac-dc14c1fcbb0c`。不是只更新 Worker 而用 keep_assets 留旧 UI。
  33 个 bindings、运行设置、资源 namespaces 和原 Access policies 保留。
- NAccount 旧 UI submit 未确认，未重放。用户另行明确批准后，仅建立两小时、原实例/parent/3.2.7 完整 SHA
  绑定的临时维护授权。既有双侧栅栏确认无 reservation/bootstrap 才继续；未删除数据、解锁、转移锁或改历史。
  临时 token 已禁用，原控制 bindings 恢复、旧 policies 不变、独立无 Cookie 探针 302。
  最终 settings-only version `68ca8567-4379-409a-8290-46d068a8d2ec` /
  deployment `ff6ff7ed-7f79-4b43-9a0d-7c24825010a0` 的实际控制代码摘要与上述 bundle 一致，static assets/runtime 配置保持。
- AssetLibrary 原实例 0.4.14：update run `39948275033` 为 `deployed-unverified`、七检查通过；独立 verify
  run `39948761193` 为 `succeeded`、四检查通过。NAccount 原实例 3.2.7：update run `39949925541`
  为 `deployed-unverified`、五检查通过；独立 verify run `39950926985` 为 `succeeded`、三检查通过。
  每个 artifact 的 ZIP digest、run/task/source 独立核对。原 update 回执不改写。
- 实际 Edge 正式控制台显示两个新版本“可用性已验证”。活动期间前台 51.644 秒捕获到 7 次 service-state，
  全部仅查询活动 NAccount；没有重复 services 列表查询或对终态 AssetLibrary 的状态轮询。既有资源 usage 仍按一分钟缓存
  到期读取，本窗口有三次，不将状态轮询优化说成所有周期请求均消失。
  两实例均终态后，前台连续 145.407 秒捕获到零请求，观测未截断、无后续分页。
- 生产证据位于 `linshi/asset-store-ui-20261023/`，凭据和私密配置仅 DPAPI 保存，不进入公开文档或 Git。
  本轮没有重新执行所有应用业务、Linux 持久化或负载/费用验收。
