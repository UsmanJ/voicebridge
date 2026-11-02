# Local patches to third-party packages

pnpm applies these at install time (`patchedDependencies` in `pnpm-workspace.yaml`). Every patch
here is a temporary workaround for a specific upstream bug. Remove it as soon as a release with
the fix is installed.

## `@livekit__components-react@2.9.24.patch`

| Field            | Value                                                                                                                                                                                   |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Package          | `@livekit/components-react` 2.9.24 (Apache-2.0, LiveKit, Inc.), with `livekit-client` 2.23.0                                                                                            |
| Upstream         | [livekit/components-js#1426](https://github.com/livekit/components-js/pull/1426), open and unreleased as of 2026-11-01. 2.9.24 (bundling components-core 0.12.15) is the latest version |
| Files changed    | `dist/room-Bfb4OWAI.mjs` (ES module build) and `dist/shared-CwqlzlSm.js` (CommonJS build)                                                                                               |
| Regression tests | `examples/web/test/sdk-patch.test.tsx`                                                                                                                                                  |

**Why components-react and not components-core.** The bug's source is in `@livekit/components-core`
(`setupTextStream` and `setupChat`), but `@livekit/components-react` 2.9.24 bundles its own copy of
components-core, and of RxJS, into its `dist` files. The browser app never loads the separate
components-core package, so a patch there would have no effect. (An earlier draft of this audit
made exactly that mistake. Checking the production bundle caught it.)

**Bug.** Incoming text streams (transcriptions on `lk.transcription`, chat on `lk.chat`) are read
with `from(reader).subscribe(next)` and no error handler. When the room disconnects, or the agent
leaves, while a stream is still open, `livekit-client` errors the stream with `DataStreamError`
(reason `AbnormalEnd`) by design. RxJS then rethrows that unhandled observable error from a
`setTimeout`, so it surfaces as an **uncaught exception** (`window.onerror`, and the Next.js dev
overlay), not as a promise rejection. Application code can't catch it. In the demo it happens
when you click End Conversation while the assistant is speaking.

**Patch.** At those two call sites the reader passed to `from(...)` is wrapped by
`vbAbsorbAbnormalStreamEnd`. When the underlying reader fails with `DataStreamError` and reason
`AbnormalEnd`, the wrapper ends iteration normally, so the text already received is kept. It does
the same for reason `Incomplete` (livekit-client 2.22.2+ throws it when a stream ends with missing
chunks, a gap in chunk indexes or fewer bytes than declared, which can happen around reconnects),
and logs a `console.warn` for it because text may be missing. Every other error (for example
`DecodeFailed`, `LengthExceeded`, or a plain `Error`) is rethrown unchanged and still surfaces
exactly as before. Attachment byte streams
aren't touched (the demo doesn't use them).

**Removing it.** When Dependabot or a manual upgrade moves `@livekit/components-react` past
2.9.24, the bookkeeping test in `examples/web/test/sdk-patch.test.tsx` fails. Then:

1. Check whether the new release contains components-js#1426 or an equivalent fix.
2. If it does, delete the patch file and its `patchedDependencies` entry, delete the bookkeeping
   test, and run `pnpm install`. Keep the behavioural tests: they should still pass against the
   fixed release.
3. If it doesn't, recreate the patch for the new version
   (`pnpm patch @livekit/components-react@<version>`; the bundled file names change between
   releases).
