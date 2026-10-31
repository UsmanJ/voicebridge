# VoiceBridge architecture

> Status: **design under review, nothing implemented yet.** VoiceBridge is a working title.
> The key decision is recorded in [ADR 0001](adr/0001-provider-neutral-core.md) (Accepted).
> LiveKit facts were checked against `@livekit/agents` 1.9.5, `livekit-server-sdk` 2.19.2, and
> LiveKit docs on 2026-10-31. Spike results are in §16, raw evidence in `spikes/m05/` on branch `spike/m0.5`.
>
> Evidence labels: **[source]** read in installed SDK source, **[docs]** vendor documentation,
> **[run]** observed in an actual M0.5 execution.

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
 │   • implements RuntimeSession: user turns in, speak/interrupt out        │
 │   • bridges ToolRegistry → native function calling (agent mode)          │
 ├──────────────────── runtime port (TS, 0.x, minimal) ─────────────────────┤
 │ @voicebridge/core  (zod only, no vendor deps)                            │
 │   • application contracts + wire schemas (JSON Schema export)            │
 │   • turn coordinator (backend-controlled mode)                           │
 │   • tool registry + validated, authorized executor (agent mode)          │
 │   • policy: timeouts, size caps, fallbacks, URL rules                    │
 │   • observability events (PII-free) · testing: FakeRuntime, conformance  │
 ├──────────────────── wire contract (HTTP JSON, v0 experimental) ───────────────────────┤
 │ Application backend (any language) ── examples: two interchangeable ones │
 └──────────────────────────────────────────────────────────────────────────┘
 Session tokens: @voicebridge/livekit-tokens (runtime-specific, server-side only)
```

## 4. Repository boundaries

| Path                         | Package                        | Allowed dependencies                 | Purpose                                                                                                                                                                |
| ---------------------------- | ------------------------------ | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core`              | `@voicebridge/core`            | `zod` **only**                       | Contracts, wire schemas, coordinator, tool registry/executor, HTTP adapter, policy, events. `./testing` subpath: `FakeRuntime`, conformance suites, wire test vectors. |
| `packages/runtime-livekit`   | `@voicebridge/runtime-livekit` | `core`, `@livekit/agents`            | LiveKit Agents runtime adapter and LiveKit provider config.                                                                                                            |
| `packages/livekit-tokens`    | `@voicebridge/livekit-tokens`  | `livekit-server-sdk`                 | Server-side token minting for app servers and Next.js routes. Never pulls `@livekit/agents`.                                                                           |
| `examples/backend-help-desk` | (private)                      | Node built-ins only                  | Example backend A: deterministic, backend-controlled replies (FAQ-style).                                                                                              |
| `examples/backend-task-list` | (private)                      | Node built-ins only                  | Example backend B: in-memory task list exposing tools (agent mode) and a `turns` endpoint. Fake data.                                                                  |
| `examples/worker-livekit`    | (private)                      | `runtime-livekit`, `core`            | Runnable worker: env config → mode + backend URL. Replaces `src/`.                                                                                                     |
| `examples/web-nextjs`        | (private)                      | `livekit-tokens`, LiveKit client SDK | Browser client plus token route.                                                                                                                                       |
| `docs/`, `docs/adr/`         |                                |                                      | Architecture, decisions, adapter-author and backend-author guides.                                                                                                     |

Both example backends implement the **full** wire contract, so either can be selected by changing
one URL in worker config. That demonstrates interchangeability.

Boundary rules, enforced by tests (§11.1):

- `core` may not import any `@livekit/*`, `livekit-*`, or other vendor package, nor Node-only
  modules beyond `node:` built-ins needed for `fetch`/timers. It runs on Node 24.
- Runtime adapters may not depend on each other. Examples may not be imported by packages.
- Provider names, model ids, and transport options appear only in runtime adapters and examples.

### 4.1 Example applications

Both are synthetic, in-memory, and dependency-free. Each implements only the capabilities it needs.

**Help desk (backend-controlled).** A deterministic knowledge service: `turns` maps questions to
approved answers from a fixed synthetic FAQ, so the reply is fully predictable and spoken
verbatim. No tools, no LLM.

**Task list (agent-controlled).** Tools over a per-user, in-memory task list. It shows the patterns
any modifying backend should follow:

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

