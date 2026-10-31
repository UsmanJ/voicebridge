import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { neverUntilAborted } from '../src/testing/in-memory.ts';
import { createToolExecutor } from '../src/tools/executor.ts';
import { ToolRegistry, defineTool } from '../src/tools/registry.ts';
import { collector, ctx } from './helpers.ts';

const addTask = vi.fn(async (input: { title: string }) => ({
  taskId: 'task_1',
  title: input.title,
}));

function tools() {
  return ToolRegistry.from([
    defineTool({
      name: 'add_task',
      description: 'Add a task for the current user.',
      effect: 'write',
      input: z.object({ title: z.string().min(1).max(100) }),
      output: z.object({ taskId: z.string(), title: z.string() }),
      execute: (input) => addTask(input),
    }),
    defineTool({
      name: 'slow_read',
      description: 'Never finishes until aborted.',
      effect: 'read',
      timeoutMs: 20,
      input: z.object({}),
      output: z.object({}),
      execute: (_i, c) => neverUntilAborted(c.signal),
    }),
    defineTool({
      name: 'bad_output',
      description: 'Returns data that violates its output schema.',
      effect: 'read',
      input: z.object({}),
      output: z.object({ count: z.number() }),
      execute: async () => ({ count: 'many' }) as unknown as { count: number },
    }),
    defineTool({
      name: 'echo_context',
      description: 'Returns what the executor injected.',
      effect: 'read',
      input: z.object({}),
      output: z.object({ sessionRef: z.string(), invocationId: z.string() }),
      execute: async (_i, c) => ({
        sessionRef: c.session.sessionRef,
        invocationId: c.invocationId,
      }),
    }),
    defineTool({
      name: 'throws_secret',
      description: 'Throws an error with internal details.',
      effect: 'read',
      input: z.object({}),
      output: z.object({}),
      execute: async () => {
        throw new Error('db password=hunter2 at 10.0.0.5');
      },
    }),
  ]);
}

describe('ToolRegistry', () => {
  const base = {
    description: 'd',
    effect: 'read' as const,
    input: z.object({}),
    output: z.object({}),
    execute: async () => ({}),
  };

  it.each(['', '1abc', 'has space', 'a'.repeat(65), 'drop;table'])(
    'rejects invalid tool name %j',
    (name) => {
      expect(() => defineTool({ ...base, name })).toThrowError(
        expect.objectContaining({ code: 'config_error' }),
      );
    },
  );

  it('rejects duplicate names', () => {
    expect(() =>
      ToolRegistry.from([
        { ...base, name: 'a' },
        { ...base, name: 'a' },
      ]),
    ).toThrowError(/duplicate/);
  });

  it('rejects non-object input schemas, empty descriptions, and invalid timeouts', () => {
    expect(() => defineTool({ ...base, name: 'x', input: z.string() as never })).toThrow();
    expect(() => defineTool({ ...base, name: 'x', description: '  ' })).toThrow();
    expect(() => defineTool({ ...base, name: 'x', timeoutMs: 0 })).toThrow();
  });

  it('is an immutable allowlist', () => {
    const r = tools();
    expect(r.names()).toEqual([
      'add_task',
      'slow_read',
      'bad_output',
      'echo_context',
      'throws_secret',
    ]);
    expect(r.has('delete_everything')).toBe(false);
  });
});

