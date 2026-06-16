import { CodexAppServerClient } from "./CodexAppServerClient.js";
import { CodexFlowGuard } from "./flow/CodexFlowGuard.js";

export const CODEX_AGENT_MODES = {
  GENERAL_ASSISTANT: "general_assistant",
  FLOW_GUARDED_DESIGN: "flow_guarded_design",
};

function normalizeMode(mode) {
  if (mode === CODEX_AGENT_MODES.FLOW_GUARDED_DESIGN) {
    return CODEX_AGENT_MODES.FLOW_GUARDED_DESIGN;
  }
  return CODEX_AGENT_MODES.GENERAL_ASSISTANT;
}

function isObject(value) {
  return typeof value === "object" && value !== null;
}

function readNestedString(value, keys) {
  let current = value;
  for (const [index, key] of keys.entries()) {
    if (!isObject(current)) {
      return null;
    }
    current = current[key];
    if (index === keys.length - 1) {
      return typeof current === "string" ? current : null;
    }
  }
  return null;
}

function readFirstString(value, paths) {
  for (const path of paths) {
    const result = readNestedString(value, path);
    if (result) return result;
  }
  return null;
}

export class CodexAgentManager {
  constructor(options = {}) {
    const {
      approvalPolicy = "untrusted",
      clientInfo = {
        name: "codex-agent-bridge",
        title: "Codex Agent Bridge",
        version: "0.0.1",
      },
      defaultApprovalResponse = { decision: "decline" },
      flowGuard = null,
      flowGuardOptions = {},
      mode = flowGuard
        ? CODEX_AGENT_MODES.FLOW_GUARDED_DESIGN
        : CODEX_AGENT_MODES.GENERAL_ASSISTANT,
      sandbox = "workspace-write",
      serviceName = "codex-agent-bridge",
      ...clientOptions
    } = options;

    this.client = new CodexAppServerClient(clientOptions);
    this.approvalPolicy = approvalPolicy;
    this.clientInfo = clientInfo;
    this.defaultApprovalResponse = defaultApprovalResponse;
    this.flowGuardOptions = flowGuardOptions;
    this.initialized = false;
    this.mode = normalizeMode(mode);
    this.flowGuard = flowGuard ?? (this.mode === CODEX_AGENT_MODES.FLOW_GUARDED_DESIGN
      ? new CodexFlowGuard(flowGuardOptions)
      : null);
    this.sandbox = sandbox;
    this.serviceName = serviceName;
    this.threadId = null;
    this.threadCwd = null;
    this.currentTurnId = null;
    this.completedTurns = new Map();
    this.lastDiff = "";
    this.eventHandlers = new Set();

    this.client.on("notification", (event) => this.handleNotification(event));
    this.client.on("serverRequest", (request) => this.handleServerRequest(request));
    this.client.on("stderr", (message) => this.emitEvent({ type: "stderr", message }));
    this.client.on("protocolError", ({ error, line }) => {
      this.emitEvent({ type: "protocolError", error, line });
    });
    this.client.on("exit", ({ code, signal }) => {
      this.initialized = false;
      this.threadId = null;
      this.threadCwd = null;
      this.currentTurnId = null;
      this.flowGuard = null;
      this.emitEvent({ type: "exit", code, signal });
    });
  }

