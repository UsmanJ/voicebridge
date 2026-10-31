# VoiceBridge architecture

> Status: **proposal**, nothing below is implemented yet. VoiceBridge is a working title.
> SDK facts were checked against `@livekit/agents` 1.9.5 and LiveKit docs on 2026-10-31.
> Anything marked **SPIKE** is an assumption that must be verified in code before we rely on it.

## 1. Purpose

VoiceBridge is a reusable gateway that puts a real-time voice interface (LiveKit) in front of an
existing application backend with minimal integration code.

The application keeps owning its data, business rules, authorization, and state. VoiceBridge owns
audio transport, speech recognition, turn-taking, speech synthesis, and (optionally) LLM
orchestration over tools that the application explicitly registers.

### Non-goals (for now)

- A hosted service, dashboard, or multi-tenant control plane.
- Databases, queues, caches, or any persistence of its own.
- Telephony, mobile, and IoT clients (the design must not block them, but browser comes first).
- Bundled application prompts, personas, or domain logic.
- Production readiness claims. The MVP is a working, tested reference implementation.

## 2. What the starter gives us

The repo was scaffolded from `livekit-examples/agent-starter-node` (MIT, © LiveKit, Inc.).

| Item                                                                                            | Verdict                      | Notes                                                                                                               |
| ----------------------------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `AgentSession` pipeline setup in `src/main.ts` (STT, TTS, turn detector, preemptive generation) | **Reuse, generalize**        | Becomes provider config in the agent runtime. Model ids move out of code.                                           |
| `cli.runApp(new ServerOptions({ agent, agentName }))` worker bootstrap                          | **Reuse**                    | Lives in the example worker, not in a library package.                                                              |
| `defineAgent({ entry })` + `session.start({ agent, room })`                                     | **Reuse**                    | Core of the agent runtime.                                                                                          |
| `Agent.create({ instructions, llm, tools })`                                                    | **Reuse**                    | Agent-controlled mode only.                                                                                         |
| The assistant prompt in `src/agent.ts`                                                          | **Starter-specific, remove** | App-flavored instructions must not live in core. A neutral default may be provided by the example, not the library. |
| Greeting via `generateReply({ instructions: 'Greet the user…' })`                               | **Starter-specific**         | Becomes an optional adapter hook.                                                                                   |
| `expressive: true`                                                                              | **Starter-specific**         | Injects TTS markup instructions into the LLM prompt. Meaningless in backend mode. Opt-in only.                      |
| `keytermsOptions: { keyterms: ['LiveKit'] }`                                                    | **Starter-specific**         | Becomes optional config.                                                                                            |
| ai-coustics noise cancellation plugin                                                           | **Make optional**            | Proprietary licence, LiveKit Cloud only (see §11).                                                                  |
| `scenarios.yaml` (3 generic assistant scenarios)                                                | **Replace**                  | Keep the simulation workflow. Rewrite scenarios against the reference backend.                                      |
| `src/agent.test.ts` (fully commented out)                                                       | **Replace**                  | Real Vitest suites per package.                                                                                     |
| `Dockerfile`                                                                                    | **Reuse later**              | Paths change with the monorepo layout.                                                                              |
| `.github/workflows/tests.yml`                                                                   | **Reuse, extend**            | Add `pnpm test`.                                                                                                    |
| `.github/workflows/simulations.yml`                                                             | **Reuse, gate**              | Spends real inference and needs repo secrets. Make it manual-only (`workflow_dispatch`) for a public repo.          |
| `.github/workflows/template-check.yml`                                                          | **Delete**                   | Exists only to keep the template's lockfile untracked. We must commit `pnpm-lock.yaml`.                             |
| `.github/assets/livekit-mark.png`, README branding                                              | **Delete**                   | LiveKit trademark. We aren't LiveKit.                                                                               |
| `AGENTS.md`, `.claude/skills`, `.agents/skills`, `.mcp.json`, `skills-lock.json`                | **Keep**                     | LiveKit guidance for coding agents. `CLAUDE.md` adds our rules on top.                                              |
| `.cursor`, `.codex`, `.gemini` skill copies                                                     | **Decide**                   | Duplicates of the same skills for other agents. See §11.                                                            |
| `LICENSE` (MIT, © LiveKit)                                                                      | **Replace**                  | Apache-2.0 for our code. Keep the MIT notice for derived starter code in `NOTICE`.                                  |

