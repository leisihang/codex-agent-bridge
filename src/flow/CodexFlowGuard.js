import fs from "node:fs";
import path from "node:path";

const DEFAULT_STEP_ORDER = [
  "rtl",
  "synthesis",
  "floorplan",
  "placement",
  "legalization",
  "cts",
  "route",
  "drc",
];

const TERMINAL_STEP_STATUSES = new Set(["done", "failed", "manual_review", "stale"]);
const RERUNNABLE_STEP_STATUSES = new Set(["ready", "done", "failed", "manual_review", "stale"]);

const READ_ONLY_COMMANDS = new Set([
  "cat",
  "find",
  "grep",
  "head",
  "ls",
  "nl",
  "pwd",
  "rg",
  "sed",
  "sort",
  "stat",
  "tail",
  "test",
  "tree",
  "wc",
]);

const BLOCKED_COMMAND_PATTERNS = [
  { pattern: /(^|\s)sudo(\s|$)/i, reason: "sudo is not allowed in guarded ECOS flow." },
  { pattern: /(^|\s)rm\s+[^;&|]*-[^\s]*r[^\s]*(\s|$)/i, reason: "recursive rm is not allowed." },
  { pattern: /(^|\s)(curl|wget)(\s|$)/i, reason: "network download commands are not allowed." },
  { pattern: /(^|\s)git\s+(reset|checkout|clean)(\s|$)/i, reason: "destructive git commands are not allowed." },
  { pattern: /(^|\s)(chmod|chown)\s+-R(\s|$)/i, reason: "recursive permission changes are not allowed." },
  { pattern: /(^|\s)(dd|mkfs)(\s|$)/i, reason: "raw disk commands are not allowed." },
];

export const DEFAULT_ECOS_FLOW_MANIFEST = {
  version: 1,
  steps: {
    rtl: {
      dependencies: [],
      workdir: ".",
      requiredAny: ["origin", "src", "home/flow.json"],
      commandPatterns: [],
      writable: [],
      outputs: [],
    },
    synthesis: {
      dependencies: ["rtl"],
      workdir: "Synthesis_yosys",
      commandPatterns: [
        "yosys",
        "make synth",
        "make synthesis",
        "bash run.sh",
        "./run.sh",
        "tclsh script/yosys_synthesis.tcl",
      ],
      writable: ["Synthesis_yosys/output", "Synthesis_yosys/log"],
      outputs: ["Synthesis_yosys/output/*.v", "Synthesis_yosys/log/*.log"],
    },
    floorplan: {
      dependencies: ["synthesis"],
      workdir: "Floorplan_ecc",
      commandPatterns: ["make floorplan", "ecos run floorplan", "bash run.sh", "./run.sh", "python run.py"],
      writable: ["Floorplan_ecc/output", "Floorplan_ecc/log"],
      outputs: ["Floorplan_ecc/output/*"],
    },
    placement: {
      dependencies: ["floorplan"],
      workdir: "place_dreamplace",
      commandPatterns: ["make place", "make placement", "bash run.sh", "./run.sh", "python run.py"],
      writable: ["place_dreamplace/output", "place_dreamplace/log"],
      outputs: ["place_dreamplace/output/*"],
    },
    legalization: {
      dependencies: ["placement"],
      workdir: "legalization_dreamplace",
      commandPatterns: ["make legalize", "make legalization", "bash run.sh", "./run.sh", "python run.py"],
      writable: ["legalization_dreamplace/output", "legalization_dreamplace/log"],
      outputs: ["legalization_dreamplace/output/*"],
    },
    cts: {
      dependencies: ["legalization"],
      workdir: "CTS_ecc",
      commandPatterns: ["make cts", "ecos run cts", "bash run.sh", "./run.sh", "python run.py"],
      writable: ["CTS_ecc/output", "CTS_ecc/log"],
      outputs: ["CTS_ecc/output/*"],
    },
    route: {
      dependencies: ["cts"],
      workdir: "route_ecc",
      commandPatterns: ["make route", "ecos run route", "bash run.sh", "./run.sh", "python run.py"],
      writable: ["route_ecc/output", "route_ecc/log"],
      outputs: ["route_ecc/output/*"],
    },
    drc: {
      dependencies: ["route"],
      workdir: "drc_ecc",
      commandPatterns: ["make drc", "ecos run drc", "bash run.sh", "./run.sh", "python run.py"],
      writable: ["drc_ecc/output", "drc_ecc/log"],
      outputs: ["drc_ecc/output/*"],
    },
  },
};

