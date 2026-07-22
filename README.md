# Codex Agent Bridge for ECOS Studio

External Agent runtime for the ECOS Studio AI / Agent GUI.

Chinese version: [README.zh-CN.md](README.zh-CN.md).

## Simple Overview

ECOS Studio owns the user-facing GUI: project pages, the AI / Agent panel,
mode switches, history controls, stop controls, and display of streamed
messages or command/action blocks.

This repository owns the Agent runtime behind that GUI. ECOS Studio points to
this checkout with `AGENT_BRIDGE_ROOT`, then calls `src/AgentRuntime.js` through
a generic Agent API. The bridge starts Codex app-server, manages sessions and
turns, streams normalized events back to the GUI, and applies guard policies
before workflow-related actions are accepted.

ECC CLI remains the normal ECOS flow engine. Opening a workspace and running
ECOS flow steps are still ECOS/ECC responsibilities, not Codex replacements.
The Agent bridge can talk about a workspace, read files when allowed, and run
approved commands, but real RTL-to-GDS execution depends on a working ECC CLI,
PDK, and toolchain environment.

The three paths are intentionally separate:

```text
Agent chat:
ECOS Studio GUI -> agent IPC/preload -> codex-agent-bridge -> Codex app-server

ECOS workspace and flow:
ECOS Studio GUI -> desktop runtime -> ecc workspace commands -> EDA tools/PDK

DSE research prototype:
codex-agent-bridge -> DSE controller/FSM -> tool adapter -> OpenROAD Docker now
```

The DSE prototype has a clean adapter boundary so the current OpenROAD Docker
backend can later be replaced by an ECC CLI adapter.

## Current Implementation

### ECOS Studio AI / Agent GUI integration

The paired ECOS Studio branch provides the GUI side of the integration:

- AI / Agent chat panel in ECOS Studio.
- Generic `agent:*` IPC handlers.
- Preload API exposed as `window.ecosDesktop.agent`.
- Shared Agent contracts used by the renderer and desktop process.
- `pnpm run dev:agent` startup path.
- Bridge discovery through `AGENT_BRIDGE_ROOT`, `CODEX_AGENT_BRIDGE_ROOT`,
  external checkout paths, or sibling checkout paths.
- General assistant mode and flow-guarded design mode.

This repository is the external runtime used by that GUI.

### Agent bridge runtime

The bridge currently provides:

- Codex app-server provider.
- Codex process startup over `codex app-server --listen stdio://`.
- Session/thread start and resume.
- Turn start, streaming event normalization, interrupt, and status handling.
- Command/action event forwarding for GUI display.
- `CodexFlowGuard` for ECOS-style guarded workflow mode.
- Verification scripts for runtime, modes, and FlowGuard behavior.

### ECC CLI boundary

ECOS Studio uses ECC CLI for workspace operations such as:

```bash
ecc workspace load --directory <workspace> --json
ecc workspace get-home --directory <workspace> --json
ecc workspace run-step --directory <workspace> --step <step> --json
ecc workspace run-flow --directory <workspace> --json
```

Facts about the current state:

- ECC CLI is separate from Codex and from this bridge.
- ECOS Studio can use ECC CLI to open and run workspaces when the ECC
  environment, PDK, and toolchain are available.
- The bridge does not replace ECC CLI.
- The current DSE smoke path does not yet call ECC CLI. It calls OpenROAD
  Docker directly through `OpenRoadDockerAdapter`.
- The intended next step is an `EccCliDseAdapter` that lets the same DSE
  controller call ECC CLI as the unified tool entry.

### DSE / FSM research prototype

The bridge also includes a minimal DSE closed loop:

- `DseController` launches candidates, runs early/final stages, records state,
  and creates branch candidates.
- `DseFlowGuard` validates candidate state transitions, agent actions, branch
  depth, maximum candidate count, and parameter schemas.
- `DseTriggerPolicy` checks cheap metrics such as WNS, TNS, and congestion
  before asking a subagent.
- `RuleBasedDseSubAgent` and `CodexDseSubAgent` implement the subagent
  decision interface.
- `OpenRoadDockerAdapter` is the currently verified tool backend.

This is a research extension of the Agent bridge. It is not required for basic
ECOS Agent chat, and it is not yet the production ECOS/ECC flow engine.

## Verified Status

Bridge-only checks:

```bash
npm run verify:agent-runtime
npm run verify:agent-modes
npm run verify:flow-guard
npm run verify:manager-flow-guard
npm run verify:dse-closed-loop
```

Real OpenROAD DSE smoke:

```bash
npm run smoke:openroad-dse
```

The real smoke run verified this loop on `nangate45/gcd`:

1. Create seed candidate `gcd_seed`.
2. Run OpenROAD-flow-scripts `make place` in Docker.
3. Collect WNS/TNS from `3_detailed_place.rpt`.
4. Trigger subagent review when `WNS = -0.02` matched the configured threshold.
5. Accept a `branch_rerun` decision after `DseFlowGuard` validation.
6. Change `CORE_UTILIZATION` from `55` to `50`.
7. Create `gcd_seed_branch_1`.
8. Re-run `place`.
9. Continue to `make finish`.
10. Generate GDS and record metrics, logs, history, and agent decisions.

