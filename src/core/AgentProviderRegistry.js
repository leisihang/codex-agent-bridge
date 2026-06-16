import { CodexAppServerProvider } from "../providers/codex/CodexAppServerProvider.js";

export const AGENT_PROVIDERS = {
  CODEX_APP_SERVER: "codex_app_server",
};

const providerFactories = new Map([
  [
    AGENT_PROVIDERS.CODEX_APP_SERVER,
    (options) => new CodexAppServerProvider(options),
  ],
]);

export function createAgentProvider(providerId, options = {}) {
  const factory = providerFactories.get(providerId);
  if (!factory) {
    throw new Error(`Unsupported agent provider: ${providerId}`);
  }
  return factory({
    ...options,
    provider: providerId,
  });
}

export function registerAgentProvider(providerId, factory) {
  if (!providerId || typeof providerId !== "string") {
    throw new Error("Provider id must be a non-empty string.");
  }
  if (typeof factory !== "function") {
    throw new Error(`Provider factory for ${providerId} must be a function.`);
  }
  providerFactories.set(providerId, factory);
}
