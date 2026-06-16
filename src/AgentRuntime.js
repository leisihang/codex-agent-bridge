import {
  AGENT_PROVIDERS,
  createAgentProvider,
  registerAgentProvider,
} from "./core/AgentProviderRegistry.js";

const DEFAULT_PROVIDER = AGENT_PROVIDERS.CODEX_APP_SERVER;

export { AGENT_PROVIDERS, registerAgentProvider };

export class AgentRuntime {
  constructor(options = {}) {
    this.providerId = options.provider ?? DEFAULT_PROVIDER;
    this.provider = createAgentProvider(this.providerId, options);
  }

  onEvent(handler) {
    return this.provider.onEvent(handler);
  }

  async start(request = {}) {
    await this.provider.start(request);
  }

  async startSession(request) {
    return await this.provider.startSession(request);
  }

  async sendMessage(request) {
    return await this.provider.sendMessage(request);
  }

  async interrupt(request = {}) {
    await this.provider.interrupt(request);
  }

  getStatus() {
    return this.provider.getStatus();
  }

  async setMode(request) {
    return await this.provider.setMode(request);
  }

  async listSessions(request = {}) {
    return await this.provider.listSessions(request);
  }

  async resumeSession(request) {
    return await this.provider.resumeSession(request);
  }

  stop(request = {}) {
    this.provider.stop(request);
  }
}
