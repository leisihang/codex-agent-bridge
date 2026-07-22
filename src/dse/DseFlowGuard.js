export const DSE_CANDIDATE_STATES = {
  CREATED: "created",
  EARLY_RUNNING: "early_running",
  EARLY_DONE: "early_done",
  AGENT_REVIEW_PENDING: "agent_review_pending",
  FULL_READY: "full_ready",
  FULL_RUNNING: "full_running",
  FULL_DONE: "full_done",
  PRUNED: "pruned",
  BRANCHED: "branched",
  TERMINATED: "terminated",
  FAILED: "failed",
  ARCHIVED: "archived",
};

export const DSE_TRANSITIONS = {
  LAUNCH_EARLY: "launch_early",
  EARLY_SUCCEEDED: "early_succeeded",
  EARLY_FAILED: "early_failed",
  REQUEST_AGENT_REVIEW: "request_agent_review",
  AGENT_CONTINUE: "agent_continue",
  AGENT_PRUNE: "agent_prune",
  AGENT_BRANCH: "agent_branch",
  AGENT_TERMINATE: "agent_terminate",
  LAUNCH_FULL: "launch_full",
  FULL_SUCCEEDED: "full_succeeded",
  FULL_FAILED: "full_failed",
  ARCHIVE: "archive",
};

export const DSE_AGENT_ACTIONS = {
  CONTINUE: "continue",
  PRUNE: "prune",
  BRANCH_RERUN: "branch_rerun",
  TERMINATE: "terminate",
};

export const DEFAULT_DSE_PARAMETER_SCHEMA = {
  CORE_UTILIZATION: { type: "number", min: 20, max: 95 },
  PLACE_DENSITY_LB_ADDON: { type: "number", min: 0, max: 0.9 },
  GPL_TIMING_DRIVEN: { type: "boolean" },
  GPL_ROUTABILITY_DRIVEN: { type: "boolean" },
};

const TERMINAL_STATES = new Set([
  DSE_CANDIDATE_STATES.FULL_DONE,
  DSE_CANDIDATE_STATES.PRUNED,
  DSE_CANDIDATE_STATES.BRANCHED,
  DSE_CANDIDATE_STATES.TERMINATED,
  DSE_CANDIDATE_STATES.FAILED,
]);

const TRANSITION_TABLE = {
  [DSE_TRANSITIONS.LAUNCH_EARLY]: {
    from: [DSE_CANDIDATE_STATES.CREATED],
    to: DSE_CANDIDATE_STATES.EARLY_RUNNING,
  },
  [DSE_TRANSITIONS.EARLY_SUCCEEDED]: {
    from: [DSE_CANDIDATE_STATES.EARLY_RUNNING],
    to: DSE_CANDIDATE_STATES.EARLY_DONE,
  },
  [DSE_TRANSITIONS.EARLY_FAILED]: {
    from: [DSE_CANDIDATE_STATES.EARLY_RUNNING],
    to: DSE_CANDIDATE_STATES.FAILED,
  },
  [DSE_TRANSITIONS.REQUEST_AGENT_REVIEW]: {
    from: [DSE_CANDIDATE_STATES.EARLY_DONE],
    to: DSE_CANDIDATE_STATES.AGENT_REVIEW_PENDING,
  },
  [DSE_TRANSITIONS.AGENT_CONTINUE]: {
    from: [DSE_CANDIDATE_STATES.AGENT_REVIEW_PENDING],
    to: DSE_CANDIDATE_STATES.FULL_READY,
  },
  [DSE_TRANSITIONS.AGENT_PRUNE]: {
    from: [DSE_CANDIDATE_STATES.AGENT_REVIEW_PENDING],
    to: DSE_CANDIDATE_STATES.PRUNED,
  },
  [DSE_TRANSITIONS.AGENT_BRANCH]: {
    from: [DSE_CANDIDATE_STATES.AGENT_REVIEW_PENDING],
    to: DSE_CANDIDATE_STATES.BRANCHED,
  },
  [DSE_TRANSITIONS.AGENT_TERMINATE]: {
    from: [DSE_CANDIDATE_STATES.AGENT_REVIEW_PENDING],
    to: DSE_CANDIDATE_STATES.TERMINATED,
  },
  [DSE_TRANSITIONS.LAUNCH_FULL]: {
    from: [DSE_CANDIDATE_STATES.FULL_READY],
    to: DSE_CANDIDATE_STATES.FULL_RUNNING,
  },
  [DSE_TRANSITIONS.FULL_SUCCEEDED]: {
    from: [DSE_CANDIDATE_STATES.FULL_RUNNING],
    to: DSE_CANDIDATE_STATES.FULL_DONE,
  },
  [DSE_TRANSITIONS.FULL_FAILED]: {
    from: [DSE_CANDIDATE_STATES.FULL_RUNNING],
    to: DSE_CANDIDATE_STATES.FAILED,
  },
  [DSE_TRANSITIONS.ARCHIVE]: {
    from: [...TERMINAL_STATES],
    to: DSE_CANDIDATE_STATES.ARCHIVED,
  },
};

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function nowIso() {
  return new Date().toISOString();
}

