/**
 * Pre-connection session verification for LiveKit jobs.
 *
 * Runs **before** the worker connects to the room, subscribes to audio, or creates STT/TTS. It
 * fails closed: every failure (malformed metadata, wrong application, missing room, backend
 * rejection, network error, invalid response, timeout) returns `{ ok: false }`, and the caller
 * shuts the job down without joining.
 *
 * Deliberately free of LiveKit SDK imports, so it can be tested exhaustively.
 */
import {
  type Application,
  type SessionContext,
  type SessionStartResult,
  VoiceBridgeError,
  parseSessionContext,
  sessionStartResultSchema,
} from '@voicebridge/core';
import { parseDispatchMetadata } from '@voicebridge/livekit-tokens';

export const DEFAULT_VERIFICATION_TIMEOUT_MS = 5_000;

/** Why a session was refused. Safe to log: carries no payloads. */
export type RejectionReason =
  | 'invalid_dispatch_metadata'
  | 'application_mismatch'
  | 'missing_room'
  | 'invalid_session_context'
  | 'session_start_not_configured'
  | 'session_not_authorized'
  | 'verification_timeout'
  | 'verification_unavailable';

export type VerificationOutcome =
  | { ok: true; context: SessionContext; startResult: SessionStartResult }
  | { ok: false; reason: RejectionReason };

/** The parts of a LiveKit job that verification reads (all server-minted). */
export interface DispatchedJob {
  readonly id: string;
  readonly metadata: string;
  readonly room?: { readonly name: string } | undefined;
}

export interface VerifyOptions {
  job: DispatchedJob;
  application: Application;
  timeoutMs?: number;
}

/**
 * Verifies a dispatched job:
 * 1. dispatch metadata is exactly v0 (opaque references, nothing else)
 * 2. its application is the one this worker serves
 * 3. the job has a room
 * 4. the session context is valid, bound to that room
 * 5. the application's authenticated `sessions/start` explicitly authorizes the session
 *    (the backend checks its active, stored binding, including the room)
 */
export async function verifyLiveKitSession(options: VerifyOptions): Promise<VerificationOutcome> {
  const { job, application } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_VERIFICATION_TIMEOUT_MS;

  let metadata: { applicationId: string; sessionRef: string };
  try {
    metadata = parseDispatchMetadata(job.metadata);
  } catch {
    return { ok: false, reason: 'invalid_dispatch_metadata' };
  }
  if (metadata.applicationId !== application.applicationId) {
    return { ok: false, reason: 'application_mismatch' };
  }
  const roomName = job.room?.name;
  if (typeof roomName !== 'string' || roomName.length === 0) {
    return { ok: false, reason: 'missing_room' };
  }

  let context: SessionContext;
  try {
    context = parseSessionContext({
      applicationId: metadata.applicationId,
      sessionId: job.id,
      sessionRef: metadata.sessionRef,
      runtimeBinding: { runtime: 'livekit', roomName },
    });
  } catch {
    return { ok: false, reason: 'invalid_session_context' };
  }

  const start = application.conversation?.start;
  if (!start) return { ok: false, reason: 'session_start_not_configured' };

  const timeout = AbortSignal.timeout(timeoutMs);
  try {
    const raw: unknown = await raceTimeout(
      start.call(application.conversation, context, timeout),
      timeout,
    );
    const result = sessionStartResultSchema.safeParse(raw);
    if (!result.success) return { ok: false, reason: 'session_not_authorized' };
    return { ok: true, context, startResult: result.data };
  } catch (error) {
    if (timeout.aborted) return { ok: false, reason: 'verification_timeout' };
    if (error instanceof VoiceBridgeError) {
      if (error.code === 'backend_timeout') return { ok: false, reason: 'verification_timeout' };
      if (error.code === 'backend_unavailable')
        return { ok: false, reason: 'verification_unavailable' };
    }
    // backend_rejected (4xx/5xx), invalid replies, unknown errors: not authorized.
    return { ok: false, reason: 'session_not_authorized' };
  }
}

function raceTimeout<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      promise.catch(() => {});
      reject(signal.reason);
      return;
    }
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}
