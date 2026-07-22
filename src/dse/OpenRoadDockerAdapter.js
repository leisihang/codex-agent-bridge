import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function safeVariant(value) {
  return String(value).replace(/[^A-Za-z0-9_.-]/g, "_");
}

function shellQuote(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:=+-]+$/.test(text)) {
    return text;
  }
  return `'${text.replaceAll("'", "'\\''")}'`;
}

function parseFirstNumber(text, regex) {
  const match = text.match(regex);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isNaN(value) ? null : value;
}

function readTextIfExists(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function fileSizeIfExists(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return null;
  }
}

function normalizeBool(value) {
  if (typeof value === "boolean") return value ? "1" : "0";
  return String(value);
}

function makeVariableArgs(params = {}) {
  const result = [];
  for (const [key, value] of Object.entries(params)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`Unsafe OpenROAD make variable: ${key}`);
    }
    result.push(`${key}=${shellQuote(normalizeBool(value))}`);
  }
  return result;
}

function runProcess(command, args, { logPath, timeoutMs = 0 } = {}) {
  ensureDir(path.dirname(logPath));
  return new Promise((resolve) => {
    const out = fs.createWriteStream(logPath, { flags: "a" });
    out.write(`$ ${[command, ...args].map(shellQuote).join(" ")}\n`);
    const child = spawn(command, args, {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let timedOut = false;
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
          }, timeoutMs)
        : null;

    child.stdout.on("data", (chunk) => out.write(chunk));
    child.stderr.on("data", (chunk) => out.write(chunk));
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      out.write(`\n[spawn-error] ${error.message}\n`);
      out.end();
      resolve({ ok: false, error: error.message, exitCode: null, signal: null, timedOut });
    });
    child.on("close", (exitCode, signal) => {
      if (timer) clearTimeout(timer);
      out.write(`\n[exit] code=${exitCode} signal=${signal ?? ""} timedOut=${timedOut}\n`);
      out.end();
      resolve({ ok: exitCode === 0 && !timedOut, exitCode, signal, timedOut });
    });
  });
}

export class OpenRoadDockerAdapter {
  constructor(options = {}) {
    this.dockerBin = options.dockerBin ?? "docker";
    this.image = options.image ?? "openroad/flow-ubuntu22.04-builder:ea032d";
    this.orfsRoot = options.orfsRoot ?? "/nfs/share/home/leisihang/OpenROAD-flow-scripts";
    this.runRoot =
      options.runRoot ?? path.join(os.tmpdir(), "codex-agent-bridge-openroad-dse");
    this.designConfig = options.designConfig ?? "./designs/nangate45/gcd/config.mk";
    this.platform = options.platform ?? "nangate45";
    this.design = options.design ?? "gcd";
    this.earlyTarget = options.earlyTarget ?? "place";
    this.finalTarget = options.finalTarget ?? "finish";
    this.timeoutMs = options.timeoutMs ?? 30 * 60 * 1000;
    this.openroadExe = options.openroadExe ?? "/work/orfs/tools/install/bin/openroad";
    this.yosysExe = options.yosysExe ?? "/usr/local/bin/yosys";
  }

  async prepareExperiment({ experimentId }) {
    ensureDir(this.getExperimentRoot(experimentId));
  }

  getExperimentRoot(experimentId) {
    return path.join(this.runRoot, safeVariant(experimentId));
  }

  getCandidateRoot(experimentId, candidateId) {
    return path.join(this.getExperimentRoot(experimentId), safeVariant(candidateId));
  }

  getFlowVariant(candidate) {
    return safeVariant(candidate.id);
  }

  getVariantName(candidate) {
    return `${this.getFlowVariant(candidate)}_1`;
  }

  getReportsDir(experimentId, candidate) {
    return path.join(
      this.getCandidateRoot(experimentId, candidate.id),
      "reports",
      this.platform,
      this.design,
      this.getVariantName(candidate),
    );
  }

  getResultsDir(experimentId, candidate) {
    return path.join(
      this.getCandidateRoot(experimentId, candidate.id),
      "results",
      this.platform,
      this.design,
      this.getVariantName(candidate),
    );
  }

  async runStage({ candidate, context, stage }) {
    const experimentId = context.experimentId;
    const candidateRoot = this.getCandidateRoot(experimentId, candidate.id);
    const logPath = path.join(candidateRoot, `${stage}.log`);
    ensureDir(candidateRoot);

    const target = stage === "early" ? this.earlyTarget : this.finalTarget;
    const makeArgs = [
      `DESIGN_CONFIG=${shellQuote(this.designConfig)}`,
      "WORK_HOME=/work/run",
      `FLOW_VARIANT=${shellQuote(this.getFlowVariant(candidate))}`,
      `OPENROAD_EXE=${shellQuote(this.openroadExe)}`,
      `YOSYS_EXE=${shellQuote(this.yosysExe)}`,
      ...makeVariableArgs(candidate.params),
      shellQuote(target),
    ].join(" ");

    const args = [
      "run",
      "--rm",
      "--user",
      `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
      "-e",
      "HOME=/tmp",
      "-v",
      `${this.orfsRoot}:/work/orfs`,
      "-v",
      `${candidateRoot}:/work/run`,
      "-w",
      "/work/orfs/flow",
      this.image,
      "bash",
      "-lc",
      `make ${makeArgs}`,
    ];

    const result = await runProcess(this.dockerBin, args, {
      logPath,
      timeoutMs: this.timeoutMs,
    });
    return {
      ...result,
      candidateRoot,
      command: [this.dockerBin, ...args].join(" "),
      logPath,
      target,
    };
  }

  async collectMetrics({ candidate, context, runResult, stage }) {
    const experimentId = context.experimentId;
    const reportsDir = this.getReportsDir(experimentId, candidate);
    const resultsDir = this.getResultsDir(experimentId, candidate);
    const timingReport =
      stage === "early"
        ? path.join(reportsDir, "3_detailed_place.rpt")
        : path.join(reportsDir, "6_finish.rpt");
    const fallbackRouteReport = path.join(reportsDir, "5_global_route.rpt");
    const reportText = readTextIfExists(timingReport) || readTextIfExists(fallbackRouteReport);
    const drcReport = path.join(reportsDir, "5_route_drc.rpt");
    const congestionReport = path.join(reportsDir, "congestion.rpt");
    const congestionText = readTextIfExists(congestionReport);
    const gdsPath = path.join(resultsDir, "6_final.gds");

    return {
      success: runResult?.ok ?? false,
      stage,
      reportPath: fs.existsSync(timingReport) ? timingReport : fallbackRouteReport,
      wns: parseFirstNumber(reportText, /(?:^|\n)\s*wns\s+(-?\d+(?:\.\d+)?)/i),
      tns: parseFirstNumber(reportText, /(?:^|\n)\s*tns\s+(-?\d+(?:\.\d+)?)/i),
      worstSlack: parseFirstNumber(reportText, /worst\s+slack\s+(-?\d+(?:\.\d+)?)/i),
      congestion: parseFirstNumber(congestionText, /(?:overflow|congestion)\D+(-?\d+(?:\.\d+)?)/i),
      drcReport,
      drcReportBytes: fileSizeIfExists(drcReport),
      gdsPath: fs.existsSync(gdsPath) ? gdsPath : null,
      logPath: runResult?.logPath ?? null,
      resultsDir,
    };
  }
}
