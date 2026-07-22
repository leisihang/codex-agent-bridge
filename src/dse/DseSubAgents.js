import { CodexAgentManager } from "../CodexAgentManager.js";
import { DSE_AGENT_ACTIONS } from "./DseFlowGuard.js";

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readMetric(metrics, name) {
  if (!isObject(metrics)) return null;
  const value = metrics[name];
  return typeof value === "number" && !Number.isNaN(value) ? value : null;
}

function hasAction(allowedActions, action) {
  return Array.isArray(allowedActions) && allowedActions.includes(action);
}

export class RuleBasedDseSubAgent {
  constructor(options = {}) {
    this.branchCongestionThreshold = options.branchCongestionThreshold ?? 0.85;
    this.branchDensityDelta = options.branchDensityDelta ?? -0.05;
    this.branchWnsThreshold = options.branchWnsThreshold ?? null;
    this.pruneWnsThreshold = options.pruneWnsThreshold ?? -0.25;
  }

  async review({ allowedActions, candidate }) {
    const earlyMetrics = candidate.metrics?.early ?? {};
    if (earlyMetrics.success === false) {
      return {
        action: DSE_AGENT_ACTIONS.TERMINATE,
        reason: "Early flow failed, so this candidate should terminate.",
      };
    }

    const wns = readMetric(earlyMetrics, "wns");
    const congestion = readMetric(earlyMetrics, "congestion");

    if (
      hasAction(allowedActions, DSE_AGENT_ACTIONS.BRANCH_RERUN) &&
      congestion !== null &&
      congestion >= this.branchCongestionThreshold
    ) {
      const currentDensity = candidate.params.PLACE_DENSITY_LB_ADDON;
      const nextDensity =
        typeof currentDensity === "number"
          ? Math.max(0, Number((currentDensity + this.branchDensityDelta).toFixed(4)))
          : 0.15;
      return {
        action: DSE_AGENT_ACTIONS.BRANCH_RERUN,
        parameter_overrides: {
          PLACE_DENSITY_LB_ADDON: nextDensity,
        },
        reason: `Congestion ${congestion} is high; branch with lower placement density.`,
      };
    }

    if (
      hasAction(allowedActions, DSE_AGENT_ACTIONS.BRANCH_RERUN) &&
      this.branchWnsThreshold !== null &&
      wns !== null &&
      wns < this.branchWnsThreshold
    ) {
      const currentUtil = candidate.params.CORE_UTILIZATION;
      const nextUtil =
        typeof currentUtil === "number"
          ? Math.max(20, Number((currentUtil - 5).toFixed(4)))
          : 50;
      return {
        action: DSE_AGENT_ACTIONS.BRANCH_RERUN,
        parameter_overrides: {
          CORE_UTILIZATION: nextUtil,
        },
        reason: `Early WNS ${wns} is below ${this.branchWnsThreshold}; branch with lower core utilization.`,
      };
    }

    if (
      hasAction(allowedActions, DSE_AGENT_ACTIONS.PRUNE) &&
      wns !== null &&
      wns < this.pruneWnsThreshold
    ) {
      return {
        action: DSE_AGENT_ACTIONS.PRUNE,
        reason: `Early WNS ${wns} is below pruning threshold ${this.pruneWnsThreshold}.`,
      };
    }

    if (hasAction(allowedActions, DSE_AGENT_ACTIONS.CONTINUE)) {
      return {
        action: DSE_AGENT_ACTIONS.CONTINUE,
        reason: "Early metrics are acceptable for full-flow continuation.",
      };
    }

    return {
      action: DSE_AGENT_ACTIONS.TERMINATE,
      reason: "No safe DSE action is available.",
    };
  }
}

export class CodexDseSubAgent {
  constructor(options = {}) {
    this.manager = options.manager ?? new CodexAgentManager({
      approvalPolicy: options.approvalPolicy ?? "untrusted",
      defaultApprovalResponse: options.defaultApprovalResponse ?? { decision: "decline" },
      sandbox: options.sandbox ?? "workspace-write",
      serviceName: options.serviceName ?? "dse-subagent",
      ...(options.managerOptions ?? {}),
    });
    this.cwd = options.cwd ?? null;
    this.timeoutMs = options.timeoutMs ?? 180000;
    this.threadStarted = false;
  }

  async review(request) {
    const prompt = [
      "You are a DSE subagent for chip implementation runs.",
      "Return only one JSON object with action, reason, and optional parameter_overrides.",
      "Allowed actions are provided in the request. Do not choose actions outside that list.",
      "",
      JSON.stringify(request, null, 2),
    ].join("\n");

    await this.manager.start();
    if (!this.manager.getStatus().threadId) {
      await this.manager.startThread({
        approvalPolicy: "untrusted",
        cwd: this.cwd,
        ephemeral: true,
        persistExtendedHistory: false,
      });
    }

    const { completedTurn } = await this.manager.startTurnAndWait(prompt, {
      cwd: this.cwd,
      timeoutMs: this.timeoutMs,
    });

    const text = extractAssistantText(completedTurn);
    const decision = extractJsonDecision(text);
    if (!decision) {
      return {
        action: DSE_AGENT_ACTIONS.TERMINATE,
        reason: `Codex DSE subagent did not return parseable JSON: ${text.slice(0, 200)}`,
      };
    }
    return decision;
  }
}

function extractAssistantText(value) {
  const chunks = [];
  visit(value);
  return chunks.join("\n").trim();

  function visit(node) {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (!isObject(node)) return;

    if (
      (node.type === "agentMessage" || node.role === "assistant") &&
      typeof node.text === "string"
    ) {
      chunks.push(node.text);
    }
    if (
      (node.type === "message" || node.type === "output_text") &&
      typeof node.text === "string"
    ) {
      chunks.push(node.text);
    }
    if (typeof node.content === "string" && node.role === "assistant") {
      chunks.push(node.content);
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value) || isObject(value)) {
        visit(value);
      }
    }
  }
}

function extractJsonDecision(text) {
  const trimmed = text.trim();
  const direct = tryParseJson(trimmed);
  if (direct) return direct;

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    const parsed = tryParseJson(fenced[1].trim());
    if (parsed) return parsed;
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return tryParseJson(trimmed.slice(start, end + 1));
  }
  return null;
}

function tryParseJson(text) {
  try {
    const parsed = JSON.parse(text);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
