import type { ConversationAdapter } from '../contracts/application.ts';
import type { SessionContext, SessionEndReason } from '../contracts/session.ts';
import type { BackendReply, UserTurn } from '../contracts/turn.ts';

export interface RecordedCall {
  readonly turn: UserTurn;
  readonly ctx: SessionContext;
  readonly signal: AbortSignal;
}

export interface InMemoryConversation extends ConversationAdapter {
  readonly calls: RecordedCall[];
  /** Turn ids whose AbortSignal fired (cancelled, timed out, or session closed). */
  readonly abortedTurnIds: string[];
  readonly endCalls: Array<{ ctx: SessionContext; reason: SessionEndReason }>;
}

export interface InMemoryConversationOptions {
  start?: (ctx: SessionContext, signal: AbortSignal) => Promise<BackendReply>;
  end?: (ctx: SessionContext, reason: SessionEndReason) => Promise<void>;
}

/** A recording, in-process conversation adapter for tests and examples. */
export function inMemoryConversation(
  respond: (
    turn: UserTurn,
    ctx: SessionContext,
    signal: AbortSignal,
  ) => Promise<BackendReply> | BackendReply,
  options: InMemoryConversationOptions = {},
): InMemoryConversation {
  const calls: RecordedCall[] = [];
  const abortedTurnIds: string[] = [];
  const endCalls: InMemoryConversation['endCalls'] = [];
  const adapter: InMemoryConversation = {
    calls,
    abortedTurnIds,
    endCalls,
    async respond(turn, ctx, signal) {
      calls.push({ turn, ctx, signal });
      signal.addEventListener('abort', () => abortedTurnIds.push(turn.turnId), { once: true });
      return respond(turn, ctx, signal);
    },
    async end(ctx, reason) {
      endCalls.push({ ctx, reason });
      await options.end?.(ctx, reason);
    },
  };
  if (options.start) adapter.start = options.start;
  return adapter;
}

/** A promise you can settle from outside. Useful for controlling backend timing in tests. */
export function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A backend that never answers until aborted, then rejects with the abort reason. */
export function neverUntilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}
