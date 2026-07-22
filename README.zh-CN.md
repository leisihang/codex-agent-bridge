# ECOS Studio Codex Agent Bridge

ECOS Studio AI / Agent GUI 使用的外部 Agent runtime。

英文版见：[README.md](README.md)。

## 简单概述

ECOS Studio 负责用户能看到的部分：项目页面、AI / Agent 面板、模式切换、
历史记录、停止按钮，以及 assistant 回复和命令/action block 的流式展示。

本仓库负责 GUI 背后的 Agent runtime。ECOS Studio 通过 `AGENT_BRIDGE_ROOT`
指向这个仓库，然后通过通用 Agent API 加载 `src/AgentRuntime.js`。bridge 会启动
Codex app-server，管理 session/turn，把 Codex 事件归一化后流式发回 GUI，并在
涉及 workflow 的动作执行前应用 guard 策略。

ECC CLI 仍然是 ECOS 正常运行 flow 的入口。打开 workspace、运行 step、运行
flow 仍然属于 ECOS/ECC 的职责，不是 Codex 的替代品。Agent bridge 可以在允许
的前提下读取 workspace 文件、运行受控命令、解释结果，但真实 RTL-to-GDS 执行
仍然依赖可用的 ECC CLI、PDK 和底层工具链。

当前系统中有三条相互独立的链路：

```text
Agent 对话：
ECOS Studio GUI -> agent IPC/preload -> codex-agent-bridge -> Codex app-server

ECOS workspace 和 flow：
ECOS Studio GUI -> desktop runtime -> ecc workspace commands -> EDA tools/PDK

DSE 研究原型：
codex-agent-bridge -> DSE controller/FSM -> tool adapter -> 当前 OpenROAD Docker
```

DSE 原型已经保留了清晰的 adapter 边界，后续可以把现在的 OpenROAD Docker
backend 替换成 ECC CLI adapter。

## 当前实现内容

### ECOS Studio AI / Agent GUI 集成

配套的 ECOS Studio 分支提供 GUI 侧能力：

- ECOS Studio 中的 AI / Agent 聊天面板。
- 通用 `agent:*` IPC handlers。
- 暴露给前端的 preload API：`window.ecosDesktop.agent`。
- renderer 和 desktop 进程共享的 Agent contract。
- `pnpm run dev:agent` 启动路径。
- 通过 `AGENT_BRIDGE_ROOT`、`CODEX_AGENT_BRIDGE_ROOT`、external 目录或同级目录
  自动查找 bridge。
- General assistant 和 Flow-guarded design 两种模式。

本仓库就是这个 GUI 使用的外部 runtime。

### Agent bridge runtime

bridge 当前提供：

- Codex app-server provider。
- 通过 `codex app-server --listen stdio://` 启动 Codex 进程。
- session/thread 创建和恢复。
- turn 启动、流式事件归一化、中断和状态查询。
- 命令/action 事件转发，供 GUI 展示。
- 面向 ECOS workflow 的 `CodexFlowGuard` 原型。
- runtime、mode、FlowGuard 的验证脚本。

### ECC CLI 边界

ECOS Studio 使用 ECC CLI 处理 workspace 操作，例如：

```bash
ecc workspace load --directory <workspace> --json
ecc workspace get-home --directory <workspace> --json
ecc workspace run-step --directory <workspace> --step <step> --json
ecc workspace run-flow --directory <workspace> --json
```

当前事实边界：

- ECC CLI 和 Codex、bridge 是分开的。
- 只要 ECC 环境、PDK、工具链可用，ECOS Studio 可以通过 ECC CLI 打开并运行
  workspace。
- bridge 不替代 ECC CLI。
- 当前 DSE smoke 还没有通过 ECC CLI 调用工具，而是通过 `OpenRoadDockerAdapter`
  直接调用 OpenROAD Docker。
- 后续合理的下一步是实现 `EccCliDseAdapter`，让同一个 DSE controller 通过
  ECC CLI 作为统一工具入口。

### DSE / FSM 研究原型

bridge 里还包含一个最小 DSE 闭环：

- `DseController` 负责启动 candidate、运行 early/final stage、记录状态，并在
  需要时创建分支 candidate。
- `DseFlowGuard` 校验 candidate 状态转移、Agent 动作、分支深度、最大 candidate
  数和参数 schema。
- `DseTriggerPolicy` 先检查 WNS、TNS、拥塞等 cheap metrics，只在指标命中时
  调用 subagent。
- `RuleBasedDseSubAgent` 和 `CodexDseSubAgent` 提供 subagent 决策接口。
- `OpenRoadDockerAdapter` 是当前已经验证的工具后端。

这是 Agent bridge 的研究扩展，不是基础 ECOS Agent 聊天所必需的部分，也不是
生产级 ECOS/ECC flow engine。

## 当前验证状态

bridge 侧验证：

```bash
npm run verify:agent-runtime
npm run verify:agent-modes
npm run verify:flow-guard
npm run verify:manager-flow-guard
npm run verify:dse-closed-loop
```

真实 OpenROAD DSE smoke：

```bash
npm run smoke:openroad-dse
```

已经用 `nangate45/gcd` 验证过下面这个最小闭环：

1. 创建 seed candidate：`gcd_seed`。
2. 在 Docker 中运行 OpenROAD-flow-scripts 的 `make place`。
3. 从 `3_detailed_place.rpt` 收集 WNS/TNS。
4. `WNS = -0.02` 命中阈值后触发 subagent review。
5. `DseFlowGuard` 校验并接受 `branch_rerun` 决策。
6. 将 `CORE_UTILIZATION` 从 `55` 改为 `50`。
7. 创建新 candidate：`gcd_seed_branch_1`。
8. 重新运行 `place`。
9. 继续运行 `make finish`。
10. 生成 GDS，并记录 metrics、logs、history 和 agent decisions。