## 3. Architecture overview

```
 Browser (Next.js example)                Application (developer-owned)
 ┌──────────────────────────┐             ┌────────────────────────────────────┐
 │ LiveKit client SDK        │  1. POST    │ Token route (uses @voicebridge/server)│
 │ mic/speaker, transcripts  │────────────▶│  - app's own auth decides identity   │
 │                           │◀────────────│  - mints LiveKit JWT + agent dispatch│
 └────────────┬─────────────┘  JWT        │  - attaches opaque delegated cred    │
              │ 2. WebRTC                  └────────────────────────────────────┘
              ▼                                          ▲
 ┌──────────────────────────┐                            │ 4. HTTPS, fixed base URL,
 │ LiveKit Cloud / OSS       │                            │    timeout, schema-checked
 └────────────┬─────────────┘                            │
              │ 3. job dispatch                           │
              ▼                                           │
 ┌───────────────────────────────────────────────┐       │
 │ Agent worker (example wiring)                  │       │
 │  @voicebridge/agent   ── LiveKit-specific ──   │       │
 │   providers → AgentSession (STT/TTS/turns)     │       │
 │   mode: backend-controlled | agent-controlled  │       │
 │  @voicebridge/core    ── LiveKit-free ──────── │───────┘
 │   contracts, tool registry, HTTP adapter/tool  │   Application backend API
 └───────────────────────────────────────────────┘   (reference backend in examples/)
```

The dependency rule: `core` imports nothing from LiveKit. `agent` imports `core` and
`@livekit/agents`. `server` imports `livekit-server-sdk` only. Application code depends on
`core` contracts, never on LiveKit types.

## 4. Packages

Three library packages, chosen for dependency isolation, not ceremony:

| Package               | Depends on                | Why it is separate                                                                                                                           |
| --------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `@voicebridge/core`   | `zod`                     | Contracts and HTTP helpers that application developers implement and test without LiveKit or native binaries.                                |
| `@voicebridge/agent`  | `core`, `@livekit/agents` | All LiveKit orchestration. The only package with native/ML dependencies.                                                                     |
| `@voicebridge/server` | `livekit-server-sdk`      | Token minting for app servers and Next.js routes. Must not pull `@livekit/agents` (native binaries, model weights) into a web server bundle. |

The npm scope `@voicebridge` is a placeholder. Availability is unchecked.

## 5. Core contracts (proposed, subject to change in M1)

```ts
/** Trusted, server-issued. Never derived from user speech or LLM output. */
interface SessionContext {
  readonly sessionId: string; // VoiceBridge-generated, per room/job
  readonly delegatedCredential?: string; // opaque; minted by the app, forwarded only to the app
  readonly claims: Readonly<Record<string, string>>; // non-secret, app-defined (e.g. locale)
}

interface UserTurn {
  readonly turnId: string;
  readonly text: string;
  readonly source: 'speech' | 'text';
}

type BackendReply =
  { kind: 'speak'; text: string } | { kind: 'silent' } | { kind: 'end'; text?: string }; // speak (optionally), then close the session

/** Backend-controlled mode. */
interface ConversationAdapter {
  respond(turn: UserTurn, ctx: SessionContext, signal: AbortSignal): Promise<BackendReply>;
  greet?(ctx: SessionContext, signal: AbortSignal): Promise<BackendReply>;
}

/** Agent-controlled mode. The registry is the allowlist. */
interface ToolDefinition<I extends z.ZodTypeAny, O extends z.ZodTypeAny> {
  name: string; // validated: /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/
  description: string; // supplied by the app, never by core
  input: I; // LLM arguments are parsed with this before execute runs
  output: O; // backend results are parsed with this before the LLM sees them
  timeoutMs?: number;
  execute(input: z.infer<I>, ctx: ToolContext): Promise<z.infer<O>>;
}

interface ToolContext {
  readonly session: SessionContext; // injected by the runtime, not an LLM argument
  readonly signal: AbortSignal;
}
```

