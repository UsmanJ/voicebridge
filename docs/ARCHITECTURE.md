# VoiceBridge architecture

> Status: **alpha (`0.1.0-alpha.1`).** Milestones M0–M5.6 are implemented: the provider-neutral
> core, the LiveKit token issuer, the LiveKit Agents adapter in **backend-controlled mode**, and a
> browser demo. **Agent-controlled mode and the task-list example are planned, not implemented**;
> sections describing them say so. VoiceBridge is a working title.
> The key decision is recorded in [ADR 0001](adr/0001-provider-neutral-core.md) (Accepted).
> LiveKit facts were checked against `@livekit/agents` 1.9.5, `livekit-server-sdk` 2.19.2,
> `livekit-client` 2.23.0, `@livekit/components-react` 2.9.24, and LiveKit docs (2026-10-31 to
> 2026-11-02). Spike results are in §16, raw evidence in `spikes/m05/` on branch `spike/m0.5`
> (local only).
>
> Evidence labels: **[source]** read in installed SDK source, **[docs]** vendor documentation,
> **[run]** observed in an actual live execution, **[unit]** asserted by an offline test,
> **[manual]** checked by hand by the maintainer.

## 1. Purpose and principles

VoiceBridge is **provider-agnostic, open-source voice AI integration middleware**. It lets developers
connect existing applications and backend APIs to real-time voice through one stable,
versioned interface, while they choose the voice runtime, AI providers, and backend.

LiveKit Agents (Node.js) is the **first runtime adapter**, not the core platform.

Principles:

1. **Portability lives in contracts, not in wrappers.** The most portable artifact is a
   language-neutral wire contract with application backends, plus test vectors.
2. **Don't re-implement what runtimes already do.** Turn-taking, interruption, media transport,
   STT/LLM/TTS pipelines, and provider plugins belong to the runtime.
3. **One runtime first, a fake runtime always.** The core is proven runtime-free by tests, not by
   speculative adapters.
4. **Security and privacy controls don't depend on the provider.** They're enforced in the core
   or are mandatory obligations for every runtime adapter (§8).

Non-goals (for now): a hosted service or control plane; databases, queues, or persistence;
multiple runtime adapters; abstracting STT/LLM/TTS providers; bundled prompts or domain logic;
production readiness claims.

## 2. The four categories, and what VoiceBridge abstracts

| Category                  | Examples                                                                   | Who owns it                        | VoiceBridge abstracts it?                                                                                            |
| ------------------------- | -------------------------------------------------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **Media transport**       | LiveKit WebRTC, Daily WebRTC, SmallWebRTC, Twilio Media Streams, WebSocket | The orchestration runtime          | **No.** A transport is chosen _inside_ a runtime. LiveKit Agents uses LiveKit rooms. Pipecat offers many transports. |
| **Orchestration runtime** | LiveKit Agents (Node), Pipecat (Python)                                    | Runtime adapter                    | **Yes, narrowly:** the runtime port (§5.3), only what our two modes need.                                            |
| **STT/LLM/TTS providers** | LiveKit Inference, Deepgram, AssemblyAI, OpenAI, Cartesia                  | The runtime's plugin system        | **No.** Provider config is runtime-specific and opaque to the core. Each runtime adapter owns it.                    |
| **Application adapters**  | The developer's backend API                                                | VoiceBridge core + the application | **Yes, fully:** the wire contract (§5.1) and TS contracts (§5.2). This is VoiceBridge's main value.                  |

Why transports aren't swapped independently: LiveKit Agents is bound to LiveKit's room model
(dispatch, RoomIO, SIP through LiveKit) **[source]**. Pipecat binds transports to its own Python
pipeline [docs: Pipecat transports]. Swapping a transport while keeping the runtime is a runtime
feature. VoiceBridge exposes the choice through the runtime adapter's configuration, not its own
transport layer.

## 3. Layered overview

```
 Clients (browser now; mobile/IoT/telephony later, via the runtime's own client SDKs)
        │ media + data (runtime-specific transport)
        ▼
 ┌──────────────────────────────────────────────────────────────────────────┐
 │ Runtime adapter  (vendor-specific, one per orchestration framework)      │
 │  @voicebridge/runtime-livekit  ── uses @livekit/agents                   │
 │   • provider config (LiveKit Inference / plugins), turn detection        │
 │   • trusted session context (job metadata)                               │
 │   • pre-connection session verification (fails closed)                   │
 │   • implements RuntimeSession: user turns in, speak/interrupt out        │
 │   • (planned) bridge ToolRegistry → native function calling              │
 ├──────────────────── runtime port (TS, 0.x, minimal) ─────────────────────┤
 │ @voicebridge/core  (zod only, no vendor deps)                            │
 │   • application contracts + wire schemas (JSON Schema export)            │
 │   • turn coordinator (backend-controlled mode)                           │
 │   • tool registry + validated executor (built, not wired to a runtime)   │
 │   • policy: timeouts, size caps, fallbacks, URL rules                    │
 │   • observability events (PII-free) · testing: FakeRuntime, vectors      │
 ├──────────────────── wire contract (HTTP JSON, v0 experimental) ───────────────────────┤
 │ Application backend (any language) ── example: help desk (task list planned) │
 └──────────────────────────────────────────────────────────────────────────┘
 Session tokens: @voicebridge/livekit-tokens (runtime-specific, server-side only)
```

## 4. Repository boundaries

