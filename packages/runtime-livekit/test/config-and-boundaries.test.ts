import { isAgent } from '@livekit/agents';
import { inMemoryConversation } from '@voicebridge/core/testing';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createVoiceBridgeAgent, createVoiceBridgeJobHandler } from '../src/agent.ts';
import { liveKitCapabilities } from '../src/runtime-session.ts';
import { fakeSdk, options } from './fakes.ts';

const conv = () =>
  inMemoryConversation(() => ({ kind: 'silent' }), { start: async () => ({ authorized: true }) });
const make = (over: Parameters<typeof options>[1]) => () =>
  createVoiceBridgeJobHandler(options(conv(), over), fakeSdk([]).bindings);

describe('createVoiceBridgeAgent configuration', () => {
  it('returns a LiveKit agent definition', () => {
    expect(isAgent(createVoiceBridgeAgent(options(conv())))).toBe(true);
  });

  it.each([
    ['agent-controlled mode (not implemented)', { mode: 'agent-controlled' as never }],
    ['zero verification timeout', { verificationTimeoutMs: 0 }],
    ['verification timeout beyond the SDK connect window', { verificationTimeoutMs: 9001 }],
    [
      'malformed STT model',
      { providers: { stt: { model: 'not a model' }, tts: { model: 'fishaudio/s2.1-pro' } } },
    ],
    [
      'malformed TTS voice',
      {
        providers: {
          stt: { model: 'assemblyai/u3' },
          tts: { model: 'fishaudio/s2.1-pro', voice: 'bad voice!' },
        },
      },
    ],
    [
      'unknown turn detection',
      {
        providers: { stt: { model: 'a/b' }, tts: { model: 'c/d' }, turnDetection: 'llm' as never },
      },
    ],
    ['non-boolean text input', { textInput: 'yes' as never }],
    ['recording with unknown category', { recording: { video: true } as never }],
  ])('rejects %s', (_name, over) => {
    expect(make(over)).toThrow();
  });

  it('accepts valid inference and STT-turn configurations', () => {
    expect(
      make({
        providers: {
          stt: { model: 'deepgram/nova-3', language: 'en-GB' },
          tts: { model: 'cartesia/sonic-2', voice: 'v_1' },
          turnDetection: 'stt',
        },
      }),
    ).not.toThrow();
  });
});

describe('capabilities', () => {
  it('reports only behaviour verified against LiveKit Agents 1.9.5', () => {
    expect(liveKitCapabilities(false)).toEqual({
      interruption: 'barge-in',
      textInput: false,
      pendingTurnSignal: true,
      streamingSpeech: false,
      trustedSessionContext: true,
      nativeToolCalling: false,
    });
  });
});

describe('package boundaries', () => {
  const repo = fileURLToPath(new URL('../../../', import.meta.url));
  const read = (p: string) =>
    JSON.parse(readFileSync(join(repo, p), 'utf8')) as Record<
      string,
      Record<string, string> | undefined
    >;

  it('declares @livekit/agents as a peer (owned by the host worker), not a dependency', () => {
    const pkg = read('packages/runtime-livekit/package.json');
    expect(pkg.peerDependencies?.['@livekit/agents']).toBe('~1.9.5');
    expect(pkg.dependencies).not.toHaveProperty('@livekit/agents');
    expect(pkg.devDependencies?.['@livekit/agents']).toBe('1.9.5');
  });

  it('19. keeps the core free of LiveKit: only runtime-livekit imports @livekit/agents', () => {
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((e) => {
        const full = join(dir, e);
        return statSync(full).isDirectory() ? files(full) : full.endsWith('.ts') ? [full] : [];
      });
    const importers = ['core', 'livekit-tokens', 'runtime-livekit']
      .flatMap((p) => files(join(repo, 'packages', p, 'src')))
      .filter((f) => /from '@livekit\/agents'/.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(repo.length).replace(/\\/g, '/'));
    expect(importers.length).toBeGreaterThan(0);
    expect(importers.every((f) => f.startsWith('packages/runtime-livekit/'))).toBe(true);
    expect(Object.keys(read('packages/core/package.json').dependencies ?? {})).toEqual(['zod']);
  });
});
