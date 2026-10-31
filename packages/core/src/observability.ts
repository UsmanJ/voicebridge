/**
 * Privacy-safe observability events.
 *
 * Events carry identifiers, outcomes, durations, and text *lengths*, never transcripts, reply
 * text, tool arguments, tool results, session refs, or credentials. Runtime adapters may forward
 * them to their own telemetry.
 */
import type { VoiceBridgeErrorCode } from './errors.ts';

export type ExecutionMode = 'backend-controlled' | 'agent-controlled';
export type BackendOperation = 'turn' | 'session_start' | 'session_end' | 'tool';

interface Base {
  /** Milliseconds since the Unix epoch. */
  at: number;
  sessionId: string;
}

export type VoiceBridgeEvent =
  | (Base & { type: 'session_started'; applicationId: string; mode: ExecutionMode })
  | (Base & { type: 'turn_started'; turnId: string; source: 'speech' | 'text'; textLength: number })
  | (Base & { type: 'turn_superseded'; turnId: string; byTurnId: string })
  | (Base & { type: 'turn_cancelled'; turnId: string })
  | (Base & { type: 'backend_failed'; operation: BackendOperation; code: VoiceBridgeErrorCode })
  | (Base & { type: 'reply_held'; turnId: string })
  | (Base & { type: 'reply_released'; turnId: string })
  | (Base & { type: 'reply_stale_discarded'; turnId: string })
  | (Base & { type: 'reply_silent'; turnId: string })
  | (Base & { type: 'speech_started'; turnId: string; textLength: number; fallback: boolean })
  | (Base & { type: 'speech_finished'; turnId: string; interrupted: boolean })
  | (Base & {
      type: 'tool_invoked';
      invocationId: string;
      tool: string;
      effect: 'read' | 'write';
      outcome: 'ok' | VoiceBridgeErrorCode;
      durationMs: number;
    })
  | (Base & { type: 'session_ended'; reason: string });

export type VoiceBridgeEventType = VoiceBridgeEvent['type'];

/** Receives events. Must not throw. VoiceBridge guards against it anyway. */
export type Observer = (event: VoiceBridgeEvent) => void;

/** Wraps an observer so that a failing observer can never break a session. */
export function safeObserver(observer: Observer | undefined): Observer {
  if (!observer) return () => {};
  return (event) => {
    try {
      observer(event);
    } catch {
      // Observability must never affect conversation behaviour.
    }
  };
}

/**
 * Distributes the `Omit` over each member of an event union.
 * The built-in `Omit` would collapse the union.
 */
export type EventInput<E> = E extends unknown ? Omit<E, 'at' | 'sessionId'> : never;
