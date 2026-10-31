import type { BackendReply, SessionContext, SessionStartResult } from '@voicebridge/core';
import { deferred, inMemoryConversation, neverUntilAborted } from '@voicebridge/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createVoiceBridgeJobHandler } from '../src/agent.ts';
import {
  APP_ID,
  EVENTS,
  FakeJob,
  ROOM,
  SECRET_REPLY,
  SECRET_TRANSCRIPT,
  SESSION_REF,
  type Step,
  activeBinding,
  bindingStore,
  conversation,
  fakeSdk,
  metadata,
  options,
  recordingLogger,
  tick,
} from './fakes.ts';

afterEach(() => vi.restoreAllMocks());

/** Wires a job with a binding store and a backend `respond`, instrumenting verification steps. */
function harness(
  respond: Parameters<typeof inMemoryConversation>[0] = (t) => ({
    kind: 'speak',
    text: `Approved: ${t.text}`,
  }),
  opts: {
    bindings?: Parameters<typeof bindingStore>[0];
    job?: Partial<FakeJob['job']>;
    authorize?: (ctx: SessionContext, signal: AbortSignal) => Promise<SessionStartResult>;
    agent?: Parameters<typeof options>[1];
  } = {},
) {
  const steps: Step[] = [];
  const store = bindingStore(opts.bindings ?? { [SESSION_REF]: activeBinding() });
  const authorizeCalls: SessionContext[] = [];
  const authorize = async (ctx: SessionContext, signal: AbortSignal) => {
    steps.push('verify:start');
    authorizeCalls.push(ctx);
    try {
      return await (opts.authorize ?? store.authorize)(ctx, signal);
    } finally {
      steps.push('verify:end');
    }
  };
  const conv = conversation(respond, authorize);
  const sdk = fakeSdk(steps);
  const log = recordingLogger();
  const job = new FakeJob(steps, opts.job);
  const handler = createVoiceBridgeJobHandler(
    options(conv, { logger: log.logger, ...opts.agent }),
    sdk.bindings,
  );
  return { steps, store, conv, sdk, log, job, handler, authorizeCalls };
}

async function untilSpoken(h: ReturnType<typeof harness>, n: number, ms = 1000) {
  const until = Date.now() + ms;
  while (h.sdk.session.speeches.length < n) {
    if (Date.now() > until)
      throw new Error(`expected ${n} utterance(s), got ${h.sdk.session.speeches.length}`);
    await tick(2);
  }
}

