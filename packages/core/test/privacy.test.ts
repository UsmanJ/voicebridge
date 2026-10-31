import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineApplication } from '../src/contracts/application.ts';
import { VoiceBridgeError } from '../src/errors.ts';
import { FakeRuntime } from '../src/testing/fake-runtime.ts';
import { inMemoryConversation, neverUntilAborted } from '../src/testing/in-memory.ts';
import { createToolExecutor } from '../src/tools/executor.ts';
import { ToolRegistry, defineTool } from '../src/tools/registry.ts';
import { runBackendControlledSession } from '../src/turns/backend-session.ts';
import { APP_ID, collector, ctx, tick } from './helpers.ts';

const SECRET_TRANSCRIPT = 'my card number is 4111 1111 1111 1111';
const SECRET_REPLY = 'Your balance is 1,234 pounds';
const SECRET_ARG = 'patient-name-Jane-Doe';

describe('observability events are privacy-safe', () => {
  it('never contain transcripts, replies, session refs, tool arguments, or tool results', async () => {
    const obs = collector();
    const conversation = inMemoryConversation(async (turn, _c, signal) =>
      turn.text.includes('slow')
        ? neverUntilAborted(signal)
        : { kind: 'speak', text: SECRET_REPLY },
    );
    const runtime = new FakeRuntime({ context: ctx() });
    const session = runBackendControlledSession(
      runtime.session,
      defineApplication({ applicationId: APP_ID, conversation }),
      { observer: obs.observer, timeoutMs: 30 },
    );
    runtime.attach(session);
    runtime.userSays(`${SECRET_TRANSCRIPT} slow`);
    runtime.userSays(SECRET_TRANSCRIPT);
    await runtime.untilSpoken(1);

    const exec = createToolExecutor({
      session: ctx(),
      observer: obs.observer,
      registry: ToolRegistry.from([
        defineTool({
          name: 'lookup',
          description: 'lookup',
          effect: 'read',
          input: z.object({ name: z.string() }),
          output: z.object({ record: z.string() }),
          execute: async ({ name }) => ({ record: `record for ${name}` }),
        }),
      ]),
    });
    await exec.execute('lookup', { name: SECRET_ARG });
    await session.close('shutdown');
    await tick(5);

    const serialized = JSON.stringify(obs.events);
    expect(obs.events.length).toBeGreaterThan(5);
    for (const secret of [SECRET_TRANSCRIPT, SECRET_REPLY, SECRET_ARG, ctx().sessionRef, '4111']) {
      expect(serialized).not.toContain(secret);
    }
    // Lengths are allowed and useful.
    expect(obs.ofType('turn_started')[1]?.textLength).toBe(SECRET_TRANSCRIPT.length);
  });
});

describe('public errors', () => {
  it('expose only code, generic message, and an optional backend-approved code', () => {
    const err = new VoiceBridgeError(
      'backend_rejected',
      'status 500 from https://internal.example/db',
      {
        cause: new Error('password=hunter2'),
      },
    );
    expect(err.toPublic()).toEqual({ code: 'backend_rejected', publicMessage: expect.any(String) });
    expect(JSON.stringify(err.toPublic())).not.toMatch(/internal\.example|hunter2|500/);
  });
});