In ORFS, `make place` includes global placement and detailed placement. The
trigger metric used by this prototype is the detailed-placement report.

GUI verification note: Electron GUI display requires a working graphical
environment such as `DISPLAY`, X11, Wayland, or VNC. The bridge can be verified
headlessly, but the final ECOS Agent panel must be checked in a graphical
session.

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
  ECOS-style FlowGuard state machine and verification scripts.

src/dse/
  DSE controller, DSE FSM/FlowGuard, trigger policies, subagents, and adapters.

docs/
  Provider protocol docs and DSE closed-loop docs.

demo-rtl-project/
  Minimal standalone RTL workspace for bridge demos.

generated/
  Generated app-server protocol type snapshots used as reference material.
```

## Requirements

For basic Agent bridge checks:

- Node.js
- npm
- Codex CLI installed and logged in

For ECOS Studio GUI integration:

- ECOS Studio GUI dependencies
- a graphical desktop environment
- this bridge checkout available through `AGENT_BRIDGE_ROOT`

For normal ECOS workspace loading and real flow execution:

- initialized ECOS submodules
- working ECC CLI
- required PDK and EDA toolchain resources

Check Codex locally:

```bash
codex --version
codex login
codex app-server --listen stdio://
```

If the last command starts successfully, stop it with `Ctrl+C`. The bridge will
start app-server itself when used by ECOS Studio.

## Quick Start With ECOS Studio

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

More ECOS-side setup details are documented in the ECOS Studio repository:

```text
ecos/docs/agent-codex-gui.md
ecos/docs/agent-codex-gui.zh-CN.md
```

## Verification Commands

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

DSE closed-loop verification without real EDA tools:

```bash
npm run verify:dse-closed-loop
```

Real OpenROAD Docker smoke:

```bash
npm run smoke:openroad-dse
```

Useful OpenROAD smoke overrides:

```bash
OPENROAD_DSE_ORFS_ROOT=/path/to/OpenROAD-flow-scripts
OPENROAD_DSE_RUN_ROOT=/path/to/run-root
OPENROAD_DSE_IMAGE=openroad/flow-ubuntu22.04-builder:ea032d
OPENROAD_DSE_EARLY_TARGET=place
OPENROAD_DSE_FINAL_TARGET=finish
```

Branch-rerun demo knobs:

```bash
OPENROAD_DSE_MAX_BRANCH_DEPTH=1 \
OPENROAD_DSE_MAX_CANDIDATES=2 \
OPENROAD_DSE_TRIGGER_WNS_BELOW=0 \
OPENROAD_DSE_BRANCH_WNS_THRESHOLD=0 \
OPENROAD_DSE_PRUNE_WNS_THRESHOLD=-1 \
npm run smoke:openroad-dse
```

## DSE Adapter Migration To ECC CLI

The DSE controller talks to tool backends through a small adapter interface:

```js
await adapter.prepareExperiment(context);
await adapter.runStage({ candidate, context, stage: "early" });
await adapter.collectMetrics({ candidate, context, runResult, stage: "early" });
await adapter.runStage({ candidate, context, stage: "final" });
await adapter.collectMetrics({ candidate, context, runResult, stage: "final" });
```

`OpenRoadDockerAdapter` implements this interface today. An `EccCliDseAdapter`
can implement the same interface by calling ECC CLI commands. That would make
the chain:

```text
ECOS Agent GUI / bridge
  -> codex-agent-bridge DSE controller
  -> ECC CLI adapter
  -> ecc workspace run-step / run-flow
  -> EDA backend selected by ECC
```

More details:

- [DSE closed loop](docs/dse-closed-loop.md)
- [DSE closed loop, Chinese](docs/dse-closed-loop.zh-CN.md)

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

1. Implement a provider with the runtime methods used by `AgentRuntime.js`.
2. Register it in `src/core/AgentProviderRegistry.js`.
3. Keep provider-specific process/RPC/protocol code in this repository.
4. Expose only normalized Agent events to ECOS Studio.

Provider id example:

```js
registerAgentProvider("my_rpc_agent", (options) => new MyRpcAgentProvider(options));
```

## Troubleshooting

If Codex does not start:

```bash
codex --version
codex login
codex app-server --listen stdio://
```

If ECOS Studio cannot find the bridge:

```bash
echo "$AGENT_BRIDGE_ROOT"
ls "$AGENT_BRIDGE_ROOT/src/AgentRuntime.js"
```

If the bridge can chat but ECOS cannot open or run a workspace, check the ECOS
`ecc` CLI and toolchain environment. That is separate from the bridge protocol.

If DSE OpenROAD smoke fails, check Docker, the OpenROAD-flow-scripts path, and
the selected Docker image.
