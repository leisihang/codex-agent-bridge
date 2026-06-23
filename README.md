# Codex Agent Bridge

External Agent bridge for ECOS Studio.

Chinese version: [README.zh-CN.md](README.zh-CN.md).

This repository keeps agent runtime logic outside the ECOS Studio source tree.
ECOS Studio loads the bridge through `AGENT_BRIDGE_ROOT` and talks to it through
a small generic Agent API. Codex app-server is the first implemented provider,
but the bridge is structured so other CLI/RPC agents can be added as providers
without putting provider-specific logic into ECOS Studio.

## What This Repository Is

This bridge is a thin runtime layer between a GUI host and an agent process.

It provides:

- provider registry and runtime entrypoint
- Codex app-server process management
- session/thread start and resume
- turn start, streaming events, and interrupt
- Codex event normalization into a generic Agent event shape
- optional FlowGuard mode for ECOS-style workflow constraints

It does not provide:

- the ECOS Studio GUI itself
- real ECC/EDA tool installation
- a replacement for ECOS `ecc` CLI flow execution
- production-grade multi-agent plugin packaging

## Architecture

```text
ECOS Studio renderer
  -> Electron preload / IPC
  -> AgentRuntimeService in ECOS Studio
  -> AGENT_BRIDGE_ROOT/src/AgentRuntime.js
  -> provider registry
  -> Codex app-server provider
  -> codex app-server --listen stdio://
```

ECOS Studio should stay thin:

- Agent chat UI
- generic `agent:*` IPC handlers
- preload API
- shared TypeScript contracts
- startup script that points to this external bridge

This bridge should own:

- agent process management
- provider adapters
- event normalization
- session mapping
- approval and interrupt handling
- FlowGuard / workflow policy logic

## Repository Layout

```text
src/AgentRuntime.js
  Runtime entry loaded by ECOS Studio.

src/core/
  Provider registry and JSON-line RPC process client.

src/providers/codex/
  Codex app-server provider adapter.

src/CodexAgentManager.js
  Codex thread, turn, approval, interrupt, and FlowGuard integration.

src/flow/
  FlowGuard state machine and verification scripts.

demo-rtl-project/
  Minimal standalone RTL workspace for bridge demos.

generated/
  Generated app-server protocol type snapshots used as reference material.
```

## Requirements

- Node.js
- npm
- Codex CLI installed and logged in

Check Codex locally:

```bash
codex --version
codex login
codex app-server --listen stdio://
```

If the last command starts successfully, stop it with `Ctrl+C`. The bridge will
start app-server itself when used by ECOS Studio.

## Quick Verification

From this repository:

```bash
npm run probe
npm run demo
npm run demo:multi
```

Runtime and FlowGuard checks:

```bash
npm run verify:agent-runtime
npm run verify:agent-modes
npm run verify:flow-guard
npm run verify:manager-flow-guard
```

Optional guarded-flow demo:

```bash
npm run demo:guarded-flow
```

`demo:guarded-flow` uses `demo-rtl-project` by default. To point it at another
workspace or demo tool directory:

```bash
ECOS_CODEX_DEMO_PROJECT=/path/to/project \
ECOS_CODEX_DEMO_TOOLS_BIN=/path/to/demo-tools/bin \
npm run demo:guarded-flow
```

## Use With ECOS Studio

Clone ECOS Studio and this bridge side by side:

```bash
git clone -b checkpoint/codex-gui-working git@github.com:<your-github-owner>/ecos-studio.git
git clone -b checkpoint/codex-agent-bridge-working git@github.com:<your-github-owner>/codex-agent-bridge.git
```

Install ECOS Studio GUI dependencies:

```bash
cd ecos-studio/ecos/gui
corepack pnpm install
```

Start ECOS Studio with this bridge:

```bash
AGENT_BRIDGE_ROOT=/path/to/codex-agent-bridge corepack pnpm run dev:agent
```

Example for sibling checkouts:

```bash
cd ecos-studio/ecos/gui
AGENT_BRIDGE_ROOT=../../../codex-agent-bridge corepack pnpm run dev:agent
```

Full ECOS-side setup, startup, troubleshooting, and demo/real-ECC notes are
documented in:

```text
https://github.com/<your-github-owner>/ecos-studio/blob/checkpoint/codex-gui-working/ecos/docs/agent-codex-gui.md
https://github.com/<your-github-owner>/ecos-studio/blob/checkpoint/codex-gui-working/ecos/docs/agent-codex-gui.zh-CN.md
```

Important: this bridge enables the Agent/Codex chat path. Opening ECOS projects
and running real RTL-to-GDS flow steps still depends on ECOS Studio's `ecc` CLI
and toolchain environment.

## Runtime API

The public entrypoint is:

```text
src/AgentRuntime.js
```

The default provider is:

```text
codex_app_server
```

Runtime methods:

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

## Provider Model

Current provider:

```text
src/providers/codex/CodexAppServerProvider.js
```

Target out-of-process provider contract:

- [Agent Provider Protocol](docs/provider-protocol.md)
- [Agent Provider Manifest](docs/provider-manifest.md)
- [Codex provider manifest example](examples/codex-provider.manifest.json)

To add another agent provider:

1. Implement a provider with the runtime methods listed above.
2. Register it in `src/core/AgentProviderRegistry.js`.
3. Keep provider-specific process/RPC/protocol code in this repository.
4. Expose only normalized Agent events to ECOS Studio.

Provider id example:

```js
registerAgentProvider("my_rpc_agent", (options) => new MyRpcAgentProvider(options));
```

## FlowGuard

FlowGuard is an optional prototype guard layer for ECOS-style workflows. It is
intended to constrain side-effecting agent actions by checking workflow context,
step status, and allowed paths/commands.

Current scope:

- lightweight DAG/step checks
- mode switch between general assistant and flow-guarded design
- decision events for GUI display and audit

Out of scope for now:

- full artifact versioning
- automatic rollback
- production-quality EDA quality gates
- replacing the ECOS `ecc` flow engine

## Troubleshooting

If Codex does not start:

```bash
codex --version
codex login
codex app-server --listen stdio://
```

If ECOS Studio cannot find the bridge:

```bash
echo $AGENT_BRIDGE_ROOT
ls "$AGENT_BRIDGE_ROOT/src/AgentRuntime.js"
```

If ECOS Studio can chat but cannot open or run projects, check the ECOS `ecc`
CLI environment. That is a GUI/ECC setup issue, not a bridge issue.

If a demo command fails because real EDA tools are missing, use the bridge
verification scripts first. Real physical-design execution requires the ECOS
toolchain.

## Current Limitations

- Codex app-server is currently the only implemented provider.
- FlowGuard is a prototype policy layer.
- Real physical-design execution depends on ECOS/ECC/toolchain setup.
- Provider packaging is not productionized yet.
