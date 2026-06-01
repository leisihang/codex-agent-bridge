import { CodexAppServerClient } from "./CodexAppServerClient.js";

export class CodexAgentManager {
  constructor(options = {}) {
    this.client = new CodexAppServerClient(options);
    this.threadId = null;
    this.currentTurnId = null;
    this.completedTurns = new Map();
    this.lastDiff = "";
    this.eventHandlers = new Set();

    this.client.on("notification", (event) => this.handleNotification(event));
    this.client.on("serverRequest", (request) => this.handleServerRequest(request));
  }

  onEvent(handler) {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  async start() {
    this.client.start();
    return this.client.request("initialize", {
      clientInfo: {
        name: "codex-agent-bridge",
        title: "Codex Agent Bridge",
        version: "0.0.1",
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    });
  }

  stop() {
    this.client.stop();
  }

  async startThread({ cwd, model = null, approvalPolicy = "untrusted", sandbox = "workspace-write" } = {}) {
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
      serviceName: "codex-agent-bridge",
      baseInstructions: null,
      developerInstructions: null,
      personality: null,
      ephemeral: true,
      sessionStartSource: null,
      threadSource: null,
      environments: null,
      dynamicTools: null,
      mockExperimentalField: null,
      experimentalRawEvents: false,
      persistExtendedHistory: false,
    });

    this.threadId = response.thread.id;
    return response;
  }

  async startTurn(prompt, { cwd = null } = {}) {
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
      approvalPolicy: null,
      approvalsReviewer: null,
      sandboxPolicy: null,
      permissions: null,
      model: null,
      serviceTier: null,
      effort: null,
      summary: null,
      personality: null,
      outputSchema: null,
      collaborationMode: null,
    });

    this.currentTurnId = response.turn.id;
    return response;
  }

  async startTurnAndWait(prompt, options = {}) {
    const response = await this.startTurn(prompt, options);
    const completedTurn = await this.waitForTurnCompleted(response.turn.id, options.timeoutMs);
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
    return this.client.request("turn/interrupt", {
      threadId: this.threadId,
      turnId: this.currentTurnId,
    });
  }

  emitEvent(event) {
    for (const handler of this.eventHandlers) {
      handler(event);
    }
  }

  handleNotification(event) {
    if (event.method === "turn/diff/updated") {
      this.lastDiff = event.params.diff;
    }
    if (event.method === "turn/completed") {
      this.currentTurnId = event.params.turn.id;
      this.completedTurns.set(event.params.turn.id, event.params.turn);
    }
    this.emitEvent({ type: "notification", ...event });
  }

  handleServerRequest(request) {
    this.emitEvent({ type: "serverRequest", ...request });

    // The PoC records approval requests but denies them by default. A real
    // Electron UI should surface these to the user and call respond().
    if (request.method === "item/commandExecution/requestApproval") {
      this.client.respond(request.id, { decision: "decline" });
      return;
    }
    if (request.method === "item/fileChange/requestApproval") {
      this.client.respond(request.id, { decision: "decline" });
      return;
    }

    this.client.respond(request.id, {});
  }
}
