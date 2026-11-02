# @voicebridge/core

> **Experimental alpha, not published.** The wire contract is **v0 (experimental)**. The runtime port is
> **0.x (unstable)**. Expect breaking changes.

The provider-neutral core of VoiceBridge. Its only package dependency is [`zod`](https://zod.dev)
(it also uses Node built-ins such as `node:crypto`; Node 24). It contains
no voice runtime, media transport, or AI-provider code. A CI job proves it installs and passes its
tests with no `@livekit/*` packages present (`pnpm verify:core-isolation`).

## What's in it

| Area             | Exports                                                                                                                                                                     |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contracts        | `SessionContext`, `UserTurn`, `BackendReply`, `ConversationAdapter`, `Application`, `defineApplication`                                                                     |
| Backend mode     | `runBackendControlledSession(runtime, application, options)`: latest-turn-wins coordination                                                                                 |
| Agent mode       | `defineTool`, `ToolRegistry` (the allowlist), `createToolExecutor`. Built and tested; **not wired to any runtime yet**                                                      |
| HTTP backends    | `createHttpBackend` → `.conversation()` and `.tool()` over the v0 wire contract                                                                                             |
| Wire contract v0 | Zod schemas (`WIRE_V0_SCHEMAS`), `wireV0JsonSchemas()`, files in `schema/v0/`, vectors in `conformance/v0/`                                                                 |
| Runtime port 0.x | `RuntimeSession`, `RuntimeEvents`, `RuntimeCapabilities`, `SpeechHandle`. The core reads only `trustedSessionContext` and `pendingTurnSignal`                               |
| Errors           | `VoiceBridgeError` with `code`, internal `message`, and generic `publicMessage`                                                                                             |
| Observability    | `VoiceBridgeEvent` (privacy-safe: ids, outcomes, durations, lengths, never text), `Observer`                                                                                |
| `./testing`      | `FakeRuntime`, `inMemoryConversation`, `deferred`, `neverUntilAborted`, `loadConformanceVectorsV0` (message-shape vectors; no behavioural or runtime conformance suite yet) |

## Example: backend-controlled session against the fake runtime

```ts
import {
  createHttpBackend,
  defineApplication,
  runBackendControlledSession,
} from '@voicebridge/core';
import { FakeRuntime } from '@voicebridge/core/testing';

const backend = createHttpBackend({
  applicationId: 'help-desk',
  baseUrl: process.env.HELP_DESK_URL!, // server-side config only
  serviceCredential: process.env.HELP_DESK_CREDENTIAL!, // per application, never sent to clients
});
const app = defineApplication({ applicationId: 'help-desk', conversation: backend.conversation() });

const runtime = new FakeRuntime({
  context: { applicationId: 'help-desk', sessionId: 's1', sessionRef: 'sr_from_your_token_server' },
});
runtime.attach(runBackendControlledSession(runtime.session, app));
runtime.userSays('What are your opening hours?'); // → POST {base}/v0/turns → reply spoken verbatim
```

A real runtime adapter (for example `@voicebridge/runtime-livekit`) implements `RuntimeSession`
and calls the returned `RuntimeEvents` from its SDK events. It must also stop speech that is playing
or queued when it delivers a new user turn: the core cancels the superseded backend request but
never calls `interrupt()` itself in 0.x.

## Guarantees and non-guarantees

- A newer turn aborts the outstanding request. A reply for a superseded turn is never delivered to
  the runtime. (Stopping speech already playing is the runtime adapter's job; see above.)
- Cancellation stops VoiceBridge waiting. It **doesn't** undo a backend action that may already
  have happened. Use `Idempotency-Key` (sent on every call: `{sessionId}:{turnId}` for turns, `{sessionId}:start`
  and `:end` for session calls, `invocationId` for tools) and confirmation flows.
- Tool arguments are validated in strict mode (unknown keys rejected), and session identity is
  injected by the executor, never taken from LLM arguments.
- Errors that reach users or LLMs are generic. Backend bodies, URLs, and credentials never leak.

See [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md) and
[ADR 0001](../../docs/adr/0001-provider-neutral-core.md).
