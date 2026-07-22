import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DseController } from "./DseController.js";
import { DseFlowGuard } from "./DseFlowGuard.js";
import { RuleBasedDseSubAgent } from "./DseSubAgents.js";
import { MetricsTriggerPolicy } from "./DseTriggerPolicy.js";

class MockOpenRoadAdapter {
  constructor(root) {
    this.root = root;
    this.calls = [];
  }

  async prepareExperiment({ experimentId }) {
    fs.mkdirSync(path.join(this.root, experimentId), { recursive: true });
  }

  async runStage({ candidate, context, stage }) {
    this.calls.push({ candidateId: candidate.id, stage });
    const candidateRoot = path.join(this.root, context.experimentId, candidate.id);
    fs.mkdirSync(candidateRoot, { recursive: true });
    const logPath = path.join(candidateRoot, `${stage}.log`);
    fs.writeFileSync(logPath, `[mock-openroad] ${candidate.id} ${stage}\n`);
    return { ok: true, candidateRoot, logPath };
  }

  async collectMetrics({ candidate, runResult, stage }) {
    const dense = candidate.id.includes("dense") && !candidate.parentId;
    const bad = candidate.id.includes("bad");
    if (stage === "early" && dense) {
      return {
        success: true,
        stage,
        wns: -0.01,
        tns: -0.1,
        congestion: 0.92,
        logPath: runResult.logPath,
      };
    }
    if (stage === "early" && bad) {
      return {
        success: true,
        stage,
        wns: -0.41,
        tns: -8.2,
        congestion: 0.22,
        logPath: runResult.logPath,
      };
    }
    if (stage === "early") {
      return {
        success: true,
        stage,
        wns: 0.01,
        tns: 0,
        congestion: 0.31,
        logPath: runResult.logPath,
      };
    }
    return {
      success: true,
      stage,
      wns: 0.03,
      tns: 0,
      congestion: 0.34,
      drcReportBytes: 0,
      gdsPath: path.join(runResult.candidateRoot, "6_final.gds"),
      logPath: runResult.logPath,
    };
  }
}

const experimentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dse-closed-loop-"));
const flowGuard = new DseFlowGuard({
  maxBranchDepth: 1,
  maxCandidates: 4,
});
const controller = new DseController({
  adapter: new MockOpenRoadAdapter(experimentRoot),
  experimentRoot,
  flowGuard,
  subAgent: new RuleBasedDseSubAgent({
    branchCongestionThreshold: 0.85,
    pruneWnsThreshold: -0.25,
  }),
  triggerPolicy: new MetricsTriggerPolicy({
    congestionAbove: 0.85,
    wnsBelow: -0.25,
  }),
});

const result = await controller.runClosedLoop({
  experimentId: "mock_openroad_dse",
  objective: "ECP",
  seedCandidates: [
    {
      id: "seed_dense",
      params: {
        CORE_UTILIZATION: 55,
        PLACE_DENSITY_LB_ADDON: 0.3,
      },
    },
    {
      id: "seed_bad",
      params: {
        CORE_UTILIZATION: 80,
        PLACE_DENSITY_LB_ADDON: 0.65,
      },
    },
  ],
});

const candidates = result.snapshot.candidates;
assert.equal(candidates.seed_dense.status, "archived");
assert.equal(candidates.seed_bad.status, "archived");
assert.equal(candidates.seed_bad.agentDecision.action, "prune");

const branch = Object.values(candidates).find((candidate) => candidate.parentId === "seed_dense");
assert.ok(branch, "branch candidate should be created from seed_dense");
assert.equal(branch.status, "archived");
assert.equal(branch.agentDecision.action, "continue");
assert.equal(branch.metrics.final.success, true);
assert.equal(branch.params.PLACE_DENSITY_LB_ADDON, 0.25);

const historyActions = result.history.map((row) => row.action);
assert.deepEqual(historyActions.sort(), ["branch_rerun", "continue", "prune"].sort());

assert.ok(fs.existsSync(path.join(experimentRoot, "dse_state.json")));
assert.ok(fs.existsSync(path.join(experimentRoot, "dse_events.jsonl")));
assert.ok(fs.existsSync(path.join(experimentRoot, "dse_history.csv")));
assert.ok(fs.existsSync(path.join(experimentRoot, "agent_decisions.jsonl")));

const agentDecisionLines = fs
  .readFileSync(path.join(experimentRoot, "agent_decisions.jsonl"), "utf8")
  .trim()
  .split("\n")
  .filter(Boolean);
assert.equal(agentDecisionLines.length, 2);
const eventText = fs.readFileSync(path.join(experimentRoot, "dse_events.jsonl"), "utf8");
assert.match(eventText, /"review":false/);

const invalid = flowGuard.validateParameters({ PLACE_DENSITY_LB_ADDON: 5 });
assert.equal(invalid.decision, "decline");

console.log(`[ok] DSE closed loop smoke passed: ${experimentRoot}`);
