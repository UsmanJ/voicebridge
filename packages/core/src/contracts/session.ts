import { z } from 'zod';
import { VoiceBridgeError } from '../errors.ts';

/** Application identifier: lowercase slug, configured server-side per application. */
export const applicationIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, 'applicationId must be a lowercase slug (max 64 chars)');

/**
 * Opaque, app-issued session reference. The backend resolves and authorizes it server-side.
 * It is **not** a credential: it is safe for the end user to see, and useless without the
 * application's service credential.
 */
export const sessionRefSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{16,256}$/, 'sessionRef must be 16-256 URL-safe characters');

export const sessionIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_.:-]{1,128}$/, 'sessionId must be 1-128 safe characters');

/**
 * Where the session is actually running, as observed by the runtime adapter from a trusted source
 * (for LiveKit: the dispatched job's room). Sent to the backend on `sessions/start` so it can check
 * the room recorded at issuance against the real one.
 */
export const runtimeBindingSchema = z.strictObject({
  /** Runtime kind, for example `livekit`. */
  runtime: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
  /** The runtime's room or call identifier. */
  roomName: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/),
});
export type RuntimeBinding = Readonly<z.infer<typeof runtimeBindingSchema>>;

export const sessionContextSchema = z.strictObject({
  applicationId: applicationIdSchema,
  sessionId: sessionIdSchema,
  sessionRef: sessionRefSchema,
  runtimeBinding: runtimeBindingSchema.optional(),
});

/**
 * Trusted session context. A runtime adapter builds it from a server-minted channel (for
 * example, LiveKit job metadata). It is never built from speech, typed text, LLM output, or
 * participant-editable fields. Contains no credentials.
 */
export type SessionContext = Readonly<z.infer<typeof sessionContextSchema>>;

export const SESSION_END_REASONS = [
  'client_left',
  'backend_ended',
  'runtime_error',
  'shutdown',
  'timeout',
] as const;
export type SessionEndReason = (typeof SESSION_END_REASONS)[number];

/**
 * Validates untrusted input into a {@link SessionContext}.
 * The error message names the invalid fields but never echoes their values.
 */
export function parseSessionContext(input: unknown): SessionContext {
  const result = sessionContextSchema.safeParse(input);
  if (!result.success) {
    const fields = [...new Set(result.error.issues.map((i) => i.path.join('.') || '(root)'))];
    throw new VoiceBridgeError(
      'invalid_session_context',
      `invalid session context: ${fields.join(', ')}`,
    );
  }
  const { runtimeBinding, ...rest } = result.data;
  return Object.freeze(
    runtimeBinding ? { ...rest, runtimeBinding: Object.freeze({ ...runtimeBinding }) } : rest,
  );
}
