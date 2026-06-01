import { CodexAppServerClient } from "./CodexAppServerClient.js";

const client = new CodexAppServerClient({ cwd: process.cwd() });
client.on("notification", (event) => console.log(JSON.stringify(event)));
client.on("stderr", (text) => {
  if (text.trim()) {
    console.error(text.trim());
  }
});

client.start();
const result = await client.request("initialize", {
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
console.log(JSON.stringify(result, null, 2));
client.stop();