describe('session verification before connecting', () => {
  it('1. starts a verified session: verify → create → start (record:false) → connect, greeting spoken', async () => {
    const h = harness();
    await h.handler(h.job);
    expect(h.steps).toEqual([
      'verify:start',
      'verify:end',
      'createSession',
      'createAgent',
      'session.start',
      'connect',
    ]);
    expect(h.authorizeCalls[0]).toEqual({
      applicationId: APP_ID,
      sessionId: 'AJ_synthetic1',
      sessionRef: SESSION_REF,
      runtimeBinding: { runtime: 'livekit', roomName: ROOM },
    });
    await untilSpoken(h, 1);
    expect(h.sdk.session.spoken).toEqual(['Welcome to the help desk.']);
    expect(h.job.shutdownReasons).toEqual([]);
  });

  it.each([
    ['empty metadata', ''],
    ['not JSON', 'not json'],
    ['wrong version', metadata({ vb: 1 })],
    ['extra field', metadata({ token: 'x' })],
    ['malformed sessionRef', metadata({ sessionRef: 'short' })],
  ])('2. rejects %s without creating, starting, or connecting', async (_name, raw) => {
    const h = harness(undefined, { job: { metadata: raw } });
    await h.handler(h.job);
    expect(h.steps).toEqual(['shutdown']);
    expect(h.job.shutdownReasons).toEqual(['voicebridge:invalid_dispatch_metadata']);
    expect(h.authorizeCalls).toHaveLength(0);
  });

  it('3. rejects a job dispatched for an application this worker does not serve', async () => {
    const h = harness(undefined, { job: { metadata: metadata({ applicationId: 'task-list' }) } });
    await h.handler(h.job);
    expect(h.steps).toEqual(['shutdown']);
    expect(h.job.shutdownReasons).toEqual(['voicebridge:application_mismatch']);
  });

  it('rejects a job without a room', async () => {
    const h = harness();
    delete (h.job.job as { room?: unknown }).room;
    await h.handler(h.job);
    expect(h.job.shutdownReasons).toEqual(['voicebridge:missing_room']);
    expect(h.steps).not.toContain('createSession');
  });

  it.each([
    [
      '4. session bound to another application',
      { [SESSION_REF]: activeBinding({ applicationId: 'task-list' }) },
    ],
    [
      '5. session bound to another room',
      { [SESSION_REF]: activeBinding({ roomName: 'vb_otherRoom' }) },
    ],
    ['6. revoked session', { [SESSION_REF]: activeBinding({ status: 'revoked' }) }],
    ['6. expired session', { [SESSION_REF]: activeBinding({ expiresAt: Date.now() - 1 }) }],
    ['unknown session', {}],
  ])('%s: backend refuses, job ends without connecting', async (_name, bindings) => {
    const h = harness(undefined, { bindings });
    await h.handler(h.job);
    expect(h.steps).toEqual(['verify:start', 'verify:end', 'shutdown']);
    expect(h.job.shutdownReasons).toEqual(['voicebridge:session_not_authorized']);
  });

  it.each([
    ['throws', async () => Promise.reject(new Error('boom'))],
    [
      'returns a non-authorization',
      async () => ({ kind: 'speak', text: 'hi' }) as unknown as SessionStartResult,
    ],
    [
      'returns authorized:false',
      async () => ({ authorized: false }) as unknown as SessionStartResult,
    ],
  ])('7. fails closed when verification %s', async (_name, authorize) => {
    const h = harness(undefined, { authorize });
    await h.handler(h.job);
    expect(h.job.shutdownReasons).toEqual(['voicebridge:session_not_authorized']);
    expect(h.steps).not.toContain('createSession');
    expect(h.steps).not.toContain('connect');
  });

  it('7. fails closed when verification times out', async () => {
    const h = harness(undefined, {
      authorize: () => new Promise(() => {}),
      agent: { verificationTimeoutMs: 30 },
    });
    await h.handler(h.job);
    expect(h.job.shutdownReasons).toEqual(['voicebridge:verification_timeout']);
    expect(h.steps).not.toContain('createSession');
  });

  it('8. processes no audio, providers, or app logic while verification is pending', async () => {
    const gate = deferred<SessionStartResult>();
    const respond = vi.fn((): BackendReply => ({ kind: 'speak', text: 'x' }));
    const h = harness(respond, {
      authorize: () => gate.promise,
      agent: { verificationTimeoutMs: 5000 },
    });
    const running = h.handler(h.job);
    await tick(20);
    expect(h.steps).toEqual(['verify:start']);
    expect(respond).not.toHaveBeenCalled();
    gate.resolve({ authorized: true });
    await running;
    expect(h.steps.slice(-4)).toEqual(['createSession', 'createAgent', 'session.start', 'connect']);
  });

  it('calls sessions/start exactly once per job (the core does not repeat it)', async () => {
    const h = harness();
    await h.handler(h.job);
    await tick(10);
    expect(h.authorizeCalls).toHaveLength(1);
  });

  it('refuses at startup to run without an authorizing sessions/start', () => {
    const noStart = inMemoryConversation(() => ({ kind: 'silent' }));
    expect(() => createVoiceBridgeJobHandler(options(noStart), fakeSdk([]).bindings)).toThrowError(
      /sessions\/start/,
    );
  });
});

