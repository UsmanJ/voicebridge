// Regression tests for the local patch in patches/@livekit__components-react@2.9.24.patch
// (upstream: https://github.com/livekit/components-js/pull/1426). See patches/README.md.
//
// @livekit/components-react 2.9.24 bundles its own copies of @livekit/components-core and RxJS.
// It reads each incoming text stream with from(reader).subscribe(next) and no error handler. When
// the room disconnects while the agent is mid-sentence, livekit-client errors the stream with
// DataStreamError(AbnormalEnd), and RxJS rethrows it from a setTimeout callback as an uncaught
// global error. That isn't a promise rejection, so an `unhandledrejection` listener never sees it.
// These tests drive the real, installed hooks the page uses (useSessionMessages is built on
// useTranscriptions → useTextStream, and useChat) and catch anything thrown from timer callbacks.
import { useChat, useTextStream } from '@livekit/components-react';
import { act, renderHook } from '@testing-library/react';
import { ConnectionState, DataStreamError, DataStreamErrorReason, type Room } from 'livekit-client';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type TextHandler = (reader: unknown, participant: { identity: string }) => Promise<void>;

/** Just enough of a livekit-client Room for the text stream hooks. */
class FakeRoom extends EventEmitter {
  readonly state = ConnectionState.Connected;
  readonly textHandlers = new Map<string, TextHandler>();
  readonly localParticipant = { identity: 'user' };
  registerTextStreamHandler(topic: string, handler: TextHandler) {
    this.textHandlers.set(topic, handler);
  }
  unregisterTextStreamHandler(topic: string) {
    this.textHandlers.delete(topic);
  }
  registerByteStreamHandler() {}
  unregisterByteStreamHandler() {}
  getParticipantByIdentity() {
    return undefined;
  }
}

/** A text stream reader that yields `chunks`, then fails with `error`. */
function failingReader(id: string, chunks: string[], error: Error) {
  return {
    info: { id, timestamp: 0, topic: 't', attributes: {} },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
      throw error;
    },
  };
}

const abnormalEnd = () =>
  new DataStreamError(
    'Room disconnected in the middle of receiving data',
    DataStreamErrorReason.AbnormalEnd,
  );

/** Lets the stream drain and RxJS's deferred error reporting (setTimeout) run. */
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 30)));

// Errors thrown from timer callbacks: what reaches window.onerror in a browser.
let uncaught: unknown[];
beforeEach(() => {
  uncaught = [];
  const realSetTimeout = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
    fn: (...args: unknown[]) => void,
    ms?: number,
    ...args: unknown[]
  ) =>
    realSetTimeout(() => {
      try {
        fn(...args);
      } catch (error) {
        uncaught.push(error);
      }
    }, ms)) as typeof setTimeout);
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function deliver(room: FakeRoom, topic: string, reader: unknown) {
  const handler = room.textHandlers.get(topic);
  expect(handler, `a handler is registered for ${topic}`).toBeDefined();
  await act(() => handler!(reader, { identity: 'agent' }));
}

describe('patched @livekit/components-react text streams', () => {
  it('a transcription that ends abnormally keeps its text and throws nothing globally', async () => {
    const room = new FakeRoom();
    const { result } = renderHook(() =>
      useTextStream('lk.transcription', { room: room as unknown as Room }),
    );
    await deliver(
      room,
      'lk.transcription',
      failingReader('s1', ['Standard delivery ', 'takes three'], abnormalEnd()),
    );
    await settle();

    expect(uncaught).toEqual([]);
    expect(result.current.textStreams.map((s) => s.text)).toEqual([
      'Standard delivery takes three',
    ]);
  });

  it('any other transcription stream error still surfaces globally', async () => {
    const room = new FakeRoom();
    renderHook(() => useTextStream('lk.transcription', { room: room as unknown as Room }));
    const decodeFailure = new DataStreamError('bad chunk', DataStreamErrorReason.DecodeFailed);
    const plain = new Error('unexpected');
    await deliver(room, 'lk.transcription', failingReader('s2', ['x'], decodeFailure));
    await deliver(room, 'lk.transcription', failingReader('s3', [], plain));
    await settle();

    expect(uncaught).toHaveLength(2);
    expect(uncaught).toEqual(expect.arrayContaining([decodeFailure, plain]));
  });

  it('a transcription that ends incomplete keeps its text, warns, and throws nothing globally', async () => {
    // livekit-client 2.22.2+ throws Incomplete when a stream ends with missing chunks (a gap in
    // chunk indexes, or fewer bytes than declared), which can happen around reconnects.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const room = new FakeRoom();
    const { result } = renderHook(() =>
      useTextStream('lk.transcription', { room: room as unknown as Room }),
    );
    const incomplete = new DataStreamError(
      'Missing chunk(s) 2..3 for data stream s4 - cannot reassemble payload',
      DataStreamErrorReason.Incomplete,
    );
    await deliver(
      room,
      'lk.transcription',
      failingReader('s4', ['Returns are ', 'accepted'], incomplete),
    );
    await settle();

    expect(uncaught).toEqual([]);
    expect(result.current.textStreams.map((s) => s.text)).toEqual(['Returns are accepted']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('text stream ended incomplete'));
  });

  it('a chat stream that ends incomplete throws nothing globally', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const room = new FakeRoom();
    const options = { room: room as unknown as Room };
    const { result } = renderHook(() => useChat(options));
    const incomplete = new DataStreamError('Not enough chunk(s)', DataStreamErrorReason.Incomplete);
    await deliver(room, 'lk.chat', failingReader('c3', ['partial'], incomplete));
    await settle();

    expect(uncaught).toEqual([]);
    expect(result.current.chatMessages.map((m) => m.message)).toContain('partial');
  });

  it('a chat stream that ends abnormally throws nothing globally; other errors still surface', async () => {
    const room = new FakeRoom();
    // Stable options: useChat sets up its pipeline again whenever the options object changes.
    const options = { room: room as unknown as Room };
    const { result } = renderHook(() => useChat(options));
    await deliver(room, 'lk.chat', failingReader('c1', ['hello'], abnormalEnd()));
    const other = new Error('unexpected');
    await deliver(room, 'lk.chat', failingReader('c2', ['hi'], other));
    await settle();

    expect(uncaught).toEqual([other]);
    expect(result.current.chatMessages.map((m) => m.message)).toContain('hello');
  });
});

describe('local SDK patch bookkeeping', () => {
  const require = createRequire(import.meta.url);

  it('is applied to the exact @livekit/components-react version it was written for', () => {
    // When this fails after an upgrade: check whether the new release contains the upstream fix
    // (components-js#1426). If it does, delete the patch and this bookkeeping test, and keep the
    // behavioural tests above. Otherwise re-create the patch. See patches/README.md.
    const entry = require.resolve('@livekit/components-react');
    const pkgPath = join(dirname(entry), '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name: string; version: string };
    expect(pkg.name).toBe('@livekit/components-react');
    expect(pkg.version).toBe('2.9.24');
    for (const file of ['room-Bfb4OWAI.mjs', 'shared-CwqlzlSm.js']) {
      const dist = readFileSync(join(dirname(entry), file), 'utf8');
      expect(dist.match(/vbAbsorbAbnormalStreamEnd\(/g)?.length, file).toBe(3);
    }
  });
});
