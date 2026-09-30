# SpringBok

个人多服务器部署工作台，第一步是可运行、可审查的发布流程契约。
Production integration, production execution and license selection remain pending evaluation. M3 provides a loopback-only demo UI, not a production control panel. This repository does not fork or bundle Komodo.

## M3：打开本地演示界面

```sh
node scripts/demo.mjs
```

目前仅支持 Linux、Node.js 22+（Windows/macOS 暂不支持）。
打开 `http://127.0.0.1:3210`，无需安装运行时依赖。四个中文服务卡支持
模拟测试、模拟验收、晋级、回滚与持久历史；重启撤销未使用的模拟验收。
界面显著标注 DEMO，未连接真实服务器。
[使用、安全边界和崩溃恢复](docs/demo-console.md)

## M1：离线契约检查

需要 Node.js 22+，无需安装依赖：

```sh
node scripts/lab.mjs
node --test tests/*.test.mjs scripts/ci/security-baseline.test.mjs
```

第一条命令读取四个无密钥服务模板（Gateway、论坛、在线游戏、账号服务），
输出带序号的离线状态事件，停在“等待人工验收”。输出明确标注 OFFLINE。
这里的成功证据是合成数据，没有部署任何服务器，也没有真正验证四个业务应用。

- `examples/services.json`：固定服务、测试/生产目标 ID 和不可变制品/配置摘要
- `src/contract.mjs`：固定操作、验收绑定、失败状态、已知成功版本回滚契约
- `tests/contract.test.mjs`：流程、拒绝越权、过期验收、失败与回滚回归测试
- `examples/fixture/`：四类业务共用的无状态健康检查样例，不是实际业务实现
- `scripts/ci/container-smoke.sh`：仅隔离 runner 容器冒烟；v1→v2→v1 重建并检查响应

容器冒烟需 Docker：`bash scripts/ci/container-smoke.sh`。容器无对外端口、
无网络、无持久卷、不推送镜像，不部署 Komodo。此检查与离线状态机是两项
独立验证，不是 Komodo 或真实生产发布的端到端验证。

[流程和安全边界](docs/deployment-contract.md) ·
[Komodo 适配评估](docs/komodo-evaluation.md) ·
[仓库安全检查](docs/security-quality-baseline.md) · [安全政策](SECURITY.md)

## M2：真实 Komodo 集成验证

已用真实 Komodo 2.3.3 跑通8个部署映射、4个测试Procedure、四服务样例更新与回滚。
只允许明确授权后的 GitHub 临时测试机运行，需授予临时 Docker 管理权限；
不是可用于生产的安装脚本。[真实集成通过记录](https://github.com/aiaimimi0920/SpringBok/actions/runs/36715595686)
覆盖样例容器与失败阻断；M3另提供演示UI，真实业务、多机及生产人工验收仍待实现。[范围、授权和验收](docs/komodo-integration.md)
