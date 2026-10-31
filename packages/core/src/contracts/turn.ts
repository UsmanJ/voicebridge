import { z } from 'zod';

export const MAX_TURN_TEXT_LENGTH = 10_000;
export const MAX_REPLY_TEXT_LENGTH = 4_000;

export const turnSourceSchema = z.enum(['speech', 'text']);
export type TurnSource = z.infer<typeof turnSourceSchema>;

export const turnIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

/** A completed user turn: the exact final transcript (speech) or the typed text. */
export interface UserTurn {
  readonly turnId: string;
  readonly text: string;
  readonly source: TurnSource;
}

// A regex (not a refine) so the rule is preserved in the exported JSON Schema.
const replyText = z.string().max(MAX_REPLY_TEXT_LENGTH).regex(/\S/, 'reply text must not be blank');

/**
 * What the application wants said for a turn. In backend-controlled mode, `speak.text` is spoken
 * verbatim, with no LLM rewriting.
 */
export const backendReplySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('speak'), text: replyText }),
  z.strictObject({ kind: z.literal('silent') }),
  z.strictObject({ kind: z.literal('end'), text: replyText.optional() }),
]);

export type BackendReply = z.infer<typeof backendReplySchema>;

/**
 * Result of `sessions/start`. Returning it is an explicit statement that the backend verified the
 * session against its trusted, server-stored binding (application, session ref, and, when a
 * runtime binding is provided, room). Anything else is not authorization.
 */
export const sessionStartResultSchema = z.strictObject({
  authorized: z.literal(true),
  greeting: backendReplySchema.optional(),
});

export type SessionStartResult = z.infer<typeof sessionStartResultSchema>;
