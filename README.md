# VoiceBridge

> **Status: alpha (`0.1.0-alpha.1`). Not production-ready.** APIs, the wire contract, and package
> names may change without notice. Nothing is published to npm. VoiceBridge is a working title.

VoiceBridge is open-source middleware for adding a real-time voice interface to an application
you already have. Your backend keeps its business logic and authorization. VoiceBridge connects
it to a voice runtime through a small, typed HTTP contract, and the runtime handles audio
transport, speech recognition, turn-taking, and speech synthesis.

The core (`@voicebridge/core`) has no vendor dependencies.
[LiveKit Agents for Node.js](https://github.com/livekit/agents-js) is the first, and so far only,
runtime. See [ADR 0001](docs/adr/0001-provider-neutral-core.md) for why.

VoiceBridge is an independent project. It is not affiliated with, endorsed by, or sponsored by
LiveKit, Inc.

## Why use it

- **Your backend stays in charge.** In backend-controlled mode the user's transcribed speech goes
  to your API, and its reply is spoken verbatim. No LLM rewrites or invents answers.
- **Security boundaries are explicit.** Tokens are minted server-side only. Sessions are opaque
  references your backend authorizes. Backend URLs come from server configuration, never from
  speech or clients. Recording is off by default.
- **One contract, language-neutral.** The `/v0` HTTP wire contract has JSON Schemas and
  conformance vectors, so the backend can be written in any language.

## Feature matrix

| Area                                                         | Status                                                                     |
| ------------------------------------------------------------ | -------------------------------------------------------------------------- |
| Backend-controlled mode (backend text spoken verbatim)       | **Implemented**                                                            |
| Wire contract `/v0` (sessions start/end, turns)              | **Implemented, experimental.** JSON Schema and conformance vectors         |
| LiveKit Agents runtime adapter (Node.js)                     | **Implemented** (`@voicebridge/runtime-livekit`)                           |
| Server-side LiveKit token issuer                             | **Implemented** (`@voicebridge/livekit-tokens`): mic-only, room-bound      |
| Session verification before the agent joins, fail closed     | **Implemented**                                                            |
| Interruptions: obsolete replies are never spoken             | **Implemented**                                                            |
| Typed text input alongside voice                             | **Implemented** (opt-in per application)                                   |
| Browser demo (Next.js + LiveKit React components)            | **Implemented** (example, demo only)                                       |
| Session revocation                                           | **Partial**: takes effect at the next turn, not instantly                  |
| Agent-controlled mode (LLM calling registered backend tools) | **Planned.** Tool registry and executor exist in core, no runtime wiring   |
| Second example application (task list)                       | Planned                                                                    |
| Other runtimes (Pipecat, Vapi, …)                            | Not planned until there's a concrete need (the runtime port stays 0.x)     |
| Production authentication, durable session storage           | **Your responsibility.** The examples use a dev identity and memory stores |
| npm packages                                                 | Not published                                                              |

**Speech providers.** The example worker uses
[LiveKit Inference](https://docs.livekit.io/agents/models/inference/) (requires LiveKit Cloud),
configured by model id. Provider plugins for self-hosted LiveKit should work through the runtime's
`stt`/`tts` options but haven't been tested.

## How it fits together

```
Browser ─ POST /api/voice/token (your auth) ─▶ Your server (host token route)
   │                                              │ creates a session in your backend,
   │◀────── { server_url, participant_token } ────┘ signs a mic-only token for a fresh room
   │
   └─ WebRTC ─▶ LiveKit ─ dispatch ─▶ VoiceBridge worker ─ POST /v0/sessions/start ─▶ Your backend
                                         (LiveKit Agents)  ─ POST /v0/turns (each turn)
                                                            ─ POST /v0/sessions/end
```

| Package / directory                                    | Role                                                                                                    | Vendor dependencies   |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- | --------------------- |
| [`packages/core`](packages/core)                       | Contracts, turn coordinator, tool executor, HTTP backend client, wire contract v0 schemas               | none (`zod` only)     |
| [`packages/livekit-tokens`](packages/livekit-tokens)   | Server-side, least-privilege LiveKit credentials with allowlisted agent dispatch                        | `livekit-server-sdk`  |
| [`packages/runtime-livekit`](packages/runtime-livekit) | LiveKit Agents adapter: verifies the session, runs backend-controlled turns, `record: false` by default | `@livekit/agents`     |
| [`examples/`](examples)                                | Help-desk demo: backend, host token route, worker, Next.js page                                         | LiveKit SDKs, Next.js |

Architecture, trade-offs, and the plan: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Quickstart: run the demo

> [!WARNING]
> **The demo's development login is for your own machine only.** With `VB_DEV_AUTH=localhost`,
> every request that reaches the token route from this machine is treated as one synthetic user.
> Its guards can't detect a reverse proxy on the same machine that adds no forwarding headers (for
> example a bare nginx `proxy_pass http://127.0.0.1:8790`): such a proxy would hand LiveKit tokens
> to anyone on the internet. Never expose port 8790 through a proxy, tunnel, or container port
> mapping. See [Security responsibilities](#security-responsibilities).

The fastest path to talking to the demo. You need Node.js 24, pnpm 10, a free
[LiveKit Cloud](https://cloud.livekit.io) project, and a desktop browser with a microphone.

```console
git clone https://github.com/UsmanJ/voicebridge.git && cd voicebridge
pnpm install --frozen-lockfile
pnpm build

cp .env.example .env.local                    # LiveKit URL, API key, API secret (server-side only)
cp examples/.env.example examples/.env.local  # then generate the two backend credentials:
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Put two different generated values in `HELP_DESK_WORKER_CREDENTIAL` and
`HELP_DESK_HOST_CREDENTIAL` in `examples/.env.local`. Then start four processes, one per terminal:

```console
pnpm --filter @voicebridge/backend-help-desk-example start   # backend, 127.0.0.1:8788
pnpm --filter @voicebridge/host-token-route-example start    # token route, 127.0.0.1:8790 (dev identity)
pnpm --filter @voicebridge/worker-livekit-example dev        # VoiceBridge worker
pnpm --filter @voicebridge/web-example dev                   # browser page
```

Open **http://localhost:3000** (use `localhost`, not `127.0.0.1`), click **Start Conversation**,
allow the microphone, and ask "What are your opening hours?". Full walkthrough, expected answers,
and checks: [examples/README.md](examples/README.md).

## Environment variables

All `.env.local` files are gitignored. The committed `.env.example` files have empty values.

| File                             | Variables                                                                                                                                                 | Read by               |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| `.env.local`                     | `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`                                                                                                    | host, worker          |
| `examples/.env.local`            | `HELP_DESK_*_CREDENTIAL`, `HELP_DESK_URL`, `VB_APPLICATION_ID`, `VB_AGENT_NAME`, `VB_DEV_AUTH`, `HOST_ALLOWED_ORIGINS`, `VB_STT_MODEL`, `VB_TTS_MODEL`, … | backend, host, worker |
| `examples/web/.env.local` (opt.) | `NEXT_PUBLIC_VB_TOKEN_ENDPOINT`, `VB_WEB_EXTRA_CONNECT_SRC`: public build-time values, never secrets                                                      | web page              |

The complete table is in [examples/README.md](examples/README.md#configuration).

## Integrating your own backend

The packages aren't on npm yet. Work inside this repository (a pnpm workspace) or vendor the
packages. Three pieces:

1. **Your backend** implements the `/v0` wire contract: `POST /v0/sessions/start` (authorize a
   session for a room), `POST /v0/turns` (answer a user turn), and `POST /v0/sessions/end`.
   Requests carry one service credential per application as a bearer token. Schemas:
   [`packages/core/schema/v0`](packages/core/schema/v0). Test vectors:
   [`packages/core/conformance/v0`](packages/core/conformance/v0). Reference implementation:
   [`examples/backend-help-desk`](examples/backend-help-desk).
2. **Your server** authenticates your user, creates a session in your backend, and issues LiveKit
   credentials with [`@voicebridge/livekit-tokens`](packages/livekit-tokens). Reference:
   [`examples/host-token-route`](examples/host-token-route). Replace its development identity with
   your own `Authenticator`.
3. **A worker** runs [`@voicebridge/runtime-livekit`](packages/runtime-livekit) with
   `createHttpBackend` from core, pointed at your backend by server-side configuration. Reference:
   [`examples/worker-livekit`](examples/worker-livekit).

The browser only ever sees `{ server_url, participant_token }`.

## Security responsibilities

VoiceBridge enforces: server-side token minting with mic-only grants and a fresh random room per
session; room-bound, compare-and-set session binding; session verification before the agent joins;
backend URLs from server configuration only (`https`, or `http` only for localhost; no redirects;
timeouts and response size caps); generic errors to callers; `record: false` by default.

**You must provide:**

- **Real user authentication on your token route.** The examples' `VB_DEV_AUTH=localhost`
  identity is for a developer's own machine only. It refuses to start with `NODE_ENV=production`,
  on a non-loopback bind address, on common hosting platforms, or with non-local browser origins,
  and it refuses requests that carry proxy forwarding headers. It **cannot** detect a reverse
  proxy on the same machine that adds no forwarding headers. Never expose it through a proxy,
  tunnel, or container port mapping. Origin and Host checks are defence in depth, not
  authentication.
- **CSRF protection** if your token route uses cookies (SameSite plus a CSRF check).
- **Durable session storage** with atomic conditional writes, **shared rate limiting**, **TLS**
  between all services, and a **secrets manager**.
- **Authorization in your backend** for every turn and tool call. The worker never bypasses it.

See [SECURITY.md](SECURITY.md) to report a vulnerability, and
[examples/README.md](examples/README.md#demo-vs-production) for the demo-versus-production table.

## Privacy

- **Recording is off.** The worker passes `record: false` to LiveKit Agents: no audio, transcript,
  trace, or log upload to LiveKit Cloud Agent Observability. Also check your LiveKit Cloud project
  settings.
- **Speech processing is third-party.** Audio goes to LiveKit Cloud, and LiveKit Inference forwards
  it to the configured STT and TTS providers. LiveKit
  [documents](https://docs.livekit.io/agents/models/inference/) Inference as zero data retention
  for those providers. That covers model providers only, not Agent Observability, and not
  provider plugins you configure directly. Review your providers before using real conversations.
- **Nothing is persisted by the demo.** The browser keeps the transcript in memory and discards it
  when the conversation ends. The example backend keeps only session metadata, in memory. Logs
  never contain transcript text, tokens, or credentials.

## Running the checks

```console
pnpm typecheck
pnpm lint
pnpm format:check
pnpm build                     # includes the browser bundle secret scan
pnpm test                      # no LiveKit credentials or network services needed
pnpm verify:core-isolation     # proves @voicebridge/core runs with no LiveKit packages installed
pnpm --filter @voicebridge/web-example smoke   # production server headers (after build)
```

CI runs all of these, plus a gitleaks history scan, on pushes to `main` and on pull requests.
Live tests against LiveKit Cloud are opt-in scripts that are never run in CI
([examples/README.md](examples/README.md#quickstart-local-development)).

## Troubleshooting

| Symptom                                                                          | Likely cause and fix                                                                                                                      |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install` fails with an engine error                                        | Node.js older than 24 or pnpm older than 10. `nvm use` reads `.nvmrc`. `corepack enable` provides the pinned pnpm.                        |
| Host exits: `no authenticator configured`                                        | Set `VB_DEV_AUTH=localhost` in `examples/.env.local` (local only), or pass your own `Authenticator`.                                      |
| Host exits mentioning `production`, `loopback`, `hosting platform`, or `origins` | The development identity refused an unsafe setting. That's intended. Use a real authenticator outside your own machine.                   |
| Browser: "Could not reach the voice service"                                     | The host token route isn't running on `127.0.0.1:8790`.                                                                                   |
| Browser: "This page is not allowed to start voice sessions"                      | The page isn't on `http://localhost:3000`, the only allowed origin. Use `localhost`, or add the origin to `HOST_ALLOWED_ORIGINS`.         |
| Browser: "The voice assistant did not join"                                      | Worker not running, or `VB_AGENT_NAME` differs between host and worker. Run `pnpm --filter @voicebridge/worker-livekit-example diagnose`. |
| Browser: microphone blocked or not found                                         | Allow the microphone in the site settings, or connect one. The page needs a secure context (`localhost` or HTTPS).                        |
| No sound, but transcript appears                                                 | The browser blocked autoplay: click **Allow audio playback**.                                                                             |
| Worker logs `session rejected before connecting`                                 | The backend refused the session (expired, revoked, wrong room, or wrong worker credential). Start a new conversation.                     |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Project rules for coding agents are in
[CLAUDE.md](CLAUDE.md), and LiveKit-specific agent guidance is in [AGENTS.md](AGENTS.md). The
repository commits LiveKit's MIT-licensed [agent skills](https://github.com/livekit/agent-skills)
in `.claude/skills/` (pinned by `skills-lock.json`) and Docs MCP server configuration for several
coding agents.

## Known limitations

- Alpha: the wire contract `/v0` and runtime port `0.x` are experimental and will change.
- Only backend-controlled mode works. Agent-controlled mode isn't wired to a runtime yet.
- Revocation takes effect at the session's next turn, not instantly.
- The examples use in-memory stores and per-process rate limits; restarting loses all sessions.
- The browser demo has been verified with synthetic microphone audio and mocked tests. A real
  microphone run is a manual check ([examples/README.md](examples/README.md#manual-browser-checklist)).
- `@livekit/components-react` 2.9.24 carries a small local patch for an upstream bug
  ([patches/README.md](patches/README.md)).
- More detail: [CHANGELOG.md](CHANGELOG.md) and
  [examples/README.md](examples/README.md#known-limitations).

## Licence

Apache-2.0, see [LICENSE](LICENSE). Portions are derived from LiveKit's MIT-licensed
[agent-starter-node](https://github.com/livekit-examples/agent-starter-node) and
[agent-skills](https://github.com/livekit/agent-skills). See [NOTICE](NOTICE) for attribution,
the local dependency patch, and notable licences of runtime dependencies, including the LiveKit
Model License that covers the turn-detector and VAD weights installed with `@livekit/agents`.
