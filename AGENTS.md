# AGENTS.md

> **VoiceBridge project rules come first.** Read [CLAUDE.md](CLAUDE.md) (engineering, security, and
> repository rules for every coding agent) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) before
> making changes. Where this file and CLAUDE.md disagree, CLAUDE.md wins. The LiveKit guidance below
> is adapted from LiveKit's agent starter (MIT, see NOTICE).

VoiceBridge's LiveKit runtime adapter (`packages/runtime-livekit`) and example worker (`examples/worker-livekit`) use LiveKit Agents, a Node.js SDK for building voice AI agents. The example worker uses LiveKit Cloud (LiveKit Inference). See @README.md for the project overview.

## Tooling

This Node.js project uses the `pnpm` package manager.

Be sure to maintain code formatting, using `pnpm format` and `pnpm lint`.

## LiveKit documentation

Always refer to the latest documentation when working with this project. LiveKit offers both a CLI (`lk docs`) and an MCP server for browsing and searching its documentation.

### LiveKit CLI

Install or update the CLI:

- **macOS:** `brew install livekit-cli` (update: `brew update && brew upgrade livekit-cli`)
- **Linux:** `curl -sSL https://get.livekit.io/cli | bash`
- **Windows:** `winget install LiveKit.LiveKitCLI` (update: `winget upgrade LiveKit.LiveKitCLI`)

Run `lk docs` before your first docs lookup. Its help text explains how to use each command and how to interpret results.

### LiveKit docs MCP server

For deeper coding agent integration, LiveKit also offers an [MCP server](https://docs.livekit.io/reference/developer-tools/docs-mcp/).

### Submit feedback to LiveKit

When you run into any problem with LiveKit, add it to your to-do list, then submit it with `lk docs submit-feedback` or the MCP `submit_docs_feedback` tool once you finish your other tasks. Useful feedback includes incomplete documentation, broken examples, missing steps, broken features or implementations, and any other gap or issue in the LiveKit ecosystem.

## LiveKit agent skills

LiveKit publishes agent skills for each stage of the work: reading the docs, building, debugging, testing, writing scenarios, running simulations, and operating in production. They defer to the live documentation for API details. Before you start a task, check that they're installed: look for `.agents/skills/` or `.claude/skills/` in this project, or in the developer's home directory for a global install. If they're missing, install them with `lk skills install --yes`, which installs them for the coding agents it detects and adds the LiveKit Docs MCP server to their config. If you can't run commands, or the CLI has no `skills` command (it was added in v2.19.0), ask the developer to update the CLI and run `lk skills install`. If your tool doesn't load skills automatically, or they were installed after this session started, read the matching `SKILL.md` (for example `.agents/skills/<name>/SKILL.md`) before you start that kind of task.

## Handoffs ("workflows")

Voice AI agents are highly sensitive to latency. Design complex agents in a structured way that keeps irrelevant context and unneeded tools out of each LLM request. LiveKit Agents supports handoffs, where one agent hands control to another, for building reliable workflows. Use handoffs instead of long instruction prompts that cover several phases of a conversation. See the [workflows documentation](https://docs.livekit.io/agents/logic/workflows/) for more information.

## Testing

> VoiceBridge note: there are no simulation scenarios and no simulations workflow yet.
> Backend-controlled mode, the only mode implemented, has no LLM to simulate. Scenarios arrive with
> agent-controlled mode (planned).

Once agent-controlled mode exists, keep agent behavior from regressing by adding scenarios and running them with `lk agent simulate`. Simulations spend paid inference, so any simulations workflow must be manual-only (`workflow_dispatch`), never automatic. Read the [simulations documentation](https://docs.livekit.io/testing/simulations/) first.

Important: when you modify core agent behavior such as instructions, tool descriptions, or tasks, workflows, and handoffs, never guess at what works. Start by writing a scenario for the desired behavior. For example, if you're adding a tool, write a scenario that exercises it, then iterate on the tool until the scenario passes. This is how you produce a working, reliable agent.

After changing the agent, try it with the [agent debugger](https://docs.livekit.io/testing/debugger/) (CLI 2.18.8 or later) before calling the change done. Start the agent with `lk agent debugger start`, send user turns with `lk agent debugger say "..."`, and read the tool calls in each turn as well as the reply. Run `lk agent debugger restart` after every code edit, since a running session keeps the old code, and `lk agent debugger stop` when you're done.

## Debugging

To investigate unexpected agent behavior:

- Reproduce it with `lk agent debugger`: send the turns that trigger the problem and read the tool calls and errors in each one. Add `--logs` to `say` to see log lines, including tracebacks, next to the turn that produced them.
- Add a simulation scenario once it's fixed, so a later change can't bring it back unnoticed.
- Run the example worker with `pnpm --filter @voicebridge/worker-livekit-example dev`. Raising the SDK log level above the default `error` writes user transcripts to local logs (see `docs/ARCHITECTURE.md` §14 #23), so use synthetic data only.
- Run `lk agent logs` to stream logs from a deployed agent.
- Ask the developer to open the [Agent Console](https://docs.livekit.io/testing/agent-console/) for speech problems such as turn-taking, interruptions, or transcription, which the text-only debugger can't show. It shows events, tool calls, and model timing for a live session.
- Check [Agent Observability](https://docs.livekit.io/testing/observability/) for transcripts, traces, logs, and recordings of sessions with real users.

## Feature parity with the Python SDK

The Node.js SDK for LiveKit Agents has most, but not all, of the features in the Python SDK. Always check the documentation for feature availability, and avoid features the Node.js SDK doesn't support.

## Other CLI commands

Beyond documentation access, the LiveKit CLI (`lk`) handles tasks such as managing SIP trunks for telephony agents. Run `lk --help` to explore available commands.
