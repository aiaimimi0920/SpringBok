# 用户服务配置校验与导出

M12提供实际用户输入的配置编译器。它读取你的服务清单，生成可审核的Komodo部分
Deployment配置草稿和确定性摘要，不再局限于CI固定样例。它不连接任何服务器、
调用Komodo、拉取镜像、创建卷或凭据，也不会把草稿提交给现有执行器。

## 使用

Linux、Node.js 22+，无需安装依赖：

```sh
node scripts/config.mjs examples/config/services.json
```

复制样例后填写自己的配置文件，再将上面的路径替换为该文件。样例镜像与Server ID
都是占位符，未查询真实资源。程序仅向stdout输出完整review JSON，不创建或覆盖
任何文件；验证失败返回非零，stdout为空，stderr给出字段位置及固定错误，不回显
输入内容。文件上限64KiB，拒绝非普通文件、符号链接及无效UTF-8/JSON。
CLI文件边界目前只支持Linux，纯编译器不依赖文件或网络。

## 输入字段

顶层固定为version:1、project和services。可配置1–4个不重复的已知服务：gateway、
forum、game、account；输出omittedServices明确列出未配置项，不强迫建立占位业务。
每个服务固定包含id、image、test和production，两环境共用同一不可变制品：

- image必须是显式registry/repository@sha256:64位小写摘要，拒绝tag、URL、账号密码及shell字符
- test/production各包含serverId（Komodo Server的24位ID）、全局唯一deploymentName、ports、volumes和secretRefs
- ports每项为hostIp、hostPort、containerPort、protocol；支持127.0.0.1或显式0.0.0.0，以及tcp/udp，整数端口1–65535。同Server/协议/端口的wildcard与loopback重叠会拒绝
- volumes只允许命名卷name、容器内containerPath、布尔readOnly。拒绝宿主路径、特殊系统挂载路径、路径穿越及重叠容器目录；同Server的卷不能在不同目标或挂载复用，防止测试与生产意外共享数据
- secretRefs只接受variable和reference两个标识符，不是密钥值、URL或密钥存储连接。不要把真实凭据放进配置文件；变量值必须以后通过另行批准的渠道解析

每个目标最多16端口、8卷、16密钥引用。未知字段（包括command、环境变量原文、
extra_args和任意URL）拒绝。支持语法是有意缩小的Docker名称/镜像子集，并不接受
所有合法Docker格式。测试与生产可位于同Server，但独立容器/命名卷不等于物理隔离。
同名卷位于不同Server时是不同卷，仍需确认实际存储驱动与备份策略。

## 输出含义

输出mode为user-configuration-review，executable与readiness始终false。
manifest为排序后的规范配置，manifestDigest绑定包括密钥引用在内的全部规范输入。
服务顺序变化不影响摘要；镜像、端口、卷、引用或目标变化影响摘要。

每个服务产生测试、生产两个draft：name、config、configDigest、unresolvedSecretRefs
和requirements。configDigest只绑定部分Komodo配置，**不含未解析密钥引用**，不能
拿它替代manifestDigest或生产审批绑定。草稿不是完整live配置、ResourceSync文件、
API请求或部署命令，不能直接作为既有执行目录的已认证输入。

固定配置使用bridge网络、unless-stopped重启、空command/extra_args，不允许自动
更新或构建触发部署；未解析environment为空且关闭秘密插值。registry account为空，
不假设私有镜像可拉取。server/swarm使用官方资源schema的别名，swarm显式为空。
端口和卷输出为Komodo转换字符串；它们只作为JSON数据输出，不拼成shell命令执行。

每项requirements明确列出尚未完成的工作：完整live默认值解析与资源所有权、镜像
可拉取性/平台/来源、镜像HEALTHCHECK与业务健康、运行位置与认证。0.0.0.0另外要求
审查外部网络暴露；命名卷要求核对创建/驱动/所有权/备份/数据迁移；密钥引用要求
安全解析。无这些依赖的服务也不能因此获得执行许可。当前不支持HTTP健康命令
生成，避免假定镜像包含curl或shell。没有重新设计现有验收、晋级、失败或回滚契约。

## 官方依据和验证

精确上游版本Komodo2.3.3，提交780ac68b992094a9fccd5fffb760e0c84fd3c3d1：

- [资源JSON Schema](https://github.com/moghtech/komodo/blob/v2.3.3/ui/public/schema/resources.json)：PartialDeploymentConfig字段/类型和restart枚举
- [Deployment定义](https://github.com/moghtech/komodo/blob/v2.3.3/client/core/rs/src/entities/deployment.rs)：server/swarm别名、image结构与配置语义
- [转换解析器](https://github.com/moghtech/komodo/blob/v2.3.3/client/core/rs/src/parsers.rs)及[Periphery转换输出](https://github.com/moghtech/komodo/blob/v2.3.3/bin/periphery/src/helpers.rs)：首个冒号拆分后按local:container组合，保留IP/端口及卷模式

tests/fixtures中的小型schema摘录保留来源，仅用于字段契约核对，不包含或运行上游
部署实现。上游GPL-3.0-or-later边界与既有Komodo评估一致，未fork或选择完整产品栈。

普通测试覆盖确定性/非变更、1–4服务、真实schema字段、端口冲突、卷隔离、非法
镜像/命令/密钥原文、摘要变化及CLI无写入/安全报错。未运行新的Komodo真实集成，
未声明服务器实际存在、镜像实际可用、业务部署成功或生产就绪；M10运行文件不变。
