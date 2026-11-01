# Security policy

VoiceBridge is alpha software (`0.1.0-alpha.1`). No version is supported for production use, and
the example applications are demonstrations, not deployable services.

## Reporting a vulnerability

Please **don't** open a public issue, discussion, or pull request for security problems.

Report vulnerabilities through GitHub's private vulnerability reporting: **Security → Report a
vulnerability** on the repository page. Include the affected commit or version, reproduction
steps, and the impact you expect.

This is a volunteer project with one maintainer. You can expect an acknowledgement within a week.
Fixes land on `main`. There are no backports while the project is in alpha.

## Supported versions

| Version         | Supported         |
| --------------- | ----------------- |
| `main`          | Yes (best effort) |
| `0.1.0-alpha.x` | Latest alpha only |
| Anything older  | No                |

## Scope

Particularly relevant classes of issues:

- Token minting that grants more than the documented permissions (microphone publish, data only
  when text input is enabled, one fresh room), or lets a client choose rooms, agents, identities,
  or backend targets.
- Any path where speech, typed text, LLM output, token metadata, or participant-editable data can
  influence which backend URL is called, or bypass tool allowlisting or argument validation.
- Session binding or verification bypasses: joining a room the session wasn't issued for, reusing
  a session, or an agent speaking for a revoked or foreign session.
- Leakage of credentials, delegated user credentials, internal errors, or transcripts to callers,
  the LLM, the browser bundle, or logs.
- Audio or conversation data retained or uploaded when recording is meant to be off.
- The development identity (`VB_DEV_AUTH=localhost`) becoming reachable from another machine
  despite its documented guards.

Out of scope:

- Deploying the examples to a network-reachable host. They're documented as local-only, and
  the development identity can't detect a same-machine reverse proxy that adds no forwarding
  headers.
- Missing production features the documentation lists as your responsibility: real user
  authentication, durable session storage, shared rate limiting, TLS between services.
- Vulnerabilities in LiveKit, speech providers, or other dependencies. Report those upstream. Do
  tell us if VoiceBridge uses a dependency in a way that makes a known issue exploitable.

## What the project does to stay safe

- CI scans the full Git history with gitleaks on every push and pull request.
- CI never uses repository secrets. Pull requests from forks run with a read-only token.
- GitHub Actions and the gitleaks image are pinned to commit SHAs and digests. Dependabot
  proposes updates for them and for npm dependencies.
- `pnpm audit` fails CI on high or critical advisories in production dependencies.
- The browser build fails if server-only packages, secret variable names, or secret values from
  local env files reach the client bundle.

## Handling secrets in this repository

- Never commit `.env*` files (only `.env.example`, with empty values), API keys, tokens, private
  URLs, LiveKit project URLs, or `livekit.toml`.
- If you accidentally commit a secret, treat it as compromised: rotate it first, then remove it
  from history.