| Call                                                     | Request                                                                     | Response                                                                  |
| -------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `POST {base}/v0/turns` (if backend-controlled supported) | `{ turnId, sessionRef, text, source: "speech" \| "text" }`                  | `{ kind: "speak", text } \| { kind: "silent" } \| { kind: "end", text? }` |
| `POST {base}/v0/sessions/start` (optional)               | `{ sessionRef }`                                                            | Same reply union (greeting)                                               |
| `POST {base}/v0/sessions/end` (optional, best effort)    | `{ sessionRef, reason }`                                                    | `204`                                                                     |
| `POST {base}{toolPath}` (per registered tool)            | `{ invocationId, sessionRef, arguments }` (arguments already Zod-validated) | `{ ok: true, result } \| { ok: false, error: { code, publicMessage? } }`  |

Headers on every call:

- `Authorization: Bearer <service credential>`: one credential **per application**,
  least privilege, identifying the VoiceBridge worker to that application only
- `VoiceBridge-Version: 0`
- `VoiceBridge-Request-Id`
- `Idempotency-Key`, on tool calls (= `invocationId`) and turns (= `turnId`)

Tool paths come from registration config, never from LLM output. Limits on every call: timeout,
maximum response bytes, schema validation.

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
  readonly sessionId: string; // VoiceBridge-assigned, for correlation
  readonly sessionRef: string; // opaque app-issued id, resolved and authorized server-side
}
interface UserTurn {
  readonly turnId: string;
  readonly text: string; // exact final transcript or typed text
  readonly source: 'speech' | 'text';
}
type BackendReply =
  { kind: 'speak'; text: string } | { kind: 'silent' } | { kind: 'end'; text?: string };

