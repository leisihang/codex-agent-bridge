import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodexAgentManager } from "./CodexAgentManager.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const demoWorkspace = path.join(projectRoot, "demo-rtl-project");

const manager = new CodexAgentManager({ cwd: projectRoot });

let activeTurnLabel = "";

manager.client.on("stderr", (text) => {
  const trimmed = text.trim();
  if (trimmed) {
    console.error(`[app-server stderr] ${trimmed}`);
  }
});

manager.onEvent((event) => {
  if (event.type === "notification") {
    if (event.method === "item/agentMessage/delta") {
      process.stdout.write(event.params.delta);
      return;
    }
    if (event.method === "turn/diff/updated") {
      console.log(`\n[${activeTurnLabel} diff updated: ${event.params.diff.length} chars]`);
      return;
    }
    if (event.method === "turn/completed") {
      console.log(`\n[${activeTurnLabel} completed: ${event.params.turn.status}]`);
      return;
    }
    if (
      event.method === "turn/started" ||
      event.method === "thread/status/changed" ||
      event.method === "thread/tokenUsage/updated"
    ) {
      console.log(`[event] ${event.method}`);
    }
    return;
  }

  if (event.type === "serverRequest") {
    console.log(`[approval/request] ${event.method}`);
    if (event.params?.command) {
      console.log(`  command: ${event.params.command}`);
    }
    if (event.params?.reason) {
      console.log(`  reason: ${event.params.reason}`);
    }
  }
});

async function runTurn(label, prompt) {
  activeTurnLabel = label;
  console.log(`\n=== ${label} ===`);
  const { response, completedTurn } = await manager.startTurnAndWait(prompt, {
    cwd: demoWorkspace,
    timeoutMs: 180000,
  });
  console.log(`[${label} turn id] ${response.turn.id}`);
  return completedTurn;
}

async function main() {
  const init = await manager.start();
  console.log(`[initialized] ${init.userAgent}`);

  const thread = await manager.startThread({
    cwd: demoWorkspace,
    approvalPolicy: "never",
    sandbox: "read-only",
  });
  console.log(`[thread] ${thread.thread.id}`);

  await runTurn(
    "turn 1",
    "请读取 src/top.v 并检查是否有明显 Verilog 语法问题。你可以运行只读 shell 命令查看文件内容，但不要修改文件。",
  );

  await runTurn(
    "turn 2",
    "基于刚才发现的问题，请给出最小修复 patch 的文字说明。不要修改文件，只说明需要改哪一行。",
  );

  await runTurn(
    "turn 3",
    "继续复用刚才的上下文：请为这个 top 模块生成一个很小的 Verilog testbench 示例。不要写文件，只输出代码块。",
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    manager.stop();
  });
