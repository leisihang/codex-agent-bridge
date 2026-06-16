import { JsonLineRpcProcessClient } from "./core/JsonLineRpcProcessClient.js";

export class CodexAppServerClient extends JsonLineRpcProcessClient {
  constructor(options = {}) {
    super({
      ...options,
      args: options.args ?? ["app-server", "--listen", "stdio://"],
      command: options.codexBin ?? options.command ?? "codex",
      name: "codex app-server",
    });
  }
}
