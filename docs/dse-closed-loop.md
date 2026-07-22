# DSE Closed Loop in codex-agent-bridge

This document describes the DSE research prototype inside the external Agent
bridge used by ECOS Studio.

The main ECOS integration is still the GUI Agent path:

```text
ECOS Studio GUI -> codex-agent-bridge -> Codex app-server
```

Normal ECOS workspace loading and flow execution still go through ECC CLI:

```text
ECOS Studio GUI -> ecc workspace commands -> EDA tools/PDK
```

The DSE loop below is an additional bridge-side prototype. It proves that the
bridge can run a tool flow, read metrics, ask a subagent only when needed, and
guard the resulting action with an FSM. The currently verified backend is
OpenROAD Docker called directly by the bridge. It has not yet been migrated to:

```text
codex-agent-bridge -> ECC CLI -> Docker/OpenROAD
```

That migration point is the adapter interface described later in this document.

## Runtime Shape

```text
ECOS Studio GUI
  displays DSE state, metrics, logs, subagent decisions, approvals

codex-agent-bridge
  DseController
  DseFlowGuard
  DseTriggerPolicy
  DSE subagent
  tool adapter

tool adapter
  OpenRoadDockerAdapter now
  EccCliDseAdapter later

EDA backend
  OpenROAD now
  iEDA / commercial tools later through ECC CLI
```

## State Machine

Each candidate moves through this guarded state sequence:

```text
created
  -> early_running
  -> early_done
  -> agent_review_pending
  -> full_ready | pruned | branched | terminated
  -> full_running
  -> full_done
  -> archived
```

Failure states go to `failed -> archived`.

## Subagent Contract

The subagent receives:

- candidate id, parent id, branch depth, parameters
- early metrics
- DSE history
- current experiment metadata
- allowed actions from `DseFlowGuard`

The subagent is not called for every candidate. `DseTriggerPolicy` first checks
cheap metrics, such as WNS, TNS, and congestion. If no threshold is matched, the
controller can continue the flow without asking the subagent.

The subagent returns one JSON decision:

```json
{
  "action": "branch_rerun",
  "parameter_overrides": {
    "PLACE_DENSITY_LB_ADDON": 0.25
  },
  "reason": "Early timing is acceptable, but congestion is high."
}
```

Supported actions:

- `continue`
- `prune`
- `branch_rerun`
- `terminate`

`DseFlowGuard` validates the decision before the controller executes it. It
checks the current state, branch depth, max candidates, and parameter schema.

## Files Emitted

Each run writes bridge-side state under the controller experiment root:

- `dse_state.json`
- `dse_events.jsonl`
- `dse_history.csv`
- `agent_decisions.jsonl`

For the OpenROAD adapter, tool logs and reports are written under the configured
OpenROAD run root.

## Commands

Fast bridge-only verification:

```bash
npm run verify:dse-closed-loop
```

Real OpenROAD smoke:

```bash
npm run smoke:openroad-dse
```

Useful environment overrides:

```bash
OPENROAD_DSE_ORFS_ROOT=/nfs/share/home/leisihang/OpenROAD-flow-scripts
OPENROAD_DSE_RUN_ROOT=/nfs/share/home/leisihang/ecos-agent-bridge-workspace/openroad-dse-smoke
OPENROAD_DSE_IMAGE=openroad/flow-ubuntu22.04-builder:ea032d
OPENROAD_DSE_EARLY_TARGET=place
OPENROAD_DSE_FINAL_TARGET=finish
```

For an explicit branch-rerun demo:

```bash
OPENROAD_DSE_MAX_BRANCH_DEPTH=1 \
OPENROAD_DSE_MAX_CANDIDATES=2 \
OPENROAD_DSE_TRIGGER_WNS_BELOW=0 \
OPENROAD_DSE_BRANCH_WNS_THRESHOLD=0 \
OPENROAD_DSE_PRUNE_WNS_THRESHOLD=-1 \
npm run smoke:openroad-dse
```

In the verified `nangate45/gcd` smoke run, `make place` includes global
placement and detailed placement. Metrics are collected from
`3_detailed_place.rpt`. A WNS threshold triggered `branch_rerun`, changed
`CORE_UTILIZATION` from `55` to `50`, reran placement, then continued to
`finish` and generated GDS.

## ECC CLI Migration Point

The OpenROAD-specific code is isolated in `OpenRoadDockerAdapter`. To move the
same loop to ECC CLI, add an adapter with the same methods:

```js
await adapter.prepareExperiment(context);
await adapter.runStage({ candidate, context, stage: "early" });
await adapter.collectMetrics({ candidate, context, runResult, stage: "early" });
await adapter.runStage({ candidate, context, stage: "final" });
await adapter.collectMetrics({ candidate, context, runResult, stage: "final" });
```

That adapter can call commands such as:

```bash
ecc dse experiment create ...
ecc dse candidate launch ...
ecc dse run status ...
ecc dse metrics collect ...
ecc dse run resume ...
ecc dse run terminate ...
```

The controller and guard do not need to know whether ECC is using OpenROAD,
iEDA, Docker, or another EDA backend.
