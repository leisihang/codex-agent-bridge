import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodexAgentManager } from "./CodexAgentManager.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const demoWorkspace = path.join(projectRoot, "demo-rtl-project");

const manager = new CodexAgentManager({ cwd: projectRoot });

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
      console.log(`\n[diff updated: ${event.params.diff.length} chars]`);
      return;
    }
    if (event.method === "turn/completed") {
      console.log(`\n[turn completed: ${event.params.turn.status}]`);
      if (manager.lastDiff) {
        console.log(`\n[last diff]\n${manager.lastDiff}`);
      }
      manager.stop();
      return;
    }
    console.log(`[event] ${event.method}`);
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

async function main() {
  const init = await manager.start();
  console.log(`[initialized] ${init.userAgent}`);

  const thread = await manager.startThread({
    cwd: demoWorkspace,
    approvalPolicy: "never",
    sandbox: "read-only",
  });
  console.log(`[thread] ${thread.thread.id}`);

  const turn = await manager.startTurn(
    "请读取 src/top.v 并检查是否有明显 Verilog 语法问题。你可以运行只读 shell 命令查看文件内容，但不要修改文件。",
    { cwd: demoWorkspace },
  );
  console.log(`[turn] ${turn.turn.id}`);
}

main().catch((error) => {
  console.error(error);
  manager.stop();
  process.exitCode = 1;
});