/** One application = one backend binding. All capabilities optional. */
interface Application {
  readonly applicationId: string;
  readonly conversation?: ConversationAdapter; // backend-controlled mode
  readonly tools?: ToolRegistry; // agent-controlled mode (allowlist)
}
interface ConversationAdapter {
  respond(turn: UserTurn, ctx: SessionContext, signal: AbortSignal): Promise<BackendReply>;
  start?(ctx: SessionContext, signal: AbortSignal): Promise<BackendReply>;
  end?(ctx: SessionContext, reason: SessionEndReason): Promise<void>;
}
interface ToolDefinition<I extends z.ZodType, O extends z.ZodType> {
  name: string; // /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/
  description: string; // app-supplied
  effect: 'read' | 'write'; // write = modifies backend state
  input: I; // LLM args validated (strict) before execute
  output: O; // backend result validated before the LLM sees it
  timeoutMs?: number;
  execute(input: z.infer<I>, ctx: ToolCallContext): Promise<z.infer<O>>;
}
interface ToolCallContext {
  readonly session: SessionContext; // injected, never from LLM arguments
  readonly invocationId: string; // idempotency key
  readonly signal: AbortSignal;
}
```

`createHttpBackend({ applicationId, baseUrl, serviceCredential, ... })` binds one application to
one backend. It provides `.conversation()` and `.tool({...})` over the wire contract. Applications
written in TS can also implement the interfaces in-process.

### 5.3 Runtime port (TypeScript, in `core`, 0.x)

The minimal surface a runtime adapter implements. Every value is JSON-serializable except the
callbacks, so the same shape could later be carried over a socket (§9.3).

```ts
interface RuntimeCapabilities {
  interruption: 'none' | 'programmatic' | 'barge-in'; // can speech be stopped, and by the user's voice?
  textInput: boolean; // typed user input
  pendingTurnSignal: boolean; // emits final transcripts before the turn is committed
  streamingSpeech: boolean; // speak() accepts incremental text
  trustedSessionContext: boolean; // can deliver server-minted session context
  nativeToolCalling: boolean; // runtime LLM can invoke registered tools
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
  onFinalTranscriptPending?(): void; // only if capabilities.pendingTurnSignal
  onEnded(reason: SessionEndReason): void;
}
```

The core exposes `runBackendControlledSession(session, adapter, options): RuntimeEvents` and
`createToolExecutor(registry, options)`. The runtime adapter wires its SDK events to the returned
handlers. The core never calls a vendor API.

### 5.4 Observability events and errors

- `VoiceBridgeEvent` union: `session_started`, `turn_started`, `backend_request`,
  `backend_failed {reason}`, `turn_cancelled`, `reply_stale_discarded`, `reply_held`,
  `speech_started`, `speech_finished {interrupted}`, `tool_invoked {name, outcome}`,
  `session_ended`. **PII-free by default:** ids, durations, outcomes, and text lengths, never text.
  Sink: `(event) => void`. Runtime adapters may forward events to their own telemetry.
- Error taxonomy: `BackendUnavailable`, `BackendTimeout`, `BackendRejected`, `InvalidBackendReply`,
  `ToolNotAllowed`, `InvalidToolArguments`, `ConfigError`. Each carries an internal cause
  (redacted in logs) and maps to a public, generic fallback.

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

### 6.2 Agent-controlled (LLM + allowlisted tools)

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

| Capability missing       | Core behaviour                                                                                            |
| ------------------------ | --------------------------------------------------------------------------------------------------------- |
| `interruption: none`     | Backend requests are still cancelled on new turns, but speech can't be stopped. Documented UX limitation. |
| `textInput: false`       | Typed input is unavailable. The adapter reports it at startup.                                            |
| `pendingTurnSignal`      | Hold rule disabled. Sequence guard only, with a small known race window.                                  |
| `streamingSpeech: false` | Replies are spoken whole (the MVP does this everywhere).                                                  |
| `trustedSessionContext`  | **Session won't start.** Without a trusted channel for `sessionRef`, there's no safe identity (§8).       |
| `nativeToolCalling`      | Agent-controlled mode is unavailable on that runtime. Backend-controlled mode still works.                |

LiveKit Agents 1.9.5 status: barge-in interruption, text input (custom callback), pending-turn signal
(final `user_input_transcribed`), trusted session context (job metadata), and native tool calling
were observed **[run]**. Streaming speech (`say()` accepts a `ReadableStream`) is **[source]** only,
not exercised.

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
| Local log level/PII guidance                                                                                                                                                                                             | adapter obligation (LiveKit: `warn` default in production)      |

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
Local SDK logs contain transcripts (DEBUG) and tool arguments (INFO) regardless of `record`.
LiveKit Inference is zero-retention with providers. Self-supplied plugin accounts follow their own policies.

## 9. Extension points

### 9.1 Adding a runtime adapter (documented, not built)

1. Implement `RuntimeSession` and wire SDK events to `RuntimeEvents`.
2. Declare `RuntimeCapabilities` honestly.
3. Deliver `SessionContext` from a trusted, server-minted channel.
4. Bridge `ToolRegistry` to native function calling if supported.
5. Meet the §8 adapter obligations.
6. Pass `@voicebridge/core/testing` runtime conformance plus wire test vectors.

### 9.2 How a future Pipecat adapter would talk to the core

Recommended: **no runtime link to the TypeScript core.** A Python package (`voicebridge-pipecat`)
would:

- implement the **wire contract** (§5.1) against the same application backends
- port the coordinator (about 150 lines), with behaviour pinned by the shared JSON test vectors
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

Implement the wire contract in any language and run `@voicebridge/core/testing`'s backend
conformance suite against it (it exercises schema, error envelope, and timeout behaviour).

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
2. **Physical isolation (CI job `core-isolated`):** `pnpm deploy --filter @voicebridge/core <dir>`
   produces a directory containing only core's dependencies. The job asserts
   `node_modules/@livekit` is absent there, then runs core's test suite in it.

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

Further suites: the coordinator rules (ported from the 8 spike tests), wire test vectors (both
example backends must pass), a tool executor allowlist/validation test, and an opt-in live harness
for LiveKit (paid, never in CI).

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

| Dates   | Step                                                                                                                                                               | Exit check                                  |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| done    | M0 repo hygiene (`4662541`), M0.5 LiveKit spikes (§16)                                                                                                             |                                             |
| 1–2 Nov | **M1 core:** workspace, wire schemas + vectors, contracts, coordinator, tool registry/executor, HTTP adapter, events, `FakeRuntime`, acceptance test, isolation CI | §11 green                                   |
| 3 Nov   | **M2 livekit-tokens:** token minting (server-named rooms, minimal grants, `sessionRef`-only dispatch metadata)                                                     | JWT decode tests                            |
| 4–5 Nov | **M3 runtime-livekit, backend mode:** port, providers, session context, text callback, `record:false`, log default                                                 | Unit tests + harness run                    |
| 6 Nov   | **M5 examples:** both backends, LiveKit worker. Remove `src/` and ai-coustics                                                                                      | Backends swap by config, vectors pass       |
| 7–8 Nov | **M6 Next.js** browser client + token route                                                                                                                        | Manual browser voice test                   |
| 9 Nov   | **M4 agent mode:** tool bridge, preemptive opt-in flag                                                                                                             | Unit tests + speculative-tool harness check |
| 10 Nov  | **M7 docs**                                                                                                                                                        | Acceptance checklist                        |

If the schedule slips, agent mode (M4) moves to a later milestone. Backend-controlled mode in
the browser plus the portability proof is the minimum scope.

## 14. Licensing, dependency, and security concerns

| #   | Concern                                                                                                                                                     | Status / action                                                                            |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 1   | Starter code MIT © LiveKit                                                                                                                                  | Done: Apache-2.0 + `NOTICE`.                                                               |
| 2   | `@livekit/plugins-ai-coustics` proprietary                                                                                                                  | Remove in M5. Optional and operator-injected.                                              |
| 3   | `@livekit/local-inference` (LiveKit Model License) is a hard dependency of `@livekit/agents`, and the main worker process always loads it **[source][run]** | Isolated to `runtime-livekit`. Never a `core` dependency. Documented for image publishers. |
| 4   | `@livekit/av-*` LGPL binaries                                                                                                                               | Noted for image publishers.                                                                |
| 5   | Pipecat (if adopted later) is BSD-2-Clause                                                                                                                  | Compatible with Apache-2.0. Its provider plugins vary.                                     |
| 6   | Recording on by default in the LiveKit SDK                                                                                                                  | Explicit `record:false` (adapter obligation, unit test).                                   |
| 7   | Credentials in client-visible tokens or metadata                                                                                                            | Forbidden. `sessionRef` + service credential.                                              |
| 8   | PII in local SDK logs                                                                                                                                       | Adapter guidance: `warn` in production. Core events are PII-free.                          |
| 9   | `@livekit/protocol` version skew                                                                                                                            | Import from `livekit-server-sdk` re-exports.                                               |
| 10  | Preemptive generation with tools                                                                                                                            | Off by default. Verified for 1.9.5 only.                                                   |
| 11  | Prompt injection steering tool choice                                                                                                                       | Inherent. Allowlist + validation + backend authorization.                                  |
| 12  | Credentials exposed outside the secret store                                                                                                                | Rotate immediately; never commit `.env*` files.                                            |
| 13  | `allowBuilds` ignored by pnpm 10                                                                                                                            | Normalise in M1.                                                                           |

## 15. Known limitations and trade-offs

- **One runtime.** Portability is proven by a fake runtime and the wire contract, not by a second
  real adapter. The runtime port is 0.x and will change when a second runtime is built.
- **LiveKit Cloud by default** for the LiveKit adapter (Inference). Self-hosting uses plugins.
- **No provider abstraction.** Switching providers is a runtime-adapter config change.
- **Backend latency is user-perceived**, there's no streaming in the MVP, and the agent shows
  `listening` while the backend works.
- **Turn-taking quality is the runtime's** (endpointing, adaptive interruption).
- **Conversation memory belongs to the backend** in backend-controlled mode.
- **`sessionRef` has no refresh** in the MVP. Sessions outliving its TTL fail backend calls.
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

### 16.1 Outstanding manual checks (not yet verified)

These remain **unverified**. Nothing above should be read as covering them:

1. **Human microphone test** through the Agent Console or a browser: perceived interruption
   latency and naturalness, and the "slow then quick" cancellation with a real voice.
2. **Observability dashboard** confirmation that `record: false` sessions show no transcript,
   audio, traces, or logs. Also the project's Agent observability and PII redaction settings.
3. **Recording-enabled control run** (synthetic data only), pending maintainer approval.
4. **Hold rule end to end:** unit-tested only. The timing wasn't reproduced in a live run.
5. **Streaming speech** via `say(ReadableStream)`: source-level only.

## 17. Starter disposition (unchanged from M0)

The LiveKit starter in `src/` remains a runnable baseline until M5, when `examples/worker-livekit`
replaces it. The assistant prompt, greeting, `expressive`, keyterms, and ai-coustics are
starter-specific and won't enter any package.
