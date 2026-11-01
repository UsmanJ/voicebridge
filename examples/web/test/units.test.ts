import { DataStreamError, DataStreamErrorReason } from 'livekit-client';
import { describe, expect, it } from 'vitest';
import { isAbandonedTranscriptStream } from '../src/components/VoiceDemo';
import { DEFAULT_TOKEN_ENDPOINT, resolveTokenEndpoint } from '../src/config';
import { toUserFacingError } from '../src/errors';
import { deriveStatus } from '../src/status';
import { buildTranscript, isAwaitingReply } from '../src/transcript';
import { msg } from './fake-livekit';

describe('resolveTokenEndpoint', () => {
  it('defaults to the local host token route', () => {
    expect(resolveTokenEndpoint(undefined)).toBe(DEFAULT_TOKEN_ENDPOINT);
    expect(resolveTokenEndpoint('  ')).toBe(DEFAULT_TOKEN_ENDPOINT);
  });

  it('accepts https anywhere and http only on loopback', () => {
    expect(resolveTokenEndpoint('https://app.example.com/api/voice/token')).toBe(
      'https://app.example.com/api/voice/token',
    );
    expect(resolveTokenEndpoint('http://localhost:8790/api/voice/token')).toContain('localhost');
    expect(() => resolveTokenEndpoint('http://app.example.com/api/voice/token')).toThrow(/https/);
    expect(() => resolveTokenEndpoint('ftp://localhost/x')).toThrow();
    expect(() => resolveTokenEndpoint('not a url')).toThrow(/valid URL/);
  });

  it('refuses embedded credentials, queries, and fragments', () => {
    for (const bad of [
      'https://user:pass@app.example.com/t',
      'https://app.example.com/t?target=http://evil',
      'https://app.example.com/t#x',
    ]) {
      expect(() => resolveTokenEndpoint(bad)).toThrow(/must not contain/);
    }
  });
});

describe('deriveStatus', () => {
  it('maps agent states to UI states', () => {
    expect(deriveStatus('connecting', false)).toBe('connecting');
    expect(deriveStatus('pre-connect-buffering', false)).toBe('connecting');
    expect(deriveStatus('initializing', false)).toBe('connecting');
    expect(deriveStatus('listening', false)).toBe('listening');
    expect(deriveStatus('listening', true)).toBe('processing');
    expect(deriveStatus('thinking', false)).toBe('processing');
    expect(deriveStatus('speaking', true)).toBe('speaking');
    expect(deriveStatus('failed', false)).toBe('error');
    expect(deriveStatus('disconnected', false)).toBe('disconnected');
  });
});

describe('buildTranscript', () => {
  const me = 'vbu_me';

  it('keeps one entry per message id, replacing partial text in place', () => {
    const entries = buildTranscript(
      [
        msg('userTranscript', 'how lo', { id: 's1', final: false }),
        msg('agentTranscript', 'Welcome.', { id: 'a1' }),
        msg('userTranscript', 'how long does delivery take', { id: 's1', final: true }),
      ],
      me,
    );
    expect(entries.map((e) => [e.id, e.text, e.final])).toEqual([
      ['s1', 'how long does delivery take', true],
      ['a1', 'Welcome.', true],
    ]);
  });

  it('skips empty text and marks local chat as typed', () => {
    const entries = buildTranscript(
      [msg('agentTranscript', '   '), msg('chatMessage', 'hours?', { from: me })],
      me,
    );
    expect(entries).toEqual([
      expect.objectContaining({ role: 'user', source: 'typed', delivery: 'sent', text: 'hours?' }),
    ]);
  });

  it('marks a typed question answered only after agent speech follows it', () => {
    const typed = msg('chatMessage', 'returns?', { from: me });
    expect(buildTranscript([typed], me)[0]!.delivery).toBe('sent');
    const after = buildTranscript([typed, msg('agentTranscript', 'You can return…')], me);
    expect(after[0]!.delivery).toBe('answered');
    const before = buildTranscript([msg('agentTranscript', 'Welcome.'), typed], me);
    expect(before[1]!.delivery).toBe('sent');
  });

  it('appends failed sends and does not treat them as awaiting a reply', () => {
    const entries = buildTranscript([msg('agentTranscript', 'Welcome.')], me, [
      { localId: 'f1', text: 'lamps?' },
    ]);
    expect(entries.at(-1)).toMatchObject({ delivery: 'failed', text: 'lamps?' });
    expect(isAwaitingReply(entries)).toBe(false);
  });

  it('awaits a reply after a final user turn, not after a partial one', () => {
    expect(
      isAwaitingReply(buildTranscript([msg('userTranscript', 'what', { final: false })], me)),
    ).toBe(false);
    expect(
      isAwaitingReply(buildTranscript([msg('userTranscript', 'what time', { final: true })], me)),
    ).toBe(true);
    expect(
      isAwaitingReply(
        buildTranscript(
          [msg('userTranscript', 'hi', { final: true }), msg('agentTranscript', 'Hello')],
          me,
        ),
      ),
    ).toBe(false);
  });
});

describe('toUserFacingError', () => {
  it('maps microphone failures and hides unknown error text', () => {
    expect(toUserFacingError(new DOMException('x', 'NotAllowedError')).code).toBe(
      'microphone_denied',
    );
    expect(toUserFacingError(new DOMException('x', 'NotFoundError')).code).toBe(
      'microphone_missing',
    );
    expect(toUserFacingError(new DOMException('x', 'NotReadableError')).code).toBe(
      'microphone_busy',
    );
    const unknown = toUserFacingError(new Error('ECONNREFUSED 10.1.2.3 secret=abc'));
    expect(unknown.code).toBe('unknown');
    expect(unknown.message).not.toMatch(/10\.1\.2\.3|secret/);
  });
});

describe('isAbandonedTranscriptStream', () => {
  it('matches only the SDK abnormal-end data stream error', () => {
    expect(
      isAbandonedTranscriptStream(
        new DataStreamError('Room disconnected', DataStreamErrorReason.AbnormalEnd),
      ),
    ).toBe(true);
    expect(
      isAbandonedTranscriptStream(new DataStreamError('x', DataStreamErrorReason.DecodeFailed)),
    ).toBe(false);
    expect(isAbandonedTranscriptStream(new Error('Room disconnected'))).toBe(false);
  });
});
