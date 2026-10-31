/**
 * Minimal acceptance test (docs/ARCHITECTURE.md §11.2): the core runs a complete
 * backend-controlled session against a fake runtime, with no vendor runtime installed.
 * `scripts/verify-core-isolation.mjs` runs this suite in an install where @livekit/* is absent.
 */
import { expect, test } from 'vitest';
import { defineApplication, runBackendControlledSession } from '../src/index.ts';
import { FakeRuntime, inMemoryConversation, neverUntilAborted } from '../src/testing/index.ts';

test('backend-controlled session runs end to end without any vendor runtime', async () => {
  const context = {
    applicationId: 'help-desk',
    sessionId: 'sess-acc',
    sessionRef: 'ref_test_0000000001',
  };
  const runtime = new FakeRuntime({ context }); // all capabilities on
  const conversation = inMemoryConversation(async (turn, ctx, signal) =>
    turn.text === 'slow'
      ? neverUntilAborted(signal)
      : { kind: 'speak', text: `ack:${turn.text}:${ctx.sessionRef}` },
  );
  const application = defineApplication({ applicationId: 'help-desk', conversation });

  runtime.attach(runBackendControlledSession(runtime.session, application, { timeoutMs: 500 }));

  runtime.userSays('hello'); // the exact text reaches the adapter
  await runtime.untilSpoken(1);
  runtime.userSays('slow'); // outstanding…
  runtime.userTypes('fast'); // …cancelled by a newer, typed turn
  await runtime.untilSpoken(2);
  runtime.end('client_left');
  runtime.userSays('after the end');
  await new Promise((r) => setTimeout(r, 20));

  expect(runtime.spoken).toEqual(['ack:hello:ref_test_0000000001', 'ack:fast:ref_test_0000000001']);
  expect(conversation.abortedTurnIds).toEqual(['t2']);
  expect(conversation.calls.map((c) => [c.turn.text, c.turn.source])).toEqual([
    ['hello', 'speech'],
    ['slow', 'speech'],
    ['fast', 'text'],
  ]);
  expect(runtime.speakCallsAfterEnd).toBe(0);
  expect(conversation.endCalls.map((c) => c.reason)).toEqual(['client_left']);
});
