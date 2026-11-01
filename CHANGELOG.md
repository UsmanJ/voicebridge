# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow
[Semantic Versioning](https://semver.org/). Before 1.0, any release may contain breaking changes.

## Unreleased

## 0.1.0-alpha.1 - unreleased (release candidate)

First public alpha. **Not production-ready.** Nothing is published to npm. See the
[release notes](docs/releases/v0.1.0-alpha.1.md).

### Added

- `@voicebridge/core`: provider-neutral contracts, turn coordinator (obsolete replies are never
  spoken), allowlisted tool registry and executor, HTTP backend client (timeouts, abort signals,
  response size caps, no redirects, `https` or localhost-only `http`), and the experimental `/v0`
  wire contract with JSON Schema and conformance vectors. Depends on `zod` only.
- `@voicebridge/livekit-tokens`: server-side LiveKit credential issuer. Mic-only grants, a fresh
  random room and identity per session, allowlisted agent dispatch, room binding verified before
  signing and recorded with compare-and-set.
- `@voicebridge/runtime-livekit`: LiveKit Agents (Node.js) adapter for backend-controlled mode.
  The session is verified with the backend before the agent joins (fails closed), backend text is
  spoken verbatim, optional typed input, and `record: false` by default.
- Examples: a fictional help-desk backend, a host token route with a localhost-only development
  identity, a runnable LiveKit worker, and a Next.js browser page.
- Documentation: architecture and ADR 0001, per-package READMEs, examples walkthrough,
  CONTRIBUTING, SECURITY, this changelog.

### Security

- The development identity also refuses requests carrying proxy or tunnel forwarding headers,
  refuses to start on common hosting platforms, and refuses non-local browser origins.
- The host's session API client caps backend response size.
- CI: actions and the gitleaks image pinned to SHAs and digests, `persist-credentials: false`, job
  timeouts, production smoke test, `pnpm audit` gate on high and critical advisories, Dependabot.

### Fixed

- The browser demo no longer raises an uncaught `DataStreamError` ("Room disconnected in the
  middle of receiving data") when a conversation ends while the assistant is speaking. The M5
  page-level `unhandledrejection` filter never matched this error, because RxJS rethrows it from a
  timer rather than rejecting a promise. It was removed and replaced by a narrow local patch to
  `@livekit/components-react` 2.9.24 (which bundles components-core) mirroring upstream
  [components-js#1426](https://github.com/livekit/components-js/pull/1426). See
  [patches/README.md](patches/README.md).
- The lockfile is back in sync with `package.json` (`eslint-plugin-react-hooks` specifier), so
  `pnpm install --frozen-lockfile` succeeds.
