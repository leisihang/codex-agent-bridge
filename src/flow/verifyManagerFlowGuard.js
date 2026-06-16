import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodexAgentManager } from "../CodexAgentManager.js";
import { CodexFlowGuard } from "./CodexFlowGuard.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../..", "demo-rtl-project");

const sentResponses = [];
const manager = new CodexAgentManager({
  cwd: projectRoot,
  flowGuard: new CodexFlowGuard({
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
      },
    },
    projectFiles: ["src/top.v"],
    stepOrder: ["rtl", "synthesis"],
  }),
});

manager.client.respond = (id, result) => {
  sentResponses.push({ id, result });
};

const decisions = [];
manager.onEvent((event) => {
  if (event.type === "flowGuardDecision") {
    decisions.push(event.result);
  }
});

manager.handleServerRequest({
  id: 1,
  method: "item/commandExecution/requestApproval",
  params: {
    command: "make synth",
    cwd: path.join(projectRoot, "synth"),
  },
});

assert.deepEqual(sentResponses.at(-1), { id: 1, result: { decision: "accept" } });
assert.equal(decisions.at(-1).step, "synthesis");
console.log("[ok] manager accepts approved step command through FlowGuard");

manager.handleServerRequest({
  id: 2,
  method: "item/commandExecution/requestApproval",
  params: {
    command: "make route",
    cwd: path.join(projectRoot, "route"),
  },
});

assert.deepEqual(sentResponses.at(-1), { id: 2, result: { decision: "decline" } });
console.log(`[ok] manager declines unmapped command: ${decisions.at(-1).reason}`);

manager.handleServerRequest({
  id: 3,
  method: "item/fileChange/requestApproval",
  params: {
    grantRoot: path.join(projectRoot, "synth/output"),
  },
});

assert.deepEqual(sentResponses.at(-1), { id: 3, result: { decision: "decline" } });
console.log(`[ok] manager declines write root without active step: ${decisions.at(-1).reason}`);

manager.flowGuard.onItemStarted({
  item: {
    type: "commandExecution",
    command: "make synth",
    cwd: path.join(projectRoot, "synth"),
  },
});

manager.handleServerRequest({
  id: 4,
  method: "item/fileChange/requestApproval",
  params: {
    grantRoot: path.join(projectRoot, "synth/output"),
  },
});

assert.deepEqual(sentResponses.at(-1), { id: 4, result: { decision: "accept" } });
console.log("[ok] manager accepts active-step write root through FlowGuard");

console.log("\nManager FlowGuard verification passed.");