function isObject(value) {
  return typeof value === "object" && value !== null;
}

function toPosixPath(value) {
  return value.replaceAll(path.sep, "/").replaceAll("\\", "/");
}

function normalizeRelativePath(value) {
  const normalized = toPosixPath(path.normalize(value));
  return normalized === "." ? "" : normalized.replace(/^\/+/, "");
}

function stripOuterQuotes(value) {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === "'" && last === "'") || (first === '"' && last === '"')) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function unwrapShellCommand(command) {
  let current = command.trim();
  for (let i = 0; i < 3; i += 1) {
    const match = current.match(/^(?:\/[\w.-]+\/)?(?:bash|sh|zsh)\s+-(?:l?c|c)\s+([\s\S]+)$/i);
    if (!match) {
      break;
    }
    current = stripOuterQuotes(match[1]);
  }
  return current;
}

function splitShellSegments(command) {
  return command
    .split(/\s*(?:&&|\|\||;|\|)\s*/g)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function getCommandName(segment) {
  const tokens = segment.trim().split(/\s+/g).filter(Boolean);
  while (tokens[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) {
    tokens.shift();
  }
  const command = tokens[0] ?? "";
  return path.basename(command);
}

function isReadOnlyCommand(command) {
  const unwrapped = unwrapShellCommand(command);
  if (/[<>]/.test(unwrapped)) {
    return false;
  }
  if (/(^|\s)tee(\s|$)/i.test(unwrapped)) {
    return false;
  }
  if (/(^|\s)find\s+[\s\S]*\s-delete(\s|$)/i.test(unwrapped)) {
    return false;
  }
  if (/(^|\s)sed\s+[\s\S]*(^|\s)-i(\s|$)/i.test(unwrapped)) {
    return false;
  }
  const segments = splitShellSegments(unwrapped);
  return segments.length > 0 && segments.every((segment) => READ_ONLY_COMMANDS.has(getCommandName(segment)));
}

function commandMatchesPattern(command, pattern) {
  const unwrapped = unwrapShellCommand(command).trim();
  const candidates = [unwrapped, ...splitShellSegments(unwrapped)];
  if (pattern.startsWith("regex:")) {
    const regex = new RegExp(pattern.slice("regex:".length), "i");
    return candidates.some((candidate) => regex.test(candidate));
  }

  const normalizedPattern = pattern.trim().toLowerCase();
  if (!normalizedPattern) {
    return false;
  }

  const firstPatternWord = normalizedPattern.split(/\s+/g)[0];

  return candidates.some((candidate) => {
    const normalizedCommand = candidate.toLowerCase();
    if (normalizedCommand === normalizedPattern || normalizedCommand.startsWith(`${normalizedPattern} `)) {
      return true;
    }

    if (!normalizedPattern.includes(" ")) {
      return getCommandName(normalizedCommand) === firstPatternWord;
    }

    return normalizedCommand.includes(` ${normalizedPattern}`);
  });
}

function compileProjectPattern(pattern) {
  const escaped = normalizeRelativePath(pattern)
    .split("*")
    .map((part) => part.replace(/[|\\{}()[\]^$+?.]/g, "\\$&"))
    .join("[^/]*");
  return new RegExp(`^${escaped}$`);
}

function firstNonGlobDirectory(pattern) {
  const parts = normalizeRelativePath(pattern).split("/");
  const prefix = [];
  for (const part of parts) {
    if (part.includes("*")) {
      break;
    }
    prefix.push(part);
  }
  if (prefix.length === parts.length) {
    prefix.pop();
  }
  return prefix.join("/");
}

function walkFiles(root) {
  const results = [];
  if (!fs.existsSync(root)) {
    return results;
  }

  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        results.push(fullPath);
      }
    }
  }
  return results;
}

function cloneManifest(manifest) {
  return JSON.parse(JSON.stringify(manifest));
}

function mergeManifest(manifest) {
  const merged = cloneManifest(DEFAULT_ECOS_FLOW_MANIFEST);
  if (!manifest?.steps) {
    return merged;
  }

  for (const [stepId, step] of Object.entries(manifest.steps)) {
    merged.steps[stepId] = {
      ...(merged.steps[stepId] ?? {}),
      ...step,
    };
  }
  return merged;
}

function normalizeDecision(decision, reason, details = {}) {
  return {
    decision,
    reason,
    ...details,
    response: { decision },
  };
}

