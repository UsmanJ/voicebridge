# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow
[Semantic Versioning](https://semver.org/). Before 1.0, any release may contain breaking changes.

## Unreleased

## 0.1.0-alpha.1 - 2026-11-02

First public, experimental alpha. **Not production-ready.** Nothing is published to npm. See the
[release notes](docs/releases/v0.1.0-alpha.1.md).

### Added

- `@voicebridge/core`: provider-neutral contracts, turn coordinator (obsolete replies are never
  spoken), allowlisted tool registry and executor, HTTP backend client (timeouts, abort signals,
  response size caps, no redirects, `https` or localhost-only `http`), and the experimental `/v0`
  wire contract with JSON Schema and conformance vectors. Depends on `zod` only.
- `@voicebridge/livekit-tokens`: server-side LiveKit credential issuer. Mic-only grants, a fresh
  random room and identity per session, allowlisted agent dispatch, room binding verified before
  signing, and recorded through the host's `recordIssuance` hook (the example backend uses
  compare-and-set).
- `@voicebridge/runtime-livekit`: LiveKit Agents (Node.js) adapter for backend-controlled mode.
  The session is verified with the backend before the agent joins (fails closed), backend text is
  spoken verbatim, optional typed input, and `record: false` by default.
- Examples: a fictional help-desk backend, a host token route with a localhost-only development
  identity, a runnable LiveKit worker, and a Next.js browser page.
- Documentation: architecture and ADR 0001, per-package READMEs, examples walkthrough,
  CONTRIBUTING, SECURITY, this changelog.

### Security

- The example worker runs the LiveKit Agents SDK at `LOG_LEVEL=error` by default and no longer
  hard-codes `--log-level warn`. `@livekit/agents` 1.9.5 writes raw user transcripts to its local
  logs at WARN (for example when a session closes with a user turn pending; observed in a real
  run) and lower; its PII redaction covers LiveKit Cloud telemetry only. A startup warning
  appears when a lower level is chosen. Tripwire tests run the real SDK statement with a synthetic
  transcript, and check the SDK's lifecycle and interruption behaviour the adapter relies on.
- The development identity also refuses requests carrying proxy or tunnel forwarding headers,
  refuses to start on common hosting platforms, and refuses non-local browser origins.
- The host's session API client caps backend response size.
- CI: actions and the gitleaks image pinned to SHAs and digests, `persist-credentials: false`, job
  timeouts, production smoke test, `pnpm audit` gate on high and critical advisories, Dependabot.

### Fixed

- The local `@livekit/components-react` patch also absorbs `DataStreamErrorReason.Incomplete`
  (a text stream that ended with missing chunks, which livekit-client 2.22.2+ can raise around
  reconnects) instead of letting RxJS rethrow it as an uncaught error. It keeps the text received
  and logs a console warning. Other stream errors still surface. Regression tests cover
  transcription and chat streams.
- Documentation now matches the implementation: architecture status, packages and examples,
  exported signatures, events and error codes, interruption responsibility, which security
  guarantees belong to the packages versus your backend, privacy and logging statements, and test
  coverage. Manual real-microphone results are recorded.
- The browser demo no longer raises an uncaught `DataStreamError` ("Room disconnected in the
  middle of receiving data") when a conversation ends while the assistant is speaking. The M5
  page-level `unhandledrejection` filter never matched this error, because RxJS rethrows it from a
  timer rather than rejecting a promise. It was removed and replaced by a narrow local patch to
  `@livekit/components-react` 2.9.24 (which bundles components-core) mirroring upstream
  [components-js#1426](https://github.com/livekit/components-js/pull/1426). See
  [patches/README.md](patches/README.md).
- The lockfile is back in sync with `package.json` (`eslint-plugin-react-hooks` specifier), so
  `pnpm install --frozen-lockfile` succeeds.
- `prettier` is now a declared root devDependency, so `pnpm format:check` works on a fresh checkout.
