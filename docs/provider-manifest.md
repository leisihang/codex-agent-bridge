# Agent Provider Manifest

This document defines the manifest format for out-of-process Agent providers.

The manifest lets ECOS discover, display, validate, and launch provider plugins
without hardcoding provider-specific logic into ECOS Studio.

## File Name

Recommended file name:

```text
agent-provider.manifest.json
```

## Manifest Shape

```ts
type AgentProviderManifest = {
  id: string;
  displayName: string;
  description?: string;
  version: string;
  protocol: 'agent-provider-stdio.v1';
  entry: {
    command: string;
    args?: string[];
    cwd?: string;
  };
  capabilities: {
    streaming: boolean;
    interrupt: boolean;
    sessions: boolean;
    resume: boolean;
    approvals: boolean;
    modes: Array<'general_assistant' | 'flow_guarded_design'>;
    flowGuard?: boolean;
  };
  environment?: {
    requiredCommands?: string[];
    optionalCommands?: string[];
    variables?: Array<{
      name: string;
      required: boolean;
      description?: string;
    }>;
  };
  workspace?: {
    requiresWorkspace: boolean;
    defaultSandbox: 'readOnly' | 'workspaceWrite' | 'dangerFullAccess';
    networkAccess: boolean;
  };
  metadata?: Record<string, unknown>;
};
```

## Required Fields

### id

Stable provider id used in requests and events.

Example:

```json
"codex_app_server"
```

### displayName

User-visible provider name.

### version

Provider package version. This is independent from the protocol version.

### protocol

Must match the provider process protocol:

```json
"agent-provider-stdio.v1"
```

### entry

Command ECOS should spawn.

Example:

```json
{
  "command": "node",
  "args": ["providers/codex/index.js"]
}
```

Relative paths are resolved relative to the manifest directory unless ECOS
chooses a different policy.

### capabilities

Describes features supported by the provider. ECOS can use this to enable or
disable UI controls.

## Environment Requirements

Use `environment.requiredCommands` for commands that must exist before the
provider can run.

For Codex:

```json
{
  "requiredCommands": ["codex"]
}
```

Provider code should still perform runtime checks and return clear errors.

## Workspace Policy

The `workspace` section documents default behavior. ECOS remains the final
authority for actual workspace roots, writable roots, sandbox policy, and
approval policy.

## Example

See:

```text
examples/codex-provider.manifest.json
```

## Validation Rules

ECOS should reject a manifest when:

- `id` is empty
- `protocol` is unsupported
- `entry.command` is empty
- `capabilities.modes` is empty
- manifest path is outside the trusted provider search roots

ECOS should warn when:

- required commands are missing
- provider version is older than a configured minimum
- manifest requests `dangerFullAccess` by default

## Migration Note

The current prototype still supports dynamic import through:

```text
AGENT_BRIDGE_ROOT/src/AgentRuntime.js
```

The manifest path is the target design for the out-of-process provider model.
