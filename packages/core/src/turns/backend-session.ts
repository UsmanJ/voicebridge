import {
  type Application,
  assertModeSupported,
  assertSameApplication,
} from '../contracts/application.ts';
import {
  type SessionContext,
  type SessionEndReason,
  parseSessionContext,
} from '../contracts/session.ts';
import { MAX_REPLY_TEXT_LENGTH } from '../contracts/turn.ts';
import { VoiceBridgeError } from '../errors.ts';
import { type Observer, type VoiceBridgeEvent, safeObserver } from '../observability.ts';
import type { RuntimeEvents, RuntimeSession } from '../runtime/port.ts';
import { type DeliverableReply, TurnCoordinator } from './coordinator.ts';

export const DEFAULT_BACKEND_TIMEOUT_MS = 8_000;
export const DEFAULT_PENDING_TURN_HOLD_MS = 3_000;
export const DEFAULT_SESSION_END_TIMEOUT_MS = 2_000;
export const DEFAULT_FALLBACK_TEXT = 'Sorry, I could not complete that.';

export interface BackendControlledOptions {
  /** Per-turn backend timeout. Default 8000 ms. */
  timeoutMs?: number;
  /** Spoken on backend error, timeout, or invalid reply. Default: a generic apology. */
  fallbackText?: string;
  /** Max time to hold a ready reply while a newer transcript awaits commit. Default 3000 ms. */
  pendingTurnHoldMs?: number;
  /** Timeout for the best-effort `conversation.end` notification. Default 2000 ms. */
  sessionEndTimeoutMs?: number;
  /** Call `conversation.start` for a greeting, if implemented. Default true. */
  greet?: boolean;
  observer?: Observer;
}

export interface BackendControlledSession extends RuntimeEvents {
  /** The validated, trusted session context. */
  readonly context: SessionContext;
  readonly closed: boolean;
  /**
   * Stops the session from the core side: aborts outstanding requests, drops held replies, and
   * notifies the backend (best effort). Doesn't end the runtime session. Idempotent.
   */
  close(reason: SessionEndReason): Promise<void>;
}

/**
 * Runs backend-controlled mode for one runtime session: each committed user turn goes to the
 * application's conversation adapter, and the approved reply is spoken verbatim.
 *
 * Throws at startup, before any backend call, if:
 * - the runtime can't supply trusted session context
 * - the context is invalid
 * - it belongs to a different application
 * - the application has no conversation adapter
 */
export function runBackendControlledSession(
  runtime: RuntimeSession,
  application: Application,
  options: BackendControlledOptions = {},
): BackendControlledSession {
  if (!runtime.capabilities.trustedSessionContext) {
    throw new VoiceBridgeError(
      'invalid_session_context',
      'runtime cannot provide trusted session context',
    );
  }
  const context = parseSessionContext(runtime.context);
  assertSameApplication(application, context);
  assertModeSupported(application, 'backend-controlled');
  const conversation = application.conversation!;

  const timeoutMs = positiveInt(options.timeoutMs, DEFAULT_BACKEND_TIMEOUT_MS, 'timeoutMs');
  const holdMs = positiveInt(
    options.pendingTurnHoldMs,
    DEFAULT_PENDING_TURN_HOLD_MS,
    'pendingTurnHoldMs',
  );
  const endTimeoutMs = positiveInt(
    options.sessionEndTimeoutMs,
    DEFAULT_SESSION_END_TIMEOUT_MS,
    'sessionEndTimeoutMs',
  );
  const fallbackText = options.fallbackText ?? DEFAULT_FALLBACK_TEXT;
  if (fallbackText.trim().length === 0 || fallbackText.length > MAX_REPLY_TEXT_LENGTH) {
    throw new VoiceBridgeError(
      'config_error',
      'fallbackText must be non-blank and within the reply length limit',
    );
  }

  const observe = safeObserver(options.observer);
  const emit = (event: Record<string, unknown> & { type: VoiceBridgeEvent['type'] }) =>
    observe({ ...event, at: Date.now(), sessionId: context.sessionId } as VoiceBridgeEvent);

  let closed = false;
  let closing: Promise<void> | undefined;

  const speak = (text: string, turnId: string, fallback: boolean): Promise<void> => {
    if (closed) return Promise.resolve();
    emit({ type: 'speech_started', turnId, textLength: text.length, fallback });
    const handle = runtime.speak(text);
    return handle.done.then(
      ({ interrupted }) => emit({ type: 'speech_finished', turnId, interrupted }),
      () => emit({ type: 'speech_finished', turnId, interrupted: true }),
    );
  };

  const deliver = (reply: DeliverableReply, turnId: string, fallback: boolean): void => {
    if (closed) return;
    if (reply.kind === 'speak') {
      void speak(reply.text, turnId, fallback);
      return;
    }
    // kind: 'end': optionally speak, then end the session from the agent side.
    void (async () => {
      if (reply.text !== undefined) await speak(reply.text, turnId, fallback);
      await close('backend_ended');
      await runtime.end('backend_ended').catch(() => {});
    })();
  };

  const coordinator = new TurnCoordinator({
    sessionId: context.sessionId,
    respond: (turn, signal) => conversation.respond(turn, context, signal),
    deliver,
    timeoutMs,
    fallbackText,
    pendingTurnHoldMs: holdMs,
    observe,
  });

  const close = (reason: SessionEndReason): Promise<void> => {
    if (closing) return closing;
    closed = true;
    coordinator.close();
    closing = (async () => {
      if (conversation.end) {
        const timer = new Promise<'timeout'>((resolve) =>
          setTimeout(resolve, endTimeoutMs, 'timeout'),
        );
        try {
          const outcome = await Promise.race([conversation.end(context, reason), timer]);
          if (outcome === 'timeout')
            emit({ type: 'backend_failed', operation: 'session_end', code: 'backend_timeout' });
        } catch (error) {
          const code = error instanceof VoiceBridgeError ? error.code : 'backend_unavailable';
          emit({ type: 'backend_failed', operation: 'session_end', code });
        }
      }
      emit({ type: 'session_ended', reason });
    })();
    return closing;
  };

  emit({
    type: 'session_started',
    applicationId: context.applicationId,
    mode: 'backend-controlled',
  });
  if ((options.greet ?? true) && conversation.start) {
    const start = conversation.start.bind(conversation);
    coordinator.startGreeting((signal) => start(context, signal));
  }

  return {
    context,
    get closed() {
      return closed;
    },
    close,
    onUserTurn({ text, source }) {
      if (closed || text.trim().length === 0) return;
      coordinator.handleTurn(text, source);
    },
    onFinalTranscriptPending() {
      if (runtime.capabilities.pendingTurnSignal) coordinator.notifyFinalTranscriptPending();
    },
    onEnded(reason) {
      void close(reason);
    },
  };
}

function positiveInt(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value <= 0) {
    throw new VoiceBridgeError('config_error', `${name} must be a positive integer`);
  }
  return value;
}