export class CodexFlowGuard {
  constructor(options = {}) {
    this.projectRoot = options.projectRoot ? path.resolve(options.projectRoot) : null;
    this.manifest = mergeManifest(options.manifest);
    this.projectFiles = Array.isArray(options.projectFiles)
      ? new Set(options.projectFiles.map((file) => normalizeRelativePath(file)))
      : null;
    this.stepOrder = options.stepOrder ?? DEFAULT_STEP_ORDER;
    this.steps = new Map();
    this.activeStep = null;
    this.history = [];
    this.commandItems = new Map();
    this.reset();
  }

  setProjectRoot(projectRoot) {
    this.projectRoot = path.resolve(projectRoot);
    this.reset();
  }

  reset() {
    this.steps.clear();
    for (const stepId of this.stepOrder) {
      if (!this.manifest.steps[stepId]) {
        continue;
      }
      this.steps.set(stepId, {
        id: stepId,
        status: "not_ready",
        reason: null,
        updatedAt: Date.now(),
      });
    }
    this.activeStep = null;
    this.commandItems.clear();

    if (this.projectRoot && this.steps.has("rtl")) {
      const rtlReady = this.stepHasRequiredInputs("rtl");
      this.setStepStatus("rtl", rtlReady ? "done" : "ready", rtlReady ? "RTL/project inputs detected." : "Project loaded.");
    }
    this.refreshReadiness();
  }

  getSnapshot() {
    const steps = {};
    for (const [stepId, state] of this.steps.entries()) {
      steps[stepId] = { ...state };
    }
    return {
      projectRoot: this.projectRoot,
      activeStep: this.activeStep,
      steps,
      history: [...this.history],
    };
  }

  authorizeCommandRequest(params) {
    const command = typeof params?.command === "string" ? params.command : "";
    const cwd = typeof params?.cwd === "string" ? params.cwd : this.projectRoot;
    const result = this.authorizeCommand({ command, cwd });
    const itemId = typeof params?.itemId === "string" ? params.itemId : null;

    if (itemId) {
      const resolvedCwd = this.resolvePath(cwd ?? this.projectRoot);
      const stepId = result.step ?? this.identifyCommandStep(command, resolvedCwd);
      const record = this.commandItems.get(itemId) ?? {};
      this.commandItems.set(itemId, {
        ...record,
        command,
        cwd: resolvedCwd,
        stepId,
        approvalDecision: result.decision,
      });

      if ((result.decision === "decline" || result.decision === "cancel") && stepId) {
        this.restoreStepAfterDeclinedCommand(itemId, stepId, result.reason);
      }
    }

    return result;
  }

  authorizeCommand({ command, cwd }) {
    if (!this.projectRoot) {
      return normalizeDecision("decline", "No ECOS project root is loaded.");
    }
    if (!command.trim()) {
      return normalizeDecision("decline", "Codex command approval did not include a command.");
    }

    const resolvedCwd = this.resolvePath(cwd ?? this.projectRoot);
    if (!this.isInsideProject(resolvedCwd)) {
      return normalizeDecision("decline", `Command cwd is outside project root: ${resolvedCwd}`);
    }

    const blocked = BLOCKED_COMMAND_PATTERNS.find(({ pattern }) => pattern.test(unwrapShellCommand(command)));
    if (blocked) {
      return normalizeDecision("decline", blocked.reason);
    }

    if (isReadOnlyCommand(command)) {
      return normalizeDecision("accept", "Read-only inspection command is allowed.", {
        commandType: "read_only",
      });
    }

    const stepId = this.identifyCommandStep(command, resolvedCwd);
    if (!stepId) {
      return normalizeDecision(
        "decline",
        "Command does not map to an allowed ECOS flow step. Add it to the project flow manifest if it is valid.",
      );
    }

    const dependencyDecision = this.canRunStep(stepId);
    if (dependencyDecision.decision !== "accept") {
      return dependencyDecision;
    }

    return normalizeDecision("accept", `Command is allowed for step ${stepId}.`, {
      commandType: "step",
      step: stepId,
    });
  }

  authorizeFileChangeRequest(params) {
    const grantRoot = typeof params?.grantRoot === "string" ? params.grantRoot : null;
    if (!grantRoot) {
      return normalizeDecision(
        "decline",
        "File change approval did not include concrete paths or grantRoot, so the guard cannot verify write scope.",
      );
    }

    return this.authorizeWriteRoot(grantRoot);
  }