Core also ships HTTP implementations so most integrations need no custom code:

- `createHttpConversationAdapter({ baseUrl, path, timeoutMs, maxResponseBytes, serviceCredential })`
- `createHttpTool({ name, description, input, output, path, timeoutMs })`, a JSON POST to a fixed path

Both take URLs from server-side configuration only. There's no path templating from LLM arguments.

Errors: adapters throw or return typed failures. The runtime maps every failure to a configured,
generic spoken fallback (e.g. "Sorry, I couldn't complete that.") and logs a redacted internal
error. Callers and the LLM never see stack traces, URLs, status bodies, or credentials.

## 6. Execution modes

### a) Backend-controlled (no LLM)

```
user speech ─▶ STT ─▶ turn detector ─▶ onUserTurnCompleted(newMessage)
                                          │
                                          ├─▶ adapter.respond(turn, ctx, signal)  [timeout]
                                          │       └─ zod-validate BackendReply
                                          └─▶ session.say(reply.text)  ─▶ TTS ─▶ user
typed text (lk.chat) ─▶ textInputCallback ─▶ same handler
```

The backend's approved text is spoken verbatim. No LLM is configured, so nothing can rewrite it.

Verified in the SDK source (1.9.5, `agent_activity.js`): when the agent has no LLM, the
`onUserTurnCompleted` hook still runs, then the activity returns without generating a reply.
`generateReply` throws `"trying to generate reply without an LLM model"`. So we must use
`session.say()`, not `generateReply()`. The default text-input handler calls `generateReply`, so
backend mode must install a custom `textInputCallback` (documented Node API).

**SPIKE-1:** confirm end to end with `lk agent debugger` that an LLM-less agent transcribes,
calls the hook, speaks via `say()`, and supports interruption. Also confirm how
`session.run({ userInput })` testing behaves without an LLM.

Consequences: no preemptive generation (it requires an LLM), so latency equals backend latency
plus TTS. Turn ordering: a new user turn while a backend call is in flight cancels the previous
call through its `AbortSignal`.

### b) Agent-controlled (LLM + allowlisted tools)

```
user speech ─▶ STT ─▶ LLM (app-supplied instructions) ─▶ tool call?
                         │                                   │
                         │        registry lookup (allowlist) ┤ unknown ─▶ rejected
                         │        zod-parse args              ┤ invalid ─▶ error to LLM
                         │        execute(args, {session})    ┤ timeout ─▶ error to LLM
                         │        zod-parse result            ┘
                         └─▶ reply text ─▶ TTS ─▶ user
```

Core `ToolDefinition`s are bridged to SDK `llm.tool(...)` in `@voicebridge/agent`. The LLM controls
only the tool arguments. Identity and the delegated credential come from `ToolContext.session`.
The backend authorizes every call as if it came from that user. The LLM can't escalate past what
the user's own credential allows.

Instructions are required configuration with no core default. Preemptive generation is **off by
default** in this mode until **SPIKE-2** confirms whether preemptive LLM runs can execute tools
before the turn is final (a side-effect risk).

## 7. Provider configuration

Providers are configured in the worker, never in adapters:

```ts
providers: {
  stt: { model: 'assemblyai/universal-3-6-pro', language: 'en' },
  tts: { model: 'fishaudio/s2.1-pro', voice: '…' },
  llm: { model: 'google/gemma-4-31b-it' },   // agent-controlled only
  turnDetection: 'livekit' | 'vad',
}
```

- Default path: LiveKit Inference model strings (`inference.STT/TTS/LLM`), the approach LiveKit
  recommends. It needs no extra provider keys, but it requires LiveKit Cloud.
- Escape hatch: accept pre-constructed SDK instances (DI) so self-hosters can use provider plugins
  without VoiceBridge depending on every plugin.
- Config is validated with Zod at startup. An invalid config fails fast with a readable message.

