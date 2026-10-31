import { describe, expect, it } from 'vitest';
import { defineApplication } from '../src/contracts/application.ts';
import type { BackendReply } from '../src/contracts/turn.ts';
import { VoiceBridgeError } from '../src/errors.ts';
import { FakeRuntime } from '../src/testing/fake-runtime.ts';
import { deferred, inMemoryConversation, neverUntilAborted } from '../src/testing/in-memory.ts';
import {
  DEFAULT_FALLBACK_TEXT,
  runBackendControlledSession,
} from '../src/turns/backend-session.ts';
import { APP_ID, collector, ctx, tick } from './helpers.ts';

function setup(
  respond: Parameters<typeof inMemoryConversation>[0],
  opts: {
    conversation?: Parameters<typeof inMemoryConversation>[1];
    runtime?: Partial<ConstructorParameters<typeof FakeRuntime>[0]>;
    session?: Parameters<typeof runBackendControlledSession>[2];
  } = {},
) {
  const conversation = inMemoryConversation(respond, opts.conversation);
  const app = defineApplication({ applicationId: APP_ID, conversation });
  const runtime = new FakeRuntime({ context: ctx(), ...opts.runtime });
  const obs = collector();
  const session = runBackendControlledSession(runtime.session, app, {
    observer: obs.observer,
    ...opts.session,
  });
  runtime.attach(session);
  return { conversation, runtime, session, obs };
}

describe('runBackendControlledSession: delivery', () => {
  it('sends the exact turn text to the backend and speaks the reply verbatim', async () => {
    const { conversation, runtime } = setup((turn) => ({
      kind: 'speak',
      text: `Approved: ${turn.text}`,
    }));
    runtime.userSays('  Exact transcript, with punctuation!  ');
    await runtime.untilSpoken(1);
    expect(conversation.calls[0]?.turn).toEqual({
      turnId: 't1',
      text: '  Exact transcript, with punctuation!  ',
      source: 'speech',
    });
    expect(conversation.calls[0]?.ctx).toEqual(ctx());
    expect(runtime.spoken).toEqual(['Approved:   Exact transcript, with punctuation!  ']);
  });

  it('routes typed text through the same adapter with source "text"', async () => {
    const { conversation, runtime } = setup(() => ({ kind: 'speak', text: 'ok' }));
    runtime.userTypes('typed hello');
    await runtime.untilSpoken(1);
    expect(conversation.calls[0]?.turn.source).toBe('text');
  });

  it('says nothing for a silent reply', async () => {
    const { runtime, obs } = setup(() => ({ kind: 'silent' }));
    runtime.userSays('hello');
    await tick(10);
    expect(runtime.spoken).toEqual([]);
    expect(obs.types()).toContain('reply_silent');
  });

  it('ignores blank turns without calling the backend', async () => {
    const { conversation, runtime } = setup(() => ({ kind: 'speak', text: 'x' }));
    runtime.userSays('   ');
    await tick(5);
    expect(conversation.calls).toHaveLength(0);
  });

  it('speaks an end reply, then ends the runtime session and notifies the backend', async () => {
    const { conversation, runtime, session } = setup(() => ({ kind: 'end', text: 'Goodbye.' }));
    runtime.userSays('bye');
    await runtime.untilSpoken(1);
    await tick(10);
    expect(runtime.spoken).toEqual(['Goodbye.']);
    expect(runtime.endCalls).toEqual(['backend_ended']);
    expect(session.closed).toBe(true);
    expect(conversation.endCalls.map((c) => c.reason)).toEqual(['backend_ended']);
  });

  it('records interrupted speech reported by the runtime', async () => {
    const { runtime, obs } = setup(() => ({ kind: 'speak', text: 'A long answer' }), {
      runtime: { autoFinishSpeech: false },
    });
    runtime.userSays('tell me');
    await runtime.untilSpoken(1);
    runtime.bargeIn();
    await tick(5);
    expect(obs.ofType('speech_finished')[0]?.interrupted).toBe(true);
  });
});

