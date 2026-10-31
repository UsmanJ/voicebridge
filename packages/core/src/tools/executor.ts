import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { SessionContext } from '../contracts/session.ts';
import {
  type PublicError,
  VoiceBridgeError,
  type VoiceBridgeErrorCode,
  toVoiceBridgeError,
} from '../errors.ts';
import { raceAbort } from '../internal/abort.ts';
import { type Observer, safeObserver } from '../observability.ts';
import { DEFAULT_TOOL_TIMEOUT_MS, type ToolRegistry } from './registry.ts';

export const invocationIdSchema = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/);

export type ToolOutcome = { ok: true; result: unknown } | { ok: false; error: PublicError };

export interface ToolExecutorOptions {
  registry: ToolRegistry;
  session: SessionContext;
  defaultTimeoutMs?: number;
  observer?: Observer;
}

export interface ToolInvocation {
  /** Idempotency key. Generated when omitted. Supply the runtime's tool-call id when available. */
  invocationId?: string;
  /** Aborted when the runtime cancels the call (for example, the user interrupted). */
  signal?: AbortSignal;
}

export interface ToolExecutor {
  /**
   * Executes an allowlisted tool. Never throws: every failure becomes `{ ok: false }` with a
   * public-safe error, which runtimes can hand to the LLM.
   *
   * Cancellation stops VoiceBridge waiting. It does **not** undo a write that may already have
   * happened.
   */
  execute(name: string, rawArguments: unknown, invocation?: ToolInvocation): Promise<ToolOutcome>;
}

export function createToolExecutor(options: ToolExecutorOptions): ToolExecutor {
  const observe = safeObserver(options.observer);
  const defaultTimeout = options.defaultTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
  const { session, registry } = options;

  return {
    async execute(name, rawArguments, invocation = {}) {
      const started = Date.now();
      const invocationId = invocation.invocationId ?? randomUUID();
      const tool = registry.get(name);
      const report = (outcome: 'ok' | VoiceBridgeErrorCode) =>
        observe({
          type: 'tool_invoked',
          at: Date.now(),
          sessionId: session.sessionId,
          invocationId: invocationIdSchema.safeParse(invocationId).success
            ? invocationId
            : 'invalid',
          tool: tool ? tool.name : 'unregistered',
          effect: tool ? tool.effect : 'read',
          outcome,
          durationMs: Date.now() - started,
        });
      const fail = (error: VoiceBridgeError): ToolOutcome => {
        report(error.code);
        return { ok: false, error: error.toPublic() };
      };

      if (!tool) {
        return fail(new VoiceBridgeError('tool_not_allowed', 'tool is not registered'));
      }
      if (!invocationIdSchema.safeParse(invocationId).success) {
        return fail(new VoiceBridgeError('invalid_tool_arguments', 'invalid invocation id'));
      }
      // Accept only plain JSON data: drops inherited/prototype properties, rejects cycles,
      // BigInt, and functions. Arguments are forwarded over the wire as JSON anyway.
      let plainArguments: unknown;
      try {
        plainArguments = JSON.parse(JSON.stringify(rawArguments ?? null)) as unknown;
      } catch {
        return fail(new VoiceBridgeError('invalid_tool_arguments', 'arguments are not plain JSON'));
      }
      const parsed = tool.input.safeParse(plainArguments);
      if (!parsed.success) {
        return fail(new VoiceBridgeError('invalid_tool_arguments', 'arguments failed validation'));
      }
      if (invocation.signal?.aborted) {
        return fail(new VoiceBridgeError('cancelled', 'cancelled before execution'));
      }

      const timeoutMs = tool.timeoutMs ?? defaultTimeout;
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = invocation.signal ? AbortSignal.any([invocation.signal, timeout]) : timeout;

      let raw: unknown;
      try {
        raw = await raceAbort(tool.execute(parsed.data, { session, invocationId, signal }), signal);
      } catch (error) {
        if (invocation.signal?.aborted) {
          return fail(
            new VoiceBridgeError('cancelled', 'cancelled during execution', { cause: error }),
          );
        }
        if (timeout.aborted) {
          return fail(
            new VoiceBridgeError('backend_timeout', `tool timed out after ${timeoutMs} ms`),
          );
        }
        return fail(toVoiceBridgeError(error, 'tool_failed'));
      }

      const result = tool.output.safeParse(raw);
      if (!result.success) {
        return fail(new VoiceBridgeError('invalid_tool_result', 'tool result failed validation'));
      }
      report('ok');
      return { ok: true, result: result.data };
    },
  };
}