## 8. Sessions, identity, and trust boundaries

1. The browser calls the **application's** token route. The app authenticates the user its own way.
2. The route calls `@voicebridge/server` → `createSessionToken({ identity, agentName, delegatedCredential, ttl })`:
   - generates a random room name server-side (clients never choose rooms)
   - grants only `roomJoin`, `canPublish` (mic), `canSubscribe`, `canPublishData`; `canUpdateOwnMetadata: false`
   - embeds explicit agent dispatch (`RoomConfiguration` + `RoomAgentDispatch`, documented API)
   - places the delegated credential in the dispatch metadata, which reaches the agent's job and
     isn't broadcast to other participants (**SPIKE-3:** confirm `ctx.job.metadata` in Node)
3. The agent builds `SessionContext` from the job metadata, never from participant-editable fields.
4. The agent forwards `delegatedCredential` to the app backend (e.g. `Authorization: Bearer`), along
   with a separate least-privilege service credential identifying the VoiceBridge worker.

Trust boundaries: user speech and LLM output are **untrusted input**. Job metadata is trusted
because only the server could mint it. The JWT is readable by the browser that holds it, so the
delegated credential must be something that user is already allowed to hold: short-lived, scoped
to voice actions, and verified by the app backend.

Backend URLs: one `baseUrl` per backend, set in worker config (env), validated at startup
(`https:` required except `localhost`), and never taken from tokens, metadata, speech, or LLM output.

## 9. State and data retention

- VoiceBridge stores nothing. Per-session state is the SDK's in-memory chat context for the session's
  lifetime, discarded on disconnect.
- Backend-controlled mode: the backend owns conversation state if it wants any (keyed by `sessionId`).
- **Retention default: off.** The SDK defaults `record` to recording audio, transcript, traces, and
  logs to LiveKit Cloud Agent Observability (`RecordingOptions`, all default `true` in 1.9.5).
  VoiceBridge passes `record: false` to `session.start` unless the operator opts in.
- Logs: no transcripts or credentials at `info` level. Debug transcript logging is opt-in and labelled PII.

## 10. Folder structure

```
voicebridge/
├─ packages/
│  ├─ core/                 @voicebridge/core (no LiveKit deps)
│  │  ├─ src/contracts/     session.ts, turn.ts, adapter.ts, tool.ts
│  │  ├─ src/http/          client.ts (timeout, size cap, abort), adapter.ts, tool.ts
│  │  ├─ src/errors.ts      public-safe error types
│  │  └─ src/config.ts      zod schemas
│  ├─ agent/                @voicebridge/agent
│  │  ├─ src/runtime.ts     createVoiceBridgeAgent(config) → defineAgent entry
│  │  ├─ src/modes/         backend-controlled.ts, agent-controlled.ts
│  │  ├─ src/providers.ts   config → inference.* or injected instances
│  │  ├─ src/session-context.ts
│  │  └─ src/tool-bridge.ts core ToolDefinition → llm.tool
│  └─ server/               @voicebridge/server
│     ├─ src/token.ts       createSessionToken
│     └─ src/handler.ts     Web-standard (Request → Response) handler for any framework
├─ examples/
│  ├─ reference-backend/    tiny Node HTTP backend implementing both contracts (fake demo data)
│  ├─ agent-worker/         runnable worker: env config → createVoiceBridgeAgent (replaces src/)
│  └─ web-nextjs/           browser client + token route
├─ docs/                    ARCHITECTURE.md, SECURITY.md, adapter guide
├─ AGENTS.md  CLAUDE.md  LICENSE  NOTICE  README.md
└─ pnpm-workspace.yaml
```

Build note: Node 24 strips TypeScript types at runtime but refuses to do so inside `node_modules`.
Library packages therefore compile to JS + `.d.ts` with `tsc`, using
`rewriteRelativeImportExtensions`. Examples keep running `.ts` directly, as the starter does.

## 11. Licensing, dependency, and security concerns