| Path                         | Package                        | Runtime dependencies                                                               | Purpose                                                                                                                                                                                         |
| ---------------------------- | ------------------------------ | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core`              | `@voicebridge/core`            | `zod` **only** (plus `node:` built-ins)                                            | Contracts, wire schemas, coordinator, tool registry/executor (not yet wired to a runtime), HTTP adapter, policy, events. `./testing` subpath: `FakeRuntime`, in-memory helpers, vectors loader. |
| `packages/livekit-tokens`    | `@voicebridge/livekit-tokens`  | `core`, `livekit-server-sdk`                                                       | Server-side token minting and the dispatch metadata format. Never pulls `@livekit/agents`.                                                                                                      |
| `packages/runtime-livekit`   | `@voicebridge/runtime-livekit` | `core`, `livekit-tokens` (dispatch metadata parser); peer `@livekit/agents ~1.9.5` | LiveKit Agents runtime adapter: verification, job orchestration, provider config.                                                                                                               |
| `examples/backend-help-desk` | (private)                      | `core` (schemas only), Node built-ins                                              | The only example backend: deterministic FAQ replies over `/v0`, plus the host's internal session API and an in-memory store with compare-and-set room binding.                                  |
| `examples/host-token-route`  | (private)                      | `core`, `livekit-tokens`                                                           | The host app's authenticated token route (`POST /api/voice/token`), localhost-only development identity, CORS allowlist, rate limits.                                                           |
| `examples/worker-livekit`    | (private)                      | `core`, `runtime-livekit`, `@livekit/agents`                                       | Runnable worker: env config → backend URL, providers, SDK log level.                                                                                                                            |
| `examples/web`               | (private)                      | `livekit-client`, `@livekit/components-react` (locally patched), Next.js           | Browser client. Calls the host token route directly; imports no workspace package.                                                                                                              |
| `docs/`, `docs/adr/`         |                                |                                                                                    | Architecture, decisions, release notes.                                                                                                                                                         |

Planned, not implemented: `examples/backend-task-list` (agent-controlled mode with tools). Until it
exists, only the help desk exercises the wire contract, so backend interchangeability isn't
demonstrated yet.

Boundary rules, enforced by tests (§11.1):

- `core` may not import any `@livekit/*`, `livekit-*`, or other vendor package. It may import
  `zod` and `node:` built-ins (it uses `node:crypto` for request and invocation ids, `Buffer`
  in the HTTP client, and `node:fs` in `./testing`). It runs on Node 24.
- Runtime adapters may not depend on each other. Examples may not be imported by packages.
- Provider names, model ids, and transport options appear only in runtime adapters and examples.

### 4.1 Example applications

Synthetic and in-memory. Only the help desk exists today; the task list is a design for M6.

**Help desk (backend-controlled).** A deterministic knowledge service: `turns` maps questions to
approved answers from a fixed synthetic FAQ, so the reply is fully predictable and spoken
verbatim. No tools, no LLM.

**Task list (agent-controlled, planned for M6, not implemented).** Tools over a per-user,
in-memory task list. It will show the patterns any modifying backend should follow:

- **Authorization:** the backend resolves `sessionRef` to a synthetic user server-side and only
  touches that user's tasks. Another user's task id fails with `not_found` (no existence leak).
  Unknown, expired, or other-application refs are rejected.
- **Confirmation:** destructive actions (`delete_task`, `complete_all`) are two-step.
  1. The first call returns `{ status: "confirmation_required", confirmationId, summary }` and
     changes nothing.
  2. The action only happens on a second call carrying that `confirmationId`, after the LLM has
     asked the user.

  Confirmation ids are single-use, short-lived, and bound to the session ref and the exact
  arguments.

- **Idempotency:** write tools honour the `Idempotency-Key` (`invocationId`). A repeated key returns
  the original result without a second effect.
- **Cancellation isn't rollback:** if the user interrupts while a write is in flight, VoiceBridge
  stops waiting and won't speak an obsolete result. The write may still have completed. The task
  list reports state truthfully on the next read and never assumes the abort undid anything.

## 5. Vendor-independent contracts

Everything in this section must stay independent of LiveKit and any other vendor.

Stability: the wire contract is **v0, experimental**. It may change without notice until it has
been validated against both example applications (help desk and task list). Only then will a
stable `v1` be proposed. The TypeScript runtime port is separately **0.x, unstable** until a second
real runtime exists.

### 5.1 Wire contract v0: VoiceBridge ↔ application backend (language-neutral)

Defined as Zod schemas in `core`, exported as JSON Schema, and pinned by shared JSON conformance
vectors. A future Python runtime (for example a Pipecat adapter) would implement **this wire
protocol** and replay the same vectors. It wouldn't import the TypeScript core (§9.2).

| Call                                                                                         | Request                                                                     | Response                                                                       |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `POST {base}/v0/turns` (if backend-controlled supported)                                     | `{ turnId, sessionRef, text, source: "speech" \| "text" }`                  | `{ kind: "speak", text } \| { kind: "silent" } \| { kind: "end", text? }`      |
| `POST {base}/v0/sessions/start` (optional in core; **required and authorizing for LiveKit**) | `{ sessionRef, runtimeBinding?: { runtime, roomName } }`                    | `{ authorized: true, greeting?: BackendReply }`. Non-2xx means not authorized. |
| `POST {base}/v0/sessions/end` (optional, best effort)                                        | `{ sessionRef, reason }`                                                    | `204`                                                                          |
| `POST {base}{toolPath}` (per registered tool)                                                | `{ invocationId, sessionRef, arguments }` (arguments already Zod-validated) | `{ ok: true, result } \| { ok: false, error: { code, publicMessage? } }`       |

Headers on every call:

- `Authorization: Bearer <service credential>`: one credential **per application**,
  least privilege, identifying the VoiceBridge worker to that application only
- `VoiceBridge-Version: 0`
- `VoiceBridge-Request-Id` (a fresh UUID per request)
- `Idempotency-Key`: `{sessionId}:{turnId}` on turns, `{sessionId}:start` and `{sessionId}:end`
  on session calls, `invocationId` on tool calls. For LiveKit, `sessionId` is the job id. Turn
  ids are a per-session counter (`t0` greeting, `t1`, `t2`, …), so keys are unique within one job
  run; whether LiveKit reuses a job id when it restarts a failed job is unverified (§14 #18)

Tool paths come from registration config, never from LLM output. Limits on every call: timeout,
maximum response bytes, schema validation.

**Session start is also authorization (changed during M3).** The backend resolves `sessionRef`
against its trusted, active, server-stored binding for the application. When `runtimeBinding` is
present, it also checks that the room recorded at issuance equals the room the runtime reports.
Only then does it answer `{ authorized: true }`. Any other response, including any non-2xx status,
timeout, or schema-invalid body, is treated as **not authorized**. Calls carry
`Idempotency-Key: {sessionId}:start`, and duplicate starts must not duplicate side effects.

Why this change was needed: v0 originally sent only `{ sessionRef }` and answered with a generic
greeting. That couldn't carry the actual room, and a greeting-only `200` would have counted as
authorization (an accidental fail-open).

**Optional application capabilities.** A backend implements only what it uses:

- the help desk implements `turns` (and maybe `sessions/start`)
- the task list implements only its tool endpoints

Capabilities are declared in worker configuration, not discovered at runtime. The core validates
at startup that the configured mode is supported:

- backend-controlled mode requires a conversation adapter
- agent-controlled mode requires at least one tool

### 5.2 Application contracts (TypeScript, in `core`)

```ts
/** Trusted. Built by the runtime adapter from a server-minted channel. Contains NO credentials. */
interface SessionContext {
  readonly applicationId: string; // from worker config, never from client-visible data
  readonly sessionId: string; // runtime-assigned, for correlation (LiveKit: the job id)
  readonly sessionRef: string; // opaque app-issued id, resolved and authorized server-side
  readonly runtimeBinding?: { runtime: string; roomName: string }; // where it actually runs
}
interface UserTurn {
  readonly turnId: string;
  readonly text: string; // exact final transcript or typed text
  readonly source: 'speech' | 'text';
}
type BackendReply =
  { kind: 'speak'; text: string } | { kind: 'silent' } | { kind: 'end'; text?: string };
/** Only the literal `true` authorizes. */
type SessionStartResult = { authorized: true; greeting?: BackendReply };

