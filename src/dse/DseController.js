import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DSE_AGENT_ACTIONS,
  DSE_CANDIDATE_STATES,
  DSE_TRANSITIONS,
  DseFlowGuard,
} from "./DseFlowGuard.js";
import { AlwaysReviewTriggerPolicy } from "./DseTriggerPolicy.js";

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function appendJsonl(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`);
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (/[",\n]/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}

function makeBranchId(parentId, index) {
  return `${parentId}_branch_${index}`;
}

function summarizeCandidate(candidate) {
  return {
    id: candidate.id,
    parentId: candidate.parentId,
    branchDepth: candidate.branchDepth,
    params: candidate.params,
    status: candidate.status,
    metrics: candidate.metrics,
    agentDecision: candidate.agentDecision,
    reason: candidate.reason,
  };
}

export class DseController {
  constructor(options = {}) {
    if (!options.adapter) {
      throw new Error("DseController requires an adapter.");
    }
    if (!options.subAgent) {
      throw new Error("DseController requires a subAgent.");
    }

    this.adapter = options.adapter;
    this.subAgent = options.subAgent;
    this.flowGuard = options.flowGuard ?? new DseFlowGuard(options.flowGuardOptions);
    this.experimentRoot =
      options.experimentRoot ?? fs.mkdtempSync(path.join(os.tmpdir(), "codex-dse-"));
    this.logger = options.logger ?? null;
    this.triggerPolicy = options.triggerPolicy ?? new AlwaysReviewTriggerPolicy();
    this.history = [];
    this.branchSerial = 0;
  }

  get files() {
    return {
      agentDecisions: path.join(this.experimentRoot, "agent_decisions.jsonl"),
      events: path.join(this.experimentRoot, "dse_events.jsonl"),
      history: path.join(this.experimentRoot, "dse_history.csv"),
      state: path.join(this.experimentRoot, "dse_state.json"),
    };
  }

  log(event) {
    if (this.logger) {
      this.logger(event);
    }
    appendJsonl(this.files.events, event);
  }

  persistState() {
    writeJson(this.files.state, {
      snapshot: this.flowGuard.getSnapshot(),
      history: this.history,
    });
    this.writeHistory();
  }

  writeHistory() {
    const lines = [
      [
        "candidate_id",
        "parent_id",
        "status",
        "action",
        "early_metrics",
        "final_metrics",
        "params",
        "reason",
      ].join(","),
    ];

    for (const row of this.history) {
      lines.push([
        csvEscape(row.candidateId),
        csvEscape(row.parentId),
        csvEscape(row.status),
        csvEscape(row.action),
        csvEscape(row.earlyMetrics),
        csvEscape(row.finalMetrics),
        csvEscape(row.params),
        csvEscape(row.reason),
      ].join(","));
    }
    ensureDir(path.dirname(this.files.history));
    fs.writeFileSync(this.files.history, `${lines.join("\n")}\n`);
  }

  async runClosedLoop({
    experimentId = `dse_${Date.now()}`,
    metadata = {},
    objective = "ECP",
    seedCandidates = [],
  } = {}) {
    ensureDir(this.experimentRoot);
    this.flowGuard.createExperiment({ id: experimentId, objective, metadata });

    if (typeof this.adapter.prepareExperiment === "function") {
      await this.adapter.prepareExperiment({
        experimentId,
        experimentRoot: this.experimentRoot,
        objective,
        metadata,
      });
    }

    const queue = [];
    for (const candidate of seedCandidates) {
      const registered = this.flowGuard.registerCandidate(candidate);
      queue.push(registered.id);
    }
    this.persistState();

    while (queue.length > 0) {
      const candidateId = queue.shift();
      const result = await this.runCandidate(candidateId, { experimentId });
      for (const candidate of result.newCandidates) {
        queue.push(candidate.id);
      }
      this.persistState();
    }

    this.flowGuard.completeExperiment("completed");
    this.persistState();
    return {
      experimentRoot: this.experimentRoot,
      history: cloneJson(this.history),
      snapshot: this.flowGuard.getSnapshot(),
    };
  }

  async runCandidate(candidateId, context) {
    const newCandidates = [];
    await this.runEarlyStage(candidateId, context);

    const candidateAfterEarly = this.flowGuard.getCandidate(candidateId);
    if (candidateAfterEarly.status === DSE_CANDIDATE_STATES.ARCHIVED) {
      return { newCandidates };
    }

    const decision = await this.resolveAgentDecision(candidateId, context);
    const actionResult = this.flowGuard.applyAgentDecision(candidateId, decision);
    if (actionResult.decision !== "accept") {
      this.flowGuard.transition(candidateId, DSE_TRANSITIONS.AGENT_TERMINATE, {
        reason: actionResult.reason,
      });
      this.recordHistory(candidateId, {
        action: DSE_AGENT_ACTIONS.TERMINATE,
        reason: actionResult.reason,
      });
      this.flowGuard.archiveCandidate(candidateId, actionResult.reason);
      return { newCandidates };
    }

    const accepted = this.flowGuard.getCandidate(candidateId);
    if (decision.action === DSE_AGENT_ACTIONS.BRANCH_RERUN) {
      const branch = this.createBranchCandidate(accepted, decision);
      newCandidates.push(branch);
      this.recordHistory(candidateId, {
        action: decision.action,
        reason: decision.reason,
      });
      this.flowGuard.archiveCandidate(candidateId, decision.reason ?? "Branched by agent.");
      return { newCandidates };
    }

    if (decision.action === DSE_AGENT_ACTIONS.CONTINUE) {
      await this.runFullStage(candidateId, context);
      this.recordHistory(candidateId, {
        action: decision.action,
        reason: decision.reason,
      });
      this.flowGuard.archiveCandidate(candidateId, decision.reason ?? "Final flow completed.");
      return { newCandidates };
    }

    this.recordHistory(candidateId, {
      action: decision.action,
      reason: decision.reason,
    });
    this.flowGuard.archiveCandidate(candidateId, decision.reason ?? `Agent selected ${decision.action}.`);
    return { newCandidates };
  }

  async runEarlyStage(candidateId, context) {
    this.flowGuard.transition(candidateId, DSE_TRANSITIONS.LAUNCH_EARLY);
    let runResult = null;
    try {
      runResult = await this.adapter.runStage({
        candidate: this.flowGuard.getCandidate(candidateId),
        context,
        stage: "early",
      });
    } catch (error) {
      runResult = { ok: false, error: error.message };
    }

    if (!runResult?.ok) {
      this.flowGuard.transition(candidateId, DSE_TRANSITIONS.EARLY_FAILED, {
        reason: runResult?.error ?? `Early stage failed with exit code ${runResult?.exitCode}.`,
      });
      this.flowGuard.updateMetrics(candidateId, "early", {
        success: false,
        runResult,
      });
      this.recordHistory(candidateId, {
        action: "early_failed",
        reason: runResult?.error ?? "Early stage failed.",
      });
      this.flowGuard.archiveCandidate(candidateId, "Early stage failed.");
      return;
    }

    this.flowGuard.transition(candidateId, DSE_TRANSITIONS.EARLY_SUCCEEDED);
    const metrics = await this.adapter.collectMetrics({
      candidate: this.flowGuard.getCandidate(candidateId),
      context,
      runResult,
      stage: "early",
    });
    this.flowGuard.updateMetrics(candidateId, "early", metrics);
    this.flowGuard.transition(candidateId, DSE_TRANSITIONS.REQUEST_AGENT_REVIEW);
  }

  async runFullStage(candidateId, context) {
    this.flowGuard.transition(candidateId, DSE_TRANSITIONS.LAUNCH_FULL);
    let runResult = null;
    try {
      runResult = await this.adapter.runStage({
        candidate: this.flowGuard.getCandidate(candidateId),
        context,
        stage: "final",
      });
    } catch (error) {
      runResult = { ok: false, error: error.message };
    }

    if (!runResult?.ok) {
      this.flowGuard.transition(candidateId, DSE_TRANSITIONS.FULL_FAILED, {
        reason: runResult?.error ?? `Final stage failed with exit code ${runResult?.exitCode}.`,
      });
      this.flowGuard.updateMetrics(candidateId, "final", {
        success: false,
        runResult,
      });
      return;
    }

    this.flowGuard.transition(candidateId, DSE_TRANSITIONS.FULL_SUCCEEDED);
    const metrics = await this.adapter.collectMetrics({
      candidate: this.flowGuard.getCandidate(candidateId),
      context,
      runResult,
      stage: "final",
    });
    this.flowGuard.updateMetrics(candidateId, "final", metrics);
  }

  async requestAgentDecision(candidateId, context) {
    const candidate = this.flowGuard.getCandidate(candidateId);
    const allowedActions = this.flowGuard.getAllowedAgentActions(candidateId);
    const request = {
      allowedActions,
      candidate: summarizeCandidate(candidate),
      context,
      experiment: this.flowGuard.getSnapshot().experiment,
      history: cloneJson(this.history),
    };
    const decision = await this.subAgent.review(request);
    const normalized = isObject(decision)
      ? decision
      : { action: DSE_AGENT_ACTIONS.TERMINATE, reason: "Subagent returned an invalid decision." };

    appendJsonl(this.files.agentDecisions, {
      candidateId,
      request,
      decision: normalized,
      time: new Date().toISOString(),
    });
    return normalized;
  }

  async resolveAgentDecision(candidateId, context) {
    const candidate = this.flowGuard.getCandidate(candidateId);
    const allowedActions = this.flowGuard.getAllowedAgentActions(candidateId);
    const trigger = this.triggerPolicy.shouldReview({
      allowedActions,
      candidate,
      context,
      history: cloneJson(this.history),
      snapshot: this.flowGuard.getSnapshot(),
    });

    this.log({
      type: "subagent_trigger_evaluated",
      candidateId,
      trigger,
      time: new Date().toISOString(),
    });

    if (!trigger.review) {
      return trigger.defaultDecision ?? {
        action: DSE_AGENT_ACTIONS.CONTINUE,
        reason: trigger.reason ?? "Subagent review skipped by trigger policy.",
      };
    }

    return this.requestAgentDecision(candidateId, {
      ...context,
      triggerReason: trigger.reason,
    });
  }

  createBranchCandidate(parent, decision) {
    const overrides = decision.parameter_overrides ?? decision.parameterOverrides ?? {};
    const branchId = decision.new_candidate_id ?? decision.newCandidateId ?? makeBranchId(parent.id, ++this.branchSerial);
    const child = this.flowGuard.registerCandidate({
      id: branchId,
      parentId: parent.id,
      branchDepth: parent.branchDepth + 1,
      params: { ...parent.params, ...overrides },
      reason: decision.reason ?? "Created from agent branch_rerun decision.",
    });
    this.log({
      type: "branch_created",
      parentId: parent.id,
      childId: child.id,
      overrides,
      time: new Date().toISOString(),
    });
    return child;
  }

  recordHistory(candidateId, { action, reason }) {
    const candidate = this.flowGuard.getCandidate(candidateId);
    this.history.push({
      action,
      candidateId,
      earlyMetrics: candidate.metrics.early ?? null,
      finalMetrics: candidate.metrics.final ?? null,
      parentId: candidate.parentId,
      params: candidate.params,
      reason: reason ?? candidate.reason ?? null,
      status: candidate.status,
    });
  }
}