  authorizeWriteRoot(root) {
    if (!this.projectRoot) {
      return normalizeDecision("decline", "No ECOS project root is loaded.");
    }
    const resolvedRoot = this.resolvePath(root);
    if (!this.isInsideProject(resolvedRoot)) {
      return normalizeDecision("decline", `Requested write root is outside project root: ${resolvedRoot}`);
    }

    const activeWritableRoots = this.activeStep ? this.getWritableRoots(this.activeStep) : [];
    if (activeWritableRoots.some((writableRoot) => this.isSameOrInside(writableRoot, resolvedRoot))) {
      return normalizeDecision("accept", `Write root is allowed for active step ${this.activeStep}.`, {
        step: this.activeStep,
      });
    }

    return normalizeDecision(
      "decline",
      "Requested write root is not within the active step writable directories.",
    );
  }

  authorizeFileChanges(changes) {
    if (!Array.isArray(changes) || changes.length === 0) {
      return normalizeDecision("decline", "No file changes were provided.");
    }

    for (const change of changes) {
      const targetPath = typeof change?.path === "string" ? change.path : "";
      if (!targetPath) {
        return normalizeDecision("decline", "A file change did not include a path.");
      }
      const resolvedPath = this.resolvePath(targetPath);
      if (!this.isInsideProject(resolvedPath)) {
        return normalizeDecision("decline", `File change path is outside project root: ${resolvedPath}`);
      }
      if (this.activeStep) {
        const allowed = this.getWritableRoots(this.activeStep).some((root) => this.isSameOrInside(root, resolvedPath));
        if (!allowed) {
          return normalizeDecision(
            "decline",
            `File change is outside writable roots for active step ${this.activeStep}: ${resolvedPath}`,
          );
        }
      } else {
        const stepId = this.identifyPathStep(resolvedPath);
        if (!stepId) {
          return normalizeDecision("decline", `File change does not map to an ECOS flow step: ${resolvedPath}`);
        }
        const allowed = this.getWritableRoots(stepId).some((root) => this.isSameOrInside(root, resolvedPath));
        if (!allowed) {
          return normalizeDecision("decline", `File change is outside writable roots for step ${stepId}: ${resolvedPath}`);
        }
        const dependencyDecision = this.canRunStep(stepId);
        if (dependencyDecision.decision !== "accept") {
          return dependencyDecision;
        }
      }
    }

    return normalizeDecision("accept", "File changes are inside the guarded project write scope.", {
      step: this.activeStep,
    });
  }

  onNotification(event) {
    if (event?.method === "item/started") {
      this.onItemStarted(event.params);
    }
    if (event?.method === "item/completed") {
      this.onItemCompleted(event.params);
    }
  }

  onItemStarted(params) {
    const item = params?.item;
    if (item?.type !== "commandExecution") {
      return;
    }

    const stepId = this.identifyCommandStep(item.command, this.resolvePath(item.cwd));
    if (!stepId) {
      return;
    }

    this.commandItems.set(item.id, {
      ...(this.commandItems.get(item.id) ?? {}),
      command: item.command,
      cwd: this.resolvePath(item.cwd),
      previousState: this.steps.get(stepId) ? { ...this.steps.get(stepId) } : null,
      stepId,
    });
    this.activeStep = stepId;
    this.setStepStatus(stepId, "running", `Command started for ${stepId}.`);
    this.invalidateDescendants(stepId, `${stepId} is being rerun.`);
  }

  onItemCompleted(params) {
    const item = params?.item;
    if (!item) {
      return;
    }

    if (item.type === "commandExecution") {
      this.onCommandCompleted(item);
      return;
    }

    if (item.type === "fileChange") {
      this.recordFileChanges(item.changes);
    }
  }

  onCommandCompleted(item) {
    const stepId = this.identifyCommandStep(item.command, this.resolvePath(item.cwd));
    if (!stepId) {
      return;
    }
    const record = this.commandItems.get(item.id);

    if (this.activeStep === stepId) {
      this.activeStep = null;
    }

    if (item.exitCode === null && (record?.approvalDecision === "decline" || record?.approvalDecision === "cancel")) {
      this.restoreStepAfterDeclinedCommand(item.id, stepId, `Command approval was ${record.approvalDecision}.`);
      this.commandItems.delete(item.id);
      return;
    }

    if (item.exitCode !== 0) {
      this.setStepStatus(stepId, "failed", `Command for ${stepId} exited with code ${item.exitCode}.`);
      this.commandItems.delete(item.id);
      this.refreshReadiness();
      return;
    }

    if (this.verifyStepOutputs(stepId)) {
      this.setStepStatus(stepId, "done", `Required artifacts for ${stepId} were found.`);
    } else {
      this.setStepStatus(stepId, "manual_review", `Command for ${stepId} succeeded, but required artifacts were not found.`);
    }
    this.commandItems.delete(item.id);
    this.refreshReadiness();
  }

