# @voicebridge/runtime-livekit

> **Experimental alpha, not published.** Implements **backend-controlled mode only**. Agent-controlled mode
> (LLM plus tools) is a later milestone.

The VoiceBridge runtime adapter for [LiveKit Agents for Node.js](https://github.com/livekit/agents-js).
It verifies every dispatched session **before** joining the room. It then sends each final user
transcript (or typed message) to your application through `@voicebridge/core`, and speaks the
backend-approved reply **verbatim** through TTS. No LLM is configured, so nothing can rewrite an
approved answer.

Turn coordination, cancellation, stale-reply protection, and HTTP calls live in
`@voicebridge/core`. This package only maps LiveKit onto the core's runtime port.

## Install

`@livekit/agents` is a **peer dependency**: your worker owns the installed version.

```console
pnpm add @voicebridge/runtime-livekit @voicebridge/core @livekit/agents@~1.9.5
```

Tested with `@livekit/agents` 1.9.5 (peer range `~1.9.5`).

## Usage

```ts
// worker.ts
import { ServerOptions, cli } from '@livekit/agents';
import { createHttpBackend, defineApplication } from '@voicebridge/core';
import { createVoiceBridgeAgent } from '@voicebridge/runtime-livekit';
import { fileURLToPath } from 'node:url';

const backend = createHttpBackend({
  applicationId: 'help-desk',
  baseUrl: process.env.HELP_DESK_URL!, // server-side config only
  serviceCredential: process.env.HELP_DESK_CREDENTIAL!, // per application, never sent to browsers
  endpoints: { sessionStart: '/v0/sessions/start' }, // REQUIRED for LiveKit (authorization)
});

export default createVoiceBridgeAgent({
  application: defineApplication({
    applicationId: 'help-desk',
    conversation: backend.conversation(),
  }),
  mode: 'backend-controlled',
  providers: {
    stt: { model: 'assemblyai/universal-3-6-pro', language: 'en' }, // LiveKit Inference, or an stt.STT instance
    tts: { model: 'fishaudio/s2.1-pro', voice: '…' }, // LiveKit Inference, or a tts.TTS instance
  },
  textInput: false, // must match the token policy's allowTextInput
});

// Register under the agent name your @voicebridge/livekit-tokens issuer dispatches.
cli.runApp(
  new ServerOptions({ agent: fileURLToPath(import.meta.url), agentName: 'voicebridge-agent' }),
);
```

**Run the LiveKit SDK at `error`:** `node worker.ts start --log-level error` (or `LOG_LEVEL=error`).
The SDK's `start` command defaults to `info` and `dev` to `debug`, and `@livekit/agents` 1.9.5 can
write raw user transcripts to local logs at `warn` and below (see Privacy). The example worker
sets `LOG_LEVEL=error` unless you override it. For local development, LiveKit now recommends
`lk agent dev`; `node worker.ts dev` still works but prints a deprecation warning.

### Options

| Option                    | Default         | Notes                                                                                                   |
| ------------------------- | --------------- | ------------------------------------------------------------------------------------------------------- |
| `application`             | required        | One application per worker. Its conversation adapter **must** implement an authorizing `start`.         |
| `mode`                    | required        | `'backend-controlled'` (the only mode in this version).                                                 |
| `providers.stt` / `tts`   | required        | `{ model, language? }` / `{ model, voice? }` for LiveKit Inference, or pre-built `stt.STT` / `tts.TTS`. |
| `providers.turnDetection` | `'livekit'`     | `'livekit'`: turn detector plus default VAD. `'stt'`: provider endpointing, no VAD (coarser).           |
| `textInput`               | `false`         | Enables typed `lk.chat` input through a custom callback.                                                |
| `verificationTimeoutMs`   | `5000`          | Max `9000` (the SDK warns if a job hasn't connected within 10 s).                                       |
| `backend`                 | core defaults   | `{ timeoutMs, fallbackText, pendingTurnHoldMs }`.                                                       |
| `recording`               | `false`         | Explicit opt-in categories only (`{ traces: true }` and so on). See privacy.                            |
| `logger` / `observer`     | stderr JSON / – | VoiceBridge warnings and errors (no payloads) / privacy-safe core events.                               |

`createVoiceBridgeJobHandler(options, sdk?)` returns the raw job entry function, for custom
bootstraps and tests (inject fake `SdkBindings`).

## Session verification (fails closed)

For every dispatched job, before connecting to the room, subscribing to audio, creating STT or
TTS, or calling application logic:

1. **Dispatch metadata** must be exactly `{ vb: 0, applicationId, sessionRef }`
   (`parseDispatchMetadata` from `@voicebridge/livekit-tokens`).
2. **Application:** `applicationId` must equal the worker's configured application.
3. **Room:** the job must carry its room name (server-minted).
4. **Authorization:** the application's authenticated `POST /v0/sessions/start` receives
   `{ sessionRef, runtimeBinding: { runtime: 'livekit', roomName } }` with the service
   credential and `Idempotency-Key: {jobId}:start`. The backend must check its **active,
   unexpired, server-stored** binding for that application, **including the room recorded at
   issuance** (see `recordIssuance` in `@voicebridge/livekit-tokens`). Only an explicit
   `{ authorized: true, greeting? }` passes.

Any failure (malformed metadata, wrong application, missing room, non-2xx, invalid body, network
error, timeout) calls `JobContext.shutdown()` without ever connecting. The worker logs only the
job id and a reason code. Opaque refs and JWT claims are never treated as authorization on their
own. `sessions/start` is called exactly once per job; the core reuses its result for the greeting.

## LiveKit mapping

| Runtime port                         | LiveKit Agents 1.9.5                                                                                                                   |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| user turn (speech)                   | `Agent.onUserTurnCompleted` hook. Forwards `newMessage.textContent` and **returns immediately** (the SDK serializes these hooks).      |
| user turn (text)                     | custom `textInputCallback`. Interrupts current speech first, then forwards (`source: 'text'`).                                         |
| final transcript pending (hold rule) | `user_input_transcribed` with `isFinal`                                                                                                |
| `speak(text)`                        | `session.say(text, { allowInterruptions: true })` → `waitForPlayout()` / `interrupted`                                                 |
| `interrupt()`                        | `session.interrupt()`. The returned Future's rejection is always handled.                                                              |
| `end(reason)`                        | `session.shutdown({ drain: true, reason })` then `JobContext.shutdown()`                                                               |
| session ended                        | `close` event (participant disconnected → `client_left`) and job shutdown callback. Both are idempotent: one `sessions/end`.           |
| capabilities                         | barge-in, text input (if enabled), pending-turn signal, trusted context. No streaming speech (not verified), no tool calling (no LLM). |

The session is created with STT, TTS, and turn detection, **no LLM**, and preemptive generation off.

**Interruptions.** The core cancels superseded backend requests but never stops speech itself.
LiveKit Agents 1.9.5 interrupts active and queued speech when it commits a spoken user turn (before
`onUserTurnCompleted` runs), and barge-in stops speech while the user talks. Typed turns bypass
that path, so the adapter calls `session.interrupt()` first.

**Lifecycle.** The SDK closes the `AgentSession` when the user disconnects deliberately
(`CLIENT_INITIATED`, `ROOM_DELETED`, `USER_REJECTED`); that releases STT and TTS and closes the
core session. The job itself ends when LiveKit closes the room after the last non-agent participant
leaves, so the adapter doesn't call `JobContext.shutdown()` on `client_left`. That isn't immediate:
LiveKit keeps an empty room open for its `departure_timeout` grace period, and after a network drop
the server first has to detect that the participant is gone (neither delay measured here). A network
drop leaves the session open so the same user can rejoin; real reconnection is not yet verified.
Tripwire tests check these SDK facts.

## Privacy

- `record` is always passed explicitly to `session.start` and defaults to `false`: no audio,
  transcript, traces, or logs are uploaded to LiveKit Cloud Agent Observability. Opting in also
  sends `enable_user_data_training` with the session report (see `docs/ARCHITECTURE.md`).
- VoiceBridge's own logs carry codes, reasons, job ids, and error class names, never transcripts,
  replies, session refs, rooms, credentials, or backend responses.
- **The LiveKit SDK's own local logs can contain user transcripts.** In `@livekit/agents` 1.9.5
  they appear at DEBUG, and at **WARN** in four statements, including "skipping user input, speech
  scheduling is paused" (`lk.pii.user_input`). That one runs whenever a session closes with a user
  turn still pending; it was observed in a real worker log. The SDK redacts `lk.pii.*` fields only
  in LiveKit Cloud telemetry export, which `record: false` keeps off; local stdout is unredacted.
  No known 1.9.5 statement at `error` carries a transcript, so run the SDK at `error` and treat
  logs at lower levels as sensitive. `test/sdk-logging.test.ts` runs the real statement with a
  synthetic transcript and fails if an SDK upgrade changes this.

### Your logging responsibilities

This package can't set the SDK's log level: your worker's entry point and the LiveKit CLI do. If
you integrate `@voicebridge/runtime-livekit` in your own worker:

- Start it with `--log-level error` or `LOG_LEVEL=error`. Don't hard-code a lower level in scripts
  (a CLI flag overrides `LOG_LEVEL`). The example worker shows one way
  (`examples/worker-livekit/src/worker.ts`).
- Raising the level for debugging can put user transcripts in your logs. Do it briefly, on synthetic
  or consented conversations, and delete those logs afterwards.
- `error` is not a redaction guarantee: error records can include job ids, room names, participant
  identities, error objects, and provider error payloads. Treat worker logs as sensitive data with
  access control and retention limits.
- `record: false` only stops Agent Observability uploads. Runtime stdout and stderr are collected by
  whatever runs the worker: LiveKit Cloud agent hosting collects them (`lk agent logs`, dashboard,
  log drains), and so does your own log pipeline on self-hosted infrastructure.
- Re-check the SDK's logging after every `@livekit/agents` upgrade; the tripwire tests here are
  pinned to 1.9.5.
- LiveKit Inference is zero-retention with model providers. Your own plugin accounts follow those
  providers' policies. Review them separately.

## Testing

- `pnpm test`: 72 tests. Orchestration runs with fake `JobContext`, `AgentSession`, and SDK bindings,
  plus a local HTTP stub. SDK tripwires read or run the installed `@livekit/agents` (logging levels,
  lifecycle, interruption). No LiveKit Cloud, credentials, or audio needed.
- **Opt-in live harness** (`live/`, synthetic data, uses your own LiveKit project, never run in CI):

  ```console
  powershell -File live/gen-wavs.ps1 -OutDir <wavDir>
  node live/stub-backend.ts                                   # host + backend with real binding checks
  node --env-file=../../.env.local live/worker.ts dev          # VoiceBridge worker
  node --env-file=../../.env.local live/harness.ts <scenario> <wavDir>
  # scenarios: basic delayed cancel stale errors text | revoked expired wrong-room forged-ref bad-metadata
  ```
