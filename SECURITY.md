# Security policy

VoiceBridge is pre-alpha. No release is supported for production use yet.

## Reporting a vulnerability

Please **don't** open a public issue for security problems.

Once this repository is public, report vulnerabilities through GitHub's private vulnerability
reporting: **Security → Report a vulnerability** on the repository page. Include the affected
commit or version, reproduction steps, and the impact you expect.

## Scope

Particularly relevant classes of issues:

- Token minting that grants more than the documented permissions, or lets a client choose rooms,
  agents, or backend targets.
- Any path where speech, typed text, LLM output, or participant-editable data can influence which
  backend URL is called, or bypass tool allowlisting or argument validation.
- Leakage of credentials, delegated user credentials, internal errors, or transcripts to callers,
  the LLM, or logs.
- Audio or conversation data retained or uploaded when recording is meant to be off.

## Handling secrets in this repository

- Never commit `.env*` files (only `.env.example`, with empty values), API keys, tokens, private
  URLs, or `livekit.toml`.
- CI runs a secret scan on every push and pull request.
- If you accidentally commit a secret, treat it as compromised: rotate it first, then remove it
  from history.
