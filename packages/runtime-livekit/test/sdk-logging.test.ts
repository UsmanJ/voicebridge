// Tripwire for a LiveKit Agents SDK privacy behaviour (see docs/ARCHITECTURE.md §14 #23).
//
// @livekit/agents 1.9.5 logs the raw user transcript at WARN when a user turn ends while speech
// scheduling is paused. That always happens when a session closes with an uncommitted user turn:
// AgentSession teardown drains the activity (pausing scheduling) and then force-commits the
// pending user turn. The SDK's PII redaction applies only to LiveKit Cloud telemetry export; the
// local pino logger writes `lk.pii.*` fields to stdout unchanged. VoiceBridge's mitigation is the
// SDK's own log level (`LOG_LEVEL=error`, the example worker's default).
//
// These tests run the real SDK statement through the real SDK logger, with a synthetic
// transcript. When the SDK is upgraded and they fail, re-audit the SDK's logging before changing
// them (patches/README.md has the same policy for the local components-react patch).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const sdkDist = dirname(require.resolve('@livekit/agents'));
const sdkVersion = (
  JSON.parse(readFileSync(join(sdkDist, '..', 'package.json'), 'utf8')) as { version: string }
).version;

type Logger = { warn: (...args: unknown[]) => void };
const { initializeLogger, log } = (await import(pathToFileURL(join(sdkDist, 'log.js')).href)) as {
  initializeLogger: (o: { pretty: boolean; level: string }) => void;
  log: () => Logger;
};
const { AgentActivity } = (await import(
  pathToFileURL(join(sdkDist, 'voice', 'agent_activity.js')).href
)) as {
  AgentActivity: { prototype: { onEndOfTurn(info: { newTranscript: string }): Promise<boolean> } };
};

const SYNTHETIC_TRANSCRIPT = 'synthetic transcript zebra-4471';

/** Runs the SDK's end-of-turn handler as it runs during session teardown, capturing stdout. */
async function endTurnWhileSchedulingPaused(level: string): Promise<string> {
  initializeLogger({ pretty: false, level });
  const written: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  try {
    const activityDuringTeardown = {
      schedulingPaused: true, // set by AgentActivity.drain() during AgentSession teardown
      newTurnsBlocked: false,
      cancelPreemptiveGeneration: () => {},
      logger: log(),
      agentSession: { amd: null, _closing: false },
    };
    const skipped = await AgentActivity.prototype.onEndOfTurn.call(activityDuringTeardown, {
      newTranscript: SYNTHETIC_TRANSCRIPT,
    });
    expect(skipped).toBe(true);
  } finally {
    spy.mockRestore();
  }
  return written.join('');
}

afterEach(() => {
  initializeLogger({ pretty: false, level: 'silent' });
});

describe('@livekit/agents local logging of user transcripts', () => {
  it('is pinned to the audited SDK version', () => {
    expect(sdkVersion).toBe('1.9.5');
  });

  it('at warn, writes the raw transcript to stdout (the limitation this guards)', async () => {
    const out = await endTurnWhileSchedulingPaused('warn');
    expect(out).toContain('skipping user input, speech scheduling is paused');
    expect(out).toContain('"lk.pii.user_input"');
    expect(out).toContain(SYNTHETIC_TRANSCRIPT);
  });

  it('at error (the example worker default), writes nothing', async () => {
    const out = await endTurnWhileSchedulingPaused('error');
    expect(out).not.toContain(SYNTHETIC_TRANSCRIPT);
    expect(out).toBe('');
  });

  it('session teardown force-commits a pending user turn after pausing scheduling (the trigger)', () => {
    const session = readFileSync(join(sdkDist, 'voice', 'agent_session.js'), 'utf8');
    const teardown = session.slice(session.indexOf('async teardownActivity('));
    const drain = teardown.indexOf('await activity.drain(');
    const commit = teardown.indexOf('activity.commitUserTurn({ audioDetached: true');
    expect(drain).toBeGreaterThan(0);
    expect(commit).toBeGreaterThan(drain);
  });

  it('the CLI reads LOG_LEVEL (the control the example worker sets) and accepts "error"', () => {
    const cli = readFileSync(join(sdkDist, 'cli.js'), 'utf8');
    expect(cli).toMatch(
      /--log-level <level>[^\n]*\.choices\(\[[^\]]*"error"[^\]]*\]\)[^\n]*\.env\("LOG_LEVEL"\)/,
    );
  });

  it('every SDK log statement carrying a user transcript field is at warn or below', () => {
    // If a release adds one at error or fatal, LOG_LEVEL=error stops being sufficient.
    const fields =
      /lk\.pii\.(user_input|new_transcript|user_transcript|transcript|audio_transcript)\b/;
    const offenders: string[] = [];
    const levels: Record<string, number> = {};
    for (const file of ['voice/agent_activity.js', 'voice/audio_recognition.js', 'voice/amd.js']) {
      const lines = readFileSync(join(sdkDist, file), 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (!fields.test(line)) return;
        // The nearest logger call at or above the field, within the same statement window.
        const window = lines.slice(Math.max(0, i - 12), i + 1).join('\n');
        const calls = [...window.matchAll(/\.(fatal|error|warn|info|debug|trace)\(/g)];
        const level = calls.at(-1)?.[1] ?? 'unclassified';
        levels[level] = (levels[level] ?? 0) + 1;
        if (level === 'error' || level === 'fatal' || level === 'unclassified') {
          offenders.push(`${file}:${i + 1} (${level})`);
        }
      });
    }
    expect(offenders).toEqual([]);
    // Sanity: the scan found the WARN statements this file is about.
    expect(levels.warn).toBeGreaterThanOrEqual(3);
  });
});
