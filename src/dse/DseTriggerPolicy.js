import { DSE_AGENT_ACTIONS } from "./DseFlowGuard.js";

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readMetric(metrics, name) {
  if (!isObject(metrics)) return null;
  const value = metrics[name];
  return typeof value === "number" && !Number.isNaN(value) ? value : null;
}

function continueDecision(reason) {
  return {
    action: DSE_AGENT_ACTIONS.CONTINUE,
    reason,
  };
}

export class AlwaysReviewTriggerPolicy {
  shouldReview() {
    return {
      reason: "Always-review trigger policy is enabled.",
      review: true,
    };
  }
}

export class MetricsTriggerPolicy {
  constructor(options = {}) {
    this.congestionAbove = options.congestionAbove ?? 0.85;
    this.enabled = options.enabled ?? true;
    this.tnsBelow = options.tnsBelow ?? null;
    this.wnsBelow = options.wnsBelow ?? -0.05;
  }

  shouldReview({ candidate, allowedActions }) {
    if (!this.enabled) {
      return {
        defaultDecision: continueDecision("Trigger policy disabled; continue without subagent review."),
        reason: "Trigger policy disabled.",
        review: false,
      };
    }

    if (!allowedActions.includes(DSE_AGENT_ACTIONS.CONTINUE)) {
      return {
        reason: "Continue is not available, so subagent review is required.",
        review: true,
      };
    }

    const earlyMetrics = candidate.metrics?.early ?? {};
    const congestion = readMetric(earlyMetrics, "congestion");
    const tns = readMetric(earlyMetrics, "tns");
    const wns = readMetric(earlyMetrics, "wns");

    if (congestion !== null && congestion >= this.congestionAbove) {
      return {
        reason: `congestion=${congestion} >= ${this.congestionAbove}`,
        review: true,
      };
    }

    if (wns !== null && wns < this.wnsBelow) {
      return {
        reason: `wns=${wns} < ${this.wnsBelow}`,
        review: true,
      };
    }

    if (this.tnsBelow !== null && tns !== null && tns < this.tnsBelow) {
      return {
        reason: `tns=${tns} < ${this.tnsBelow}`,
        review: true,
      };
    }

    return {
      defaultDecision: continueDecision("Metrics did not trigger subagent review; continue full flow."),
      reason: "No trigger threshold matched.",
      review: false,
    };
  }
}
