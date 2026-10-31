/**
 * Server-side voice session store.
 *
 * DEMO ONLY: state lives in process memory and is lost on restart. It isn't shared between
 * instances. A production backend must use a durable store where each check-and-set below is a
 * single conditional write (for example `UPDATE … WHERE room_name IS NULL`, or a transaction).
 *
 * JavaScript runs each method to completion without interleaving, so in this single-process demo
 * every method is atomic.
 */
import { randomBytes } from 'node:crypto';

export type SessionStatus = 'active' | 'revoked' | 'ended';

export interface VoiceSession {
  readonly sessionRef: string;
  readonly applicationId: string;
  /** Opaque host-side user id. Never a name, email, or phone number. */
  readonly subject: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  status: SessionStatus;
  /** Set once at issuance (compare-and-set). Never overwritten. */
  roomName?: string;
  /** First authorized start. Repeated starts don't change it. */
  startedAt?: number;
  /** Side effects of starting (here, a counter standing in for audit/analytics). Must stay 1. */
  startEffects: number;
}

export type Refusal =
  | 'not_found'
  | 'revoked'
  | 'expired'
  | 'ended'
  | 'room_mismatch'
  | 'not_started'
  | 'room_not_bound';

export interface SessionStoreOptions {
  /** Max session lifetime from creation. Default 30 minutes. */
  ttlMs?: number;
  now?: () => number;
}

export const SUBJECT_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

export class InMemorySessionStore {
  readonly #sessions = new Map<string, VoiceSession>();
  readonly #ttlMs: number;
  readonly #now: () => number;

  constructor(options: SessionStoreOptions = {}) {
    this.#ttlMs = options.ttlMs ?? 30 * 60_000;
    this.#now = options.now ?? Date.now;
  }

  /** Creates an active session for an authenticated subject. Returns an unguessable ref (256 bits). */
  create(applicationId: string, subject: string): { sessionRef: string; expiresAt: number } {
    if (!SUBJECT_PATTERN.test(subject)) throw new Error('invalid subject');
    const sessionRef = `sr_${randomBytes(32).toString('base64url')}`;
    const createdAt = this.#now();
    const session: VoiceSession = {
      sessionRef,
      applicationId,
      subject,
      createdAt,
      expiresAt: createdAt + this.#ttlMs,
      status: 'active',
      startEffects: 0,
    };
    this.#sessions.set(sessionRef, session);
    return { sessionRef, expiresAt: session.expiresAt };
  }

  /**
   * Looks up a session for an application. Another application's session is reported as
   * `not_found`, so its existence never leaks across applications.
   */
  #lookup(applicationId: string, sessionRef: string): VoiceSession | Refusal {
    const s = this.#sessions.get(sessionRef);
    if (!s || s.applicationId !== applicationId) return 'not_found';
    if (s.status === 'revoked') return 'revoked';
    if (s.status === 'ended') return 'ended';
    if (s.expiresAt <= this.#now()) return 'expired';
    return s;
  }

  /** Token issuance may proceed only for an active, unexpired session with no room bound yet. */
  canIssue(applicationId: string, sessionRef: string): boolean {
    const s = this.#lookup(applicationId, sessionRef);
    return typeof s !== 'string' && s.roomName === undefined;
  }

  /**
   * Records the issued room with compare-and-set. A second issuance can never overwrite the
   * binding: it gets `conflict`, and its token must not be returned.
   */
  attachRoom(
    applicationId: string,
    sessionRef: string,
    roomName: string,
  ): 'attached' | 'conflict' | Refusal {
    const s = this.#lookup(applicationId, sessionRef);
    if (typeof s === 'string') return s;
    if (s.roomName !== undefined) return 'conflict';
    s.roomName = roomName;
    return 'attached';
  }

  /**
   * Authorizes `sessions/start`: active, unexpired, same application, bound room equals the actual
   * room. Idempotent per logical session: repeated starts (any job id) succeed without repeating
   * side effects.
   */
  authorizeStart(
    applicationId: string,
    sessionRef: string,
    actualRoom: string,
  ): { ok: true; firstStart: boolean } | { ok: false; reason: Refusal } {
    const s = this.#lookup(applicationId, sessionRef);
    if (typeof s === 'string') return { ok: false, reason: s };
    if (s.roomName === undefined) return { ok: false, reason: 'room_not_bound' };
    if (s.roomName !== actualRoom) return { ok: false, reason: 'room_mismatch' };
    if (s.startedAt !== undefined) return { ok: true, firstStart: false };
    s.startedAt = this.#now();
    s.startEffects++;
    return { ok: true, firstStart: true };
  }

  /** Re-checked on every turn: the session must still be active, unexpired, and started. */
  checkActive(
    applicationId: string,
    sessionRef: string,
  ): { ok: true } | { ok: false; reason: Refusal } {
    const s = this.#lookup(applicationId, sessionRef);
    if (typeof s === 'string') return { ok: false, reason: s };
    if (s.startedAt === undefined) return { ok: false, reason: 'not_started' };
    return { ok: true };
  }

  revoke(applicationId: string, sessionRef: string): boolean {
    const s = this.#sessions.get(sessionRef);
    if (!s || s.applicationId !== applicationId) return false;
    if (s.status === 'active') s.status = 'revoked';
    return true;
  }

  /** Marks the session ended (idempotent). Later starts and turns are refused. */
  end(applicationId: string, sessionRef: string): boolean {
    const s = this.#sessions.get(sessionRef);
    if (!s || s.applicationId !== applicationId) return false;
    if (s.status === 'active') s.status = 'ended';
    return true;
  }

  /** Test and diagnostics helper. Returns a copy. */
  inspect(sessionRef: string): Readonly<VoiceSession> | undefined {
    const s = this.#sessions.get(sessionRef);
    return s ? { ...s } : undefined;
  }
}
