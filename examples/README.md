# VoiceBridge examples: help desk over LiveKit (backend-controlled)

> **DEMO ONLY.** Synthetic data, in-memory storage, and a development-only identity. Read
> [Demo vs production](#demo-vs-production) before adapting any of this.

> [!WARNING]
> **Development identity: local machine only.** `VB_DEV_AUTH=localhost` treats every local
> request as one synthetic user. A reverse proxy on the same machine that adds no forwarding
> headers (for example a bare nginx `proxy_pass http://127.0.0.1:8790`) makes internet requests
> look local, and no Host, Origin, or address check can tell the difference. Never expose the host
> token route through a proxy, tunnel, or container port mapping. Details:
> [Development identity](#development-identity).

Four small processes show how an existing application adds a voice interface with VoiceBridge:

| Directory            | Role                                                                                                                             | Depends on                                        |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `backend-help-desk/` | **Your application backend.** Fictional FAQ ("Pebblebrook Home Goods"), session store, VoiceBridge wire contract v0. No LiveKit. | `@voicebridge/core` (schemas only)                |
| `host-token-route/`  | **Your web app's server.** Authenticates the user, creates the voice session, returns LiveKit credentials.                       | `@voicebridge/livekit-tokens`                     |
| `worker-livekit/`    | **The VoiceBridge worker.** Verifies each session, then speaks the backend's approved answers.                                   | `@voicebridge/runtime-livekit`, `@livekit/agents` |
| `web/`               | **Your web page.** Next.js browser client: start and end, mute, status, transcript, typed questions.                             | `livekit-client`, `@livekit/components-react`     |

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

Requirements: Node.js 24, pnpm 10, a LiveKit Cloud project (LiveKit Inference is used for STT and
TTS), and a desktop browser with a microphone (see [Browser demo](#browser-demo)).

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

Then, in four terminals:

```console
pnpm --filter @voicebridge/backend-help-desk-example start   # 127.0.0.1:8788
pnpm --filter @voicebridge/host-token-route-example start    # 127.0.0.1:8790 (dev identity)
pnpm --filter @voicebridge/worker-livekit-example dev        # registers "voicebridge-help-desk"
pnpm --filter @voicebridge/web-example dev                   # http://localhost:3000
```

Open **http://localhost:3000** (not `127.0.0.1:3000`: the host accepts only the exact origin
`http://localhost:3000`) and click **Start Conversation**. For a production build of the page,
run `pnpm --filter @voicebridge/web-example build`, then `pnpm --filter @voicebridge/web-example start`.

Optional checks:

```console
pnpm --filter @voicebridge/worker-livekit-example diagnose   # sanitized config + backend reachability
curl -s http://127.0.0.1:8081/worker                          # worker health (agent name, job count)
curl -s -X POST http://127.0.0.1:8790/api/voice/token         # { server_url, participant_token }
```

Without a browser, the opt-in end-to-end script plays the browser's part with synthetic speech
(Windows speech engine for the audio files):

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

There's no LLM. Answers are deterministic keyword lookups and are spoken unchanged. Typed questions
and the example-question buttons in the browser go through the same worker and backend adapter as
speech (`POST /v0/turns`), so they get exactly the same answers.

## Browser demo

`examples/web` is a Next.js App Router page built on LiveKit's React components (`useSession`,
`useAgent`, `useSessionMessages`, `BarVisualizer`, `RoomAudioRenderer`, `StartAudio`,
`useTrackToggle`). It contains no FAQ logic: `src/demo-app.ts` holds only the display name,
description, and example questions. To point the page at another backend, change that file plus
the host and worker configuration.

| Area             | Behaviour                                                                                                                                                                                                  |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Starting         | Only on a click. Nothing is requested on page load. A synchronous guard turns double clicks into one credential request.                                                                                   |
| Credentials      | One `POST` to the host token route per Start (no body, no cookies), passed to the SDK as `TokenSource.literal` so the SDK never fetches again. Each conversation gets a new backend session and room.      |
| Microphone       | Microphone only. There are no camera, video, or screen-share controls, and `Permissions-Policy` disables them. A denied or missing microphone gets a specific message, and the session is closed.          |
| Status           | Connecting, Listening, Processing, Speaking, Disconnected, Error. Processing covers the gap between the end of a user turn and the start of the reply: without an LLM the agent has no `thinking` state.   |
| Transcript       | From `useSessionMessages`, in arrival order, one entry per segment (partial speech updates in place). Interrupted replies show only what was spoken. Cleared when the conversation ends. Never persisted.  |
| Typed questions  | Sent on the `lk.chat` text stream. Marked **Sent** once LiveKit accepts the stream (not proof of processing), **Answered** once agent speech follows, and **Not sent** on failure.                         |
| Ending           | End Conversation, closing or reloading the page, the backend ending the session (goodbye, revoked), connection loss, or a 30 s connect timeout. All of them disconnect and stop the microphone.            |
| Autoplay         | `StartAudio` shows an **Allow audio playback** button only when the browser blocks audio.                                                                                                                  |
| Content security | The CSP limits network access to the page itself, the token route, and `*.livekit.cloud`. Production builds have no `unsafe-eval`. `pnpm build` fails if server-only packages or secrets reach the bundle. |

**Browser requirements:** a current desktop Chrome, Edge, Firefox, or Safari with WebRTC and a
microphone. Serve the page from `http://localhost:3000` (a secure context, and the only allowed
origin) or over HTTPS.

**Why the browser calls the host directly (no Next.js proxy).** The M4 host already enforces an
exact-origin allowlist (no wildcard CORS), a localhost-only development identity, and rate limits.
A Next.js proxy route would add a second server hop and a second place to get authentication
wrong, without removing any risk. The page holds no secrets: the token endpoint is a public,
build-time value. LiveKit API keys and backend credentials exist only in the host, backend, and
worker processes.

**Replacing the development identity.** In a real application the token route lives in your own
server and authenticates the request with your existing user session (cookie or bearer token).
Pass an `Authenticator` to `loadHostConfig(env, authenticate)` that returns your user's opaque id,
or `null`. If you use cookies, protect the route with SameSite cookies and CSRF checks, and send
`credentials: 'include'` from the page. Origin and Host checks are defence in depth, not
authentication.

### Manual browser checklist

Run this with a real microphone (the automated tests use mocks; see [Verification](#verification)):

1. Open http://localhost:3000. The status reads **Disconnected**, and the host log shows no
   `token_issued`.
2. Click **Start Conversation** and allow the microphone. You hear and see the welcome message.
3. Say "What are your opening hours?". The answer is spoken and shown verbatim.
4. Ask a follow-up ("How do I return an item?"), then speak over the answer. It stops, and the
   transcript shows only what was spoken.
5. Type "How long does delivery take?" and press Enter. It shows **Sent**, then **Answered**.
6. Click **Mute microphone** and speak: nothing is transcribed. Unmute and speak: it works again.
7. Click **End Conversation**. The transcript clears and the browser's microphone indicator turns off.
8. Start again. A new session begins (the host logs another `token_issued`).
9. Revoke the session through the backend's internal API (as `e2e revoke` does). The agent stays
   until your next question, then says "This support session is no longer active. Goodbye.", and
   the page shows **The assistant ended the conversation.**
10. Block the microphone in the browser's site settings and start again. You get the
    microphone-blocked message.

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
- a hosting-platform environment variable is set (`KUBERNETES_SERVICE_HOST`, `K_SERVICE`,
  `AWS_EXECUTION_ENV`, `FLY_APP_NAME`, `DYNO`, and others; see `HOSTING_ENV_MARKERS` in
  `host-token-route/src/auth.ts`)
- `HOST_ALLOWED_ORIGINS` contains anything other than `http://localhost`, `http://127.0.0.1`, or
  `http://[::1]` origins

Per request, it requires a loopback client **and** a `localhost` `Host` header, which blocks
DNS-rebinding attacks from web pages. It also refuses any request carrying a proxy forwarding
header (`Forwarded`, `Via`, `X-Forwarded-*`, `X-Real-IP`, `CF-Connecting-IP`, and others), which
blocks most reverse proxies, tunnels (ngrok, cloudflared), and load balancers. A refused request
gets `401`. Without `VB_DEV_AUTH` and without your own authenticator, the host refuses to start:
there's no unauthenticated mode. The host logs a warning at startup whenever the development
identity is on.

**What it can't detect.** A reverse proxy on the same machine that forwards to `127.0.0.1:8790`
without adding forwarding headers (for example a bare nginx `proxy_pass http://127.0.0.1:8790;`,
which also sends `Host: 127.0.0.1:8790`) makes remote requests look local. A container started
with `--network host` behind such a proxy is the same. No Host, Origin, or address check can tell
these apart from a real local request, so the guards above are defence in depth, not
authentication. **Never run `VB_DEV_AUTH=localhost` on a machine whose port 8790 is reachable
through a proxy, tunnel, or port mapping.** Anything network-reachable needs a real
`Authenticator`.

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
| `NEXT_PUBLIC_VB_TOKEN_ENDPOINT`, `VB_WEB_EXTRA_CONNECT_SRC`         | web (optional `examples/web/.env.local`)               | Public build-time values. Never secrets.                     |

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
| Browser page     | Calls the host on `127.0.0.1:8790`        | Token route behind your own login, HTTPS, CSP reviewed for your LiveKit host.                                   |

## Privacy and third-party processing

- Speech audio goes to LiveKit Cloud, and LiveKit Inference forwards it to the configured speech
  providers (STT and TTS). Review those providers' data handling before using real conversations.
- LiveKit [documents](https://docs.livekit.io/agents/models/inference/) Inference as zero data
  retention: neither LiveKit nor the model providers store or train on the audio and text. That
  covers model calls through LiveKit Inference only. It doesn't cover Agent Observability (below),
  custom voice clones, or provider plugins that call a provider directly.
- **Agent Observability is separate.** It's LiveKit Cloud's optional upload of session audio,
  transcripts, traces, and logs for its dashboard. VoiceBridge passes `record: false` to
  `session.start`, so this worker uploads none of them. Check the project's settings in the
  LiveKit Cloud dashboard too.
- The help-desk backend keeps only session metadata (no utterances), in memory. Service logs
  contain event names and outcomes, never utterance text, session refs, tokens, or credentials.
- The page keeps the transcript in React state only (no localStorage, analytics, or logging) and
  discards it when the conversation ends. When there are connection problems, the browser console
  (LiveKit SDK at `warn`) may show the random room name and participant identity, but never tokens
  or transcript text.

## Not production-ready

This demo is not production-ready. Before real use it needs at least real user authentication in
place of the development identity, durable session storage, HTTPS everywhere, shared rate
limiting, a secrets manager, and a review of the speech providers' data handling.

## Verification

Automated, without LiveKit Cloud:

- `pnpm --filter @voicebridge/web-example test`: mocked SDK hooks covering the lifecycle, Strict
  Mode, failures, transcripts, typed messages, console hygiene, and keyboard use
- `pnpm --filter @voicebridge/web-example build`: includes the bundle scan
- `pnpm --filter @voicebridge/web-example smoke`: production server headers and the initial page

Live, on LiveKit Cloud with all four processes, in Chrome (dev and production builds): start, a
voice question and a follow-up, an interruption, typed questions, example-question buttons, mute
and unmute, End Conversation, restart with a new session, page reload, goodbye, and next-turn
revoke. The test machine has no microphone, so that run injected synthetic speech as the
microphone. **A run with a real microphone and the browser's permission prompt is still to be
done** (see the checklist above).

Release audit (M5.5), from a fresh clone of the release commit with no reused `node_modules` or
build output: frozen-lockfile install, typecheck, lint, format check, build (with bundle scan),
all tests, core isolation, backend startup, and the production smoke test. None of these needs
LiveKit credentials.

## Known limitations

- One application per worker. The host and worker configs must agree on application and agent name.
- Turn detection is model-based. Utterances separated by short pauses may merge into one turn.
- `node worker.ts dev` prints an SDK deprecation warning (LiveKit now recommends `lk agent dev`).
- The FAQ matcher is a keyword lookup, intentionally simple and predictable.
- LiveKit React SDK quirks the page works around (`@livekit/components-react` 2.9.24):
  `useSession` fetches credentials on mount, on `end()`, and after unexpected disconnects, so the
  page fetches once itself and passes `TokenSource.literal`. `useAgent` reports `failed` during a
  full reconnect and stays `failed` afterwards, so "assistant ended" is decided from agent
  presence and room state.
- `@livekit/components-react` 2.9.24 (its bundled copy of components-core) rethrows a text stream that ends abnormally (the room
  closes while the assistant is mid-sentence) as an uncaught global error. A narrow local patch
  absorbs only that error and rethrows every other one. It mirrors the open upstream fix
  [components-js#1426](https://github.com/livekit/components-js/pull/1426). See
  [patches/README.md](../patches/README.md).
- Clicking Start before the page has finished loading does nothing (React is not attached yet).
