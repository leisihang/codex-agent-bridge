import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodexFlowGuard } from "./CodexFlowGuard.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../..", "demo-rtl-project");

const manifest = {
  steps: {
    rtl: {
      requiredAny: ["src/top.v"],
    },
    synthesis: {
      workdir: "synth",
      commandPatterns: ["make synth", "bash run.sh", "yosys"],
      writable: ["synth/output", "synth/log"],
      outputs: ["synth/output/top.v"],
    },
    floorplan: {
      workdir: "floorplan",
      commandPatterns: ["make floorplan", "bash run.sh"],
      writable: ["floorplan/output", "floorplan/log"],
      outputs: ["floorplan/output/floorplan.def"],
    },
    placement: {
      workdir: "place",
      commandPatterns: ["make place", "bash run.sh"],
      writable: ["place/output", "place/log"],
      outputs: ["place/output/place.def"],
    },
  },
};

function makeGuard(projectFiles) {
  return new CodexFlowGuard({
    projectRoot,
    manifest,
    projectFiles,
    stepOrder: ["rtl", "synthesis", "floorplan", "placement"],
  });
}

function assertDecision(label, actual, expected) {
  assert.equal(actual.decision, expected, `${label}: ${actual.reason}`);
  console.log(`[ok] ${label}: ${actual.decision} - ${actual.reason}`);
}

const initialFiles = ["src/top.v"];
const guard = makeGuard(initialFiles);

assert.equal(guard.getSnapshot().steps.rtl.status, "done");
assert.equal(guard.getSnapshot().steps.synthesis.status, "ready");
assert.equal(guard.getSnapshot().steps.floorplan.status, "not_ready");

assertDecision(
  "allows read-only project inspection",
  guard.authorizeCommand({ command: "ls src && cat src/top.v", cwd: projectRoot }),
  "accept",
);

assertDecision(
  "allows read-only existence probe",
  guard.authorizeCommand({ command: "test -f Makefile && sed -n '1,20p' Makefile", cwd: projectRoot }),
  "accept",
);

assertDecision(
  "allows read-only find sort pipeline",
  guard.authorizeCommand({ command: "find . -maxdepth 2 -type d | sort", cwd: projectRoot }),
  "accept",
);

assertDecision(
  "blocks route/floorplan before synthesis is done",
  guard.authorizeCommand({ command: "make floorplan", cwd: path.join(projectRoot, "floorplan") }),
  "decline",
);

assertDecision(
  "blocks destructive shell command",
  guard.authorizeCommand({ command: "rm -rf synth/output", cwd: projectRoot }),
  "decline",
);

assertDecision(
  "allows synthesis command from manifest",
  guard.authorizeCommand({ command: "make synth", cwd: path.join(projectRoot, "synth") }),
  "accept",
);

guard.onItemStarted({
  item: {
    type: "commandExecution",
    command: "make synth",
    cwd: path.join(projectRoot, "synth"),
  },
});

assert.equal(guard.getSnapshot().steps.synthesis.status, "running");

assertDecision(
  "allows writes under active step output",
  guard.authorizeWriteRoot(path.join(projectRoot, "synth/output")),
  "accept",
);

assertDecision(
  "blocks writes outside active step output",
  guard.authorizeWriteRoot(path.join(projectRoot, "floorplan/output")),
  "decline",
);

guard.onItemCompleted({
  item: {
    type: "commandExecution",
    command: "make synth",
    cwd: path.join(projectRoot, "synth"),
    exitCode: 0,
  },
});

assert.equal(guard.getSnapshot().steps.synthesis.status, "manual_review");
assert.equal(guard.getSnapshot().steps.floorplan.status, "not_ready");
console.log("[ok] synthesis success without required artifact enters manual_review");

const completedGuard = makeGuard(["src/top.v", "synth/output/top.v", "synth/log/synth.log"]);
completedGuard.onItemStarted({
  item: {
    type: "commandExecution",
    command: "make synth",
    cwd: path.join(projectRoot, "synth"),
  },
});
completedGuard.onItemCompleted({
  item: {
    type: "commandExecution",
    command: "make synth",
    cwd: path.join(projectRoot, "synth"),
    exitCode: 0,
  },
});

assert.equal(completedGuard.getSnapshot().steps.synthesis.status, "done");
assert.equal(completedGuard.getSnapshot().steps.floorplan.status, "ready");
console.log("[ok] synthesis artifacts promote floorplan to ready");

completedGuard.onItemStarted({
  item: {
    type: "commandExecution",
    command: "make floorplan",
    cwd: path.join(projectRoot, "floorplan"),
  },
});
completedGuard.onItemCompleted({
  item: {
    type: "commandExecution",
    command: "make floorplan",
    cwd: path.join(projectRoot, "floorplan"),
    exitCode: 0,
  },
});

assert.equal(completedGuard.getSnapshot().steps.floorplan.status, "manual_review");
console.log("[ok] floorplan without artifact enters manual_review");

const downstreamGuard = makeGuard([
  "src/top.v",
  "synth/output/top.v",
  "synth/log/synth.log",
  "floorplan/output/floorplan.def",
  "place/output/place.def",
]);
downstreamGuard.setStepStatus("synthesis", "done", "seed synthesis");
downstreamGuard.setStepStatus("floorplan", "done", "seed floorplan");
downstreamGuard.setStepStatus("placement", "done", "seed placement");

downstreamGuard.recordFileChanges([{ path: "floorplan/config/fp.json", kind: "update", diff: "" }]);

assert.equal(downstreamGuard.getSnapshot().steps.floorplan.status, "stale");
assert.equal(downstreamGuard.getSnapshot().steps.placement.status, "stale");
console.log("[ok] upstream file changes mark downstream steps stale");

assertDecision(
  "blocks stale-dependent placement rerun until floorplan is repaired",
  downstreamGuard.authorizeCommand({ command: "make place", cwd: path.join(projectRoot, "place") }),
  "decline",
);

const rejectedGuard = makeGuard(["src/top.v"]);
rejectedGuard.onItemStarted({
  item: {
    id: "floorplan-1",
    type: "commandExecution",
    command: "make floorplan",
    cwd: path.join(projectRoot, "floorplan"),
  },
});
assert.equal(rejectedGuard.getSnapshot().steps.floorplan.status, "running");

const rejectedDecision = rejectedGuard.authorizeCommandRequest({
  itemId: "floorplan-1",
  command: "make floorplan",
  cwd: path.join(projectRoot, "floorplan"),
});
assertDecision("declines floorplan when synthesis is not done", rejectedDecision, "decline");

rejectedGuard.onItemCompleted({
  item: {
    id: "floorplan-1",
    type: "commandExecution",
    command: "make floorplan",
    cwd: path.join(projectRoot, "floorplan"),
    exitCode: null,
  },
});
assert.equal(rejectedGuard.getSnapshot().steps.floorplan.status, "not_ready");
console.log("[ok] declined command completion does not mark step failed");

console.log("\nFlowGuard verification passed.");