/** One application = one backend binding. Capabilities optional, at least one required. */
interface Application {
  readonly applicationId: string;
  readonly conversation?: ConversationAdapter; // backend-controlled mode
  readonly tools?: ToolRegistry; // agent-controlled mode (allowlist; not wired to a runtime yet)
}
interface ConversationAdapter {
  respond(turn: UserTurn, ctx: SessionContext, signal: AbortSignal): Promise<BackendReply>;
  start?(ctx: SessionContext, signal: AbortSignal): Promise<SessionStartResult>;
  end?(ctx: SessionContext, reason: SessionEndReason): Promise<void>;
}
interface ToolDefinition<I extends z.ZodObject, O extends z.ZodType> {
  name: string; // /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/
  description: string; // app-supplied
  effect: 'read' | 'write'; // write = modifies backend state
  input: I; // object schema; LLM args validated (strict) before execute
  output: O; // backend result validated before the LLM sees it
  timeoutMs?: number;
  execute(input: z.output<I>, ctx: ToolCallContext): Promise<z.input<O>>;
}
interface ToolCallContext {
  readonly session: SessionContext; // injected, never from LLM arguments
  readonly invocationId: string; // idempotency key
  readonly signal: AbortSignal;
}
```

`defineApplication({ applicationId, conversation?, tools? })` validates and freezes an application.
`createHttpBackend({ applicationId, baseUrl, serviceCredential, timeoutMs?, maxResponseBytes?, endpoints? })`
binds one application to one backend. It provides `.conversation()` and `.tool({...})` over the
wire contract. Session endpoints are off unless configured
(`endpoints: { sessionStart: '/v0/sessions/start', sessionEnd: '/v0/sessions/end' }`).
Applications written in TS can also implement the interfaces in-process.

### 5.3 Runtime port (TypeScript, in `core`, 0.x)

The minimal surface a runtime adapter implements. Every value is JSON-serializable except the
callbacks, so the same shape could later be carried over a socket (§9.3).

```ts
interface RuntimeCapabilities {
  interruption: 'none' | 'programmatic' | 'barge-in'; // informational in 0.x (see below)
  textInput: boolean; // informational in 0.x
  pendingTurnSignal: boolean; // read by the core: enables the hold rule
  streamingSpeech: boolean; // unused in 0.x
  trustedSessionContext: boolean; // read by the core: sessions refused without it
  nativeToolCalling: boolean; // unused until agent-controlled mode exists
}

interface SpeechHandle {
  readonly done: Promise<{ interrupted: boolean }>;
}

interface RuntimeSession {
  readonly capabilities: RuntimeCapabilities;
  readonly context: SessionContext;
  speak(text: string): SpeechHandle;
  interrupt(): void;
  end(reason: SessionEndReason): Promise<void>;
}

