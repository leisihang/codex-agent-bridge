# codex-agent-bridge 中的 DSE 闭环

本文档说明 ECOS Studio 外部 Agent bridge 中的 DSE 研究原型。

主线 ECOS 集成仍然是 GUI Agent 链路：

```text
ECOS Studio GUI -> codex-agent-bridge -> Codex app-server
```

普通 ECOS workspace 打开和 flow 执行仍然通过 ECC CLI：

```text
ECOS Studio GUI -> ecc workspace commands -> EDA tools/PDK
```

下面的 DSE 闭环是 bridge 侧的附加原型。它验证 bridge 可以启动工具流程、读取
metrics、只在指标值得关注时调用 subagent，并用 FSM/FlowGuard 约束 subagent
返回的动作。当前已经验证的后端是 bridge 直接调用 OpenROAD Docker；它还没有
迁移成：

```text
codex-agent-bridge -> ECC CLI -> Docker/OpenROAD
```

后续迁移点是本文后面描述的 adapter 接口。

## 运行结构

```text
ECOS Studio GUI
  展示 DSE 状态、metrics、日志、subagent 决策、审批结果

codex-agent-bridge
  DseController
  DseFlowGuard
  DseTriggerPolicy
  DSE subagent
  tool adapter

tool adapter
  当前 OpenRoadDockerAdapter
  后续 EccCliDseAdapter

EDA backend
  当前 OpenROAD
  后续可通过 ECC CLI 接 iEDA / commercial tools
```

## 状态机

每个 candidate 经过受控状态序列：

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

失败状态会进入 `failed -> archived`。

## Subagent 契约

subagent 接收：

- candidate id、parent id、branch depth、参数
- early metrics
- DSE history
- 当前 experiment metadata
- `DseFlowGuard` 给出的 allowed actions

subagent 不会对每个 candidate 都调用。`DseTriggerPolicy` 会先检查 WNS、TNS、
congestion 这类 cheap metrics。没有命中阈值时，controller 可以直接继续完整
flow，不询问 subagent。

subagent 返回一个 JSON 决策：

```json
{
  "action": "branch_rerun",
  "parameter_overrides": {
    "PLACE_DENSITY_LB_ADDON": 0.25
  },
  "reason": "Early timing is acceptable, but congestion is high."
}
```

支持的动作：

- `continue`
- `prune`
- `branch_rerun`
- `terminate`

`DseFlowGuard` 会在 controller 执行动作前校验这个决策，包括当前状态、分支
深度、最大 candidate 数和参数 schema。

## 输出文件

每次运行会在 controller 的 experiment root 下写入：

- `dse_state.json`
- `dse_events.jsonl`
- `dse_history.csv`
- `agent_decisions.jsonl`

使用 OpenROAD adapter 时，工具日志和报告会写到配置的 OpenROAD run root 下。

## 命令

不依赖真实 EDA 工具的快速验证：

```bash
npm run verify:dse-closed-loop
```

真实 OpenROAD smoke：

```bash
npm run smoke:openroad-dse
```

常用环境变量：

```bash
OPENROAD_DSE_ORFS_ROOT=/nfs/share/home/leisihang/OpenROAD-flow-scripts
OPENROAD_DSE_RUN_ROOT=/nfs/share/home/leisihang/ecos-agent-bridge-workspace/openroad-dse-smoke
OPENROAD_DSE_IMAGE=openroad/flow-ubuntu22.04-builder:ea032d
OPENROAD_DSE_EARLY_TARGET=place
OPENROAD_DSE_FINAL_TARGET=finish
```

触发 branch-rerun 的 demo：

```bash
OPENROAD_DSE_MAX_BRANCH_DEPTH=1 \
OPENROAD_DSE_MAX_CANDIDATES=2 \
OPENROAD_DSE_TRIGGER_WNS_BELOW=0 \
OPENROAD_DSE_BRANCH_WNS_THRESHOLD=0 \
OPENROAD_DSE_PRUNE_WNS_THRESHOLD=-1 \
npm run smoke:openroad-dse
```

在已验证的 `nangate45/gcd` smoke run 中，`make place` 包含 global placement 和
detailed placement。metrics 从 `3_detailed_place.rpt` 读取。WNS 阈值触发
`branch_rerun` 后，系统将 `CORE_UTILIZATION` 从 `55` 改为 `50`，重新跑
placement，然后继续 `finish` 并生成 GDS。

## 迁移到 ECC CLI 的位置

OpenROAD 相关逻辑隔离在 `OpenRoadDockerAdapter`。要把同一个 DSE 闭环迁移到
ECC CLI，需要新增一个实现同样方法的 adapter：

```js
await adapter.prepareExperiment(context);
await adapter.runStage({ candidate, context, stage: "early" });
await adapter.collectMetrics({ candidate, context, runResult, stage: "early" });
await adapter.runStage({ candidate, context, stage: "final" });
await adapter.collectMetrics({ candidate, context, runResult, stage: "final" });
```

这个 adapter 可以调用：

```bash
ecc workspace load --directory <workspace> --json
ecc workspace run-step --directory <workspace> --step <step> --json
ecc workspace run-flow --directory <workspace> --json
```

controller 和 guard 不需要知道 ECC 内部到底使用 OpenROAD、iEDA、Docker 还是
其他 EDA 后端。
