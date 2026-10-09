# 人类开发者文档站

`site.json` 是显式页面清单。`content/` 放人类入口文章；逐文件参考与接入流程直接读取
`../ai-docs/` 的对应 Markdown，示例读取同一份教学文件，不维护第二套协议字段。
`build.mjs` 使用无第三方依赖的受限 Markdown 渲染器：标题、段落、列表、表格、代码块、
链接、行内代码及加粗；HTML 一律转义，不执行远程 include 或 JavaScript。

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
