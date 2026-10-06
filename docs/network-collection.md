# M04-S01：普通用户只读网络吞吐采集

本项提供可以独立运行的 Linux 采集器，不表示已安装网络监控。开发状态见
[总计划](development-plan.md)，后续 M04-S02 才扩展[版本化指标通道](node-telemetry.md)。
原 v6 /30 文件包、daemon、Worker、SQLite 和 UI 不变，不在已有安装内追加文件。

## 运行与数据范围

在已审阅 checkout、Node.js 22+、普通 Linux 用户下运行：

```sh
node scripts/node-network.mjs
```

第一行 JSON 是 `unknown/warming-up`；此后采集和同步输出结束后至少等 30 秒。
实际窗口由单调纳秒计时器测量，不按理想 30 秒推算，不补采赶进度。SIGINT/SIGTERM
停止后丢弃在途采样结果，不再输出或发起新采样。CLI 拒绝 root、非 Linux 和任何参数。

只读取 `/proc/self/net/dev`、`/proc/sys/kernel/random/boot_id` 和
`/proc/self/ns/net` 的链接标识；后两个仅用于本地基线连续性检查，不进入输出。
无凭据、外部网络请求、抓包、IP/MAC/路由/业务内容、任意路径、环境变量采集或持久写入。
读路径的父目录和 procfs 由操作系统提供，O_NOFOLLOW 只约束最终组件，不认证宿主挂载。

## 数值与失败语义

- `schema=springbok-network/v1`，`scope=linux-network-namespace`，`unit=bytes-per-second`。
- 每个接口输出 `name`、`status/reason`、窗口内 `rxBytes/txBytes`，以及
  `rxBytesPerSecond/txBytesPerSecond`。速率为 `deltaBytes / actualSeconds`，四舍五入至两位小数。
  极低非零吞吐也可能因显示精度舍入为 0；字节差分仍保留，不能据此推断链路空闲。
- 累计计数严格解析为无符号 64 位 BigInt；先差分再转换，只允许安全整数 bytes 和
  安全的百分之一 bytes/s。超范围返回该接口 `unknown/counter-out-of-range`，不 clamp。
- 一个可用且未增长的接口是合法 0；预热、回退/回绕或基线变化的数值是 null，不能与 0 混淆。
- 接口的 RX/TX 任一计数回退则该接口 `unknown/counter-regressed`，不猜计数器位宽或累加回绕；
  其他接口仍可用时总状态为 `partial`。当前计数作为新基线，下一完整窗口可恢复。
- boot/namespace 或接口名字集合变化会丢弃整个窗口并重新建立基线；墙钟回退、单调时钟异常、
  超过安全纳秒差范围（约 104 天）也不计算速率。过早调用不移动基线。
- 读取、解析或时钟获取失败清除旧基线，返回固定原因和空接口数组，不回显原始错误；恢复先预热。
  空接口集合为 `unavailable/no-interfaces`。这不是在线状态或业务就绪证明。

`/proc/self/net/dev` 接受上限 64 KiB（最多额外 1 字节探针），最多 256 接口。
表头/16 列/重复名/整数/UTF-8 严格校验。当前支持 1–15 字节 ASCII 字母、数字、下划线、
点和连字符接口名（排除 `.`/`..`）；其他合法但不在此窄集合的名字使整次报告不可用，
不静默丢弃。文件按实际读取字节限量并关闭描述符，不依赖 procfs 的 st_size。

## 不应从这些数值推导什么

接口计数是当前进程可见 network namespace 的视角，不证明物理宿主/网卡位置，
也不等于容器自己的业务净载荷或运营商计费。包括回环、bridge、veth、隧道等接口；
同一流量可能在多个接口或两个方向出现，**不提供跨接口总和或物理出口带宽**。
输出不含链路额定速率，所以也不计算利用率百分比。

轮询能识别已观察到的名字集合/上下文变化和计数倒退，但没有 netlink 生命周期订阅：
同名接口在两次采样间删除重建、计数已超过旧值，或者 namespace 标识被复用，可能无法识别。
同次读取前后上下文检查也不排除 ABA；不宣称永久稳定接口身份或原子全接口快照。
连续性标识及前后读取只有局部一致性用途，不授予任何节点身份或执行权限。

## 验证入口

```sh
node --test tests/network.test.mjs tests/network-process.test.mjs tests/cpu.test.mjs tests/memory.test.mjs
node scripts/ci/network-native.mjs
```

纯契约覆盖 uint64/BigInt 精度、0/null、实际窗口与早调用、接口/上下文变化、回退/回绕、
局部失败、超范围、读取/UTF-8/实际限量/关闭、时钟异常与串行停止。Linux 进程测试验证
真实无参数 CLI 的预热和两个停止信号，非 Linux/root 单独验证拒绝，不将 skip 算作 Linux 通过。

原生对照只在一次性普通用户测试环境运行：CLI 的两个真实样本间隔至少 30 秒；
在两者之间向自建 `127.0.0.1` TCP 服务传递 4 MiB 固定合成 bytes，严格核对接收量；
从独立 `/sys/class/net/lo/statistics/{rx,tx}_bytes` 在两次采样前后取得累计计数上下界，
验证产品差分落在界内、至少包含该载荷、速率与真实窗口公式吻合，再 SIGTERM 收尾。
这是当前 namespace 回环链路证据，不是用户主机物理网卡、多机或公网吞吐验收。

该入口加入既有 contracts job，不新增权限/依赖、不修改生产开关或历史证据。
本轮实际结果、精确提交和 PR/main 状态记录在总计划与最终交付回执，不预报未运行检查。