describe('turn handling', () => {
  it('9 + 10. routes the exact transcript and speaks the approved reply unchanged', async () => {
    const h = harness();
    await h.handler(h.job);
    await untilSpoken(h, 1); // greeting
    const returned = h.sdk.userSays('  Exact transcript, unchanged!  ');
    expect(returned).toBeUndefined(); // the hook returns immediately
    await untilSpoken(h, 2);
    expect(h.conv.calls[0]?.turn).toEqual({
      turnId: 't1',
      text: '  Exact transcript, unchanged!  ',
      source: 'speech',
    });
    expect(h.sdk.session.spoken[1]).toBe('Approved:   Exact transcript, unchanged!  ');
  });

  it('the end-of-turn hook returns synchronously even while the backend is slow', async () => {
    const h = harness((_t, _c, signal) => neverUntilAborted(signal));
    await h.handler(h.job);
    const t0 = performance.now();
    h.sdk.userSays('slow question');
    expect(performance.now() - t0).toBeLessThan(20);
  });

  it('11. routes typed text through the same adapter, interrupting current speech first', async () => {
    const h = harness(undefined, { agent: { textInput: true } });
    h.sdk.session.autoFinish = false;
    await h.handler(h.job);
    expect(h.sdk.session.startArgs?.inputOptions.textEnabled).toBe(true);
    await untilSpoken(h, 1);
    h.sdk.session.type('typed question');
    expect(h.sdk.session.interruptCalls).toBe(1);
    expect(h.sdk.session.speeches[0]?.interrupted).toBe(true);
    await untilSpoken(h, 2);
    expect(h.conv.calls[0]?.turn.source).toBe('text');
    expect(h.sdk.session.spoken[1]).toBe('Approved: typed question');
  });

  it('11. disables text input unless configured', async () => {
    const h = harness();
    await h.handler(h.job);
    expect(h.sdk.session.startArgs?.inputOptions).toEqual({ textEnabled: false });
  });

  it('12. a new turn cancels the outstanding backend request', async () => {
    const h = harness((t, _c, signal) =>
      t.text === 'slow' ? neverUntilAborted(signal) : { kind: 'speak', text: 'fast reply' },
    );
    await h.handler(h.job);
    await untilSpoken(h, 1);
    h.sdk.userSays('slow');
    h.sdk.userSays('fast');
    await untilSpoken(h, 2);
    await tick(10);
    expect(h.conv.abortedTurnIds).toContain('t1');
    expect(h.sdk.session.spoken.slice(1)).toEqual(['fast reply']);
  });

  it('13. suppresses a late reply from a backend that ignores cancellation', async () => {
    const late = deferred<BackendReply>();
    const h = harness((t) =>
      t.text === 'stubborn' ? late.promise : { kind: 'speak', text: 'fresh' },
    );
    await h.handler(h.job);
    await untilSpoken(h, 1);
    h.sdk.userSays('stubborn');
    h.sdk.userSays('next');
    await untilSpoken(h, 2);
    late.resolve({ kind: 'speak', text: 'LATE - MUST NOT BE SPOKEN' });
    await tick(20);
    expect(h.sdk.session.spoken).not.toContain('LATE - MUST NOT BE SPOKEN');
  });

  it('14. a disconnect during an outstanding request aborts it and speaks nothing more', async () => {
    const late = deferred<BackendReply>();
    const h = harness((_t, _c, signal) => {
      signal.addEventListener('abort', () => late.reject(signal.reason));
      return late.promise;
    });
    await h.handler(h.job);
    await untilSpoken(h, 1);
    h.sdk.userSays('question');
    await tick(5);
    h.sdk.session.emit(EVENTS.close, { reason: 'participant_disconnected' });
    await tick(10);
    expect(h.conv.abortedTurnIds).toEqual(['t1']);
    expect(h.conv.endCalls.map((c) => c.reason)).toEqual(['client_left']);
    expect(h.sdk.session.spoken).toHaveLength(1);
  });

  it('15. never speaks after termination (job shutdown callback)', async () => {
    const late = deferred<BackendReply>();
    const h = harness(() => late.promise);
    await h.handler(h.job);
    await untilSpoken(h, 1);
    h.sdk.userSays('question');
    await h.job.runShutdownCallbacks();
    late.resolve({ kind: 'speak', text: 'AFTER SHUTDOWN' });
    h.sdk.userSays('after shutdown');
    await tick(20);
    expect(h.sdk.session.spoken).toEqual(['Welcome to the help desk.']);
  });

  it('a backend "end" reply speaks, then shuts down the session and the job', async () => {
    const h = harness(() => ({ kind: 'end', text: 'Goodbye.' }));
    await h.handler(h.job);
    await untilSpoken(h, 1);
    h.sdk.userSays('bye');
    await untilSpoken(h, 2);
    await tick(20);
    expect(h.sdk.session.shutdowns).toEqual([{ drain: true, reason: 'backend_ended' }]);
    expect(h.job.shutdownReasons).toEqual(['voicebridge:backend_ended']);
  });

  it('forwards final transcripts as the pending-turn signal (hold rule)', async () => {
    const slow = deferred<BackendReply>();
    const h = harness((t) =>
      t.text === 'first' ? slow.promise : { kind: 'speak', text: 'second reply' },
    );
    await h.handler(h.job);
    await untilSpoken(h, 1);
    h.sdk.userSays('first');
    h.sdk.session.emit(EVENTS.userInputTranscribed, { transcript: 'second', isFinal: true }); // pending
    slow.resolve({ kind: 'speak', text: 'OLD - HELD THEN DISCARDED' });
    await tick(10);
    expect(h.sdk.session.spoken).toHaveLength(1);
    h.sdk.userSays('second');
    await untilSpoken(h, 2);
    expect(h.sdk.session.spoken[1]).toBe('second reply');
  });
});