function accept(reason, extra = {}) {
  return { decision: "accept", reason, ...extra };
}

function decline(reason, extra = {}) {
  return { decision: "decline", reason, ...extra };
}

function normalizeCandidateId(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("DSE candidate id must be a non-empty string.");
  }
  return value.trim();
}

function normalizeAgentAction(action) {
  if (action === DSE_AGENT_ACTIONS.CONTINUE) return DSE_AGENT_ACTIONS.CONTINUE;
  if (action === DSE_AGENT_ACTIONS.PRUNE) return DSE_AGENT_ACTIONS.PRUNE;
  if (action === DSE_AGENT_ACTIONS.BRANCH_RERUN) return DSE_AGENT_ACTIONS.BRANCH_RERUN;
  if (action === DSE_AGENT_ACTIONS.TERMINATE) return DSE_AGENT_ACTIONS.TERMINATE;
  return null;
}

function validateParameterValue(name, value, rule) {
  if (!isObject(rule)) {
    return accept(`Parameter ${name} has no schema rule.`);
  }

  if (rule.type === "number") {
    if (typeof value !== "number" || Number.isNaN(value)) {
      return decline(`Parameter ${name} must be a number.`);
    }
    if (typeof rule.min === "number" && value < rule.min) {
      return decline(`Parameter ${name}=${value} is below min ${rule.min}.`);
    }
    if (typeof rule.max === "number" && value > rule.max) {
      return decline(`Parameter ${name}=${value} is above max ${rule.max}.`);
    }
    return accept(`Parameter ${name} is valid.`);
  }

  if (rule.type === "boolean") {
    if (typeof value !== "boolean" && value !== 0 && value !== 1) {
      return decline(`Parameter ${name} must be boolean-like.`);
    }
    return accept(`Parameter ${name} is valid.`);
  }

  if (rule.type === "enum") {
    const values = Array.isArray(rule.values) ? rule.values : [];
    if (!values.includes(value)) {
      return decline(`Parameter ${name} must be one of ${values.join(", ")}.`);
    }
    return accept(`Parameter ${name} is valid.`);
  }

  return accept(`Parameter ${name} uses unchecked schema type ${rule.type}.`);
}

export class DseFlowGuard {
  constructor(options = {}) {
    this.allowBranch = options.allowBranch ?? true;
    this.maxBranchDepth = options.maxBranchDepth ?? 1;
    this.maxCandidates = options.maxCandidates ?? 32;
    this.parameterSchema = {
      ...DEFAULT_DSE_PARAMETER_SCHEMA,
      ...(options.parameterSchema ?? {}),
    };
    this.experiment = null;
    this.candidates = new Map();
    this.events = [];
  }

