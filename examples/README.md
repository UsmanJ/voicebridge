# VoiceBridge examples: help desk over LiveKit (backend-controlled)

> **DEMO ONLY.** Synthetic data, in-memory storage, and a development-only identity. Read
> [Demo vs production](#demo-vs-production) before adapting any of this.

Three small services show how an existing application adds a voice interface with VoiceBridge:

| Directory            | Role                                                                                                                             | Depends on                                        |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `backend-help-desk/` | **Your application backend.** Fictional FAQ ("Pebblebrook Home Goods"), session store, VoiceBridge wire contract v0. No LiveKit. | `@voicebridge/core` (schemas only)                |
| `host-token-route/`  | **Your web app's server.** Authenticates the user, creates the voice session, returns LiveKit credentials.                       | `@voicebridge/livekit-tokens`                     |
| `worker-livekit/`    | **The VoiceBridge worker.** Verifies each session, then speaks the backend's approved answers.                                   | `@voicebridge/runtime-livekit`, `@livekit/agents` |

```
Browser ──1. POST /api/voice/token (your auth)──▶ host-token-route ──2. create session──▶ backend-help-desk
   │                                                  │  3. sign token (fresh room, mic-only)       (internal API,
   │◀──────── { server_url, participant_token } ──────┘  4. record room (compare-and-set) ────▶   host credential)
   │
   └──5. WebRTC──▶ LiveKit Cloud ──6. dispatch──▶ worker-livekit ──7. POST /v0/sessions/start──▶ backend-help-desk
                                                     (verifies before   8. POST /v0/turns (each turn)  (wire API,
                                                      joining the room)  9. POST /v0/sessions/end       worker credential)
```

## Quickstart (local development)

Requirements: Node.js 24, pnpm 10, a LiveKit Cloud project (LiveKit Inference is used for STT and TTS).

```console
pnpm install
pnpm build                                   # the examples run against the built packages

# LiveKit credentials (root .env.local, gitignored):
#   LIVEKIT_URL=wss://<project>.livekit.cloud
#   LIVEKIT_API_KEY=...
#   LIVEKIT_API_SECRET=...

cp examples/.env.example examples/.env.local  # gitignored
# Fill HELP_DESK_WORKER_CREDENTIAL and HELP_DESK_HOST_CREDENTIAL with two different values:
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Then, in three terminals:

```console
pnpm --filter @voicebridge/backend-help-desk-example start   # 127.0.0.1:8788
pnpm --filter @voicebridge/host-token-route-example start    # 127.0.0.1:8790 (dev identity)
pnpm --filter @voicebridge/worker-livekit-example dev        # registers "voicebridge-help-desk"
```

Optional checks:

```console
pnpm --filter @voicebridge/worker-livekit-example diagnose   # sanitized config + backend reachability
curl -s http://127.0.0.1:8081/worker                          # worker health (agent name, job count)
curl -s -X POST http://127.0.0.1:8790/api/voice/token         # { server_url, participant_token }
```

A browser client (Next.js) arrives in the next milestone. Until then, the opt-in end-to-end script
plays the browser's part with synthetic speech (Windows speech engine for the audio files):

```console
powershell -File examples/worker-livekit/e2e/gen-wavs.ps1 -OutDir <wavDir>
pnpm --filter @voicebridge/worker-livekit-example e2e conversation <wavDir>
pnpm --filter @voicebridge/worker-livekit-example e2e revoke <wavDir>
```

## Expected interactions

| You say or type                        | The agent says (verbatim from the backend)                                                                                             |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| (session start)                        | "Welcome to Pebblebrook Home Goods support. You can ask about opening hours, returns, delivery, warranty, or resetting your password." |
| "What are your opening hours?"         | "Pebblebrook Home Goods is open Monday to Saturday, from nine in the morning to six in the evening. We are closed on Sundays."         |
| "How do I return an item?"             | "You can return unused items within thirty days with your order number. …"                                                             |
| "How long does delivery take?" (typed) | "Standard delivery takes three to five working days, and it is free on orders over fifty pounds."                                      |
| anything else                          | "I can help with opening hours, returns, delivery, warranty, or resetting your password. …"                                            |
| "That's all, goodbye."                 | "Thanks for contacting Pebblebrook Home Goods. Goodbye." Then the session ends.                                                        |

There's no LLM. Answers are deterministic keyword lookups and are spoken unchanged.

## Authentication and session binding

**Two credentials, least privilege.** The backend accepts:

- the **host credential** only on `/internal/v0/sessions*` (create, verify issuance, attach room, revoke)
- the **worker credential** only on the wire contract `/v0/*` (start, turns, end)

Each credential identifies exactly one application. Credentials are compared in constant time.

**Issuing a voice session** (`POST /api/voice/token` on the host):

1. The host authenticates the caller (here: the development identity, see below). Anything the
   browser sends in the body is **ignored**: room names, identities, agent names, metadata,
   application ids.
2. The application id comes from host configuration. The host asks the backend to create a
   session for the authenticated subject, which returns an opaque 256-bit `sessionRef`.
3. `@voicebridge/livekit-tokens` checks the session is issuable (active, unexpired, **no room bound
   yet**), then signs a token for a fresh random room with explicit dispatch of the allowlisted agent.
4. `recordIssuance` binds the room to the session with **compare-and-set**. A second issuance can
   never overwrite it (`409`), and its token is never returned. Of several concurrent issuances,
   exactly one wins.

**Starting the session** (worker, before joining the room): dispatch metadata is validated, the
application must match, and `POST /v0/sessions/start` must answer `{ authorized: true }`. The
backend checks the session is active, unexpired, not revoked, for this application, and in the
**recorded room**. Start is idempotent per logical session: repeated starts, even from different
LiveKit job ids, succeed without repeating side effects.

**Every turn** (`POST /v0/turns`) re-checks the session. A revoked, expired, or ended session gets
`{ kind: "end", text: "This support session is no longer active. Goodbye." }`, and the worker
then ends the session.

### Current enforcement boundary for revocation

Revocation takes effect at the session's **next turn**, not instantly. Verified live: after the
host revoked the session, the agent stayed in the room until the user spoke again. Then it said
the inactive message and left.

Instant termination would need additional work, none of it implemented:

- the host or backend removing the participant through LiveKit's server API
  (`RoomServiceClient.removeParticipant` or `deleteRoom`)
- or the worker polling or subscribing to session status

### Development identity

`VB_DEV_AUTH=localhost` makes the host treat every **local** request as the synthetic user
`dev-user-0001`. It's refused (the host won't start) when:

- `VB_DEV_AUTH` is anything other than `localhost`
- `NODE_ENV=production`
- the host binds to a non-loopback address

Per request, it also requires a loopback client **and** a `localhost` `Host` header, which blocks
DNS-rebinding attacks from web pages. Without `VB_DEV_AUTH` and without your own authenticator,
the host refuses to start: there's no unauthenticated mode.

## Configuration

`examples/.env.example` lists every variable:

| Variable                                                            | Used by                                                | Notes                                                        |
| ------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------ |
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`              | host, worker                                           | Root `.env.local`. Server-side only.                         |
| `HELP_DESK_WORKER_CREDENTIAL`, `HELP_DESK_HOST_CREDENTIAL`          | backend (both), worker (worker cred), host (host cred) | At least 32 characters, distinct.                            |
| `HELP_DESK_URL`                                                     | host, worker                                           | `https`, or `http` only for localhost.                       |
| `VB_APPLICATION_ID`, `VB_AGENT_NAME`, `VB_TEXT_INPUT`               | all                                                    | Must agree across host and worker.                           |
| `VB_DEV_AUTH`, `HOST_ALLOWED_ORIGINS`, `HOST_RATE_PER_*`            | host                                                   | Dev identity; exact-match CORS origins; per-minute limits.   |
| `VB_STT_MODEL`, `VB_TTS_MODEL`, `VB_TTS_VOICE`, `VB_TURN_DETECTION` | worker                                                 | LiveKit Inference ids. `VB_TURN_DETECTION=stt` disables VAD. |
| `VB_HEALTH_HOST`, `VB_HEALTH_PORT`                                  | worker                                                 | SDK health server. Defaults `127.0.0.1:8081`.                |

The worker always runs with **recording disabled**, **no LLM**, and `--log-level warn`.

## Demo vs production

| Area             | This demo                                 | Production requirement                                                                                          |
| ---------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| User auth        | Synthetic localhost identity              | Your real authentication. Plug an `Authenticator` into the host (`loadHostConfig(env, authenticate)`).          |
| Session store    | In-memory, one process, lost on restart   | Durable store. `attachRoom`/`authorizeStart` as single conditional writes (`UPDATE … WHERE room_name IS NULL`). |
| Rate limiting    | In-memory fixed window per client/subject | Gateway or shared-store limits per user and client, plus abuse monitoring.                                      |
| CSRF / CORS      | Exact-origin allowlist, no cookies        | If you use cookies: SameSite plus CSRF protection on the token route.                                           |
| Transport        | `http://127.0.0.1` between services       | TLS everywhere (the core refuses `http` except localhost), private networking.                                  |
| Credentials      | `.env.local` files                        | A secrets manager, rotation, distinct credentials per environment.                                              |
| Revocation       | Effective at the next turn                | Add participant removal via LiveKit's server API if you need it to be immediate.                                |
| Worker packaging | `node src/worker.ts dev`                  | `start --log-level warn` under a process manager or container (no Dockerfile shipped yet).                      |
| Providers        | LiveKit Inference (zero data retention)   | Review the data handling of any provider plugins you switch to.                                                 |

## Known limitations

- One application per worker. The host and worker configs must agree on application and agent name.
- Turn detection is model-based. Utterances separated by short pauses may merge into one turn.
- `node worker.ts dev` prints an SDK deprecation warning (LiveKit now recommends `lk agent dev`).
- The FAQ matcher is a keyword lookup, intentionally simple and predictable.