describe('runBackendControlledSession: cancellation and stale replies', () => {
  it('a new turn aborts the outstanding request and only the new reply is spoken', async () => {
    const { conversation, runtime, obs } = setup((turn, _c, signal) =>
      turn.text === 'slow' ? neverUntilAborted(signal) : { kind: 'speak', text: 'fast reply' },
    );
    runtime.userSays('slow');
    runtime.userSays('fast');
    await runtime.untilSpoken(1);
    await tick(5);
    expect(conversation.abortedTurnIds).toContain('t1');
    expect(runtime.spoken).toEqual(['fast reply']);
    expect(obs.types()).toEqual(expect.arrayContaining(['turn_superseded', 'turn_cancelled']));
  });

  it('never speaks a late reply from a backend that ignores the abort signal', async () => {
    const late = deferred<BackendReply>();
    const { runtime } = setup((turn) =>
      turn.text === 'stubborn' ? late.promise : { kind: 'speak', text: 'fast reply' },
    );
    runtime.userSays('stubborn');
    runtime.userSays('fast');
    await runtime.untilSpoken(1);
    late.resolve({ kind: 'speak', text: 'LATE - MUST NOT BE SPOKEN' });
    await tick(10);
    expect(runtime.spoken).toEqual(['fast reply']);
  });

  it('holds a reply while a newer transcript awaits commit, then discards it when the turn arrives', async () => {
    const slow = deferred<BackendReply>();
    const { runtime, obs } = setup((turn) =>
      turn.text === 'first' ? slow.promise : { kind: 'speak', text: 'second reply' },
    );
    runtime.userSays('first');
    runtime.finalTranscriptPending();
    slow.resolve({ kind: 'speak', text: 'OLD - MUST NOT BE SPOKEN' });
    await tick(5);
    expect(runtime.spoken).toEqual([]);
    expect(obs.types()).toContain('reply_held');
    runtime.userSays('second');
    await runtime.untilSpoken(1);
    expect(runtime.spoken).toEqual(['second reply']);
    expect(obs.types()).toContain('reply_stale_discarded');
  });

  it('releases a held reply if the runtime never commits the pending turn', async () => {
    const slow = deferred<BackendReply>();
    const { runtime, obs } = setup(() => slow.promise, { session: { pendingTurnHoldMs: 20 } });
    runtime.userSays('hello');
    runtime.finalTranscriptPending(); // e.g. a backchannel the runtime will not commit
    slow.resolve({ kind: 'speak', text: 'reply' });
    await tick(5);
    expect(runtime.spoken).toEqual([]);
    await runtime.untilSpoken(1, 500);
    expect(obs.types()).toContain('reply_released');
  });

  it('ignores the pending-turn signal when the runtime does not declare that capability', async () => {
    const { runtime } = setup(() => ({ kind: 'speak', text: 'reply' }), {
      runtime: { capabilities: { pendingTurnSignal: false } },
    });
    runtime.userSays('hello');
    runtime.finalTranscriptPending();
    await runtime.untilSpoken(1, 200);
  });

  it('stops all delivery after the runtime session ends, and aborts outstanding requests', async () => {
    const { conversation, runtime, obs } = setup((_t, _c, signal) => neverUntilAborted(signal));
    runtime.userSays('hello');
    runtime.end('client_left');
    await tick(10);
    runtime.userSays('after end');
    await tick(10);
    expect(conversation.abortedTurnIds).toEqual(['t1']);
    expect(conversation.calls).toHaveLength(1);
    expect(runtime.speakCallsAfterEnd).toBe(0);
    expect(obs.ofType('session_ended')[0]?.reason).toBe('client_left');
  });
});

describe('runBackendControlledSession: failures', () => {
  it('speaks the fallback when the backend throws, without leaking details', async () => {
    const { runtime, obs } = setup(() => {
      throw new Error('ECONNREFUSED 10.0.0.1 token=secret-xyz');
    });
    runtime.userSays('hello');
    await runtime.untilSpoken(1);
    expect(runtime.spoken).toEqual([DEFAULT_FALLBACK_TEXT]);
    expect(obs.ofType('backend_failed')[0]?.code).toBe('backend_unavailable');
    expect(JSON.stringify(obs.events)).not.toContain('secret-xyz');
    expect(obs.ofType('speech_started')[0]?.fallback).toBe(true);
  });

  it('times out a slow backend and speaks the configured fallback', async () => {
    const { runtime, obs } = setup((_t, _c, signal) => neverUntilAborted(signal), {
      session: { timeoutMs: 20, fallbackText: 'Custom fallback.' },
    });
    runtime.userSays('hello');
    await runtime.untilSpoken(1);
    expect(runtime.spoken).toEqual(['Custom fallback.']);
    expect(obs.ofType('backend_failed')[0]?.code).toBe('backend_timeout');
  });

  it('times out a backend that ignores its abort signal', async () => {
    const { runtime } = setup(() => new Promise<BackendReply>(() => {}), {
      session: { timeoutMs: 20 },
    });
    runtime.userSays('hello');
    await runtime.untilSpoken(1);
    expect(runtime.spoken).toEqual([DEFAULT_FALLBACK_TEXT]);
  });

  it.each([
    ['blank speak text', { kind: 'speak', text: '   ' }],
    ['unknown kind', { kind: 'transfer' }],
    ['extra fields', { kind: 'speak', text: 'hi', ssml: '<x/>' }],
  ])('rejects an invalid in-process reply (%s) and speaks the fallback', async (_name, bad) => {
    const { runtime, obs } = setup(() => bad as unknown as BackendReply);
    runtime.userSays('hello');
    await runtime.untilSpoken(1);
    expect(runtime.spoken).toEqual([DEFAULT_FALLBACK_TEXT]);
    expect(obs.ofType('backend_failed')[0]?.code).toBe('invalid_backend_reply');
  });

  it('a throwing observer never breaks the session', async () => {
    const conversation = inMemoryConversation(() => ({ kind: 'speak', text: 'ok' }));
    const runtime = new FakeRuntime({ context: ctx() });
    const session = runBackendControlledSession(
      runtime.session,
      defineApplication({ applicationId: APP_ID, conversation }),
      {
        observer: () => {
          throw new Error('observer failed');
        },
      },
    );
    runtime.attach(session);
    runtime.userSays('hello');
    await runtime.untilSpoken(1);
  });
});

