# Agent Provider Protocol

This document defines the first stable boundary for out-of-process ECOS Agent
providers.

The goal is to let ECOS Studio talk to Codex, OMP-style RPC agents, or future
CLI agents through the same provider contract. ECOS owns the runtime lifecycle
and workspace scope. Providers own provider-specific process and protocol
translation.

## Protocol Version

```text
agent-provider-stdio.v1
```

The protocol runs over stdio using newline-delimited JSON messages.

## Transport

ECOS starts the provider process declared by the provider manifest.

```text
ECOS AgentRuntimeManager
  -> spawn provider command
  -> provider stdin/stdout JSON-RPC
  -> provider backend, such as codex app-server
```

Messages are encoded as one JSON object per line.

Requests from ECOS:

```json
{"jsonrpc":"2.0","id":"1","method":"initialize","params":{}}
```

Responses from provider:

```json
{"jsonrpc":"2.0","id":"1","result":{"provider":"codex_app_server"}}
```

Notifications from provider:

```json
{"jsonrpc":"2.0","method":"agent/event","params":{"type":"messageDelta","provider":"codex_app_server","delta":"Hello"}}
```

Provider stdout must be reserved for protocol messages. Human-readable logs
should go to stderr.

## Request Envelope

```ts
type ProviderRequest = {
  jsonrpc: '2.0';
  id: string;
  method: ProviderMethod;
  params?: Record<string, unknown>;
};
```

## Response Envelope

```ts
type ProviderResponse =
  | {
      jsonrpc: '2.0';
      id: string;
      result: unknown;
    }
  | {
      jsonrpc: '2.0';
      id: string;
      error: {
        code: string;
        message: string;
        data?: unknown;
      };
    };
```

## Event Envelope

```ts
type ProviderNotification = {
  jsonrpc: '2.0';
  method: 'agent/event';
  params: DesktopAgentEvent;
};
```

`DesktopAgentEvent` should match the normalized Agent event shape already used
by the ECOS renderer. The provider should not send raw backend-specific events
unless they are nested under a diagnostic field.

## Methods

### initialize

Called once after the process starts.

Request:

```ts
type InitializeParams = {
  clientInfo?: {
    name: string;
    title?: string;
    version?: string;
  };
  provider: string;
  workspaceRoots?: string[];
  environment?: {
    cwd?: string;
  };
};
```

Response:

```ts
type InitializeResult = {
  provider: string;
  protocolVersion: 'agent-provider-stdio.v1';
  capabilities: ProviderCapabilities;
};
```

### getStatus

Returns provider status without starting a new turn.

Request:

```ts
type GetStatusParams = {
  provider?: string;
};
```

Response:

```ts
type AgentStatus = {
  provider: string;
  mode: 'general_assistant' | 'flow_guarded_design';
  running: boolean;
  currentSessionId?: string | null;
  currentTurnId?: string | null;
  flowGuard?: FlowGuardStatus | null;
};
```

### startSession

Starts a new provider session in an ECOS workspace.

Request:

```ts
type StartSessionParams = {
  cwd: string;
  provider?: string;
  mode?: 'general_assistant' | 'flow_guarded_design';
  workspaceRoots?: string[];
  sandbox?: AgentSandboxPolicy;
  approvalPolicy?: AgentApprovalPolicy;
};
```

Response:

```ts
type StartSessionResult = {
  provider: string;
  sessionId: string;
};
```

### sendMessage

Starts a provider turn.

Request:

```ts
type SendMessageParams = {
  cwd?: string | null;
  mode?: 'general_assistant' | 'flow_guarded_design' | null;
  prompt: string;
  provider?: string;
  sessionId?: string | null;
  sandbox?: AgentSandboxPolicy;
  approvalPolicy?: AgentApprovalPolicy;
};
```

Response:

```ts
type SendMessageResult = {
  provider: string;
  messageId?: string | null;
  turnId?: string | null;
};
```

Streaming assistant text and action updates should be emitted through
`agent/event` notifications, not buffered into the response.

### interrupt

Requests cancellation of the active provider turn.

Request:

```ts
type InterruptParams = {
  provider?: string;
  sessionId?: string | null;
  turnId?: string | null;
};
```

Response:

```ts
type InterruptResult = {
  provider: string;
  interrupted: boolean;
};
```

### listSessions

Lists known provider sessions.

Request:

```ts
type ListSessionsParams = {
  provider?: string;
  cwd?: string | null;
  limit?: number;
};
```

Response:

```ts
type ListSessionsResult = {
  sessions: AgentSessionSummary[];
};
```

