# ADR 0001: Provider-neutral TypeScript core, LiveKit Agents as the first runtime

- Status: **Accepted** (2026-10-31, with the refinements below)
- Date: 2026-10-31
- Deciders: maintainer
- Supersedes: the LiveKit-centred package layout in the M0 architecture draft

## Context

VoiceBridge's goal is to connect existing applications to real-time voice through one stable
interface, while letting developers choose their voice infrastructure, AI services, and backends.
The first working implementation must use LiveKit, and must be demonstrable by 11 November 2026.

Four categories are often conflated, and they don't swap independently:

| Category              | Examples                                                                       | Coupling observed                                                                               |
| --------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Media transport       | LiveKit WebRTC, Daily WebRTC, SmallWebRTC, Twilio Media Streams, raw WebSocket | Owned by the orchestration runtime. You pick a transport _inside_ a runtime.                    |
| Orchestration runtime | LiveKit Agents (Node/Python), Pipecat (Python)                                 | Owns the turn-taking, interruption, STT→LLM→TTS pipeline, and its own provider plugins.         |
| STT/LLM/TTS providers | LiveKit Inference, Deepgram, AssemblyAI, OpenAI, Cartesia                      | Configured through the runtime's plugin system. Each runtime has a different catalogue and API. |
| Application adapters  | The developer's backend API                                                    | Independent of all of the above. This is where VoiceBridge adds value.                          |

LiveKit Agents is bound to LiveKit's transport (rooms, dispatch, SIP via LiveKit). Pipecat binds
many transports, including LiveKit and Daily, to its own Python pipeline. So "swap the transport
but keep the runtime" is a runtime feature (Pipecat has it, LiveKit Agents doesn't). It's not
something VoiceBridge should re-implement.

### Options considered

**A. TypeScript-first VoiceBridge core, LiveKit Agents (Node) as the first runtime adapter.** The
core owns application contracts, turn coordination for backend-controlled mode, tool
registry/validation/execution, security policy, and observability events. A runtime adapter
implements a narrow port (events in, speech commands out) for one orchestration framework.

**B. VoiceBridge as an application layer on top of Pipecat.** VoiceBridge becomes Python
processors in a Pipecat pipeline. Transport choice comes from Pipecat (Daily, LiveKit, WebSocket,
telephony serializers).

| Criterion                   | A: TS core + LiveKit Agents first                                                                                                                                                      | B: On top of Pipecat                                                                                                                                                                               |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Maintainability             | One language for now. We own a small core (contracts, coordinator, tools). Adapter surface is narrow.                                                                                  | Less code of our own, but it tracks a fast-moving framework's internal frame/processor APIs.                                                                                                       |
| TypeScript vs Python        | Matches the specified stack (TS, Zod, Vitest, Next.js). Pipecat support later requires a Python adapter.                                                                               | Server side is Python only (Pipecat requires Python 3.11+). Breaks the specified TS stack. JS is limited to clients.                                                                               |
| Vendor independence         | Independent of any one framework through our own port. LiveKit Agents is replaceable.                                                                                                  | Independent of transports, but **locked to Pipecat** as the runtime. LiveKit Agents can never be the runtime.                                                                                      |
| Runtime capabilities        | Full LiveKit Agents feature set, all verified in M0.5: Inference, turn detector, adaptive interruption, explicit dispatch, observability controls.                                     | Pipecat's LiveKit support is a transport, so LiveKit Agents features (dispatch, Inference, turn detector) aren't available through it (dispatch and Inference support via Pipecat are unverified). |
| Latency overhead            | None added: the adapter is in-process, and the core is plain function calls around the SDK.                                                                                            | None added if in-process. Pipecat's own pipeline overhead is comparable in kind.                                                                                                                   |
| Implementation complexity   | Moderate: core plus one adapter. The port must be designed carefully (risk of premature abstraction, see §Consequences).                                                               | Low for a Pipecat-only product. High if TS parts (Next.js token route, TS contracts) must interoperate.                                                                                            |
| Licensing                   | Apache-2.0 core. `@livekit/agents` Apache-2.0, plus the LiveKit Model License weights (documented).                                                                                    | Pipecat BSD-2-Clause (permissive, compatible). Provider plugins vary.                                                                                                                              |
| Open-source differentiation | A runtime-neutral application contract (backend-controlled mode with verbatim speech, tool allowlisting, cancellation semantics, security defaults) that no single framework provides. | Pipecat already offers multi-transport. A thin app layer on it differentiates less and competes with Pipecat Flows and RTVI actions.                                                               |
| Feasible by 11 Nov          | **Yes, if scoped**: one runtime, two backends, and a fake runtime. M0.5 de-risked the LiveKit path.                                                                                    | Risky: new language toolchain, new framework, no spike evidence, and it de-emphasises LiveKit Agents.                                                                                              |