  createExperiment({ id, objective = "ECP", metadata = {} } = {}) {
    const experimentId = id ?? `dse_${Date.now()}`;
    this.experiment = {
      id: experimentId,
      objective,
      metadata: cloneJson(metadata),
      status: "running",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.recordEvent("experiment_created", { experimentId, objective, metadata });
    return this.getSnapshot();
  }

  registerCandidate(candidate) {
    if (!this.experiment) {
      throw new Error("createExperiment() must be called before registerCandidate().");
    }
    if (this.candidates.size >= this.maxCandidates) {
      throw new Error(`DSE maxCandidates=${this.maxCandidates} exceeded.`);
    }

    const id = normalizeCandidateId(candidate.id);
    if (this.candidates.has(id)) {
      throw new Error(`DSE candidate already exists: ${id}`);
    }

    const params = cloneJson(candidate.params ?? {});
    const validation = this.validateParameters(params);
    if (validation.decision !== "accept") {
      throw new Error(validation.reason);
    }

    const now = nowIso();
    const entry = {
      id,
      parentId: candidate.parentId ?? null,
      branchDepth: candidate.branchDepth ?? 0,
      params,
      metrics: {},
      agentDecision: null,
      status: DSE_CANDIDATE_STATES.CREATED,
      createdAt: now,
      updatedAt: now,
      reason: candidate.reason ?? null,
    };
    this.candidates.set(id, entry);
    this.recordEvent("candidate_registered", { candidate: cloneJson(entry) });
    return cloneJson(entry);
  }

  getCandidate(candidateId) {
    const candidate = this.candidates.get(candidateId);
    return candidate ? cloneJson(candidate) : null;
  }

  getAllowedAgentActions(candidateId) {
    const candidate = this.candidates.get(candidateId);
    if (!candidate || candidate.status !== DSE_CANDIDATE_STATES.AGENT_REVIEW_PENDING) {
      return [];
    }

    const actions = [
      DSE_AGENT_ACTIONS.CONTINUE,
      DSE_AGENT_ACTIONS.PRUNE,
      DSE_AGENT_ACTIONS.TERMINATE,
    ];
    if (this.allowBranch && candidate.branchDepth < this.maxBranchDepth) {
      actions.push(DSE_AGENT_ACTIONS.BRANCH_RERUN);
    }
    return actions;
  }

  validateParameters(params = {}) {
    if (!isObject(params)) {
      return decline("DSE parameters must be an object.");
    }

    for (const [name, value] of Object.entries(params)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        return decline(`Parameter name is not safe: ${name}`);
      }
      const rule = this.parameterSchema[name];
      if (!rule) {
        return decline(`Parameter ${name} is not allowed by the DSE schema.`);
      }
      const result = validateParameterValue(name, value, rule);
      if (result.decision !== "accept") {
        return result;
      }
    }

    return accept("DSE parameters are valid.");
  }

  authorizeTransition(candidateId, transition) {
    const candidate = this.candidates.get(candidateId);
    if (!candidate) {
      return decline(`Unknown DSE candidate: ${candidateId}`, { transition });
    }

    const rule = TRANSITION_TABLE[transition];
    if (!rule) {
      return decline(`Unknown DSE transition: ${transition}`, { candidateId, transition });
    }

    if (!rule.from.includes(candidate.status)) {
      return decline(
        `Cannot apply ${transition} while candidate ${candidateId} is ${candidate.status}.`,
        { candidateId, transition, status: candidate.status },
      );
    }

    return accept(`DSE transition ${transition} is allowed.`, {
      candidateId,
      from: candidate.status,
      to: rule.to,
      transition,
    });
  }

  transition(candidateId, transition, payload = {}) {
    const authorization = this.authorizeTransition(candidateId, transition);
    if (authorization.decision !== "accept") {
      this.recordEvent("transition_declined", { candidateId, transition, authorization });
      return authorization;
    }

    const candidate = this.candidates.get(candidateId);
    candidate.status = TRANSITION_TABLE[transition].to;
    candidate.updatedAt = nowIso();
    if (typeof payload.reason === "string") {
      candidate.reason = payload.reason;
    }
    this.recordEvent("candidate_transition", {
      candidateId,
      transition,
      from: authorization.from,
      to: authorization.to,
      payload,
    });
    return authorization;
  }