在 ORFS 中，`make place` 包含 global placement 和 detailed placement。本原型
用于触发判断的是 detailed placement 后的 report。

GUI 验证说明：Electron GUI 需要可用图形环境，例如 `DISPLAY`、X11、Wayland 或
VNC。bridge 可以 headless 验证，但 ECOS Agent 面板最终仍需要在图形会话中检查。

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
  面向 ECOS workflow 的 FlowGuard 状态机和验证脚本。

src/dse/
  DSE controller、DSE FSM/FlowGuard、trigger policy、subagent 和 adapter。

docs/
  provider protocol 文档和 DSE closed-loop 文档。

demo-rtl-project/
  用于 bridge demo 的最小 RTL workspace。

generated/
  app-server 协议类型快照，作为参考资料。
```

## 环境要求

基础 Agent bridge 验证需要：

- Node.js
- npm
- Codex CLI 已安装并登录

ECOS Studio GUI 集成需要：

- ECOS Studio GUI 依赖
- 可用图形桌面环境
- 通过 `AGENT_BRIDGE_ROOT` 指向本 bridge 仓库

正常打开 ECOS workspace 和运行真实 flow 还需要：

- ECOS 子模块已初始化
- ECC CLI 可用
- 对应 PDK 和 EDA 工具链资源可用

先检查 Codex：

```bash
codex --version
codex login
codex app-server --listen stdio://
```

如果最后一条命令能启动，说明 app-server 可用。确认后用 `Ctrl+C` 停掉；正式
使用时 bridge 会自己启动 app-server。

## 配合 ECOS Studio 快速启动

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

更完整的 ECOS 侧说明在 ECOS Studio 仓库：

```text
ecos/docs/agent-codex-gui.md
ecos/docs/agent-codex-gui.zh-CN.md
```

## 验证命令

在本仓库中执行：

```bash
npm run probe
npm run demo
npm run demo:multi
```

runtime 和 FlowGuard 验证：

```bash
npm run verify:agent-runtime
npm run verify:agent-modes
npm run verify:flow-guard
npm run verify:manager-flow-guard
```

不依赖真实 EDA 工具的 DSE 闭环验证：

```bash
npm run verify:dse-closed-loop
```

真实 OpenROAD Docker smoke：

```bash
npm run smoke:openroad-dse
```

常用 OpenROAD smoke 环境变量：

```bash
OPENROAD_DSE_ORFS_ROOT=/path/to/OpenROAD-flow-scripts
OPENROAD_DSE_RUN_ROOT=/path/to/run-root
OPENROAD_DSE_IMAGE=openroad/flow-ubuntu22.04-builder:ea032d
OPENROAD_DSE_EARLY_TARGET=place
OPENROAD_DSE_FINAL_TARGET=finish
```

触发 branch-rerun 的 demo 参数：

```bash
OPENROAD_DSE_MAX_BRANCH_DEPTH=1 \
OPENROAD_DSE_MAX_CANDIDATES=2 \
OPENROAD_DSE_TRIGGER_WNS_BELOW=0 \
OPENROAD_DSE_BRANCH_WNS_THRESHOLD=0 \
OPENROAD_DSE_PRUNE_WNS_THRESHOLD=-1 \
npm run smoke:openroad-dse
```

## DSE 迁移到 ECC CLI 的位置

DSE controller 通过很小的 adapter 接口调用工具后端：

```js
await adapter.prepareExperiment(context);
await adapter.runStage({ candidate, context, stage: "early" });
await adapter.collectMetrics({ candidate, context, runResult, stage: "early" });
await adapter.runStage({ candidate, context, stage: "final" });
await adapter.collectMetrics({ candidate, context, runResult, stage: "final" });
```

当前由 `OpenRoadDockerAdapter` 实现。后续可以新增 `EccCliDseAdapter`，在这个
接口里调用 ECC CLI 命令。届时链路会变成：

```text
ECOS Agent GUI / bridge
  -> codex-agent-bridge DSE controller
  -> ECC CLI adapter
  -> ecc workspace run-step / run-flow
  -> ECC 选择的 EDA 后端
```

更多细节：

- [DSE closed loop](docs/dse-closed-loop.md)
- [DSE closed loop 中文版](docs/dse-closed-loop.zh-CN.md)

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

1. 实现 `AgentRuntime.js` 使用的 runtime 方法。
2. 在 `src/core/AgentProviderRegistry.js` 注册 provider。
3. provider-specific 的 process/RPC/protocol 逻辑放在本仓库。
4. 只向 ECOS Studio 暴露归一化后的 Agent events。

注册示例：

```js
registerAgentProvider("my_rpc_agent", (options) => new MyRpcAgentProvider(options));
```

## 常见问题

如果 Codex 无法启动：

```bash
codex --version
codex login
codex app-server --listen stdio://
```

如果 ECOS Studio 找不到 bridge：

```bash
echo "$AGENT_BRIDGE_ROOT"
ls "$AGENT_BRIDGE_ROOT/src/AgentRuntime.js"
```

如果 bridge 可以聊天，但 ECOS 不能打开或运行 workspace，请检查 ECOS `ecc`
CLI 和工具链环境。这和 bridge 协议是两件事。

如果 DSE OpenROAD smoke 失败，请检查 Docker、OpenROAD-flow-scripts 路径和所选
Docker image。