  recordFileChanges(changes) {
    if (!Array.isArray(changes)) {
      return;
    }

    const touchedSteps = new Set();
    for (const change of changes) {
      const targetPath = typeof change?.path === "string" ? this.resolvePath(change.path) : null;
      if (!targetPath || !this.isInsideProject(targetPath)) {
        continue;
      }

      const stepId = this.identifyPathStep(targetPath);
      if (stepId) {
        touchedSteps.add(stepId);
      }
    }

    for (const stepId of touchedSteps) {
      if (stepId === this.activeStep) {
        continue;
      }
      const state = this.steps.get(stepId);
      if (state && TERMINAL_STEP_STATUSES.has(state.status)) {
        this.setStepStatus(stepId, "stale", `Files under ${stepId} changed.`);
      }
      this.invalidateDescendants(stepId, `Files under ${stepId} changed.`);
    }
    this.refreshReadiness();
  }

  canRunStep(stepId) {
    this.refreshReadiness();

    if (this.activeStep && this.activeStep !== stepId) {
      return normalizeDecision("decline", `Step ${this.activeStep} is already running; cannot run ${stepId}.`, {
        step: stepId,
      });
    }

    const step = this.steps.get(stepId);
    if (!step) {
      return normalizeDecision("decline", `Unknown ECOS flow step: ${stepId}`);
    }

    const missingDependency = this.getDependencies(stepId).find((dependency) => this.steps.get(dependency)?.status !== "done");
    if (missingDependency) {
      const status = this.steps.get(missingDependency)?.status ?? "missing";
      return normalizeDecision(
        "decline",
        `Step ${stepId} requires ${missingDependency} to be done, but it is ${status}.`,
        { step: stepId },
      );
    }

    if (!RERUNNABLE_STEP_STATUSES.has(step.status)) {
      return normalizeDecision("decline", `Step ${stepId} is ${step.status}, so it is not runnable.`, {
        step: stepId,
      });
    }

    return normalizeDecision("accept", `Step ${stepId} is runnable.`, { step: stepId });
  }

  setStepStatus(stepId, status, reason) {
    const current = this.steps.get(stepId);
    if (!current) {
      return;
    }

    current.status = status;
    current.reason = reason;
    current.updatedAt = Date.now();
    this.history.push({
      at: current.updatedAt,
      step: stepId,
      status,
      reason,
    });
  }

  restoreStepAfterDeclinedCommand(itemId, stepId, reason) {
    const record = this.commandItems.get(itemId);
    if (this.activeStep === stepId) {
      this.activeStep = null;
    }

    if (record?.previousState) {
      this.steps.set(stepId, {
        ...record.previousState,
        updatedAt: Date.now(),
      });
    } else {
      const dependenciesDone = this.getDependencies(stepId).every((dependency) => this.steps.get(dependency)?.status === "done");
      const restoredStatus = dependenciesDone ? "ready" : "not_ready";
      this.setStepStatus(stepId, restoredStatus, `Command declined before execution: ${reason}`);
    }
    this.refreshReadiness();
  }

  refreshReadiness() {
    if (!this.projectRoot) {
      return;
    }

    for (const stepId of this.stepOrder) {
      const state = this.steps.get(stepId);
      if (!state || state.status === "running" || TERMINAL_STEP_STATUSES.has(state.status)) {
        continue;
      }
      const dependenciesDone = this.getDependencies(stepId).every((dependency) => this.steps.get(dependency)?.status === "done");
      state.status = dependenciesDone ? "ready" : "not_ready";
      state.updatedAt = Date.now();
    }
  }

  invalidateDescendants(stepId, reason) {
    for (const descendant of this.getDescendants(stepId)) {
      const state = this.steps.get(descendant);
      if (!state || state.status === "running") {
        continue;
      }
      if (state.status === "ready") {
        this.setStepStatus(descendant, "not_ready", reason);
      } else if (state.status !== "not_ready") {
        this.setStepStatus(descendant, "stale", reason);
      }
    }
  }

  verifyStepOutputs(stepId) {
    const outputs = this.manifest.steps[stepId]?.outputs ?? [];
    if (outputs.length === 0) {
      return true;
    }
    return outputs.every((pattern) => this.projectPatternHasMatch(pattern));
  }

