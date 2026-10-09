# 人类开发者文档站

发布地址：https://aiaimimi0920.github.io/SpringBok/ 。由 main 的 Pages 工作流发布；
本地构建、PR 检查通过并不等于网站已经更新，应另核对发布任务和实际页面。

`site.json` 是显式页面清单。`content/` 放人类入口文章；逐文件参考与接入流程直接读取
`../ai-docs/` 的对应 Markdown，示例读取同一份教学文件，不维护第二套协议字段。
`build.mjs` 使用无第三方依赖的受限 Markdown 渲染器：标题、段落、列表、表格、代码块、
链接、行内代码及加粗；HTML 一律转义，不执行远程 include 或 JavaScript。
公开 Markdown、教学示例及样式通过同一已打开的普通文件句柄读取，拒绝链接来源；
不以“先检查路径、随后重新打开”的方式读取已检查文件。

```sh
node pages/check-example.mjs
node --test pages/docs.test.mjs
node pages/build.mjs /absolute/path/to/temporary/site
```

本地预览可使用 Python 标准库，只监听本机：

```sh
python -m http.server 4179 --bind 127.0.0.1 --directory /absolute/path/to/temporary/site
```

Windows 开发优先输出到 `C:/Users/Public/nas_home/AI/GameEditor/linshi/`。构建不删除目录，
应使用全新、空的输出目录；CI 只上传 `$RUNNER_TEMP/springbok-pages`，不上传仓库根。
站点使用相对链接，在 GitHub 项目路径 `/SpringBok/` 下运行，无自定义域名或后台 API。

新增公开内容时更新 site.json 和导航。不要将内部 docs、部署回执、日志、真实云账号、
邮箱、密钥或备份作为素材加入；CI 会检查公开输出的允许文件集合。

GitHub Pages 工作流仅 main 或手动 main 发布，PR 只构建验证。发布 job 单独使用
pages:write 与 id-token:write，不持有云部署秘密；不改变 SpringBok 管理平台的 Access。
