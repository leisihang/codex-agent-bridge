import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CODEX_AGENT_MODES, CodexAgentManager } from "../CodexAgentManager.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../..", "demo-rtl-project");

const manager = new CodexAgentManager({ cwd: projectRoot });

assert.equal(manager.getStatus().mode, CODEX_AGENT_MODES.GENERAL_ASSISTANT);
assert.equal(manager.getStatus().flowGuard, null);
console.log("[ok] manager defaults to general assistant without FlowGuard");

manager.setMode(CODEX_AGENT_MODES.FLOW_GUARDED_DESIGN, {
  projectRoot,
  flowGuardOptions: {
    projectRoot,
    manifest: {
      steps: {
        rtl: {
          requiredAny: ["src/top.v"],
        },
        synthesis: {
          workdir: "synth",
          commandPatterns: ["make synth"],
          writable: ["synth/output"],
          outputs: ["synth/output/top.v"],
        },
        floorplan: {
          workdir: "floorplan",
          commandPatterns: ["make floorplan"],
          writable: ["floorplan/output"],
          outputs: ["floorplan/output/floorplan.def"],
        },
      },
    },
    projectFiles: ["src/top.v"],
    stepOrder: ["rtl", "synthesis", "floorplan"],
  },
});

assert.equal(manager.getStatus().mode, CODEX_AGENT_MODES.FLOW_GUARDED_DESIGN);
assert.equal(manager.getStatus().flowGuard.steps.rtl.status, "done");
assert.equal(manager.getStatus().flowGuard.steps.synthesis.status, "ready");
assert.equal(manager.getStatus().flowGuard.steps.floorplan.status, "not_ready");
console.log("[ok] design flow mode enables FlowGuard snapshot");

const decision = manager.flowGuard.authorizeCommand({
  command: "make floorplan",
  cwd: path.join(projectRoot, "floorplan"),
});
assert.equal(decision.decision, "decline");
assert.match(decision.reason, /requires synthesis/);
console.log("[ok] design flow mode blocks dependency skip");

manager.setMode(CODEX_AGENT_MODES.GENERAL_ASSISTANT);
assert.equal(manager.getStatus().mode, CODEX_AGENT_MODES.GENERAL_ASSISTANT);
assert.equal(manager.getStatus().flowGuard, null);
console.log("[ok] returning to general assistant disables FlowGuard");

console.log("\nAgent mode verification passed.");