## Decision

Adopt **Option A**, with portability concentrated where it's cheap and real:

1. **The language-neutral wire contract is the primary portability artifact.** The HTTP JSON
   protocol between VoiceBridge and application backends (turn request/reply, tool
   invocation/result, error envelope, version header) is defined once as Zod schemas, exported as
   JSON Schema, and covered by shared JSON conformance vectors. It's **v0, experimental**. Any runtime, in any language (including a
   future Pipecat adapter), can implement it and prove conformance.
2. **The TypeScript core is runtime-free.** `@voicebridge/core` depends only on `zod`. It contains
   the contracts, the turn coordinator, the tool registry/executor, policy (timeouts, size caps,
   fallbacks), and observability event types.
3. **A narrow runtime port** (`RuntimeSession`: events in, `speak`/`interrupt`/`end` out, plus a
   capability descriptor) is extracted from the LiveKit implementation and checked against a fake
   runtime. It's _not_ designed up front for runtimes we haven't built.
4. **Providers aren't abstracted by VoiceBridge.** STT/LLM/TTS configuration is runtime-specific
   and opaque to the core. Each runtime adapter owns its provider config.
5. **LLM orchestration stays in the runtime.** In agent-controlled mode the core provides tool
   definitions and a validated, authorized executor. The runtime's native function calling invokes
   them. VoiceBridge doesn't re-implement an LLM loop.

## Refinements agreed at acceptance

- Package names: `@voicebridge/core`, `@voicebridge/runtime-livekit`, and `@voicebridge/livekit-tokens`
  (token generation only, renamed from `livekit-server`).
- The wire contract is **v0, experimental**. No stable v1 is promised until it has been validated
  against both example applications (help desk: backend-controlled; task list: agent-controlled).
- A future Python runtime implements the same wire protocol and conformance vectors. It doesn't
  import the TypeScript core.
- Application capabilities are optional. A backend implements only the modes and tools it uses.
- The task-list example demonstrates authorization, confirmation for destructive actions, and
  idempotency for writes.
- Security: opaque session refs with trusted server-side resolution, and validated, authenticated
  application context (one service credential per application). No cross-application session
  leakage. No credentials in client tokens or participant metadata. No recording or transcript
  retention by default.
- Cancellation prevents obsolete replies from being spoken, but is never assumed to reverse a
  backend action that may already have executed.
- No speculative Pipecat, Daily, Twilio, or WebSocket adapters. Transport, orchestration, and
  provider configuration stay inside runtime adapters. Capabilities that LiveKit or Pipecat
  already provide aren't rebuilt.

## Consequences

Positive:

- Core and wire contract can be tested with no LiveKit installed (CI job, see ARCHITECTURE §12).
- A Pipecat adapter is feasible later without changing application backends.
- The LiveKit implementation keeps every verified LiveKit Agents capability.

Negative and risks:

- **Premature abstraction.** A port designed from one runtime may fit the next one badly.
  Mitigations: keep the port minimal (only what our two modes use), mark it `0.x` (unstable),
  forbid speculative adapters, and revisit when a second runtime is actually built.
- **Duplicated logic across languages.** A Python adapter would re-implement the coordinator
  (~150 lines) instead of sharing code. Mitigation: behaviour is pinned by the shared test vectors.
- **Capability gaps** between runtimes (interruption, text input, streaming, metadata) must be
  declared and handled explicitly, not hidden.
- Agent-controlled mode is only as portable as each runtime's function-calling support.

## Revisit when

- A second runtime adapter is actually started (re-evaluate the port with real requirements).
- Pipecat gains a supported TypeScript server runtime, or LiveKit Agents Node drops required features.
- Users ask for a hosted session service (would justify the sidecar option in ARCHITECTURE §9.3).

## References

- Pipecat repository (Python ≥3.11, BSD-2-Clause, transports and serializers): https://github.com/pipecat-ai/pipecat
- Pipecat transports overview: https://docs.pipecat.ai/pipecat/learn/transports
- Pipecat client transport guidance: https://docs.pipecat.ai/client/concepts/choosing-a-transport
- RTVI standard (client/server messaging, function-call flow): https://docs.pipecat.ai/api-reference/standards/rtvi-standard
- M0.5 LiveKit spike results: `docs/ARCHITECTURE.md` §15
