/**
 * Latest-turn-wins coordinator for backend-controlled mode.
 *
 * Design validated against LiveKit Agents 1.9.5 in the M0.5 spikes (docs/ARCHITECTURE.md §16):
 * - `handleTurn` returns synchronously. Runtimes may serialize their turn hooks, so awaiting the
 *   backend inside a hook would block later turns.
 * - A new turn aborts the outstanding request.
 * - A reply for a superseded turn is never delivered, even if the backend ignored the abort.
 * - A reply that becomes ready while a newer final transcript awaits commit is held, then
 *   discarded when that turn arrives or released after a bounded wait.
 * - Errors, timeouts, and invalid replies deliver a generic fallback. Details never leak.
 *
 * All state is per instance (one instance per session). Nothing is shared between sessions.
 */
import {
  type BackendReply,
  type TurnSource,
  type UserTurn,
  backendReplySchema,
} from '../contracts/turn.ts';
import { VoiceBridgeError, toVoiceBridgeError } from '../errors.ts';
import { raceAbort } from '../internal/abort.ts';
import type { BackendOperation, EventInput, Observer, VoiceBridgeEvent } from '../observability.ts';

export type DeliverableReply = Exclude<BackendReply, { kind: 'silent' }>;

export interface TurnCoordinatorOptions {
  sessionId: string;
  respond(turn: UserTurn, signal: AbortSignal): Promise<BackendReply>;
  deliver(reply: DeliverableReply, turnId: string, fallback: boolean): void;
  timeoutMs: number;
  fallbackText: string;
  pendingTurnHoldMs: number;
  observe: Observer;
}

interface InFlight {
  seq: number;
  turnId: string;
  controller: AbortController;
}

interface Held {
  turnId: string;
  reply: DeliverableReply;
  fallback: boolean;
  timer: ReturnType<typeof setTimeout>;
}

export class TurnCoordinator {
  readonly #opts: TurnCoordinatorOptions;
  #seq = 0;
  #current: InFlight | undefined;
  #held: Held | undefined;
  #userTurnPending = false;
  #closed = false;

  constructor(options: TurnCoordinatorOptions) {
    this.#opts = options;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Starts handling a user turn and returns its id synchronously. Never throws or awaits. */
  handleTurn(text: string, source: TurnSource): string {
    const seq = ++this.#seq;
    const turnId = `t${seq}`;
    if (this.#closed) return turnId;
    this.#userTurnPending = false;
    this.#discardHeld();
    this.#supersede(turnId);
    this.#emit({ type: 'turn_started', turnId, source, textLength: text.length });
    const turn: UserTurn = Object.freeze({ turnId, text, source });
    this.#begin(seq, turnId, 'turn', (signal) => this.#opts.respond(turn, signal));
    return turnId;
  }

  /** Runs a session-start greeting as turn `t0`. Any user turn supersedes it. */
  startGreeting(start: (signal: AbortSignal) => Promise<BackendReply>): string {
    const turnId = 't0';
    if (this.#closed || this.#seq !== 0) return turnId;
    this.#begin(0, turnId, 'session_start', start);
    return turnId;
  }

  /** Signals that a final user transcript arrived but its turn is not committed yet. */
  notifyFinalTranscriptPending(): void {
    if (!this.#closed) this.#userTurnPending = true;
  }

  /** Aborts outstanding work and drops held replies. Idempotent. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#discardHeld();
    this.#current?.controller.abort(new VoiceBridgeError('session_closed', 'session closed'));
    this.#current = undefined;
  }

  #supersede(byTurnId: string): void {
    const previous = this.#current;
    if (!previous) return;
    this.#emit({ type: 'turn_superseded', turnId: previous.turnId, byTurnId });
    previous.controller.abort(new VoiceBridgeError('cancelled', 'superseded by a newer turn'));
    this.#current = undefined;
  }

  #begin(
    seq: number,
    turnId: string,
    operation: BackendOperation,
    call: (signal: AbortSignal) => Promise<BackendReply>,
  ): void {
    const controller = new AbortController();
    this.#current = { seq, turnId, controller };
    void this.#run(seq, turnId, operation, controller, call);
  }

  async #run(
    seq: number,
    turnId: string,
    operation: BackendOperation,
    controller: AbortController,
    call: (signal: AbortSignal) => Promise<BackendReply>,
  ): Promise<void> {
    const timeout = AbortSignal.timeout(this.#opts.timeoutMs);
    const signal = AbortSignal.any([controller.signal, timeout]);
    let reply: BackendReply;
    let fallback = false;
    try {
      const raw: unknown = await raceAbort(call(signal), signal);
      const parsed = backendReplySchema.safeParse(raw);
      if (!parsed.success) {
        throw new VoiceBridgeError('invalid_backend_reply', 'reply failed validation');
      }
      reply = parsed.data;
    } catch (error) {
      if (controller.signal.aborted) {
        this.#emit({ type: 'turn_cancelled', turnId });
        return;
      }
      const failure = timeout.aborted
        ? new VoiceBridgeError('backend_timeout', `no reply within ${this.#opts.timeoutMs} ms`)
        : toVoiceBridgeError(error, 'backend_unavailable');
      this.#emit({ type: 'backend_failed', operation, code: failure.code });
      if (operation === 'session_start') return; // a failed greeting is skipped, not apologised for
      reply = { kind: 'speak', text: this.#opts.fallbackText };
      fallback = true;
    }

    // Staleness guard: only the current turn may deliver.
    if (this.#closed || seq !== this.#seq || controller.signal.aborted) {
      this.#emit({ type: 'reply_stale_discarded', turnId });
      return;
    }
    this.#current = undefined;

    if (reply.kind === 'silent') {
      this.#emit({ type: 'reply_silent', turnId });
      return;
    }

    if (this.#userTurnPending) {
      const deliverable = reply;
      const timer = setTimeout(() => {
        if (this.#held?.turnId !== turnId || this.#closed) return;
        this.#held = undefined;
        this.#userTurnPending = false;
        this.#emit({ type: 'reply_released', turnId });
        this.#opts.deliver(deliverable, turnId, fallback);
      }, this.#opts.pendingTurnHoldMs);
      this.#held = { turnId, reply: deliverable, fallback, timer };
      this.#emit({ type: 'reply_held', turnId });
      return;
    }

    this.#opts.deliver(reply, turnId, fallback);
  }

  #discardHeld(): void {
    const held = this.#held;
    if (!held) return;
    clearTimeout(held.timer);
    this.#held = undefined;
    this.#emit({ type: 'reply_stale_discarded', turnId: held.turnId });
  }

  #emit(event: EventInput<VoiceBridgeEvent>): void {
    this.#opts.observe({
      ...event,
      at: Date.now(),
      sessionId: this.#opts.sessionId,
    } as VoiceBridgeEvent);
  }
}
