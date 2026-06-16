import path from "node:path";
import { CodexAgentManager } from "./CodexAgentManager.js";
import { CodexFlowGuard } from "./flow/CodexFlowGuard.js";

const demoWorkspace = process.env.ECOS_CODEX_DEMO_PROJECT
  ?? "/mnt/c/Users/26086/Desktop/least_ecos/codex_gui_demo_project_ecos";

const manager = new CodexAgentManager({
  cwd: demoWorkspace,
  env: {
    ...process.env,
    PATH: `/mnt/c/Users/26086/Desktop/least_ecos/codex_gui_demo_tools/bin:${process.env.PATH}`,
  },
  flowGuard: new CodexFlowGuard({
    projectRoot: demoWorkspace,
    manifest: {
      steps: {
        synthesis: {
          workdir: "Synthesis_yosys",
          commandPatterns: [
            "yosys",
            "tclsh script/yosys_synthesis.tcl",
            "bash run.sh",
            "make synthesis",
            "make synth",
          ],
          writable: [
            "Synthesis_yosys/output",
            "Synthesis_yosys/log",
            "Synthesis_yosys/report",
            "Synthesis_yosys/feature",
            "Synthesis_yosys/data/tmp",
          ],
          outputs: [
            "Synthesis_yosys/output/*.v",
          ],
        },
        floorplan: {
          workdir: "Floorplan_ecc",
          commandPatterns: [
            "ecos run floorplan",
            "make floorplan",
            "bash run.sh",
            "python run.py",
          ],
          writable: [
            "Floorplan_ecc/output",
            "Floorplan_ecc/log",
            "Floorplan_ecc/report",
            "Floorplan_ecc/feature",
          ],
          outputs: [
            "Floorplan_ecc/output/*",
          ],
        },
      },
    },
  }),
});

let approvalRequests = 0;
let guardDecisions = 0;

manager.client.on("stderr", (text) => {
  const trimmed = text.trim();
  if (trimmed) {
    console.error(`[app-server stderr] ${trimmed}`);
  }
});

manager.onEvent((event) => {
  if (event.type === "serverRequest") {
    approvalRequests += 1;
    console.log(`\n[approval/request] ${event.method}`);
    if (event.params?.command) {
      console.log(`  command: ${event.params.command}`);
    }
    if (event.params?.cwd) {
      console.log(`  cwd: ${event.params.cwd}`);
    }
    if (event.params?.grantRoot) {
      console.log(`  grantRoot: ${event.params.grantRoot}`);
    }
    return;
  }

  if (event.type === "flowGuardDecision") {
    guardDecisions += 1;
    console.log(`[flow-guard] ${event.result.decision}: ${event.result.reason}`);
    return;
  }

  if (event.type !== "notification") {
    return;
  }

  if (event.method === "item/agentMessage/delta") {
    process.stdout.write(event.params.delta);
    return;
  }

  if (event.method === "item/started") {
    const item = event.params?.item;
    if (item?.type === "commandExecution") {
      console.log(`\n[command/started] ${item.command}`);
    }
    return;
  }

  if (event.method === "item/completed") {
    const item = event.params?.item;
    if (item?.type === "commandExecution") {
      console.log(`\n[command/completed] exit=${item.exitCode} command=${item.command}`);
    }
    return;
  }

  if (event.method === "turn/completed") {
    console.log(`\n[turn completed: ${event.params.turn.status}]`);
    console.log(`[approval requests] ${approvalRequests}`);
    console.log(`[flow guard decisions] ${guardDecisions}`);
    console.log("[flow snapshot]");
    console.log(JSON.stringify(manager.flowGuard.getSnapshot().steps, null, 2));
    manager.stop();
  }
});

async function main() {
  const init = await manager.start();
  console.log(`[initialized] ${init.userAgent}`);

  const thread = await manager.startThread({
    cwd: demoWorkspace,
    approvalPolicy: "untrusted",
    sandbox: "workspace-write",
  });
  console.log(`[thread] ${thread.thread.id}`);

  const prompt = [
    "这是一个 ECOS demo workspace。",
    "请先运行只读命令确认当前目录和关键目录。",
    "然后请尝试执行 floorplan 步骤，例如进入 Floorplan_ecc 后运行 make floorplan 或 bash run.sh。",
    "如果命令被拒绝，请报告拒绝原因。",
    "不要修改任何配置文件。",
  ].join("\n");

  const turn = await manager.startTurn(prompt, {
    cwd: demoWorkspace,
  });
  console.log(`[turn] ${turn.turn.id}`);

  setTimeout(() => {
    console.error("\n[timeout] stopping guarded demo");
    manager.stop();
    process.exitCode = 1;
  }, Number(process.env.ECOS_CODEX_GUARDED_DEMO_TIMEOUT_MS ?? 180000)).unref();
}

main().catch((error) => {
  console.error(error);
  manager.stop();
  process.exitCode = 1;
});

console.log(`[workspace] ${path.resolve(demoWorkspace)}`);
