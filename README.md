# Codex Agent Bridge

External agent bridge for ECOS Studio experiments.

This repository keeps the agent runtime outside the ECOS Studio source tree. ECOS
Studio loads it through `AGENT_BRIDGE_ROOT` and talks to it through a small
generic Agent API. Codex app-server is the first provider; the bridge is designed
so more providers, such as RPC-based CLI agents, can be added without putting
their logic into ECOS Studio.

## What It Provides

- Starts and manages `codex app-server --listen stdio://`
- Initializes Codex app-server and opens sessions
- Starts turns and streams assistant events
- Maps Codex events into a generic Agent event shape for ECOS Studio
- Supports session listing and resume
- Supports turn interruption
- Provides an optional FlowGuard mode for ECOS-style flow constraints
- Keeps provider-specific logic outside the ECOS Studio GUI repository

## Repository Layout

```text
src/AgentRuntime.js
  Generic runtime entry loaded by ECOS Studio.

src/core/
  Generic provider registry and JSON-line RPC process client.

src/providers/codex/
  Codex app-server provider adapter.

src/CodexAgentManager.js
  Codex thread, turn, approval, interrupt, and FlowGuard integration.

src/flow/
  FlowGuard state machine and verification scripts.

demo-rtl-project/
  Minimal standalone RTL workspace for bridge demos.
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

The last command should start the app-server process. Stop it with `Ctrl+C`
after confirming it starts.

## Standalone Verification

From this repository:

```bash
npm run probe
npm run demo
npm run demo:multi
```

For the generic runtime and FlowGuard checks:

```bash
npm run verify:agent-runtime
npm run verify:flow-guard
npm run verify:manager-flow-guard
```

Optional guarded-flow demo:

```bash
npm run demo:guarded-flow
```

## Use With ECOS Studio

Clone ECOS Studio and this bridge side by side:

```bash
git clone -b checkpoint/codex-gui-working git@github.com:leisihang/ecos-studio.git
git clone -b checkpoint/codex-agent-bridge-working git@github.com:leisihang/codex-agent-bridge.git
```

Install ECOS Studio GUI dependencies:

```bash
cd ecos-studio/ecos/gui
corepack pnpm install
```

Start the GUI with this bridge:

```bash
AGENT_BRIDGE_ROOT=/path/to/codex-agent-bridge corepack pnpm run dev:agent
```

Example for sibling checkouts:

```bash
cd ecos-studio/ecos/gui
AGENT_BRIDGE_ROOT=../../../codex-agent-bridge corepack pnpm run dev:agent
```

If Electron dependency download is slow in China, install with:

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ corepack pnpm install
```

## ECOS Studio Boundary

ECOS Studio should stay thin:

- GUI components
- `agent:*` IPC handlers
- preload bridge
- shared TypeScript contracts
- development script that points to this external bridge

This repository should own:

- agent process management
- provider adapters
- event normalization
- session mapping
- approval handling
- FlowGuard / workflow policy logic

When adding another agent provider, prefer adding it under `src/providers/` and
registering it in `src/core/AgentProviderRegistry.js`. Avoid adding
provider-specific runtime logic to ECOS Studio.

## Provider Model

The public entry for ECOS Studio is:

```text
src/AgentRuntime.js
```

It accepts a `provider` option. The current default provider is:

```text
codex_app_server
```

Future providers should implement the same runtime-facing methods:

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

## Current Limitations

- Codex app-server is currently the only implemented provider.
- FlowGuard is a prototype guard layer for ECOS-style flow validation.
- Real physical-design execution still depends on the local ECOS/toolchain
  environment.
- The demo project is for integration validation, not full production EDA flow.

