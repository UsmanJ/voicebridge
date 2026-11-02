# CLAUDE.md

VoiceBridge (working title): open-source, provider-agnostic voice AI integration middleware.
LiveKit Agents (Node.js) is the first runtime adapter. Architecture and plan: @docs/ARCHITECTURE.md.
LiveKit-specific workflow (docs lookup, skills, debugger, simulations): @AGENTS.md.

This is a **public repository from day one**. Write every file, commit message, and comment as if
strangers will read it.

## Stack

TypeScript (strict), Node.js 24 LTS, pnpm workspaces, `@livekit/agents`, Zod, Vitest, Next.js
(example app only). Apache-2.0.

## Architecture rules

- VoiceBridge is provider-neutral middleware (see `docs/adr/0001-provider-neutral-core.md`).
  `packages/core` depends on `zod` only: no LiveKit or other vendor imports, ever. Tests enforce this.
- Vendor code lives only in runtime adapters (`packages/runtime-livekit`) and runtime-specific server
  helpers (`packages/livekit-tokens`, which must not depend on `@livekit/agents`).
- Don't abstract media transports or STT/LLM/TTS providers. They belong to the runtime. Don't
  re-implement LLM orchestration in core. Don't build speculative runtime adapters. The runtime
  port is 0.x until a second real runtime exists.
- The wire contract with application backends (`/v0`) is the language-neutral interface. It's
  **experimental**: don't call it stable or v1 until both example apps validate it. Every change
  updates the JSON Schema and conformance vectors.
- Security invariants: opaque `sessionRef` resolved server-side, one service credential per
  application, no cross-application state, no credentials in client tokens or metadata,
  `record: false` by default, obsolete replies never spoken, and cancellation never assumed to undo
  backend writes.
- No application-specific prompts, personas, or domain logic in any package. They belong in
  `examples/` or in the user's app.
- Two modes: backend-controlled (backend text is spoken verbatim, no LLM configured; implemented)
  and agent-controlled (LLM calls explicitly registered tools only; planned, not wired to a runtime).
- Provider and model choices live in worker config, never in adapters.
- Stateless by default. No databases, queues, caches, or new infrastructure without an explicit,
  documented reason agreed with the maintainer.
- Small cohesive modules, dependency injection, composition over abstraction. Don't add an
  interface until there are two implementations or a test needs the seam.

## Security rules (non-negotiable)

- LiveKit tokens are minted server-side only. Clients never choose rooms, backend URLs, or agent config.
- Backend URLs come from server-side config only, validated at startup. Never from tokens,
  metadata, speech, or LLM output. No path templating from LLM arguments.
- Tools are allowlisted by registration. Validate LLM arguments with Zod before calling a backend.
  Validate backend responses with Zod before using them.
- Identity and delegated credentials come from trusted session context, never from LLM arguments.
  The backend authorizes every call. The LLM must not be able to bypass app authorization.
- Every backend call has a timeout, an `AbortSignal`, and a response size cap.
- Callers and the LLM never see internal errors, stack traces, URLs, or credentials. Speak a
  generic fallback and log a redacted error.
- No raw audio, transcript, or conversation retention by default. Pass `record: false` to
  `session.start` unless the operator opts in. Never log transcripts or credentials at info level.
- Least-privilege grants and credentials.

## Repository hygiene

- Never commit `.env*` files (except `.env.example` with empty values), credentials, tokens,
  private URLs, LiveKit project URLs, or private configuration.
- No proprietary code, private datasets, or third-party branding. Example data must be obviously fake.
- Never read or import files from outside this repository (in particular the maintainer's other projects).
- Never push, open PRs, publish packages, or deploy without explicit approval from the maintainer.
  Local commits are fine when asked.
- Check the licence of every new dependency before adding it and record anything non-OSI in `NOTICE`.

## LiveKit SDK usage

- Look APIs up before using them: `lk docs search` / `lk docs get-page` or the `livekit-docs` MCP
  server, plus the skills in `.claude/skills/`. Don't write LiveKit code from memory, and don't
  invent SDK methods. If docs and installed types disagree, trust `node_modules/@livekit/agents/dist/*.d.ts`
  and note the discrepancy.
- On Windows, run `lk docs get-page` from PowerShell. Git Bash rewrites `/agents/...` paths.
- Node SDK lacks some Python features. Check availability before designing around one.
- When an assumption about SDK behaviour matters, mark it **SPIKE** in `docs/ARCHITECTURE.md` and
  verify it with `lk agent debugger` before building on it.

## Engineering workflow

- Implement incrementally: one small, testable change at a time, matching the plan in
  `docs/ARCHITECTURE.md` §13.
- Public APIs need TSDoc and Vitest tests. Bug fixes start with a failing test.
- Before calling a change done: `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`.
- When agent-controlled mode lands, agent behaviour changes (instructions, tool descriptions) also
  need a LiveKit simulation scenario (see AGENTS.md). There are no scenarios yet.
- Document trade-offs and limitations honestly. Never claim production readiness without evidence.
- Keep `docs/ARCHITECTURE.md` current when a decision changes or a spike resolves.