  onEvent(handler) {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  async start() {
    this.client.start();
    if (this.initialized) {
      return null;
    }

    const response = await this.client.request("initialize", {
      clientInfo: this.clientInfo,
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    });
    this.initialized = true;
    return response;
  }

  async initialize() {
    return this.start();
  }

  stop() {
    this.client.stop();
    this.initialized = false;
    this.threadId = null;
    this.threadCwd = null;
    this.currentTurnId = null;
    this.flowGuard = null;
  }

  setFlowGuard(flowGuard) {
    this.flowGuard = flowGuard;
    this.mode = flowGuard
      ? CODEX_AGENT_MODES.FLOW_GUARDED_DESIGN
      : CODEX_AGENT_MODES.GENERAL_ASSISTANT;
    this.emitEvent({ type: "modeChanged", status: this.getStatus() });
  }

  setMode(mode, options = {}) {
    this.mode = normalizeMode(mode);

    if (this.mode === CODEX_AGENT_MODES.FLOW_GUARDED_DESIGN) {
      const projectRoot =
        options.projectRoot ?? options.cwd ?? this.threadCwd ?? this.flowGuardOptions.projectRoot;
      this.flowGuardOptions = {
        ...this.flowGuardOptions,
        ...options.flowGuardOptions,
        projectRoot,
      };
      this.flowGuard = this.flowGuard ?? new CodexFlowGuard(this.flowGuardOptions);
      if (projectRoot) {
        this.flowGuard.setProjectRoot(projectRoot);
      }
    } else {
      this.flowGuard = null;
    }

    this.emitEvent({ type: "modeChanged", status: this.getStatus() });
  }

  getStatus() {
    return {
      mode: this.mode,
      threadId: this.threadId,
      currentTurnId: this.currentTurnId,
      flowGuard: this.flowGuard?.getSnapshot() ?? null,
    };
  }

  async startThread({
    approvalPolicy = this.approvalPolicy,
    cwd,
    ephemeral = true,
    model = null,
    persistExtendedHistory = false,
    sandbox = this.sandbox,
  } = {}) {
    await this.start();
    this.threadCwd = cwd ?? null;
    if (this.flowGuard && cwd) {
      this.flowGuard.setProjectRoot(cwd);
    }

    const response = await this.client.request("thread/start", {
      model,
      modelProvider: null,
      serviceTier: null,
      cwd,
      runtimeWorkspaceRoots: cwd ? [cwd] : null,
      approvalPolicy,
      approvalsReviewer: null,
      sandbox,
      permissions: null,
      config: null,
      serviceName: this.serviceName,
      baseInstructions: null,
      developerInstructions: null,
      personality: null,
      ephemeral,
      sessionStartSource: null,
      threadSource: null,
      environments: null,
      dynamicTools: null,
      mockExperimentalField: null,
      experimentalRawEvents: false,
      persistExtendedHistory,
    });

    const threadId = readFirstString(response, [
      ["thread", "id"],
      ["threadId"],
      ["id"],
    ]);
    if (!threadId) {
      throw new Error(
        `Codex thread/start response did not include a thread id: ${JSON.stringify(response)}`,
      );
    }
    this.threadId = threadId;
    return response;
  }

  async startTurn(prompt, {
    approvalPolicy = null,
    cwd = null,
    sandboxPolicy = null,
  } = {}) {
    await this.start();
    if (!this.threadId) {
      throw new Error("startThread() must be called before startTurn()");
    }

    const response = await this.client.request("turn/start", {
      threadId: this.threadId,
      input: [{ type: "text", text: prompt, text_elements: [] }],
      responsesapiClientMetadata: null,
      environments: null,
      cwd,
      runtimeWorkspaceRoots: cwd ? [cwd] : null,
      approvalPolicy,
      approvalsReviewer: null,
      sandboxPolicy,
      permissions: null,
      model: null,
      serviceTier: null,
      effort: null,
      summary: null,
      personality: null,
      outputSchema: null,
      collaborationMode: null,
    });

    const turnId = readFirstString(response, [
      ["turn", "id"],
      ["turnId"],
      ["id"],
    ]);
    if (!turnId) {
      throw new Error(
        `Codex turn/start response did not include a turn id: ${JSON.stringify(response)}`,
      );
    }
    this.currentTurnId = turnId;
    return response;
  }

  async listThreads({
    archived = false,
    cursor = null,
    cwd = null,
    limit = 20,
    modelProviders = null,
    searchTerm = null,
    sourceKinds = ["appServer", "vscode", "cli"],
    useStateDbOnly = false,
  } = {}) {
    await this.start();
    return this.client.request("thread/list", {
      cursor,
      limit,
      sortKey: "updated_at",
      sortDirection: "desc",
      modelProviders,
      sourceKinds,
      archived,
      cwd,
      useStateDbOnly,
      searchTerm,
    });
  }

  async resumeThread({
    approvalPolicy = this.approvalPolicy,
    cwd = null,
    persistExtendedHistory = false,
    sandbox = this.sandbox,
    threadId,
  } = {}) {
    await this.start();
    const response = await this.client.request("thread/resume", {
      threadId,
      history: null,
      path: null,
      model: null,
      modelProvider: null,
      serviceTier: null,
      cwd,
      runtimeWorkspaceRoots: cwd ? [cwd] : null,
      approvalPolicy,
      approvalsReviewer: null,
      sandbox,
      permissions: null,
      config: null,
      baseInstructions: null,
      developerInstructions: null,
      personality: null,
      excludeTurns: false,
      persistExtendedHistory,
    });

    this.threadId = readFirstString(response, [
      ["thread", "id"],
      ["threadId"],
      ["id"],
    ]) ?? threadId;
    this.threadCwd = cwd ?? this.threadCwd;
    this.currentTurnId = null;
    if (this.flowGuard && cwd) {
      this.flowGuard.setProjectRoot(cwd);
    }
    return response;
  }

  async startTurnAndWait(prompt, options = {}) {
    const response = await this.startTurn(prompt, options);
    const completedTurn = await this.waitForTurnCompleted(
      response.turn.id,
      options.timeoutMs,
    );
    return { response, completedTurn };
  }

  waitForTurnCompleted(turnId, timeoutMs = 180000) {
    const completed = this.completedTurns.get(turnId);
    if (completed) {
      return Promise.resolve(completed);
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        unsubscribe();
        reject(new Error(`Timed out waiting for turn ${turnId} to complete`));
      }, timeoutMs);

      const unsubscribe = this.onEvent((event) => {
        if (
          event.type === "notification" &&
          event.method === "turn/completed" &&
          event.params.turn.id === turnId
        ) {
          clearTimeout(timeout);
          unsubscribe();
          resolve(event.params.turn);
        }
      });
    });
  }

  async interruptTurn() {
    if (!this.threadId || !this.currentTurnId) {
      return null;
    }
    const response = await this.client.request("turn/interrupt", {
      threadId: this.threadId,
      turnId: this.currentTurnId,
    });
    this.currentTurnId = null;
    return response;
  }

  emitEvent(event) {
    for (const handler of this.eventHandlers) {
      handler(event);
    }
  }

  handleNotification(event) {
    this.flowGuard?.onNotification(event);

    if (event.method === "turn/diff/updated") {
      this.lastDiff = event.params.diff;
    }
    if (event.method === "turn/completed") {
      this.completedTurns.set(event.params.turn.id, event.params.turn);
      this.currentTurnId = null;
    }
    this.emitEvent({ type: "notification", ...event });
  }

  handleServerRequest(request) {
    this.emitEvent({ type: "serverRequest", ...request });

    if (request.method === "item/commandExecution/requestApproval") {
      const result = this.flowGuard?.authorizeCommandRequest(request.params) ?? {
        response: this.defaultApprovalResponse,
      };
      this.emitEvent({
        type: "flowGuardDecision",
        method: request.method,
        params: request.params,
        result,
      });
      this.client.respond(request.id, result.response);
      return;
    }
    if (request.method === "item/fileChange/requestApproval") {
      const result = this.flowGuard?.authorizeFileChangeRequest(request.params) ?? {
        response: this.defaultApprovalResponse,
      };
      this.emitEvent({
        type: "flowGuardDecision",
        method: request.method,
        params: request.params,
        result,
      });
      this.client.respond(request.id, result.response);
      return;
    }

    this.client.respond(request.id, {});
  }
}