describe('createToolExecutor', () => {
  it('executes an allowlisted tool with validated arguments', async () => {
    addTask.mockClear();
    const exec = createToolExecutor({ registry: tools(), session: ctx() });
    await expect(exec.execute('add_task', { title: 'Buy milk' })).resolves.toEqual({
      ok: true,
      result: { taskId: 'task_1', title: 'Buy milk' },
    });
    expect(addTask).toHaveBeenCalledOnce();
  });

  it('rejects unregistered tools without executing anything', async () => {
    const obs = collector();
    const exec = createToolExecutor({ registry: tools(), session: ctx(), observer: obs.observer });
    const outcome = await exec.execute('delete_everything', {});
    expect(outcome).toEqual({
      ok: false,
      error: { code: 'tool_not_allowed', publicMessage: expect.any(String) },
    });
    expect(obs.ofType('tool_invoked')[0]?.tool).toBe('unregistered');
  });

  it.each([
    ['missing field', {}],
    ['wrong type', { title: 42 }],
    ['too long', { title: 'x'.repeat(101) }],
    ['not an object', 'Buy milk'],
    [
      'LLM tries to inject identity (strict schema)',
      { title: 'ok', sessionRef: 'sr_attacker_000000000' },
    ],
  ])('rejects invalid arguments before the tool runs: %s', async (_name, args) => {
    addTask.mockClear();
    const exec = createToolExecutor({ registry: tools(), session: ctx() });
    const outcome = await exec.execute('add_task', args);
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.error.code).toBe('invalid_tool_arguments');
    expect(addTask).not.toHaveBeenCalled();
  });

  it('injects session context and invocation id from the executor, not from arguments', async () => {
    const exec = createToolExecutor({ registry: tools(), session: ctx() });
    const outcome = await exec.execute('echo_context', {}, { invocationId: 'call_abc' });
    expect(outcome).toEqual({
      ok: true,
      result: { sessionRef: ctx().sessionRef, invocationId: 'call_abc' },
    });
  });

  it('generates an invocation id when the runtime supplies none', async () => {
    const exec = createToolExecutor({ registry: tools(), session: ctx() });
    const outcome = await exec.execute('echo_context', {});
    expect(outcome.ok && (outcome.result as { invocationId: string }).invocationId).toMatch(
      /^[0-9a-f-]{36}$/,
    );
  });

  it('times out slow tools', async () => {
    const exec = createToolExecutor({ registry: tools(), session: ctx() });
    const outcome = await exec.execute('slow_read', {});
    expect(!outcome.ok && outcome.error.code).toBe('backend_timeout');
  });

  it('reports cancellation when the runtime aborts the call (and does not claim rollback)', async () => {
    const exec = createToolExecutor({ registry: tools(), session: ctx() });
    const controller = new AbortController();
    const pending = exec.execute('slow_read', {}, { signal: controller.signal });
    controller.abort();
    const outcome = await pending;
    expect(!outcome.ok && outcome.error.code).toBe('cancelled');
  });

  it('rejects results that violate the output schema', async () => {
    const exec = createToolExecutor({ registry: tools(), session: ctx() });
    const outcome = await exec.execute('bad_output', {});
    expect(!outcome.ok && outcome.error.code).toBe('invalid_tool_result');
  });

  it('never leaks internal error details to the LLM or observers', async () => {
    const obs = collector();
    const exec = createToolExecutor({ registry: tools(), session: ctx(), observer: obs.observer });
    const outcome = await exec.execute('throws_secret', {});
    expect(!outcome.ok && outcome.error.code).toBe('tool_failed');
    expect(JSON.stringify(outcome)).not.toContain('hunter2');
    expect(JSON.stringify(obs.events)).not.toContain('hunter2');
  });

  it('never throws, even for hostile inputs', async () => {
    const exec = createToolExecutor({ registry: tools(), session: ctx() });
    const cyclic: Record<string, unknown> = { title: 'x' };
    cyclic.self = cyclic;
    const inherited = Object.create({ title: 'inherited' }) as object;
    for (const args of [null, undefined, 42, [], inherited, cyclic, { title: 1n }]) {
      await expect(exec.execute('add_task', args)).resolves.toMatchObject({ ok: false });
    }
    await expect(
      exec.execute('add_task', { title: 'x' }, { invocationId: 'bad id with spaces' }),
    ).resolves.toMatchObject({
      ok: false,
    });
  });

  it('reports write effects in privacy-safe events (no arguments or results)', async () => {
    const obs = collector();
    const exec = createToolExecutor({ registry: tools(), session: ctx(), observer: obs.observer });
    await exec.execute('add_task', { title: 'SECRET TITLE' }, { invocationId: 'call_1' });
    expect(obs.ofType('tool_invoked')[0]).toMatchObject({
      tool: 'add_task',
      effect: 'write',
      outcome: 'ok',
    });
    expect(JSON.stringify(obs.events)).not.toContain('SECRET TITLE');
  });
});