describe('privacy', () => {
  it('16. recording is explicitly disabled by default', async () => {
    const h = harness();
    await h.handler(h.job);
    expect(h.sdk.session.startArgs?.record).toBe(false);
  });

  it('16. recording is passed through only as explicit opt-in categories', async () => {
    const h = harness(undefined, { agent: { recording: { traces: true } } });
    await h.handler(h.job);
    expect(h.sdk.session.startArgs?.record).toEqual({ traces: true });
    expect(() =>
      createVoiceBridgeJobHandler(
        options(
          inMemoryConversation(() => ({ kind: 'silent' }), {
            start: async () => ({ authorized: true }),
          }),
          {
            recording: true as never,
          },
        ),
        fakeSdk([]).bindings,
      ),
    ).toThrowError(/recording/);
  });

  it('17. logs never contain transcripts, replies, session refs, rooms, or backend errors', async () => {
    const consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m),
    );
    // Successful session with secret content.
    const h = harness(() => ({ kind: 'speak', text: SECRET_REPLY }));
    await h.handler(h.job);
    h.sdk.userSays(SECRET_TRANSCRIPT);
    await untilSpoken(h, 2);
    // A failing session and SDK errors with sensitive messages.
    const bad = harness(undefined, {
      authorize: async () => {
        throw new Error(`denied for ${SESSION_REF} in ${ROOM}: ${SECRET_REPLY}`);
      },
    });
    await bad.handler(bad.job);
    h.sdk.session.emit(EVENTS.error, { error: new Error(`stt failed on "${SECRET_TRANSCRIPT}"`) });
    const all = [...h.log.lines, ...bad.log.lines].join('\n');
    expect(all.length).toBeGreaterThan(0);
    for (const secret of [SECRET_TRANSCRIPT, SECRET_REPLY, SESSION_REF, ROOM, '99887766']) {
      expect(all).not.toContain(secret);
    }
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled(); // injected logger used
  });
});

describe('SDK failure handling', () => {
  it('18. session creation failure ends the job (no connect)', async () => {
    const h = harness();
    h.sdk.bindings.createSessionError = new Error('inference credentials missing');
    await h.handler(h.job);
    expect(h.job.shutdownReasons).toEqual(['voicebridge:session_create_failed']);
    expect(h.steps).not.toContain('connect');
  });

  it('18. session.start failure ends the job (no connect, no core session)', async () => {
    const h = harness();
    h.sdk.session.startError = new Error('room io failed');
    await h.handler(h.job);
    expect(h.job.shutdownReasons).toEqual(['voicebridge:session_start_failed']);
    expect(h.steps).not.toContain('connect');
  });

  it('18. room connection failure closes the core session and ends the job', async () => {
    const h = harness();
    h.job.connectError = new Error('ws failed');
    await h.handler(h.job);
    expect(h.job.shutdownReasons).toEqual(['voicebridge:connect_failed']);
  });

  it('18. say() throwing or playout failing is logged and never crashes the session', async () => {
    const h = harness();
    h.sdk.session.sayError = new Error('tts unavailable');
    await h.handler(h.job);
    await tick(10);
    h.sdk.session.sayError = undefined;
    h.sdk.session.autoFinish = false;
    h.sdk.userSays('hello');
    const until = Date.now() + 500;
    while (h.sdk.session.speeches.length === 0 && Date.now() < until) await tick(2);
    h.sdk.session.speeches[0]?.fail(new Error('playout broke'));
    await tick(10);
    expect(h.log.lines.some((l) => l.includes('speech could not be started'))).toBe(true);
    expect(h.log.lines.some((l) => l.includes('speech playout failed'))).toBe(true);
  });

  it('18. a rejecting interrupt() future is handled (no unhandled rejection)', async () => {
    const h = harness(undefined, { agent: { textInput: true } });
    h.sdk.session.interruptRejects = true;
    await h.handler(h.job);
    h.sdk.session.type('typed');
    await untilSpoken(h, 2);
  });

  it('18. SDK error events are logged by class only', async () => {
    const h = harness();
    await h.handler(h.job);
    h.sdk.session.emit(EVENTS.error, {
      error: Object.assign(new Error('secret detail'), { name: 'STTError' }),
    });
    expect(h.log.lines.at(-1)).toContain('STTError');
    expect(h.log.lines.at(-1)).not.toContain('secret detail');
  });
});
