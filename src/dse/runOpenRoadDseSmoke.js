import path from "node:path";
import { DseController } from "./DseController.js";
import { DseFlowGuard } from "./DseFlowGuard.js";
import { OpenRoadDockerAdapter } from "./OpenRoadDockerAdapter.js";
import { RuleBasedDseSubAgent } from "./DseSubAgents.js";
import { MetricsTriggerPolicy } from "./DseTriggerPolicy.js";

const runRoot =
  process.env.OPENROAD_DSE_RUN_ROOT ??
  "/nfs/share/home/leisihang/ecos-agent-bridge-workspace/openroad-dse-smoke";
const experimentId = process.env.OPENROAD_DSE_EXPERIMENT_ID ?? `openroad_gcd_${Date.now()}`;

const adapter = new OpenRoadDockerAdapter({
  design: process.env.OPENROAD_DSE_DESIGN ?? "gcd",
  designConfig: process.env.OPENROAD_DSE_DESIGN_CONFIG ?? "./designs/nangate45/gcd/config.mk",
  earlyTarget: process.env.OPENROAD_DSE_EARLY_TARGET ?? "place",
  finalTarget: process.env.OPENROAD_DSE_FINAL_TARGET ?? "finish",
  image: process.env.OPENROAD_DSE_IMAGE ?? "openroad/flow-ubuntu22.04-builder:ea032d",
  orfsRoot: process.env.OPENROAD_DSE_ORFS_ROOT ?? "/nfs/share/home/leisihang/OpenROAD-flow-scripts",
  platform: process.env.OPENROAD_DSE_PLATFORM ?? "nangate45",
  runRoot,
  timeoutMs: Number(process.env.OPENROAD_DSE_TIMEOUT_MS ?? 30 * 60 * 1000),
});

const controller = new DseController({
  adapter,
  experimentRoot: path.join(runRoot, experimentId, "bridge_state"),
  flowGuard: new DseFlowGuard({
    maxBranchDepth: Number(process.env.OPENROAD_DSE_MAX_BRANCH_DEPTH ?? 0),
    maxCandidates: Number(process.env.OPENROAD_DSE_MAX_CANDIDATES ?? 1),
  }),
  subAgent: new RuleBasedDseSubAgent({
    branchCongestionThreshold: Number(process.env.OPENROAD_DSE_BRANCH_CONGESTION_THRESHOLD ?? 0.85),
    branchWnsThreshold: process.env.OPENROAD_DSE_BRANCH_WNS_THRESHOLD === undefined
      ? null
      : Number(process.env.OPENROAD_DSE_BRANCH_WNS_THRESHOLD),
    pruneWnsThreshold: Number(process.env.OPENROAD_DSE_PRUNE_WNS_THRESHOLD ?? -1),
  }),
  triggerPolicy: new MetricsTriggerPolicy({
    congestionAbove: Number(process.env.OPENROAD_DSE_TRIGGER_CONGESTION_ABOVE ?? 0.85),
    enabled: process.env.OPENROAD_DSE_TRIGGER_ENABLED !== "0",
    tnsBelow: process.env.OPENROAD_DSE_TRIGGER_TNS_BELOW === undefined
      ? null
      : Number(process.env.OPENROAD_DSE_TRIGGER_TNS_BELOW),
    wnsBelow: Number(process.env.OPENROAD_DSE_TRIGGER_WNS_BELOW ?? -0.05),
  }),
});

const result = await controller.runClosedLoop({
  experimentId,
  objective: "ECP",
  seedCandidates: [
    {
      id: "gcd_seed",
      params: {
        CORE_UTILIZATION: Number(process.env.OPENROAD_DSE_CORE_UTILIZATION ?? 55),
        PLACE_DENSITY_LB_ADDON: Number(process.env.OPENROAD_DSE_PLACE_DENSITY_LB_ADDON ?? 0.2),
      },
    },
  ],
});

console.log(JSON.stringify({
  experimentRoot: result.experimentRoot,
  history: result.history,
}, null, 2));
