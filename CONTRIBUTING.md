# Contributing to VoiceBridge

Thanks for your interest. VoiceBridge is an early alpha with one maintainer, so please open an
issue to discuss anything larger than a small fix before writing code.

## Ground rules

- By contributing you agree that your contribution is licensed under the
  [Apache License 2.0](LICENSE).
- Don't submit code you don't have the right to contribute: no proprietary code, private
  datasets, or third-party branding. Example data must be obviously fake.
- Never commit `.env*` files (except `.env.example` with empty values), credentials, tokens,
  LiveKit project URLs, recordings, transcripts, or screenshots of real conversations.
- Report security problems privately. See [SECURITY.md](SECURITY.md), not the issue tracker.

## Development setup

Requirements: Node.js 24 (`.nvmrc`) and pnpm 10 (`corepack enable` picks up the pinned version).

```console
pnpm install --frozen-lockfile
pnpm build
```

No LiveKit account is needed for the automated checks. To run the voice demo you need a LiveKit
Cloud project. See the [quickstart](README.md#quickstart-run-the-demo).

## Before opening a pull request

Run everything CI runs:

```console
pnpm typecheck && pnpm lint && pnpm format:check && pnpm build && pnpm test
pnpm verify:core-isolation
pnpm --filter @voicebridge/web-example smoke
```

`pnpm format` and `pnpm lint:fix` fix most formatting and lint problems.

## Architecture rules

The full list is in [CLAUDE.md](CLAUDE.md) (written for coding agents, and binding for humans
too). The most important:

- `packages/core` depends on `zod` only. No LiveKit or other vendor imports. CI enforces this.
- Vendor code lives in runtime adapters (`packages/runtime-livekit`) and runtime-specific server
  helpers (`packages/livekit-tokens`).
- No application-specific prompts, personas, or domain logic in any package. They belong in
  `examples/`.
- The `/v0` wire contract is experimental. Every change updates the Zod schemas, the generated JSON
  Schema (`pnpm --filter @voicebridge/core generate:schemas`), and the conformance vectors.
- Public APIs need TSDoc and Vitest tests. Bug fixes start with a failing test.
- Don't weaken a security check or a test to make something pass.
- Look up LiveKit APIs in the docs and the installed SDK types rather than writing them from
  memory (see [AGENTS.md](AGENTS.md)).

## Dependencies

- Check the licence of every new dependency. Prefer MIT, Apache-2.0, BSD, ISC. Record anything
  that isn't OSI-approved, or that carries extra conditions, in [NOTICE](NOTICE).
- Commit `pnpm-lock.yaml` changes with the `package.json` change that caused them. CI installs
  with `--frozen-lockfile`.
- Local patches to third-party packages need an upstream issue or pull request and a removal
  plan. See [patches/README.md](patches/README.md).

## Commits and pull requests

- Small, focused pull requests with a clear description of what changed and why.
- Conventional commit style is used (`feat(core): …`, `fix(examples): …`, `docs: …`).
- Update the documentation, including `docs/ARCHITECTURE.md` and `CHANGELOG.md`, when behaviour
  or a decision changes.
- CI must pass. It never needs secrets, and live LiveKit tests are never run on pull requests.
