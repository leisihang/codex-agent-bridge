# Codex Agent Bridge 使用说明

这是 ECOS Studio 的外部 Agent 桥接层。

英文版见：[README.md](README.md)。

这个仓库的目标是把 agent runtime 逻辑放在 ECOS Studio 本体之外。ECOS Studio
通过 `AGENT_BRIDGE_ROOT` 加载本仓库的 `src/AgentRuntime.js`，再通过通用
Agent API 与它通信。当前第一个 provider 是 Codex app-server，但整体结构是
面向多 provider 的，以后可以接入其他 CLI/RPC agent。

## 这个仓库负责什么

负责：

- provider registry 和 runtime entrypoint
- 启动并管理 `codex app-server --listen stdio://`
- 创建和恢复 session/thread
- 启动 turn、接收 streaming events、中断 turn
- 把 Codex events 归一化成通用 Agent event
- 提供可选 FlowGuard 模式，用于 ECOS 风格流程约束

不负责：

- ECOS Studio GUI 本体
- 真实 ECC/EDA 工具安装
- 替代 ECOS `ecc` CLI 跑真实 flow
- 生产级多 agent plugin packaging

## 架构边界

```text
ECOS Studio renderer
  -> Electron preload / IPC
  -> ECOS Studio 中的 AgentRuntimeService
  -> AGENT_BRIDGE_ROOT/src/AgentRuntime.js
  -> provider registry
  -> Codex app-server provider
  -> codex app-server --listen stdio://
```

ECOS Studio 应保持很薄：

- Agent chat UI
- 通用 `agent:*` IPC handlers
- preload API
- shared TypeScript contracts
- 指向外部 bridge 的启动脚本

本 bridge 应负责：

- agent process management
- provider adapters
- event normalization
- session mapping
- approval / interrupt handling
- FlowGuard / workflow policy logic

## 仓库结构

```text
src/AgentRuntime.js
  ECOS Studio 加载的 runtime 入口。

src/core/
  Provider registry 和 JSON-line RPC process client。

src/providers/codex/
  Codex app-server provider adapter。

src/CodexAgentManager.js
  Codex thread、turn、approval、interrupt、FlowGuard 集成。

src/flow/
  FlowGuard 状态机和验证脚本。

demo-rtl-project/
  用于 bridge demo 的最小 RTL workspace。

generated/
  app-server 协议类型快照，作为参考资料。
```

## 环境要求

- Node.js
- npm
- Codex CLI 已安装并登录

先检查 Codex：

```bash
codex --version
codex login
codex app-server --listen stdio://
```

如果最后一条命令能启动，说明 app-server 可用。确认后用 `Ctrl+C` 停掉；正式
使用时 bridge 会自己启动 app-server。

## 快速验证

在本仓库中执行：

```bash
npm run probe
npm run demo
npm run demo:multi
```

验证 runtime 和 FlowGuard：

```bash
npm run verify:agent-runtime
npm run verify:agent-modes
npm run verify:flow-guard
npm run verify:manager-flow-guard
```

可选 guarded-flow demo：

```bash
npm run demo:guarded-flow
```

`demo:guarded-flow` 默认使用 `demo-rtl-project`。如果要指定其他 project 或
demo tool 目录：

```bash
ECOS_CODEX_DEMO_PROJECT=/path/to/project \
ECOS_CODEX_DEMO_TOOLS_BIN=/path/to/demo-tools/bin \
npm run demo:guarded-flow
```

## 配合 ECOS Studio 使用

建议把 ECOS Studio 和 bridge 放在同一级目录：

```bash
git clone -b checkpoint/codex-gui-working git@github.com:<your-github-owner>/ecos-studio.git
git clone -b checkpoint/codex-agent-bridge-working git@github.com:<your-github-owner>/codex-agent-bridge.git
```

安装 ECOS Studio GUI 依赖：

```bash
cd ecos-studio/ecos/gui
corepack pnpm install
```

启动带 Agent bridge 的 ECOS Studio：

```bash
AGENT_BRIDGE_ROOT=/path/to/codex-agent-bridge corepack pnpm run dev:agent
```

同级目录示例：

```bash
cd ecos-studio/ecos/gui
AGENT_BRIDGE_ROOT=../../../codex-agent-bridge corepack pnpm run dev:agent
```

ECOS GUI 侧更完整的启动、排错、demo ECC shim 和真实 ECC CLI 说明见：

```text
https://github.com/<your-github-owner>/ecos-studio/blob/checkpoint/codex-gui-working/ecos/docs/agent-codex-gui.md
https://github.com/<your-github-owner>/ecos-studio/blob/checkpoint/codex-gui-working/ecos/docs/agent-codex-gui.zh-CN.md
```

注意：本 bridge 只负责 Agent/Codex 对话链路。ECOS 打开项目和运行真实
RTL-to-GDS flow 仍然依赖 ECOS Studio 的 `ecc` CLI 和本地工具链环境。

## Runtime API

公共入口：

```text
src/AgentRuntime.js
```

默认 provider：

```text
codex_app_server
```

Runtime 方法：

- `start`
- `startSession`
- `sendMessage`
- `interrupt`
- `getStatus`
- `setMode`
- `listSessions`
- `resumeSession`
- `stop`
- `onEvent`

## Provider 模型

当前 provider：

```text
src/providers/codex/CodexAppServerProvider.js
```

目标 out-of-process provider 契约：

- [Agent Provider Protocol](docs/provider-protocol.md)
- [Agent Provider Manifest](docs/provider-manifest.md)
- [Codex provider manifest 示例](examples/codex-provider.manifest.json)

如果以后要接入其他 agent provider：

1. 实现上面列出的 runtime 方法。
2. 在 `src/core/AgentProviderRegistry.js` 注册 provider。
3. provider-specific 的 process/RPC/protocol 逻辑放在本仓库。
4. 只向 ECOS Studio 暴露归一化后的 Agent events。

注册示例：

```js
registerAgentProvider("my_rpc_agent", (options) => new MyRpcAgentProvider(options));
```

## FlowGuard

FlowGuard 是一个可选的 ECOS workflow guard 原型。目标是在 agent 产生副作用
之前，根据 workflow context、step status、允许的路径/命令等信息做检查。

当前范围：

- 轻量 DAG/step 检查
- General assistant / Flow-guarded design 模式切换
- decision events，用于 GUI 展示和审计

暂不包括：

- 完整 artifact versioning
- 自动 rollback
- 生产级 EDA quality gate
- 替代 ECOS `ecc` flow engine

## 常见问题

如果 Codex 无法启动：

```bash
codex --version
codex login
codex app-server --listen stdio://
```

如果 ECOS Studio 找不到 bridge：

```bash
echo $AGENT_BRIDGE_ROOT
ls "$AGENT_BRIDGE_ROOT/src/AgentRuntime.js"
```

如果 ECOS Studio 可以聊天，但打不开项目或无法运行 flow，请检查 ECOS `ecc`
CLI 环境。这是 GUI/ECC 环境问题，不是 bridge 协议问题。

如果 demo 命令因为缺少真实 EDA 工具而失败，先使用 bridge 的 verify 脚本确认
桥接层本身可用。真实物理设计执行依赖 ECOS 工具链。

## 当前限制

- 目前只实现了 Codex app-server provider。
- FlowGuard 还是原型策略层。
- 真实物理设计执行依赖 ECOS/ECC/toolchain 安装。
- provider packaging 还不是生产级。