### resumeSession

Loads an existing provider session.

Request:

```ts
type ResumeSessionParams = {
  provider?: string;
  sessionId: string;
};
```

Response:

```ts
type ResumeSessionResult = {
  provider: string;
  sessionId: string;
  messages: AgentChatMessage[];
};
```

### setMode

Switches provider mode.

Request:

```ts
type SetModeParams = {
  provider?: string;
  mode: 'general_assistant' | 'flow_guarded_design';
};
```

Response:

```ts
type SetModeResult = AgentStatus;
```

### stop

Stops provider-managed resources. ECOS may also terminate the provider process
after this method returns.

Request:

```ts
type StopParams = {
  provider?: string;
};
```

Response:

```ts
type StopResult = {
  provider: string;
  stopped: boolean;
};
```

### respondApproval

Responds to a provider approval request. This is included in the protocol so
approval UI can be implemented in ECOS consistently across providers.

Request:

```ts
type RespondApprovalParams = {
  provider?: string;
  approvalId: string;
  decision: 'accept' | 'decline' | 'manual_review';
  reason?: string;
};
```

Response:

```ts
type RespondApprovalResult = {
  provider: string;
  accepted: boolean;
};
```

## Event Types

The provider should emit events that map to ECOS `DesktopAgentEvent`.

### status

```ts
type AgentStatusEvent = {
  type: 'status';
  provider: string;
  status: AgentStatus;
};
```

### messageDelta

```ts
type AgentMessageDeltaEvent = {
  type: 'messageDelta';
  provider: string;
  delta: string;
};
```

### action

```ts
type AgentActionEvent = {
  type: 'action';
  provider: string;
  action: {
    id?: string;
    kind: 'command' | 'fileChange' | 'approval' | 'reasoning' | 'other';
    status: 'started' | 'running' | 'completed' | 'failed' | 'cancelled';
    title?: string;
    content?: string;
    metadata?: Record<string, unknown>;
  };
};
```

### approvalRequest

```ts
type AgentApprovalRequestEvent = {
  type: 'approvalRequest';
  provider: string;
  approvalId: string;
  request: {
    kind: 'command' | 'fileChange' | 'permission' | 'other';
    title: string;
    description?: string;
    command?: string;
    cwd?: string;
    paths?: string[];
    metadata?: Record<string, unknown>;
  };
};
```

### flowGuardDecision

```ts
type AgentFlowGuardDecisionEvent = {
  type: 'flowGuardDecision';
  provider: string;
  result: {
    decision: 'accept' | 'decline' | 'manual_review';
    ruleId?: string;
    reason: string;
    recoveryHint?: string;
    evidence?: unknown[];
  };
};
```

### error

```ts
type AgentErrorEvent = {
  type: 'error';
  provider: string;
  message: string;
  code?: string;
  data?: unknown;
};
```

## Supporting Types

```ts
type ProviderCapabilities = {
  streaming: boolean;
  interrupt: boolean;
  sessions: boolean;
  resume: boolean;
  approvals: boolean;
  modes: Array<'general_assistant' | 'flow_guarded_design'>;
  flowGuard?: boolean;
};

type AgentSandboxPolicy = {
  type: 'readOnly' | 'workspaceWrite' | 'dangerFullAccess';
  writableRoots?: string[];
  networkAccess?: boolean;
};

type AgentApprovalPolicy =
  | 'never'
  | 'untrusted'
  | 'onFailure'
  | 'onRequest';

type AgentSessionSummary = {
  id: string;
  provider: string;
  cwd?: string;
  preview?: string;
  createdAt?: number;
  updatedAt?: number;
  name?: string | null;
};

type AgentChatMessage = {
  role: 'user' | 'assistant' | 'system';
  content: string;
};

type FlowGuardStatus = {
  activeStep?: string | null;
  projectRoot?: string | null;
  steps: Record<string, {
    id: string;
    status: string;
    reason?: string | null;
    updatedAt: number;
  }>;
};
```

## Security Rules

ECOS is the authority for:

- provider process launch
- workspace root selection
- writable roots
- approval policy
- provider manifest trust
- user-visible approval decisions

Providers should not infer extra workspace access from environment variables.
Providers should use the explicit workspace and sandbox data supplied by ECOS.

## Compatibility

During migration, ECOS may keep the legacy dynamic import path:

```text
AGENT_BRIDGE_ROOT/src/AgentRuntime.js
```

The plugin protocol should become the preferred path once an
`AgentProviderProcessClient` exists in ECOS.