| #   | Concern                                                                                                                                                                               | Severity   | Proposed action                                                                                                                                                                                                                                                                                                                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Starter code is MIT © LiveKit. The repo LICENSE is currently MIT.                                                                                                                     | Must fix   | Apache-2.0 `LICENSE` for our work. Keep the LiveKit MIT notice in `NOTICE` for any retained starter code (`Dockerfile`, workflows, `AGENTS.md`). MIT is compatible.                                                                                                                                                                                       |
| 2   | `@livekit/plugins-ai-coustics` licence is "SEE LICENSE IN livekit.io/legal/terms-of-service" (proprietary).                                                                           | High       | Remove from library deps. Optional, injected by the operator, documented as LiveKit Cloud only.                                                                                                                                                                                                                                                           |
| 3   | `@livekit/local-inference` (transitive via `@livekit/agents`) is `Apache-2.0 AND LicenseRef-LiveKit-Model`. The turn-detector/VAD weights are under LiveKit's model licence, not OSI. | Medium     | Document in README/NOTICE. Allow `turnDetection: 'vad'` for users who need to avoid it (**SPIKE-4:** confirm the weights load only when that detector is used).                                                                                                                                                                                           |
| 4   | `@livekit/av-*` native binaries are LGPL-2.1-or-later (FFmpeg).                                                                                                                       | Low/Medium | Fine as a dynamically loaded dependency. Note it for anyone redistributing Docker images.                                                                                                                                                                                                                                                                 |
| 5   | LiveKit Inference and Agent Observability are LiveKit Cloud features.                                                                                                                 | Info       | Be honest in docs: the default config needs LiveKit Cloud. The self-host path is plugins plus DI.                                                                                                                                                                                                                                                         |
| 6   | SDK records audio, transcripts, traces, and logs by default.                                                                                                                          | High       | `record: false` default (§9). Covered by a unit test.                                                                                                                                                                                                                                                                                                     |
| 7   | LiveKit API keys are project-wide (no per-grant key scoping). The token server holds a key able to mint any token.                                                                    | Medium     | Keep keys only in the token server and worker env. The worker doesn't need to mint tokens. Document key rotation.                                                                                                                                                                                                                                         |
| 8   | The API secret was pasted into a chat session during setup.                                                                                                                           | Action     | Rotate the key in LiveKit Cloud before any public push.                                                                                                                                                                                                                                                                                                   |
| 9   | `.env.local` holds real credentials.                                                                                                                                                  | Done (M0)  | `.env*` (except `.env.example`), `livekit.toml`, and key files are ignored. CI runs gitleaks v8.30.1 over the full history.                                                                                                                                                                                                                               |
| 10  | `simulations.yml` runs on push to `main` with secrets.                                                                                                                                | Done (M0)  | Now `workflow_dispatch` only.                                                                                                                                                                                                                                                                                                                             |
| 11  | Duplicate skill copies (`.claude/skills`, `.agents/skills`) of MIT content from `livekit/agent-skills`.                                                                               | Done (M0)  | `.agents/skills` was byte-identical and has been removed and ignored. `.claude/skills` and `skills-lock.json` are committed with attribution in `NOTICE`. `.cursor`, `.codex`, and `.gemini` hold only Docs MCP config (no skills) and are kept. `.vscode/` stays ignored. No LiveKit Claude plugin is installed globally, so nothing is installed twice. |
| 12  | `pnpm-workspace.yaml` uses `allowBuilds`, which pnpm 10.24 ignores (it warned).                                                                                                       | Low        | Harmless today (the skipped scripts are no-ops). Normalise when restructuring.                                                                                                                                                                                                                                                                            |
| 13  | Preemptive generation plus side-effecting tools.                                                                                                                                      | Medium     | Off by default in agent mode until SPIKE-2.                                                                                                                                                                                                                                                                                                               |
| 14  | Prompt injection via speech can steer tool choice.                                                                                                                                    | Inherent   | Mitigated, not solved: allowlist, schema validation, per-user backend authorization, no LLM-controlled URLs. Documented as a limitation.                                                                                                                                                                                                                  |

## 12. MVP acceptance criteria

Functional

1. A developer can integrate a backend by implementing `ConversationAdapter` **or** registering
   `ToolDefinition`s, with no LiveKit types in their code.
