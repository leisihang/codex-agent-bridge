import { CodexAgentManager, CODEX_AGENT_MODES } from "../../CodexAgentManager.js";

const DEFAULT_PROVIDER = "codex_app_server";

function isObject(value) {
  return typeof value === "object" && value !== null;
}

function readString(value, key) {
  if (!isObject(value)) return null;
  const result = value[key];
  return typeof result === "string" ? result : null;
}

function readNumber(value, key) {
  if (!isObject(value)) return null;
  const result = value[key];
  return typeof result === "number" ? result : null;
}

function getArray(value, key) {
  if (!isObject(value)) return [];
  const result = value[key];
  return Array.isArray(result) ? result : [];
}

function readNestedString(value, keys) {
  let current = value;
  for (const [index, key] of keys.entries()) {
    if (!isObject(current)) return null;
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

function normalizeMode(mode) {
  if (mode === CODEX_AGENT_MODES.FLOW_GUARDED_DESIGN) {
    return CODEX_AGENT_MODES.FLOW_GUARDED_DESIGN;
  }
  return CODEX_AGENT_MODES.GENERAL_ASSISTANT;
}

function normalizeFlowGuardStatus(snapshot) {
  if (!isObject(snapshot)) return null;
  const steps = {};
  if (isObject(snapshot.steps)) {
    for (const [key, value] of Object.entries(snapshot.steps)) {
      if (!isObject(value)) continue;
      steps[key] = {
        id: readString(value, "id") ?? key,
        reason: readString(value, "reason"),
        status: readString(value, "status") ?? "unknown",
        updatedAt: readNumber(value, "updatedAt") ?? 0,
      };
    }
  }
  return {
    activeStep: readString(snapshot, "activeStep"),
    projectRoot: readString(snapshot, "projectRoot"),
    steps,
  };
}

function readItem(params) {
  if (!isObject(params)) return null;
  const item = params.item;
  return isObject(item) ? item : null;
}

function formatJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatCommandBlock(item, status, streamedOutput = null) {
  const command = readString(item, "command") ?? "(command unavailable)";
  const cwd = readString(item, "cwd");
  const output = streamedOutput ?? readString(item, "aggregatedOutput");
  const exitCode = readNumber(item, "exitCode");
  const statusLabel = status === "started" ? "running" : readString(item, "status") ?? status;
  const lines = [`**Command ${statusLabel}**`, "```bash", command, "```"];

  if (cwd) lines.push(`cwd: \`${cwd}\``);
  if (exitCode !== null) lines.push(`exit: \`${exitCode}\``);
  if (output) lines.push("", "```text", output.trimEnd(), "```");
  return lines.join("\n");
}

function formatFileChangeBlock(item, status) {
  const changes = getArray(item, "changes");
  const statusLabel = readString(item, "status") ?? status;
  const lines = [`**File change ${statusLabel}**`];

  if (changes.length > 0) {
    for (const change of changes) {
      if (!isObject(change)) continue;
      const filePath = readString(change, "path") ?? "(unknown path)";
      const kind = readString(change, "kind");
      const diff = readString(change, "diff");
      lines.push("", `${kind ? `${kind}: ` : ""}\`${filePath}\``);
      if (diff) lines.push("```diff", diff.trimEnd(), "```");
    }
  } else {
    lines.push("", "No file diff was provided by the agent.");
  }
  return lines.join("\n");
}

function extractTextInputs(content) {
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      if (!isObject(item)) return "";
      if (item.type === "text" && typeof item.text === "string") return item.text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function formatCommandHistory(item) {
  return formatCommandBlock(item, "completed");
}

function formatFileChangeHistory(item) {
  return formatFileChangeBlock(item, "completed");
}

function extractMessagesFromThread(thread) {
  const messages = [];
  for (const turn of getArray(thread, "turns")) {
    for (const item of getArray(turn, "items")) {
      if (!isObject(item)) continue;
      if (item.type === "userMessage") {
        const text = extractTextInputs(item.content);
        if (text) messages.push({ role: "user", content: text });
        continue;
      }
      if (item.type === "agentMessage") {
        const text = readString(item, "text");
        if (text) messages.push({ role: "assistant", content: text });
        continue;
      }
      if (item.type === "commandExecution") {
        messages.push({ role: "assistant", content: formatCommandHistory(item) });
        continue;
      }
      if (item.type === "fileChange") {
        messages.push({ role: "assistant", content: formatFileChangeHistory(item) });
      }
    }
  }
  return messages;
}

function mapThreadSummary(thread) {
  if (!isObject(thread)) return null;
  const id = readString(thread, "id") ?? "";
  if (!id) return null;

  return {
    id,
    cwd: readString(thread, "cwd") ?? "",
    preview: readString(thread, "preview") ?? "",
    createdAt: readNumber(thread, "createdAt") ?? 0,
    updatedAt: readNumber(thread, "updatedAt") ?? 0,
    name: readString(thread, "name"),
  };
}

export class CodexAppServerProvider {
  constructor(options = {}) {
    this.provider = options.provider ?? DEFAULT_PROVIDER;
    this.mode = normalizeMode(options.mode);
    this.projectRoot = null;
    this.eventHandlers = new Set();
    this.activeCommandOutputs = new Map();
    this.manager = new CodexAgentManager({
      approvalPolicy: options.approvalPolicy ?? "untrusted",
      clientInfo: options.clientInfo ?? {
        name: "codex-app-server-provider",
        title: "Codex App Server Provider",
        version: "0.0.1",
      },
      defaultApprovalResponse: options.defaultApprovalResponse ?? { decision: "accept" },
      env: options.env ?? process.env,
      sandbox: options.sandbox ?? "workspace-write",
      serviceName: options.serviceName ?? "agent-runtime",
    });

    this.manager.onEvent((event) => this.handleManagerEvent(event));
    this.ensureMode();
  }

  onEvent(handler) {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  async start() {
    await this.manager.start();
  }

  async startSession({ cwd }) {
    const response = await this.manager.startThread({
      cwd,
      ephemeral: false,
      persistExtendedHistory: false,
    });
    this.projectRoot = cwd ?? null;
    this.ensureMode();
    this.emitStatus();
    return {
      provider: this.provider,
      sessionId: readFirstString(response, [["thread", "id"], ["threadId"], ["id"]]),
    };
  }

  async sendMessage({ cwd = null, mode = null, prompt }) {
    if (mode) {
      this.mode = normalizeMode(mode);
      this.ensureMode();
      this.emitStatus();
    }
    if (!this.manager.getStatus().threadId) {
      if (!cwd) {
        throw new Error("Agent session has not been started and no cwd was provided.");
      }
      await this.startSession({ cwd });
    }
    const response = await this.manager.startTurn(prompt, {
      cwd,
      sandboxPolicy: cwd
        ? {
            type: "workspaceWrite",
            writableRoots: [cwd],
            networkAccess: false,
            excludeTmpdirEnvVar: false,
            excludeSlashTmp: false,
          }
        : null,
    });
    this.emitStatus();
    return {
      messageId: readFirstString(response, [["turn", "id"], ["turnId"], ["id"]]),
      provider: this.provider,
    };
  }

  async interrupt() {
    await this.manager.interruptTurn();
    this.emitStatus();
  }

  getStatus() {
    const status = this.manager.getStatus();
    return {
      activeTurnId: status.currentTurnId,
      flowGuard: normalizeFlowGuardStatus(status.flowGuard),
      mode: this.mode,
      provider: this.provider,
      threadId: status.threadId,
    };
  }

  async setMode({ cwd = null, mode }) {
    this.mode = normalizeMode(mode);
    this.projectRoot = cwd ?? this.projectRoot;
    this.ensureMode();
    if (cwd && !this.manager.getStatus().threadId) {
      await this.startSession({ cwd });
    }
    this.emitStatus();
    return this.getStatus();
  }

  async listSessions({ cwd = null, limit = 20 } = {}) {
    const response = await this.manager.listThreads({ cwd, limit });
    return {
      sessions: getArray(response, "data")
        .map(mapThreadSummary)
        .filter((thread) => thread !== null)
        .map((thread) => ({ ...thread, provider: this.provider })),
    };
  }

  async resumeSession({ cwd = null, sessionId }) {
    const response = await this.manager.resumeThread({
      cwd,
      threadId: sessionId,
    });
    this.projectRoot = cwd ?? this.projectRoot;
    this.ensureMode();
    this.emitStatus();
    return {
      messages: extractMessagesFromThread(isObject(response) ? response.thread : null),
      provider: this.provider,
      sessionId: this.manager.getStatus().threadId ?? sessionId,
    };
  }

  stop() {
    this.manager.stop();
    this.projectRoot = null;
    this.activeCommandOutputs.clear();
    this.emitStatus();
  }

  ensureMode() {
    this.manager.setMode(this.mode, {
      cwd: this.projectRoot,
      projectRoot: this.projectRoot,
    });
  }

  emit(event) {
    const normalized = { provider: this.provider, ...event };
    for (const handler of this.eventHandlers) {
      handler(normalized);
    }
  }

  emitStatus() {
    this.emit({
      type: "status",
      status: this.getStatus(),
    });
  }

  handleManagerEvent(event) {
    if (event.type === "stderr") {
      this.emit({ type: "stderr", message: event.message });
      return;
    }
    if (event.type === "exit") {
      this.emit({ type: "exit", code: event.code, signal: event.signal });
      this.emitStatus();
      return;
    }
    if (event.type === "modeChanged") {
      this.emitStatus();
      return;
    }
    if (event.type === "flowGuardDecision") {
      this.emit({
        type: "flowGuardDecision",
        decision: event.result,
      });
      this.emitStatus();
      return;
    }
    if (event.type === "serverRequest") {
      this.handleServerRequestEvent(event);
      return;
    }
    if (event.type === "notification") {
      this.handleNotificationEvent(event);
    }
  }

  handleServerRequestEvent(event) {
    if (event.method === "item/commandExecution/requestApproval") {
      this.emit({
        type: "action",
        action: {
          id: readString(event.params, "itemId"),
          kind: "command",
          content: formatCommandBlock(event.params, "approval"),
          status: "running",
        },
      });
      return;
    }
    if (event.method === "item/fileChange/requestApproval") {
      this.emit({
        type: "action",
        action: {
          id: readString(event.params, "itemId"),
          kind: "fileChange",
          content: `**File change approval accepted**\n\n\`\`\`json\n${formatJson(event.params)}\n\`\`\``,
          status: "running",
        },
      });
    }
  }

  handleNotificationEvent(event) {
    if (event.method === "item/agentMessage/delta") {
      const delta = isObject(event.params) && typeof event.params.delta === "string"
        ? event.params.delta
        : "";
      if (delta) this.emit({ type: "messageDelta", delta });
      return;
    }

    if (event.method === "item/started") {
      const item = readItem(event.params);
      const itemId = readString(item, "id");
      if (item?.type === "commandExecution") {
        this.emit({
          type: "action",
          action: {
            id: itemId,
            kind: "command",
            content: formatCommandBlock(item, "started"),
            status: "running",
          },
        });
        return;
      }
      if (item?.type === "fileChange") {
        this.emit({
          type: "action",
          action: {
            id: itemId,
            kind: "fileChange",
            content: formatFileChangeBlock(item, "started"),
            status: "running",
          },
        });
        return;
      }
    }

    if (event.method === "item/commandExecution/outputDelta") {
      const itemId = readString(event.params, "itemId");
      const delta = readString(event.params, "delta");
      if (!delta) return;
      const output = `${this.activeCommandOutputs.get(itemId) ?? ""}${delta}`;
      if (itemId) this.activeCommandOutputs.set(itemId, output);
      this.emit({
        type: "action",
        action: {
          id: itemId,
          kind: "command",
          content: `**Command running**\n\n\`\`\`text\n${output.trimEnd()}\n\`\`\``,
          status: "running",
        },
      });
      return;
    }

    if (event.method === "item/completed") {
      const item = readItem(event.params);
      const itemId = readString(item, "id");
      if (item?.type === "commandExecution") {
        const output = itemId ? this.activeCommandOutputs.get(itemId) : null;
        if (itemId) this.activeCommandOutputs.delete(itemId);
        this.emit({
          type: "action",
          action: {
            id: itemId,
            kind: "command",
            content: formatCommandBlock(item, "completed", output),
            status: "done",
          },
        });
        return;
      }
      if (item?.type === "fileChange") {
        this.emit({
          type: "action",
          action: {
            id: itemId,
            kind: "fileChange",
            content: formatFileChangeBlock(item, "completed"),
            status: "done",
          },
        });
        return;
      }
    }

    if (event.method === "item/fileChange/patchUpdated") {
      this.emit({
        type: "action",
        action: {
          id: readString(event.params, "itemId"),
          kind: "fileChange",
          content: `**File change preview**\n\n\`\`\`json\n${formatJson(event.params)}\n\`\`\``,
          status: "running",
        },
      });
      return;
    }

    if (event.method === "turn/completed") {
      this.emit({ type: "messageCompleted" });
      this.emitStatus();
      return;
    }

    if (event.method === "error") {
      const message = isObject(event.params) && typeof event.params.message === "string"
        ? event.params.message
        : "Agent returned an error.";
      this.emit({ type: "error", message });
    }
  }
}
