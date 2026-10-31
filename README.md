# VoiceBridge

> **Status: pre-alpha, under active design.** VoiceBridge is a working title. Nothing here is
> production-ready, and public APIs don't exist yet.

VoiceBridge is an open-source, application-agnostic gateway for adding a real-time voice interface
to existing applications and backend APIs, built on
[LiveKit Agents for Node.js](https://github.com/livekit/agents-js).

The goal: a developer connects their backend with a small, typed adapter, and VoiceBridge handles
audio transport, speech recognition, turn-taking, and speech synthesis. It supports two modes:

- **Backend-controlled:** the user's transcribed speech goes to your backend, and its approved
  response is spoken verbatim. No LLM rewrites it.
- **Agent-controlled:** an LLM converses with the user and may call only the backend tools you
  explicitly register, with validated arguments and your backend's authorization.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design, trade-offs, MVP acceptance
criteria, and implementation plan.

## Current state

The repository currently contains the LiveKit Node.js agent starter (in `src/`) as a runnable
baseline. It will be replaced by the packages described in the architecture document. Don't build
on `src/`.

## Development setup

Requirements: Node.js 24, pnpm 10, and the
[LiveKit CLI](https://docs.livekit.io/intro/basics/cli/) 2.19 or later.

```console
pnpm install
cp .env.example .env.local   # then fill in your own LiveKit project credentials
```

Never commit `.env.local` or any other credentials. See [SECURITY.md](SECURITY.md).

Common commands:

```console
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm dev            # runs the starter agent against your LiveKit Cloud project (lk agent dev)
```

The default configuration uses [LiveKit Inference](https://docs.livekit.io/agents/models/inference/),
which requires a LiveKit Cloud project. Self-hosted LiveKit needs provider plugins instead.

## Using coding agents

Project rules for all coding agents are in [CLAUDE.md](CLAUDE.md). LiveKit's own guidance is in
[AGENTS.md](AGENTS.md).

LiveKit publishes [agent skills](https://github.com/livekit/agent-skills) for building, testing,
and debugging LiveKit agents. This repository commits one copy for Claude Code in
`.claude/skills/`, pinned by `skills-lock.json`. Docs MCP server config is committed for Claude
Code (`.mcp.json`), Cursor (`.cursor/mcp.json`), Codex (`.codex/config.toml`), and Gemini CLI
(`.gemini/settings.json`).

If you use another coding agent (Codex, Cursor, Gemini CLI, GitHub Copilot, and others), install
the skills locally with the LiveKit CLI:

```console
lk skills install     # installs for the coding agents it detects, and configures the Docs MCP server
lk skills list        # shows what's installed and whether it's current
```

This may create directories such as `.agents/skills/`. Please don't commit them: one copy in
`.claude/skills/` plus `skills-lock.json` is the source of truth. To update the skills, run
`lk skills update` and commit the changes to `.claude/skills/` and `skills-lock.json` together.

## Licence

Apache-2.0, see [LICENSE](LICENSE). Portions are derived from LiveKit's MIT-licensed
[agent-starter-node](https://github.com/livekit-examples/agent-starter-node). See [NOTICE](NOTICE)
for attribution and for notable licences of runtime dependencies, including the LiveKit Model
License that covers the turn-detector weights shipped with `@livekit/agents`.

VoiceBridge is an independent project and isn't affiliated with or endorsed by LiveKit, Inc.