  stepHasRequiredInputs(stepId) {
    const requiredAny = this.manifest.steps[stepId]?.requiredAny ?? [];
    if (requiredAny.length === 0) {
      return true;
    }
    return requiredAny.some((candidate) => this.projectPathExists(candidate));
  }

  identifyCommandStep(command, cwd) {
    const resolvedCwd = this.resolvePath(cwd ?? this.projectRoot);
    const workdirMatches = [];
    const commandMatches = [];

    for (const stepId of this.stepOrder) {
      const step = this.manifest.steps[stepId];
      if (!step) {
        continue;
      }

      const stepWorkdir = this.resolvePath(step.workdir ?? ".");
      const patterns = step.commandPatterns ?? [];
      const matchesPattern = patterns.some((pattern) => commandMatchesPattern(command, pattern));
      if (this.isSameOrInside(stepWorkdir, resolvedCwd)) {
        workdirMatches.push(stepId);
      }
      if (matchesPattern) {
        commandMatches.push(stepId);
      }
    }

    const exact = commandMatches.find((stepId) => workdirMatches.includes(stepId));
    if (exact) {
      return exact;
    }
    if (commandMatches.length === 1) {
      return commandMatches[0];
    }
    return null;
  }

  identifyPathStep(filePath) {
    const resolvedPath = this.resolvePath(filePath);
    for (const stepId of this.stepOrder) {
      const step = this.manifest.steps[stepId];
      if (!step) {
        continue;
      }
      const candidates = [step.workdir, ...(step.writable ?? [])].filter(Boolean);
      if (candidates.some((candidate) => this.isSameOrInside(this.resolvePath(candidate), resolvedPath))) {
        return stepId;
      }
    }
    return null;
  }

  getDependencies(stepId) {
    return this.manifest.steps[stepId]?.dependencies ?? [];
  }

  getDescendants(stepId) {
    const descendants = new Set();
    const visit = (current) => {
      for (const [candidate, step] of Object.entries(this.manifest.steps)) {
        if ((step.dependencies ?? []).includes(current) && !descendants.has(candidate)) {
          descendants.add(candidate);
          visit(candidate);
        }
      }
    };
    visit(stepId);
    return [...descendants].filter((candidate) => this.steps.has(candidate));
  }

  getWritableRoots(stepId) {
    return (this.manifest.steps[stepId]?.writable ?? []).map((root) => this.resolvePath(root));
  }

  resolvePath(value) {
    if (!value) {
      return this.projectRoot;
    }
    return path.resolve(path.isAbsolute(value) ? value : path.join(this.projectRoot ?? process.cwd(), value));
  }

  isInsideProject(targetPath) {
    return this.isSameOrInside(this.projectRoot, targetPath);
  }

  isSameOrInside(parentPath, targetPath) {
    if (!parentPath || !targetPath) {
      return false;
    }
    const relative = path.relative(path.resolve(parentPath), path.resolve(targetPath));
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  }

  projectPathExists(projectPath) {
    const relativePath = normalizeRelativePath(projectPath);
    if (this.projectFiles) {
      return this.projectFiles.has(relativePath) || [...this.projectFiles].some((file) => file.startsWith(`${relativePath}/`));
    }
    return fs.existsSync(this.resolvePath(relativePath));
  }

  projectPatternHasMatch(pattern) {
    const normalizedPattern = normalizeRelativePath(pattern);
    if (!normalizedPattern.includes("*")) {
      return this.projectPathExists(normalizedPattern);
    }

    const regex = compileProjectPattern(normalizedPattern);
    if (this.projectFiles) {
      return [...this.projectFiles].some((file) => regex.test(file));
    }

    const baseDirectory = this.resolvePath(firstNonGlobDirectory(normalizedPattern));
    return walkFiles(baseDirectory).some((file) => {
      const relative = normalizeRelativePath(path.relative(this.projectRoot, file));
      return regex.test(relative);
    });
  }

  static loadManifest(projectRoot, manifestPath = ".ecos-codex-flow.json") {
    const resolvedPath = path.resolve(projectRoot, manifestPath);
    if (!fs.existsSync(resolvedPath)) {
      return cloneManifest(DEFAULT_ECOS_FLOW_MANIFEST);
    }
    const parsed = JSON.parse(fs.readFileSync(resolvedPath, "utf8"));
    if (!isObject(parsed)) {
      throw new Error(`Invalid flow manifest: ${resolvedPath}`);
    }
    return mergeManifest(parsed);
  }
}
