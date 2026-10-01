# M9：固定资源只读检查

真实测试控制台在服务卡上方提供“检查固定资源”。它读取固定目录中的8个
Deployment（四服务，各有测试/临时生产角色），核对确切 ID、名称和完整配置。
配置匹配任一已知版本时，才按该目录版本绑定的 server ID 读取服务器缓存状态。
不会发现、遍历或读取任意外部服务器，也不接受网页传入 URL、ID、配置或凭据。

结果列出固定资源身份、配置是否匹配、已知不可变镜像、服务器缓存状态，以及
本地是否仍有 unknown/accepted 记录。目标缺失、身份错误、未知完整配置、读取
失败或超时均明确显示。未知配置不展示原字段，也不跟随其中的外来 server ID。
同一已知 server 只读取一次。

## “匹配”不代表获准部署

所有响应始终 `executionReady=false`、`approvalGranted=false`，不会写 journal、
改变审批或解锁 unknown，不会写配置或发送 Deploy。已知目录内的其他版本也可
匹配，因此它不是“当前候选已准备”的证明；固定坏镜像同样属于已知测试目录。
检查不读取容器健康，也不替代执行前计划确认和执行后精确证据核对。

Komodo 2.3.3 的 [GetServerState 定义](https://github.com/moghtech/komodo/blob/v2.3.3/client/core/rs/src/api/read/server.rs)
只返回 `status`；其 [服务端实现](https://github.com/moghtech/komodo/blob/v2.3.3/bin/core/src/api/read/server.rs)
从 Core 内存缓存读取。没有回显 ID 或新鲜度时间戳，界面因此使用“Core 缓存：Ok”
等字样，不称即时在线或生产就绪。绑定依靠向可信既有 transport 请求固定 server ID，
不声称从该响应独立证明了服务器身份。未调用可能含旧 passkey 的 GetServer 配置接口。

## 超时、重复与取消

检查串行读取最多8个资源，以及这些匹配资源所引用的去重 server，至多8个。
每次读取沿用控制器的超时值；整轮截止不超过15秒，也不超过该超时的3倍。
超时后未读取的条目保持未确认，不恢复后台扫描，不自动重试。

点击“取消检查”中止浏览器等待并关闭请求；服务端把断连传到当前读取的
AbortSignal，停止后续读取并释放锁。已发送的只读请求不能撤回，未知 transport
也可能不遵守 abort，但其迟到结果不会采用、不会继续触发其他请求。
重新检查是新的只读请求，重复不会更改发布记录。Back/页面离开也取消；已取消
或旧 revision 的结果不再显示。检查期间与原控制器操作互斥，避免本控制器边读边写。

这仍不阻止其他 Komodo 写入者改变配置，不保证缓存新鲜，不提供真实所有者认证，
也不构成生产接入。HTTP 沿用 loopback、精确 Host/Origin、内存 CSRF 和大小限制。

## 本轮验证边界

单元与假后端 HTTP 测试覆盖固定目标、未知/错配/缺失、缓存不可用及未知枚举、
未决记录保留、截止时间、重复、取消和真实 HTTP 断连传播；普通 Chrome 回归
覆盖页面检查、取消/重开、配置异常、手机布局和零写入。截图标明假后端。
没有运行新的真实 Komodo、生成登录凭据或扩大 Docker 权限。

```sh
node --test tests/*.test.mjs scripts/ci/security-baseline.test.mjs
# 已有 Chrome 和锁定测试依赖时：
node tests/browser/execution-review.mjs
```

M6历史成功运行和后续源码改动仍明确区分，原证书不变，普通CI继续核验精确
历史提交/树/20项SHA256；累积变化记录在 [test-console-evolution.json](test-console-evolution.json)。