interface RuntimeEvents {
  onUserTurn(turn: { text: string; source: 'speech' | 'text' }): void;
  onFinalTranscriptPending(): void; // ignored unless capabilities.pendingTurnSignal
  onEnded(reason: SessionEndReason): void;
}
```

The core exposes
`runBackendControlledSession(runtime: RuntimeSession, application: Application, options?): BackendControlledSession`,
where `BackendControlledSession` extends `RuntimeEvents` with `context`, `closed`, and
`close(reason)`. Options: `timeoutMs` (8000), `fallbackText`, `pendingTurnHoldMs` (3000),
`sessionEndTimeoutMs` (2000), `greet`, `startResult` (a pre-verified `sessions/start` result, as
the LiveKit adapter passes), and `observer`. It also exposes
`createToolExecutor({ registry, session, defaultTimeoutMs?, observer? })`, not yet used by a
runtime. The runtime adapter wires its SDK events to the returned handlers. The core never calls a
vendor API.

**Interruption responsibility.** In 0.x the core never calls `RuntimeSession.interrupt()`. When a
new turn arrives it cancels the previous backend request and never delivers its reply, but
stopping speech that is already playing or queued is the runtime's or adapter's job. LiveKit
Agents 1.9.5 interrupts active and queued speech itself before it runs `onUserTurnCompleted` for a
committed spoken turn **[source][unit]**, and the LiveKit adapter calls `session.interrupt()`
(current and queued speech) before forwarding a typed turn **[source][unit][run]**. A future
runtime with only programmatic interruption would have to do the same in its adapter (or the core
would gain that duty).

### 5.4 Observability events and errors

- `VoiceBridgeEvent` union ([`observability.ts`](../packages/core/src/observability.ts)):
  `session_started {applicationId, mode}`, `turn_started {turnId, source, textLength}`,
  `turn_superseded {turnId, byTurnId}`, `turn_cancelled`, `backend_failed {operation, code}`,
  `reply_held`, `reply_released`, `reply_stale_discarded`, `reply_silent`,
  `speech_started {textLength, fallback}`, `speech_finished {interrupted}`,
  `tool_invoked {invocationId, tool, effect, outcome, durationMs}`, `session_ended {reason}`. Every
  event carries `at` and `sessionId`. **PII-free:** ids, codes, durations, and text lengths, never
  text. Sink: `observer: (event) => void`, wrapped so a throwing observer can't break a session.
  The example worker doesn't wire an observer yet, so these events aren't visible in the demo.
- Error taxonomy (`VoiceBridgeError.code`, [`errors.ts`](../packages/core/src/errors.ts)):
  `config_error`, `invalid_session_context`, `mode_not_supported`, `backend_unavailable`,
  `backend_timeout`, `backend_rejected`, `invalid_backend_reply`, `response_too_large`,
  `tool_not_allowed`, `invalid_tool_arguments`, `invalid_tool_result`, `tool_failed`, `cancelled`,
  `session_closed`. Each has an internal message and cause (never logged with payloads) and a
  generic `publicMessage`; `toPublic()` is safe for users and LLMs.

## 6. Execution modes (generic behaviour, then LiveKit specifics)

### 6.1 Backend-controlled (no LLM)

Generic (core): user turn → coordinator → `adapter.respond` → validated reply → `session.speak`.
Coordinator rules, all validated in M0.5 **[run][unit]**:

1. The runtime's turn handler must return immediately. The coordinator owns the request.
2. A new turn aborts the outstanding request (`AbortSignal`).
3. A reply for a superseded turn is discarded (sequence guard), even if the backend ignored the abort.
4. If `pendingTurnSignal` is available, a reply that's ready while a newer transcript awaits
   commit is held, then discarded or released after a bounded wait.
5. Timeouts and errors produce a generic fallback. Backend bodies are never spoken or logged.

LiveKit adapter specifics **[source][run]**: no LLM is configured. `onUserTurnCompleted` → coordinator
(the SDK serializes hooks, so the hook must not await). Speech uses `session.say()`, and interruption
reports through the handle. Typed text needs a custom `textInputCallback` that calls
`session.interrupt()` (the default handler throws without an LLM). `user_input_transcribed`
(final) feeds the pending-turn signal. The SDK keeps only assistant items in history, so
conversation memory belongs to the backend. End-of-turn delay of 0.04–2.2 s was observed, and the
agent state stays `listening` while the backend works.

**Session and job lifecycle (LiveKit, verified for 1.9.5 [source][docs][unit]).**

- The SDK closes the `AgentSession` when the linked participant disconnects with
  `CLIENT_INITIATED`, `ROOM_DELETED`, or `USER_REJECTED` only (`closeOnDisconnect`). Closing stops
  speech recognition (the STT stream) and releases TTS. The adapter maps the `close` event to
  `onEnded('client_left')`: the core aborts any in-flight backend request, drops held replies,
  never speaks again, and sends `sessions/end` (2 s budget).
- Closing the `AgentSession` does **not** end the job. The job process ends on
  `JobContext.shutdown()`, when its room disconnects, on worker shutdown, or on a crash. LiveKit
  closes a room when the last non-agent participant leaves, which disconnects the agent and ends
  the job; the shutdown callback then calls `close('shutdown')`, which is idempotent (one
  `sessions/end`). So the adapter doesn't call `JobContext.shutdown()` on `client_left`. Room
  shutdown isn't immediate: after the last participant leaves, LiveKit keeps the room open for its
  `departure_timeout` grace period **[docs]**, and after a network drop the server first has to
  notice the participant is gone. Neither delay has been measured for this project, and network
  reconnection remains unverified (checklist item 8).
- Other disconnects (for example a network drop) leave the `AgentSession` open, so the same
  identity can rejoin. If the user never returns, the job ends when LiveKit closes the room.
- A backend `end` reply speaks its text, closes the core session, then calls
  `session.shutdown({ drain: true })` and `JobContext.shutdown()`.

### 6.2 Agent-controlled (LLM + allowlisted tools), planned for M6, not implemented

The registry and executor below exist in core and are unit-tested; no runtime uses them yet.

Generic (core): `ToolRegistry` is the allowlist. The executor validates arguments, injects
`SessionContext` (never from the LLM), applies the timeout, calls the backend, validates the
result, and maps failures to safe errors. **The LLM loop stays in the runtime.**

LiveKit adapter specifics: registry entries are bridged to `llm.tool(...)`. Preemptive generation
is **off by default**, with an opt-in flag. In 1.9.5, speculative turns emitted tool calls but didn't
execute them **[source][run]**, yet `llmNode` and LLM inference do run speculatively.

**Cancellation semantics (both modes).** Cancellation guarantees that VoiceBridge stops waiting
and never speaks an obsolete reply or result. It does **not** guarantee the backend didn't act.
An aborted request may already have committed a change. Backends must make writes idempotent
(`Idempotency-Key`), use confirmation for destructive actions, and treat `turns` requests as
potentially repeated or abandoned. VoiceBridge doesn't retry write tools automatically.

## 7. Capability differences and degradation

| Capability missing       | Core behaviour                                                                                                                                                                                             |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `interruption: none`     | Backend requests are still cancelled on new turns. The core never stops speech itself in 0.x (§5.3), so with no runtime interruption an obsolete reply already playing finishes. Documented UX limitation. |
| `textInput: false`       | Typed input is unavailable. The adapter reports it at startup.                                                                                                                                             |
| `pendingTurnSignal`      | Hold rule disabled. Sequence guard only, with a small known race window.                                                                                                                                   |
| `streamingSpeech: false` | Replies are spoken whole (the MVP does this everywhere).                                                                                                                                                   |
| `trustedSessionContext`  | **Session won't start.** Without a trusted channel for `sessionRef`, there's no safe identity (§8).                                                                                                        |
| `nativeToolCalling`      | Agent-controlled mode is unavailable on that runtime. Backend-controlled mode still works.                                                                                                                 |

LiveKit Agents 1.9.5 status: barge-in interruption, text input (custom callback), pending-turn signal
(final `user_input_transcribed`), trusted session context (job metadata), and native tool calling
(in the M0.5 spike, with an LLM) were observed **[run]**. The adapter reports
`nativeToolCalling: false` because backend-controlled mode configures no LLM. Streaming speech
(`say()` accepts a `ReadableStream`) is **[source]** only, not exercised.

## 8. Security and privacy controls, independent of the provider

| Control                                                                                                                                                                                                                  | Enforced by                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| Backend URLs from server config only, `https` except localhost                                                                                                                                                           | core (config schema)                                            |
| Tool allowlist, Zod argument and result validation                                                                                                                                                                       | core (registry/executor)                                        |
| Session identity from trusted context only, never from LLM/speech                                                                                                                                                        | core API shape + adapter obligation                             |
| Timeouts, abort, response size caps, generic fallbacks, no error leakage                                                                                                                                                 | core                                                            |
| PII-free observability events                                                                                                                                                                                            | core                                                            |
| Service credential on backend calls, one per application, least privilege                                                                                                                                                | core HTTP adapter                                               |
| Validated, authenticated application context: `sessionRef` format-checked by core, resolved and authorized by the backend; unknown/expired/foreign refs rejected                                                         | core (validation) + backend obligation                          |
| No cross-application leakage: each session is bound to one `applicationId`, adapter, and credential. Core refuses to run a session against another application's adapter. Per-session state only (no module-level state) | core (tests) + worker config                                    |
| Obsolete replies never spoken after cancellation; cancellation never assumed to undo backend writes                                                                                                                      | core (coordinator, executor) + backend idempotency/confirmation |
| **No credentials in client-visible tokens or metadata**                                                                                                                                                                  | adapter obligation (+ `livekit-tokens` tests)                   |
| Server-side token minting, server-named rooms/sessions                                                                                                                                                                   | adapter obligation (`livekit-tokens`)                           |
| Recording/observability upload off by default                                                                                                                                                                            | adapter obligation (LiveKit: explicit `record: false`)          |
| Local log level/PII guidance                                                                                                                                                                                             | adapter obligation (LiveKit: SDK at `error`; see §14 #23)       |

Adapter obligations are part of the adapter author guide and checked by a conformance checklist.

LiveKit facts behind these rules **[run]**:

- The JWT payload, including dispatch metadata, is readable by the client.
- Participant metadata and attributes are visible to every participant.
- With `canUpdateOwnMetadata: false`, client edits are silently ignored with no error.
- A token's dispatch is ignored for rooms that already exist.

Hence an opaque `sessionRef` plus a service credential, never delegated credentials. Trust
boundaries: client input, speech, typed text, LLM output, and participant-visible fields are
untrusted. Signed token/job contents give integrity, not confidentiality.

Retention **[source][docs][run]**: `record: false` uploads nothing. An explicit value overrides the
project setting. Enabling recording also sets `enable_user_data_training` in the uploaded report.
LiveKit Inference is zero-retention with providers. Self-supplied plugin accounts follow their own policies.

Local SDK logs are a separate channel from LiveKit Cloud observability, and `record` doesn't
govern them **[source][unit][run]**:

- The SDK's pino logger writes `lk.pii.*` fields (transcripts, tool arguments) to local stdout
  unchanged. Its PII redaction (`PIIFilteringSpanProcessor`) applies to OpenTelemetry spans
  exported to LiveKit Cloud, and log export to the cloud is only enabled when recording logs is
  opted in.
- Transcripts appear at DEBUG, and at **WARN** in at least four `agent_activity.js` statements,
  including "skipping user input, speech scheduling is paused". That one runs whenever a session
  closes with an uncommitted user turn: teardown drains the activity, which pauses scheduling, then
  force-commits the pending turn. It was observed in a real worker log at `--log-level warn` on
  2026-11-01.
- No known 1.9.5 statement at `error` or `fatal` carries a user transcript. The example worker
  therefore runs the SDK at `error` by default (`LOG_LEVEL`), and treats any lower level as
  producing sensitive logs (§14 #23). `error` is not a redaction guarantee: error records can
  still contain identifiers (job ids, room names, participant identities), error objects, and
  provider error payloads, and a future SDK version could log differently. Treat worker logs as
  sensitive operational data at every level.
- **Where the logs go is the operator's concern, not `record`'s.** On your own host, stdout and
  stderr go wherever your process manager sends them. For agents deployed to **LiveKit Cloud**,
  LiveKit collects the runtime stdout and stderr (`lk agent logs`, the dashboard, and optional log
  drains to Datadog, CloudWatch, and others) **[docs]**. That collection is separate from Agent
  Observability and is not affected by `record: false`.

## 9. Extension points

### 9.1 Adding a runtime adapter (documented, not built)

1. Implement `RuntimeSession` and wire SDK events to `RuntimeEvents`.
2. Declare `RuntimeCapabilities` honestly.
3. Deliver `SessionContext` from a trusted, server-minted channel, and verify the session with the
   backend before any media or provider is created (the LiveKit adapter's `verifyLiveKitSession`
   is the reference).
4. Stop current and queued speech when a user turn is committed (§5.3, interruption
   responsibility).
5. Bridge `ToolRegistry` to native function calling if supported (once agent mode exists).
6. Meet the §8 adapter obligations, including local log hygiene.
7. Test against `FakeRuntime`-style scenarios and the wire vectors. **There is no packaged runtime
   conformance suite yet**; `@voicebridge/core/testing` provides `FakeRuntime`, in-memory adapter
   helpers, and the shape vectors only.

### 9.2 How a future Pipecat adapter would talk to the core

Recommended: **no runtime link to the TypeScript core.** A Python package (`voicebridge-pipecat`)
would:

- implement the **wire contract** (§5.1) against the same application backends, validating
  messages with the shared JSON Schemas and shape vectors
- port the coordinator and session runner (about 400 lines of TypeScript today). The shared
  vectors pin **message shapes only**. Pinning coordinator **behaviour** across languages needs
  behavioural vectors (scripted turn, pending, reply-timing, abort, and end sequences with expected
  speech and events), which don't exist yet and should come before a second runtime
- run as processors in a Pipecat pipeline: final user transcription in → coordinator → HTTP turn
  call → a TTS speak frame out, using Pipecat's interruption mechanism and its function-calling
  registration for tools. Exact Pipecat class and method names are to be verified when built.

Application backends don't change, and neither does the TS core. Portability is proven by
conformance, not shared code.

### 9.3 Deferred alternative: TS core as a session sidecar

The runtime port could be serialized over a local WebSocket ("VoiceBridge session protocol":
`turn.user`, `transcript.pending`, `speech.done` events and `speak`/`interrupt`/`end` commands), so
any-language runtimes reuse the TS coordinator. Costs: an extra process, an extra hop (local
latency is small but nonzero), lifecycle and failure handling, and deployment complexity. **Not
built.** Reconsider only if several non-TS runtimes need identical behaviour, or if users want a
hosted service. §5.3 keeps values serializable so this stays possible.

### 9.4 Adding a backend

Implement the wire contract in any language. Validate your request handling and responses against
the JSON Schemas in `packages/core/schema/v0/` and the vectors in
`packages/core/conformance/v0/vectors.json` (38 valid/invalid message examples). The help-desk
tests show the pattern ("every backend response to the worker conforms to the v0 schemas"). There
is no packaged backend conformance suite (error envelopes, timeouts) yet.

## 10. Risks of premature abstraction, and guardrails

| Risk                                                           | Guardrail                                                                                                            |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Port shaped by LiveKit leaks its concepts (rooms, jobs, `say`) | Port uses VoiceBridge terms only. Reviewed against Pipecat's model on paper, not in code.                            |
| Lowest-common-denominator API hides LiveKit strengths          | Capabilities are declared. Runtime-specific options stay in the adapter config (opaque to core).                     |
| Abstracting providers and transports VoiceBridge doesn't own   | Explicitly out of scope (§2). Provider config is runtime-owned.                                                      |
| Re-implementing LLM orchestration to "own" agent mode          | Forbidden. The core supplies tools and an executor only.                                                             |
| Speculative adapters rot untested                              | None built. One real adapter plus `FakeRuntime`. The port stays 0.x until a second real adapter.                     |
| Generic layers add latency or complexity                       | The port is plain in-process calls. No sidecar, broker, or queue.                                                    |
| Interface churn, or promising stability too early              | Wire contract stays **v0 experimental** until both example apps validate it. Then propose v1. The TS port stays 0.x. |

## 11. Testing strategy

### 11.1 Proving the core doesn't depend on LiveKit

1. **Static:** a Vitest test asserts `packages/core/package.json` has exactly `{ zod }` as runtime
   dependencies, and that no file under `packages/core/src` imports a non-relative module other
   than `zod` and `node:*`.
2. **Physical isolation (CI job `core-isolated`, `pnpm verify:core-isolation`):** the script
   `pnpm pack`s `@voicebridge/core` and `npm install`s the tarball (plus only the test runner) into
   an empty directory **outside** the workspace. It fails if any `@livekit/*` or other vendor
   package is present. It then imports the installed package and runs the full core test suite
   there. (`pnpm deploy --legacy` was tried and rejected: it installed the whole workspace
   lockfile, including `@livekit/*`.)

### 11.2 Minimal acceptance test: the core against a fake runtime

Runs in the isolated job, so LiveKit isn't installed. (Illustrative sketch. The implemented API is
in `packages/core` and its README.)

```ts
// packages/core/test/acceptance.fake-runtime.test.ts
import { runBackendControlledSession } from '@voicebridge/core';
import { FakeRuntime, inMemoryAdapter } from '@voicebridge/core/testing';

test('backend-controlled session runs end to end without any vendor runtime', async () => {
  const runtime = new FakeRuntime({ sessionRef: 'ref-test-1' }); // all capabilities on
  const adapter = inMemoryAdapter(async (turn, ctx, signal) =>
    turn.text === 'slow'
      ? new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)))
      : { kind: 'speak', text: `ack:${turn.text}:${ctx.sessionRef}` },
  );
  const events = runBackendControlledSession(runtime.session, adapter, { timeoutMs: 500 });
  runtime.attach(events);

  runtime.userSays('hello'); // exact text reaches the adapter
  await runtime.untilSpoken(1);
  runtime.userSays('slow'); // outstanding…
  runtime.userTypes('fast'); // …cancelled by a newer turn (text source)
  await runtime.untilSpoken(2);
  await runtime.end('client_left');

  expect(runtime.spoken).toEqual(['ack:hello:ref-test-1', 'ack:fast:ref-test-1']);
  expect(adapter.abortedTurns).toEqual(['t2']);
  expect(runtime.speakCallsAfterEnd).toBe(0);
});
```

The real test is `packages/core/test/acceptance.fake-runtime.test.ts`; the helper names differ
from this sketch (`inMemoryConversation`, `abortedTurnIds`).

### 11.3 What exists (offline, `pnpm test`, 471 tests at M5.6)

| Package                      | Tests | Covers                                                                                                                                                                       |
| ---------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core`              | 170   | Coordinator rules, HTTP limits and errors, tools, contracts, isolation, privacy of events, JSON Schema drift, and the 38 shape vectors (one test each)                       |
| `packages/livekit-tokens`    | 81    | Grants decoded from real JWTs, request shape, dispatch metadata, binding and recording failures                                                                              |
| `packages/runtime-livekit`   | 72    | Job ordering and verification with fake SDK bindings; plus tripwires that read or run the installed SDK (transcript logging levels, session and job lifecycle, interruption) |
| `examples/backend-help-desk` | 38    | Session store compare-and-set, idempotent start, per-turn checks, role separation, schema conformance of every response                                                      |
| `examples/host-token-route`  | 38    | Ignored browser fields, development identity guards, CORS, rate limits, size caps, log hygiene                                                                               |
| `examples/worker-livekit`    | 13    | Configuration, including the SDK log level default                                                                                                                           |
| `examples/web`               | 59    | Page lifecycle with mocked hooks, reconnect handling, transcripts, typed messages, accessibility, the components-react patch with real hooks                                 |

CI adds typecheck, lint, format, build with a bundle secret scan, a production smoke test, the
physical core isolation job, `pnpm audit`, and gitleaks. Not covered offline: latency, audio,
endpointing, real reconnection, the hold rule in a live race, and the fidelity of the structural
SDK fakes. The opt-in live harness (paid, never in CI) and the manual checklist cover part of that.

## 12. MVP acceptance criteria

Portability

1. `@voicebridge/core` has only `zod` as a runtime dependency, and the `core-isolated` CI job passes with no `@livekit/*` installed.
2. The fake-runtime acceptance test (§11.2) passes.
3. Wire contract v0 (experimental) is published as JSON Schema with conformance vectors, and both
   example backends pass them. Promotion to v1 is a separate, later decision.
4. The two example applications are selected by configuration only. Each implements only the
   capabilities it uses. The task list demonstrates authorization, confirmation, and idempotency.
5. The adapter-author and backend-author guides document the extension points (§9).

LiveKit implementation

6. Backend-controlled: speech in the Next.js example reaches the selected backend as the exact
   final transcript, and the reply is spoken verbatim. No LLM is configured.
7. A new turn cancels the outstanding request. No reply for a superseded turn is spoken.
8. Agent-controlled: the LLM calls an allowlisted tool. Unknown tools and invalid arguments never reach the backend.
9. Typed text works in both modes. Switching models is a config change only.

Security and quality

10. Tokens are minted server-side and contain no credentials. `record` is explicit and `false` by default.
11. Timeouts, errors, oversized and invalid replies produce the generic fallback (unit tests).
12. gitleaks, typecheck, lint, format, and tests pass in CI on Node 24. Public APIs have TSDoc and tests.
13. README documents limitations honestly, including the LiveKit Model License weights.

## 13. Implementation plan and schedule

| Dates   | Step                                                                                                                                                                                       | Exit check                                       |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| done    | M0 repo hygiene (`4662541`), M0.5 LiveKit spikes (§16)                                                                                                                                     |                                                  |
| 1–2 Nov | **M1 core (done 31 Oct, approved):** workspace, wire schemas + vectors, contracts, coordinator, tool registry/executor, HTTP adapter, events, `FakeRuntime`, acceptance test, isolation CI | §11 green                                        |
| 3 Nov   | **M2 livekit-tokens (done 31 Oct, approved):** token minting (server-named rooms, minimal grants, `sessionRef`-only dispatch metadata)                                                     | JWT decode tests                                 |
| 4–5 Nov | **M3 runtime-livekit, backend mode (done 31 Oct, approved):** port, providers, session context, text callback, `record:false`, log default                                                 | Unit tests + harness run                         |
| 31 Oct  | **M4 examples (done, approved):** help-desk backend, host token route, LiveKit worker. Starter `src/`, ai-coustics, Dockerfile, and starter scenarios removed                              | 63 example tests + live e2e                      |
| 1 Nov   | **M5 browser (done, approved):** Next.js client calling the host token route directly (exact-origin CORS, no proxy), LiveKit React components, typed questions on `lk.chat`                | 56 web tests + live browser e2e (synthetic mic)  |
| 1 Nov   | **M5.5 release-readiness audit (done, approved):** security and licence audit, dev-identity hardening, SDK error patch, CI pinning, release docs for `v0.1.0-alpha.1`                      | Clean-clone verification, no LiveKit credentials |
| 2 Nov   | **M5.6 release risk remediation:** SDK transcript logging (worker defaults to SDK `error`), lifecycle and interruption verification, documentation corrected to match the code             | 471 offline tests incl. SDK tripwires            |
| then    | **M6 agent mode** + task-list example (authorization, confirmation, idempotency), tool bridge, preemptive opt-in flag                                                                      | Unit tests + harness                             |
| 10 Nov  | **M7 docs**                                                                                                                                                                                | Acceptance checklist                             |

Milestone order changed at M4 to put a working browser demonstration before agent-controlled mode.
Backend-controlled mode in the browser, plus the portability proof, is the minimum scope.

## 14. Licensing, dependency, and security concerns

| #   | Concern                                                                                                                                                                                                                                                                                                                                                              | Status / action                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Starter code MIT © LiveKit                                                                                                                                                                                                                                                                                                                                           | Done: Apache-2.0 + `NOTICE`.                                                                                                                                                                                                                                                                                                                                                                                                                |
| 2   | `@livekit/plugins-ai-coustics` proprietary                                                                                                                                                                                                                                                                                                                           | Done (M4): removed with the starter agent.                                                                                                                                                                                                                                                                                                                                                                                                  |
| 3   | `@livekit/local-inference` (LiveKit Model License) is a hard dependency of `@livekit/agents`, and the main worker process always loads it **[source][run]**                                                                                                                                                                                                          | Isolated to `runtime-livekit`. Never a `core` dependency. Documented for image publishers.                                                                                                                                                                                                                                                                                                                                                  |
| 4   | `@livekit/av-*` LGPL binaries                                                                                                                                                                                                                                                                                                                                        | Noted for image publishers.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 5   | Pipecat (if adopted later) is BSD-2-Clause                                                                                                                                                                                                                                                                                                                           | Compatible with Apache-2.0. Its provider plugins vary.                                                                                                                                                                                                                                                                                                                                                                                      |
| 6   | Recording on by default in the LiveKit SDK                                                                                                                                                                                                                                                                                                                           | Explicit `record:false` (adapter obligation, unit test).                                                                                                                                                                                                                                                                                                                                                                                    |
| 7   | Credentials in client-visible tokens or metadata                                                                                                                                                                                                                                                                                                                     | Forbidden. `sessionRef` + service credential.                                                                                                                                                                                                                                                                                                                                                                                               |
| 8   | PII in local SDK logs                                                                                                                                                                                                                                                                                                                                                | See #23: transcripts reach local SDK logs at WARN and below. Example worker runs the SDK at `error`. Core events and VoiceBridge logs are PII-free.                                                                                                                                                                                                                                                                                         |
| 9   | `@livekit/protocol` version skew                                                                                                                                                                                                                                                                                                                                     | Import from `livekit-server-sdk` re-exports.                                                                                                                                                                                                                                                                                                                                                                                                |
| 10  | Preemptive generation with tools                                                                                                                                                                                                                                                                                                                                     | Off by default. Verified for 1.9.5 only.                                                                                                                                                                                                                                                                                                                                                                                                    |
| 11  | Prompt injection steering tool choice                                                                                                                                                                                                                                                                                                                                | Inherent. Allowlist + validation + backend authorization.                                                                                                                                                                                                                                                                                                                                                                                   |
| 12  | Credentials exposed outside the secret store                                                                                                                                                                                                                                                                                                                         | Rotate immediately; never commit `.env*` files.                                                                                                                                                                                                                                                                                                                                                                                             |
| 13  | `allowBuilds` ignored by pnpm 10                                                                                                                                                                                                                                                                                                                                     | Done (M1): `onlyBuiltDependencies`.                                                                                                                                                                                                                                                                                                                                                                                                         |
| 14  | LiveKit's reference token endpoint honours client-sent `room_name`, `participant_identity`, and `room_config` (agent name and metadata) **[docs]**                                                                                                                                                                                                                   | `livekit-tokens` accepts only `{applicationId, sessionRef}` from server-derived context. The endpoint must ignore client fields (README).                                                                                                                                                                                                                                                                                                   |
| 15  | Grant enforcement is silent on the client: refused camera/screen publishes never complete, and data sent without `canPublishData` resolves locally but is dropped by the server **[run]**                                                                                                                                                                            | Frontends must not offer those controls or treat `sendText` success as delivery.                                                                                                                                                                                                                                                                                                                                                            |
| 16  | ~~The worker can't yet verify `sessionRef` server-side~~                                                                                                                                                                                                                                                                                                             | Resolved (M3): `verifyLiveKitSession` calls the authorizing `sessions/start` with the actual room before connecting, and fails closed.                                                                                                                                                                                                                                                                                                      |
| 17  | Revocation mid-call                                                                                                                                                                                                                                                                                                                                                  | Partly addressed (M4): the help-desk backend re-checks the session on every turn and answers `{ kind: "end" }`, so revocation takes effect **at the next turn** (verified live). Not instant: immediate termination would need participant removal via LiveKit's server API, or worker-side status checks. Not implemented.                                                                                                                 |
| 18  | LiveKit may restart a failed job (`JRP_ON_FAILURE`), calling `sessions/start` again                                                                                                                                                                                                                                                                                  | `sessions/start` must be idempotent per `sessionRef` (the `Idempotency-Key` is per job). Not verified live whether a restarted job keeps its id. If it does, turn keys (`{jobId}:t1`, …) would repeat for different turns after a restart, which matters only for backends that cache by `Idempotency-Key` (the help desk doesn't). Post-release fix: add a per-run nonce.                                                                  |
| 19  | The SDK's own logger writes transcripts at DEBUG (`dev` default)                                                                                                                                                                                                                                                                                                     | Superseded by #23. A live run at `info` (M3) showed no transcripts, but WARN-level transcript statements exist and were observed.                                                                                                                                                                                                                                                                                                           |
| 20  | `useSession` (components-react 2.9.24) fetches credentials on mount (`prepareConnection`), on `end()`, and after unexpected disconnects **[source]**                                                                                                                                                                                                                 | Each fetch would create a backend session. The web example fetches once per Start and passes `TokenSource.literal`.                                                                                                                                                                                                                                                                                                                         |
| 21  | During a full reconnect livekit-client drops remote participants before reporting `Reconnecting`; `useAgent` then reports `failed` and stays `failed` **[run][source]**                                                                                                                                                                                              | Observed live (it ended a conversation). The web example decides "agent ended" from agent presence plus room state, with a 2 s grace period.                                                                                                                                                                                                                                                                                                |
| 22  | `@livekit/components-react` 2.9.24 (bundling components-core 0.12.15 and RxJS) reads text streams with `subscribe(next)` and no error handler, so an abnormally ended stream (`DataStreamError` AbnormalEnd, room closed mid-reply) is rethrown by RxJS from a timer as an **uncaught exception**, not a promise rejection **[run][source]**                         | Upstream fix open: components-js#1426. A local pnpm patch to components-react absorbs only that error and rethrows all others (`patches/README.md`, regression tests in `examples/web/test/sdk-patch.test.tsx`). The M5 `unhandledrejection` filter never matched and was removed.                                                                                                                                                          |
| 23  | `@livekit/agents` 1.9.5 writes raw user transcripts to **local** logs at WARN (`lk.pii.user_input` in "skipping user input, speech scheduling is paused" and three similar statements), not only at DEBUG. Session teardown triggers it whenever a user turn is pending at close. The SDK redacts `lk.pii.*` only for cloud telemetry export **[source][unit][run]** | Mitigated (M5.6): the example worker sets `LOG_LEVEL=error` by default (no known 1.9.5 transcript statement at `error`), drops the hard-coded `--log-level warn`, and prints a warning when a lower level is chosen. Tripwire tests run the real SDK statement with a synthetic transcript and fail if the SDK changes. Lower levels must be treated as sensitive logs. Integrators running their own worker must set the level themselves. |
| 24  | Closing the `AgentSession` (user left) doesn't end the job **[source]**                                                                                                                                                                                                                                                                                              | Not a leak: STT and TTS are released on session close, and LiveKit closes the room once the last non-agent participant leaves, which ends the job **[docs]** (tripwire tests in `runtime-livekit`). The delay (room departure timeout) is unmeasured.                                                                                                                                                                                       |

## 15. Known limitations and trade-offs

- **One runtime.** Portability is proven by a fake runtime and the wire contract, not by a second
  real adapter. The runtime port is 0.x and will change when a second runtime is built.
- **LiveKit Cloud by default** for the LiveKit adapter (Inference). Self-hosting uses plugins.
- **No provider abstraction.** Switching providers is a runtime-adapter config change.
- **Backend latency is user-perceived**, there's no streaming in the MVP, and the agent shows
  `listening` while the backend works. End-to-end latency hasn't been measured yet.
- **Turn-taking quality is the runtime's** (endpointing, adaptive interruption).
- **Conversation memory belongs to the backend** in backend-controlled mode.
- **`sessionRef` has no refresh** in the MVP. The help desk ends a session whose TTL (30 min) expired at its next turn.
- **Revocation takes effect at the next turn**, and there is no idle or maximum-duration limit in the worker.
- **Local SDK logs** contain transcripts at WARN and below (§14 #23).
- **Prompt injection** can't be fully prevented in agent mode.
- **LiveKit-licensed model weights** ship with any LiveKit-runtime install.
- **1:1 sessions only.**

## 16. M0.5 LiveKit spike results

| Spike | Question                                         | Result                      | Evidence                                                                                                                                                                                   |
| ----- | ------------------------------------------------ | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1.1   | `onUserTurnCompleted` without an LLM             | **Pass**                    | [source][run] Hook fired every turn. `generateReply`/`run()` throw without an LLM.                                                                                                         |
| 1.2   | Exact final transcript reaches backend           | **Pass**                    | [run] Backend log equals the hook's transcript, including multi-segment turns.                                                                                                             |
| 1.3   | `say()` speaks backend text without rewriting    | **Pass**                    | [run] Agent transcript identical to backend text (marker phrases).                                                                                                                         |
| 1.4   | Response associated with the conversation        | **Pass, with caveat**       | [run] The assistant item is added to history, but **not the user item**. Association by VoiceBridge `turnId`.                                                                              |
| 1.5   | Interruptions                                    | **Pass**                    | [run] `interrupted: true`, truncated history text. Interruption latency follows SDK adaptive settings.                                                                                     |
| 1.6   | New turn cancels outstanding request             | **Pass**                    | [run] Backend saw `client_aborted`. The SDK serializes hooks, so the hook must not await.                                                                                                  |
| 1.7   | Late cancelled responses never spoken            | **Pass with the hold rule** | [run][unit] Sequence guard discarded a late reply. One race (reply ready before the next turn is committed) needed the hold rule. That rule is unit-tested, not yet reproduced end to end. |
| 1.8   | Errors and timeouts                              | **Pass**                    | [run] 500 and timeout gave the fallback, backend body not leaked, abort propagated.                                                                                                        |
| 2.1   | Typed text through the same adapter              | **Pass**                    | [run] Custom `textInputCallback`. Default handler fails without an LLM. Must call `session.interrupt()`.                                                                                   |
| 2.2   | Tool side effects in discarded speculative turns | **Pass for 1.9.5**          | [source][run] Speculative tool call emitted but not executed. `llmNode` and LLM inference do run speculatively.                                                                            |
| 3.1   | Job metadata from `JobContext`                   | **Pass**                    | [run] `ctx.job.metadata`.                                                                                                                                                                  |
| 3.2   | Explicit dispatch                                | **Pass**                    | [run] Dispatch via token `roomConfig`. No dispatch without it.                                                                                                                             |
| 3.3   | Token dispatch only on room creation             | **Pass**                    | [run] Pre-created room: no agent, no job.                                                                                                                                                  |
| 3.4   | Permissions and metadata visibility              | **Pass (findings)**         | [run] JWT fully client-readable. Participant fields visible to all participants. Dispatch metadata not visible to others. Locked metadata edits silently ignored.                          |
| 4.1   | `record:false` prevents upload                   | **Pass (local evidence)**   | [source][docs][run] No upload path executed. Dashboard confirmation is a manual step for the maintainer.                                                                                   |
| 4.2   | Data outside that mechanism                      | **Findings**                | [source][run] Local logs contain transcripts (DEBUG), tool args (INFO), user input (some WARN). Egress is separate.                                                                        |
| 4.3   | Provider retention                               | **Documented**              | [docs] Inference is zero retention. Own plugin accounts follow provider policies.                                                                                                          |
| 4.4   | Project override of recording                    | **Pass**                    | [source][docs] Explicit `record` wins. Project-off uploads nothing regardless.                                                                                                             |
| 4.5   | VAD-only avoids restricted weights               | **Fail**                    | [source][run] VAD is Silero in the same LiveKit-licensed binary. The main process always loads it.                                                                                         |
| 4.6   | Redistribution restrictions                      | **Documented**              | `@livekit/local-inference` (LiveKit Model License), ai-coustics (proprietary), `@livekit/av-*` (LGPL). See §14.                                                                            |

### 16.1 Manual checks

**Verified manually by the maintainer on 2026-11-01** with a real microphone and speakers (browser
and version not recorded). Items refer to
[the manual checklist](releases/v0.1.0-alpha.1-manual-checklist.md):

- 1: permission prompt, Listening, welcome message heard
- 3: audible answer matching the transcript
- 4: interruption: speech stops promptly, transcript shows only what was spoken
- 5: End Conversation while the agent is speaking: no `DataStreamError`
- 6: fresh session after ending

Items 2 (microphone denied), 7 (autoplay fallback), 9 (microphone indicator), and 10 (dashboard
privacy) are **not independently verified**.

**Still unverified.** Nothing above should be read as covering these:

1. **Network interruption and reconnection** (checklist item 8), with a real drop.
2. **Job lifetime after the user leaves** (LiveKit room departure timeout), not measured.
3. **Perceived latency** (speech end to first audio) and interruption latency. Not measured.
4. **Recording-enabled control run** (synthetic data only), pending maintainer approval.
5. **Hold rule end to end:** unit-tested only. The timing wasn't reproduced in a live run.
6. **Streaming speech** via `say(ReadableStream)`: source-level only.

### 16.2 M3 live harness results (2026-10-31, synthetic data, `@livekit/agents` 1.9.5)

| Scenario                                    | Observed                                                                                                                                                        |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| basic                                       | Authorized `sessions/start` (room binding, `Idempotency-Key: {jobId}:start`, called once), greeting spoken, turn routed, reply spoken verbatim (length matched) |
| revoked / expired / wrong-room / forged-ref | Backend refused (`revoked` / `expired` / `room_mismatch` / `unknown`). Worker logged only `session_not_authorized` and **no agent joined the room**             |
| bad-metadata                                | Worker refused (`invalid_dispatch_metadata`) before any backend call. No agent joined                                                                           |
| text                                        | Typed `lk.chat` routed with `source: text`, reply spoken                                                                                                        |
| cancel / stale                              | New turn superseded the outstanding request, backend saw the abort, the late reply was dropped, and only the new answer was spoken                              |
| errors                                      | 500 → generic fallback. 12 s backend vs 8 s timeout → abort plus fallback                                                                                       |
| delayed                                     | 6 s backend delay, then the approved reply was spoken                                                                                                           |
| worker log at `info` (713 lines)            | 0 transcripts, replies, session refs, or credentials                                                                                                            |

With a 1.2 s gap between utterances, the turn detector merged them into a single turn. With 3 s, it
produced two turns. Endpointing is model-based and varies between runs.

### 16.3 M4 end-to-end results (2026-10-31, synthetic data, three example services plus LiveKit Cloud)

| Scenario                               | Observed                                                                                                                                                                                                                                                                                                                     |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| conversation                           | Host issued a token (dev identity, browser fields ignored). Backend authorized start (`firstStart: true`). Greeting, opening hours, returns, typed delivery question, then goodbye. Every agent transcript was identical to the FAQ text. Goodbye ended the session, the agent left, and the backend received `sessions/end` |
| revoke                                 | After host revocation the agent **remained in the room** (checked 3 s later). On the next user turn the backend answered the inactive message, and the agent spoke it and left                                                                                                                                               |
| logs (backend, host, worker at `warn`) | 0 credentials, LiveKit secrets, session refs, tokens, or user text                                                                                                                                                                                                                                                           |
| health                                 | SDK health `GET /` 200. `GET /worker` exposes agent name, job count, and SDK version only                                                                                                                                                                                                                                    |

## 17. Starter disposition

Removed in M4. `examples/worker-livekit` replaced the starter agent in `src/`. The assistant prompt, greeting, `expressive`, keyterms, and ai-coustics are
starter-specific and won't enter any package.