describe('runBackendControlledSession: greeting', () => {
  it('speaks the backend greeting at session start', async () => {
    const { runtime } = setup(() => ({ kind: 'speak', text: 'reply' }), {
      conversation: { start: async () => ({ kind: 'speak', text: 'Welcome to the help desk.' }) },
    });
    await runtime.untilSpoken(1);
    expect(runtime.spoken).toEqual(['Welcome to the help desk.']);
  });

  it('a user turn supersedes a slow greeting', async () => {
    const greeting = deferred<BackendReply>();
    const { runtime } = setup(() => ({ kind: 'speak', text: 'answer' }), {
      conversation: { start: () => greeting.promise },
    });
    runtime.userSays('question');
    await runtime.untilSpoken(1);
    greeting.resolve({ kind: 'speak', text: 'LATE GREETING' });
    await tick(10);
    expect(runtime.spoken).toEqual(['answer']);
  });

  it('skips a failed greeting silently instead of apologising', async () => {
    const { runtime, obs } = setup(() => ({ kind: 'speak', text: 'answer' }), {
      conversation: {
        start: async () => {
          throw new Error('down');
        },
      },
    });
    await tick(10);
    expect(runtime.spoken).toEqual([]);
    expect(obs.ofType('backend_failed')[0]?.operation).toBe('session_start');
  });
});

describe('runBackendControlledSession: startup guards', () => {
  const conversation = inMemoryConversation(() => ({ kind: 'speak', text: 'x' }));
  const app = defineApplication({ applicationId: APP_ID, conversation });

  it('refuses a session minted for a different application (no cross-application leakage)', () => {
    const runtime = new FakeRuntime({ context: ctx({ applicationId: 'task-list' }) });
    expect(() => runBackendControlledSession(runtime.session, app)).toThrowError(
      expect.objectContaining({ code: 'invalid_session_context' }),
    );
    expect(conversation.calls).toHaveLength(0);
  });

  it('refuses runtimes without trusted session context', () => {
    const runtime = new FakeRuntime({
      context: ctx(),
      capabilities: { trustedSessionContext: false },
    });
    expect(() => runBackendControlledSession(runtime.session, app)).toThrowError(VoiceBridgeError);
  });

  it('refuses malformed session context without echoing its values', () => {
    const runtime = new FakeRuntime({ context: ctx({ sessionRef: 'bad ref <script>' }) });
    let error: unknown;
    try {
      runBackendControlledSession(runtime.session, app);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(VoiceBridgeError);
    expect((error as Error).message).not.toContain('<script>');
  });

  it('refuses an application without a conversation adapter', async () => {
    const { defineTool } = await import('../src/tools/registry.ts');
    const { z } = await import('zod');
    const toolsOnly = defineApplication({
      applicationId: APP_ID,
      tools: [
        defineTool({
          name: 'noop',
          description: 'noop',
          effect: 'read',
          input: z.object({}),
          output: z.object({}),
          execute: async () => ({}),
        }),
      ],
    });
    const runtime = new FakeRuntime({ context: ctx() });
    expect(() => runBackendControlledSession(runtime.session, toolsOnly)).toThrowError(
      expect.objectContaining({ code: 'mode_not_supported' }),
    );
  });

  it.each([{ timeoutMs: 0 }, { pendingTurnHoldMs: -1 }, { fallbackText: '  ' }])(
    'rejects invalid options %o',
    (bad) => {
      const runtime = new FakeRuntime({ context: ctx() });
      expect(() => runBackendControlledSession(runtime.session, app, bad)).toThrowError(
        expect.objectContaining({ code: 'config_error' }),
      );
    },
  );
});

describe('runBackendControlledSession: session isolation', () => {
  it('keeps concurrent sessions fully separate (context, turns, replies)', async () => {
    const conversation = inMemoryConversation((turn, c) => ({
      kind: 'speak',
      text: `${c.sessionRef}:${turn.text}`,
    }));
    const app = defineApplication({ applicationId: APP_ID, conversation });
    const a = new FakeRuntime({
      context: ctx({ sessionId: 'sess-a', sessionRef: 'sr_aaaaaaaaaaaaaaaa' }),
    });
    const b = new FakeRuntime({
      context: ctx({ sessionId: 'sess-b', sessionRef: 'sr_bbbbbbbbbbbbbbbb' }),
    });
    a.attach(runBackendControlledSession(a.session, app));
    b.attach(runBackendControlledSession(b.session, app));
    a.userSays('one');
    b.userSays('two');
    a.userSays('three'); // supersedes only session a's turn
    await Promise.all([a.untilSpoken(1), b.untilSpoken(1)]);
    await tick(5);
    expect(a.spoken).toEqual(['sr_aaaaaaaaaaaaaaaa:three']);
    expect(b.spoken).toEqual(['sr_bbbbbbbbbbbbbbbb:two']);
  });
});
