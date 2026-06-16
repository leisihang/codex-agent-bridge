import assert from "node:assert/strict";
import { AgentRuntime } from "../AgentRuntime.js";
import { CodexAppServerProvider } from "../providers/codex/CodexAppServerProvider.js";

const runtime = new AgentRuntime({
  clientInfo: {
    name: "agent-runtime-verify",
    title: "Agent Runtime Verify",
    version: "0.0.1",
  },
});

const events = [];
runtime.onEvent((event) => events.push(event));

assert.equal(runtime.getStatus().provider, "codex_app_server");
assert.equal(runtime.getStatus().mode, "general_assistant");
console.log("[ok] runtime exposes provider and default mode");

await runtime.setMode({
  cwd: null,
  mode: "flow_guarded_design",
});
assert.equal(runtime.getStatus().mode, "flow_guarded_design");
assert.equal(runtime.getStatus().flowGuard.projectRoot, null);
console.log("[ok] guarded mode can be selected without project root");

const provider = new CodexAppServerProvider({
  clientInfo: {
    name: "codex-provider-verify",
    title: "Codex Provider Verify",
    version: "0.0.1",
  },
});
const providerEvents = [];
provider.onEvent((event) => providerEvents.push(event));

provider.handleNotificationEvent({
  method: "item/agentMessage/delta",
  params: { delta: "hello" },
});
assert.deepEqual(providerEvents.at(-1), {
  provider: "codex_app_server",
  type: "messageDelta",
  delta: "hello",
});
console.log("[ok] maps Codex text delta to generic messageDelta");

provider.handleNotificationEvent({
  method: "item/started",
  params: {
    item: {
      id: "cmd-1",
      type: "commandExecution",
      command: "pwd",
      cwd: "/tmp/project",
    },
  },
});
assert.equal(providerEvents.at(-1).type, "action");
assert.equal(providerEvents.at(-1).action.kind, "command");
assert.equal(providerEvents.at(-1).action.status, "running");
console.log("[ok] maps command start to generic action");

provider.handleNotificationEvent({
  method: "item/commandExecution/outputDelta",
  params: {
    itemId: "cmd-1",
    delta: "/tmp/project\n",
  },
});
assert.match(providerEvents.at(-1).action.content, /\/tmp\/project/);
console.log("[ok] accumulates command output");

provider.handleNotificationEvent({
  method: "item/completed",
  params: {
    item: {
      id: "cmd-1",
      type: "commandExecution",
      command: "pwd",
      cwd: "/tmp/project",
      exitCode: 0,
      status: "completed",
    },
  },
});
assert.equal(providerEvents.at(-1).action.status, "done");
assert.match(providerEvents.at(-1).action.content, /\/tmp\/project/);
console.log("[ok] maps command completion to generic action");

runtime.stop();
provider.stop();
console.log("\nAgent runtime verification passed.");
