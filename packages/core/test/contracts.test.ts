import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  assertModeSupported,
  defineApplication,
  supportedModes,
} from '../src/contracts/application.ts';
import { parseSessionContext } from '../src/contracts/session.ts';
import {
  ERROR_CODES,
  VoiceBridgeError,
  publicMessageFor,
  toVoiceBridgeError,
} from '../src/errors.ts';
import { inMemoryConversation } from '../src/testing/in-memory.ts';
import { defineTool } from '../src/tools/registry.ts';
import { ctx } from './helpers.ts';

const tool = defineTool({
  name: 'list_tasks',
  description: 'List tasks.',
  effect: 'read',
  input: z.object({}),
  output: z.object({ tasks: z.array(z.string()) }),
  execute: async () => ({ tasks: [] }),
});

describe('parseSessionContext', () => {
  it('accepts and freezes a valid context', () => {
    const parsed = parseSessionContext(ctx());
    expect(parsed).toEqual(ctx());
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it('accepts and deep-freezes an optional runtime binding', () => {
    const parsed = parseSessionContext({
      ...ctx(),
      runtimeBinding: { runtime: 'livekit', roomName: 'vb_abc' },
    });
    expect(parsed.runtimeBinding).toEqual({ runtime: 'livekit', roomName: 'vb_abc' });
    expect(Object.isFrozen(parsed.runtimeBinding)).toBe(true);
  });

  it.each([
    [
      'runtime binding with an unknown field',
      { ...ctx(), runtimeBinding: { runtime: 'livekit', roomName: 'r', token: 'x' } },
    ],
    [
      'runtime binding with an unsafe room name',
      { ...ctx(), runtimeBinding: { runtime: 'livekit', roomName: 'a b' } },
    ],
    ['missing sessionRef', { applicationId: 'help-desk', sessionId: 's' }],
    ['uppercase applicationId', { ...ctx(), applicationId: 'Help-Desk' }],
    ['short sessionRef', { ...ctx(), sessionRef: 'abc' }],
    ['extra field (e.g. a smuggled credential)', { ...ctx(), apiKey: 'sk_live_x' }],
    ['not an object', 'help-desk'],
  ])('rejects %s', (_name, input) => {
    expect(() => parseSessionContext(input)).toThrowError(
      expect.objectContaining({ code: 'invalid_session_context' }),
    );
  });

  it('names invalid fields without echoing their values', () => {
    expect.assertions(2);
    try {
      parseSessionContext({ ...ctx(), sessionRef: 'SECRET VALUE!' });
    } catch (e) {
      expect((e as Error).message).toContain('sessionRef');
      expect((e as Error).message).not.toContain('SECRET VALUE');
    }
  });
});

describe('defineApplication and optional capabilities', () => {
  const conversation = inMemoryConversation(() => ({ kind: 'silent' }));

  it('supports conversation-only, tools-only, and both', () => {
    expect(supportedModes(defineApplication({ applicationId: 'help-desk', conversation }))).toEqual(
      ['backend-controlled'],
    );
    expect(
      supportedModes(defineApplication({ applicationId: 'task-list', tools: [tool] })),
    ).toEqual(['agent-controlled']);
    expect(
      supportedModes(defineApplication({ applicationId: 'both', conversation, tools: [tool] })),
    ).toEqual(['backend-controlled', 'agent-controlled']);
  });

  it('rejects an application with no capabilities, or an empty tool list', () => {
    expect(() => defineApplication({ applicationId: 'empty' })).toThrowError(
      expect.objectContaining({ code: 'config_error' }),
    );
    expect(() => defineApplication({ applicationId: 'empty', tools: [] })).toThrow();
  });

  it('rejects invalid application ids', () => {
    expect(() => defineApplication({ applicationId: 'Bad Id', conversation })).toThrow();
  });

  it('fails fast at startup when the configured mode is not supported', () => {
    const app = defineApplication({ applicationId: 'task-list', tools: [tool] });
    expect(() => assertModeSupported(app, 'backend-controlled')).toThrowError(
      expect.objectContaining({ code: 'mode_not_supported' }),
    );
    expect(() => assertModeSupported(app, 'agent-controlled')).not.toThrow();
  });

  it('freezes the application', () => {
    expect(Object.isFrozen(defineApplication({ applicationId: 'help-desk', conversation }))).toBe(
      true,
    );
  });
});

describe('error taxonomy', () => {
  it('has a generic public message for every code', () => {
    for (const code of ERROR_CODES) expect(publicMessageFor(code).length).toBeGreaterThan(5);
  });

  it('wraps unknown errors without exposing their message', () => {
    const wrapped = toVoiceBridgeError(new TypeError('secret detail'), 'backend_unavailable');
    expect(wrapped).toBeInstanceOf(VoiceBridgeError);
    expect(wrapped.code).toBe('backend_unavailable');
    expect(wrapped.message).not.toContain('secret detail');
    expect(wrapped.cause).toBeInstanceOf(TypeError);
  });
});
