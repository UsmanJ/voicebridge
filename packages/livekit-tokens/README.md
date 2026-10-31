# @voicebridge/livekit-tokens

> **Pre-alpha, not published.** Server-side only. Never bundle this package into a browser.

Mints LiveKit participant credentials for VoiceBridge voice sessions:

- **least-privilege**: microphone in, audio out
- **room-scoped**: exactly one fresh, server-named room
- **short-lived**: 10 minutes by default
- **explicit dispatch** of a server-selected, allowlisted agent

## What it deliberately does not do

- **Authenticate users.** Your application does that before calling this package.
- **Decide authorization on its own.** You supply a verifier that checks the session binding in
  your own store.
- **Accept client choices.** No client-selected room names, participant identities, agent names,
  or metadata.
- **Expose an HTTP endpoint.** You wire it into your own authenticated route. Don't create a
  public, unauthenticated token endpoint.
- **Run the agent.** No `@livekit/agents`, no native binaries, no frontend code. Production
  dependencies: `livekit-server-sdk` (→ `@livekit/protocol`, `@bufbuild/protobuf`, `jose`) and
  `@voicebridge/core` (→ `zod`).
- **Verify sessions inside the worker.** The worker must re-verify the binding server-side (see
  [Integration with the worker](#integration-with-the-voicebridge-worker)). That's not implemented yet.

## Usage (server-side)

```ts
import {
  LiveKitTokenError,
  createLiveKitTokenIssuer,
  loadServerConfigFromEnv,
  toTokenSourceResponse,
} from '@voicebridge/livekit-tokens';

const issuer = createLiveKitTokenIssuer({
  ...loadServerConfigFromEnv(), // LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET (server secrets)
  applications: {
    // The allowlist: applicationId → agent dispatched for it (chosen here, never by the client).
    'help-desk': { agentName: 'voicebridge-agent' },
    'task-list': { agentName: 'voicebridge-agent', allowTextInput: true },
  },
  // Checked against YOUR store: the ref exists, is unexpired, belongs to the
  // authenticated user, and is bound to this application. Must return exactly `true`.
  verifySessionBinding: async ({ applicationId, sessionRef }) =>
    voiceSessions.isBound({ applicationId, sessionRef }),
  ttlSeconds: 600, // optional, 60–3600
});

// Inside YOUR authenticated route handler (pseudo-code):
async function startVoiceSession(req: AuthenticatedRequest) {
  const user = req.user; // from your auth middleware, not from the request body
  const applicationId = 'help-desk'; // decided by your server for this route/product
  const sessionRef = await voiceSessions.create({ userId: user.id, applicationId }); // opaque, ≥128 bits
  try {
    const creds = await issuer.issue({ applicationId, sessionRef });
    return json(200, toTokenSourceResponse(creds)); // { server_url, participant_token }
  } catch (e) {
    if (e instanceof LiveKitTokenError) return json(e.httpStatus, { error: e.publicMessage });
    throw e;
  }
}
```

`issue()` returns `{ serverUrl, participantToken, roomName, participantIdentity, expiresAt }`.
`toTokenSourceResponse()` produces the body LiveKit client SDKs' endpoint `TokenSource` expects.

**Important:** LiveKit's reference token endpoint honours `room_name`, `participant_identity`,
and `room_config` (including `agent_name` and `agent_metadata`) sent by the client. Your
endpoint must ignore all of them. `issue()` refuses any request that contains anything other
than `applicationId` and `sessionRef`.

## Server-side configuration

| Setting                | Rules                                                                                          |
| ---------------------- | ---------------------------------------------------------------------------------------------- |
| `serverUrl`            | `wss://…` (`ws://` only for localhost). No credentials, query, or fragment.                    |
| `apiKey`               | `[A-Za-z0-9_-]{3,128}`. Appears in tokens as `iss`. This is public by design.                  |
| `apiSecret`            | At least 32 characters, no whitespace. Never returned, logged, or included in errors.          |
| `applications`         | Non-empty allowlist. Ids are lowercase slugs. `agentName` is `[A-Za-z0-9][A-Za-z0-9_-]{0,63}`. |
| `verifySessionBinding` | Required.                                                                                      |
| `ttlSeconds`           | Integer 60–3600, default 600.                                                                  |
| `bindingTimeoutMs`     | Verifier timeout, default 3000.                                                                |

Invalid configuration throws `LiveKitTokenError('config_error')` at construction, naming the
problem but never the secret. The issuer object holds no secret properties, so it's safe to log
or inspect.

## Trust boundary

```
 Browser ──(your session cookie / auth)──▶ Your server route ──▶ issuer.issue({applicationId, sessionRef})
   untrusted                               trusted: authenticates      │  1. exact shape, known application
                                           the user, picks the app,    │  2. verifySessionBinding(...) === true
                                           creates sessionRef          │  3. sign: new room, opaque identity,
                                                                       ▼     least-privilege grant, dispatch
 Browser ◀──── { server_url, participant_token } ─────────────────────────
   (can decode the JWT payload: it contains no secrets or PII)
 LiveKit ──job (metadata {vb:0, applicationId, sessionRef})──▶ Worker ──verify sessionRef server-side (M3)
```

- **Untrusted:** everything from the browser, including any application id, room, agent, identity, or metadata.
- **Trusted:** your server's authenticated user, your choice of application, and your session store.
- **Opaqueness isn't authorization.** A well-formed `sessionRef` is never accepted without
  `verifySessionBinding` returning `true`.
- **Participant metadata isn't authorization.** This package sets none, and VoiceBridge never
  uses it as proof of anything. Participant fields are visible to everyone in the room.
- **The JWT is readable by its holder.** Dispatch metadata in it carries only opaque references.
  The signature gives integrity, not confidentiality.

## Permission model

The decoded token grant is exactly:

| Grant                                                                                                                                                                      | Value                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `room`, `roomJoin`                                                                                                                                                         | the fresh room only, `true`                            |
| `canPublish` / `canPublishSources`                                                                                                                                         | `true` / `["microphone"]` (no camera, no screen share) |
| `canSubscribe`                                                                                                                                                             | `true` (to hear the agent)                             |
| `canPublishData`                                                                                                                                                           | `false`, unless the application sets `allowTextInput`  |
| `canUpdateOwnMetadata`, `hidden`, `recorder`, `agent`, `roomCreate`, `roomList`, `roomRecord`, `roomAdmin`, `ingressAdmin`, `canSubscribeMetrics`, `canManageAgentSession` | all explicitly `false`                                 |

There's no display name, participant metadata, or attributes, and no SIP, inference, or
observability grants. Room names (`vb_` + 128 random bits) and identities (`vbu_` + 128 random
bits) are generated per session and never derived from user or application data.

Verified against LiveKit Cloud on 2026-10-31 (one-off live check, synthetic data):

- microphone publish succeeded
- camera and screen-share publishes were refused (the client call never completed rather than
  erroring, so don't offer those controls)
- with `canPublishData: false`, a typed `lk.chat` message was silently dropped by the server
  (the client call resolved, but a second participant received nothing)
- with text input enabled, the same message was delivered

`canSubscribe` covers all track kinds. LiveKit has no audio-only subscribe grant.

## Token lifetime

`exp` is `ttlSeconds` (default 10 minutes) after issue. It governs the **initial connection
only**: LiveKit refreshes tokens for connected clients, so a session can outlive it. Server SDKs
default to 6 hours if no TTL is set, which this package never allows. A short TTL limits replay of
a leaked token and keeps LiveKit Cloud's revocation window meaningful.

## Dispatch behaviour

MVP approach: **token-based explicit dispatch** (`RoomConfiguration.agents[0]` =
`RoomAgentDispatch({ agentName, metadata })`).

- `agentName` comes from the application's allowlist entry. Requests can't influence it.
- `metadata` is `{"vb":0,"applicationId":"…","sessionRef":"…"}`: opaque references only.
- LiveKit applies `roomConfig` **only when the room is first created**. If the room already
  exists, the dispatch is ignored and no agent joins (verified in the M0.5 spikes). This package
  always generates a fresh, unpredictable room name and never accepts one, so every token
  creates its room.

Why token-based: one signed artifact, no extra server-to-LiveKit call, and no admin-scoped
credential use at request time. The alternative, `AgentDispatchClient.createDispatch(room, agent,
{ metadata })` from `livekit-server-sdk`, needs an extra privileged API call per session. Consider
it later for re-dispatch or for dispatching into rooms that already exist.

## Integration with the VoiceBridge worker

Record the issued room against the session with the optional `recordIssuance` hook. It's awaited
before the token is returned, and a failure means no token:

```ts
recordIssuance: async ({ applicationId, sessionRef, roomName }) =>
  voiceSessions.attachRoom({ applicationId, sessionRef, roomName }),
```

The worker (`@voicebridge/runtime-livekit`) then, before connecting to the room or processing
any audio:

1. Parses job metadata with `parseDispatchMetadata(ctx.job.metadata)`. That rejects anything other
   than the exact v0 shape.
2. Checks `applicationId` against its own configured application (the cross-application guard).
3. Calls the application's authenticated `POST /v0/sessions/start` with
   `{ sessionRef, runtimeBinding: { runtime: 'livekit', roomName } }`. The backend must verify the
   ref against its active, server-stored binding, including the recorded room, and answer
   `{ authorized: true }`. Anything else ends the job without joining the room.

A parsed `sessionRef` alone proves only that someone holding the API secret minted it.

## Errors

`LiveKitTokenError` has a `code`, an operator `message`, a public `publicMessage`, and an
`httpStatus`:

| Code                     | Meaning                                   | Status |
| ------------------------ | ----------------------------------------- | ------ |
| `config_error`           | Invalid server configuration              | 503    |
| `invalid_request`        | Bad shape, format, or unknown application | 400    |
| `session_not_authorized` | Verifier didn't return `true`             | 403    |
| `signing_failed`         | The SDK failed to sign                    | 503    |

Messages never include tokens, secrets, session refs, or request values. The package never logs.