  validateAgentDecision(candidateId, decision) {
    const candidate = this.candidates.get(candidateId);
    if (!candidate) {
      return decline(`Unknown DSE candidate: ${candidateId}`);
    }
    if (candidate.status !== DSE_CANDIDATE_STATES.AGENT_REVIEW_PENDING) {
      return decline(`Candidate ${candidateId} is not waiting for agent review.`);
    }
    if (!isObject(decision)) {
      return decline("Agent decision must be an object.");
    }

    const action = normalizeAgentAction(decision.action);
    if (!action) {
      return decline(`Unsupported DSE agent action: ${decision.action}`);
    }

    const allowedActions = this.getAllowedAgentActions(candidateId);
    if (!allowedActions.includes(action)) {
      return decline(`Agent action ${action} is not allowed in current DSE state.`, {
        allowedActions,
      });
    }

    if (action === DSE_AGENT_ACTIONS.BRANCH_RERUN) {
      const overrides = decision.parameter_overrides ?? decision.parameterOverrides ?? {};
      const merged = { ...candidate.params, ...overrides };
      const validation = this.validateParameters(merged);
      if (validation.decision !== "accept") {
        return validation;
      }
    }

    return accept(`Agent action ${action} is allowed.`, { action, allowedActions });
  }

  applyAgentDecision(candidateId, decision) {
    const validation = this.validateAgentDecision(candidateId, decision);
    if (validation.decision !== "accept") {
      this.recordEvent("agent_decision_declined", { candidateId, decision, validation });
      return validation;
    }

    const candidate = this.candidates.get(candidateId);
    candidate.agentDecision = cloneJson(decision);
    candidate.updatedAt = nowIso();
    this.recordEvent("agent_decision_accepted", { candidateId, decision });

    const transitionByAction = {
      [DSE_AGENT_ACTIONS.CONTINUE]: DSE_TRANSITIONS.AGENT_CONTINUE,
      [DSE_AGENT_ACTIONS.PRUNE]: DSE_TRANSITIONS.AGENT_PRUNE,
      [DSE_AGENT_ACTIONS.BRANCH_RERUN]: DSE_TRANSITIONS.AGENT_BRANCH,
      [DSE_AGENT_ACTIONS.TERMINATE]: DSE_TRANSITIONS.AGENT_TERMINATE,
    };

    return this.transition(candidateId, transitionByAction[validation.action], {
      reason: decision.reason ?? `Agent selected ${validation.action}.`,
    });
  }

  updateMetrics(candidateId, stage, metrics) {
    const candidate = this.candidates.get(candidateId);
    if (!candidate) {
      throw new Error(`Unknown DSE candidate: ${candidateId}`);
    }
    candidate.metrics[stage] = cloneJson(metrics ?? {});
    candidate.updatedAt = nowIso();
    this.recordEvent("candidate_metrics_updated", { candidateId, stage, metrics });
    return cloneJson(candidate.metrics);
  }

  archiveCandidate(candidateId, reason = null) {
    const result = this.transition(candidateId, DSE_TRANSITIONS.ARCHIVE, { reason });
    return result;
  }

  completeExperiment(status = "completed") {
    if (!this.experiment) {
      throw new Error("No DSE experiment is active.");
    }
    this.experiment.status = status;
    this.experiment.updatedAt = nowIso();
    this.recordEvent("experiment_completed", { status });
    return this.getSnapshot();
  }

  recordEvent(type, payload = {}) {
    const event = {
      type,
      time: nowIso(),
      payload: cloneJson(payload),
    };
    this.events.push(event);
    if (this.experiment) {
      this.experiment.updatedAt = event.time;
    }
    return event;
  }

  getSnapshot() {
    const candidates = {};
    for (const [id, candidate] of this.candidates.entries()) {
      candidates[id] = cloneJson(candidate);
    }
    return {
      experiment: this.experiment ? cloneJson(this.experiment) : null,
      candidates,
      events: cloneJson(this.events),
      limits: {
        allowBranch: this.allowBranch,
        maxBranchDepth: this.maxBranchDepth,
        maxCandidates: this.maxCandidates,
      },
      parameterSchema: cloneJson(this.parameterSchema),
    };
  }
}