2. **Backend-controlled:** speaking into the Next.js example produces a call to the reference
   backend with the transcribed text, and the agent speaks the backend's text verbatim. No LLM is
   configured in this mode.
3. **Agent-controlled:** the LLM calls a registered reference-backend tool. A tool not in the
   registry can't be called. Invalid arguments are rejected before the backend is contacted.
4. Switching STT/TTS/LLM models is a config change only, with zero adapter changes (shown by the
   example worker running both modes with two different provider configs).
5. Tokens are minted only server-side. The browser never supplies room names, backend URLs, or
   agent configuration.
6. Typed text input (`lk.chat`) works in both modes.

Robustness and security 7. Backend timeout, network error, non-2xx status, oversized body, and schema-invalid response each
produce the generic spoken fallback and a redacted log line, covered by unit tests. 8. Recording/observability upload is off unless explicitly enabled (asserted in a test). 9. No secrets in Git: gitleaks (or equivalent) passes in CI. `.env*` is ignored except `.env.example`. 10. The delegated credential reaches the backend on every adapter and tool call. The LLM can't
read or set it (tested).

Quality 11. `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and `pnpm test` pass in CI on Node 24. 12. Public APIs of all three packages have TSDoc and unit tests. `core` and `server` reach ≥90% line coverage. 13. README quickstart takes a new developer from clone to talking to the reference backend
(with their own LiveKit Cloud project), and documents limitations honestly. 14. Spikes 1–4 are resolved and their outcomes recorded in this document.

## 13. Implementation plan

Small, separately reviewable steps. Each ends green on typecheck, lint, and test.

| Step            | Scope                                                                                                                                                                                              | Exit check                                                                      |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| M0 Repo hygiene | Apache-2.0 LICENSE + NOTICE, remove LiveKit branding and template-check, gate simulations, pnpm workspace skeleton, commit lockfile, gitleaks + test in CI, SECURITY.md, first commit (local only) | CI config valid locally, no secrets in `git ls-files`                           |
| M0.5 Spikes     | SPIKE-1..4 in a throwaway branch with `lk agent debugger`                                                                                                                                          | Findings written into §6/§8/§11                                                 |
| M1 `core`       | Contracts, errors, config schemas, HTTP client with timeout/size cap/abort, HTTP adapter and tool                                                                                                  | Unit tests with a local stub server                                             |
| M2 `server`     | `createSessionToken`, Web handler, grant minimisation                                                                                                                                              | Tests decode the JWT and assert grants, dispatch, TTL                           |
| M3 Backend mode | Runtime, providers, session context, backend-controlled mode, `record: false`                                                                                                                      | Unit tests with fakes, plus a debugger transcript against the reference backend |
| M4 Agent mode   | Tool bridge, agent-controlled mode                                                                                                                                                                 | Unit tests, one simulation scenario per tool behaviour                          |
| M5 Examples     | reference-backend, agent-worker                                                                                                                                                                    | Both modes run locally against LiveKit Cloud                                    |
| M6 Browser      | Next.js example with token route                                                                                                                                                                   | Manual voice test in browser, documented                                        |
| M7 Docs         | README quickstart, adapter guide, limitations                                                                                                                                                      | Acceptance criteria checklist reviewed                                          |

## 14. Known limitations and trade-offs (initial)

- **LiveKit Cloud by default.** The Inference defaults are the simplest path but tie the default
  setup to LiveKit Cloud. Self-hosting needs plugin instances.
- **Backend latency is user-perceived.** Backend mode can't start speaking before the backend
  answers. Streaming backend replies are a possible post-MVP extension (`say()` accepts a stream).
- **Delegated credential lifetime.** No refresh mechanism in the MVP. Sessions longer than the
  credential TTL will start failing backend calls.
- **Prompt injection** can't be fully prevented in agent mode. Safety rests on backend authorization.
- **Node SDK parity.** Some Python-SDK features (e.g. MCP tools) aren't available in Node.
- **1:1 sessions only.** One user and one agent per room. Multi-party rooms are out of scope.
