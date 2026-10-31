/**
 * Wire contract **v0 (experimental)** between VoiceBridge and application backends.
 *
 * Language-neutral: these Zod schemas are exported as JSON Schema (`schema/v0/*.json`) and pinned
 * by conformance vectors (`conformance/v0/vectors.json`). Implementations in other languages (for
 * example, a future Python runtime) implement this protocol. They don't import this package.
 */
import { z } from 'zod';
import { SESSION_END_REASONS, sessionRefSchema } from '../contracts/session.ts';
import {
  MAX_TURN_TEXT_LENGTH,
  backendReplySchema,
  turnIdSchema,
  turnSourceSchema,
} from '../contracts/turn.ts';
import { invocationIdSchema } from '../tools/executor.ts';

export const WIRE_V0_PATHS = {
  turns: '/v0/turns',
  sessionStart: '/v0/sessions/start',
  sessionEnd: '/v0/sessions/end',
} as const;

export const WIRE_HEADERS = {
  version: 'VoiceBridge-Version',
  requestId: 'VoiceBridge-Request-Id',
  idempotencyKey: 'Idempotency-Key',
} as const;

/** `POST /v0/turns` request. */
export const turnRequestSchema = z.strictObject({
  turnId: turnIdSchema,
  sessionRef: sessionRefSchema,
  text: z.string().max(MAX_TURN_TEXT_LENGTH),
  source: turnSourceSchema,
});

/** `POST /v0/turns` and `POST /v0/sessions/start` response. */
export const turnReplySchema = backendReplySchema;

/** `POST /v0/sessions/start` request. */
export const sessionStartRequestSchema = z.strictObject({ sessionRef: sessionRefSchema });

/** `POST /v0/sessions/end` request (response: 204). */
export const sessionEndRequestSchema = z.strictObject({
  sessionRef: sessionRefSchema,
  reason: z.enum(SESSION_END_REASONS),
});

/** `POST {toolPath}` request. `arguments` has already been validated against the tool's input schema. */
export const toolInvocationRequestSchema = z.strictObject({
  invocationId: invocationIdSchema,
  sessionRef: sessionRefSchema,
  arguments: z.record(z.string(), z.unknown()),
});

/** Machine-readable application error code, for example `not_found` or `confirmation_required`. */
export const applicationErrorCodeSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);

/** `POST {toolPath}` response. `publicMessage` must be safe to show to the user or LLM. */
export const toolInvocationResponseSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), result: z.unknown() }),
  z.strictObject({
    ok: z.literal(false),
    error: z.strictObject({
      code: applicationErrorCodeSchema,
      publicMessage: z.string().min(1).max(300).optional(),
    }),
  }),
]);

export type TurnRequest = z.infer<typeof turnRequestSchema>;
export type SessionStartRequest = z.infer<typeof sessionStartRequestSchema>;
export type SessionEndRequest = z.infer<typeof sessionEndRequestSchema>;
export type ToolInvocationRequest = z.infer<typeof toolInvocationRequestSchema>;
export type ToolInvocationResponse = z.infer<typeof toolInvocationResponseSchema>;

/** All v0 message schemas by name. Names match the JSON Schema files and conformance vectors. */
export const WIRE_V0_SCHEMAS = {
  turnRequest: turnRequestSchema,
  turnReply: turnReplySchema,
  sessionStartRequest: sessionStartRequestSchema,
  sessionEndRequest: sessionEndRequestSchema,
  toolInvocationRequest: toolInvocationRequestSchema,
  toolInvocationResponse: toolInvocationResponseSchema,
} as const;

export type WireV0SchemaName = keyof typeof WIRE_V0_SCHEMAS;

/** JSON Schema (draft 2020-12) for every v0 message, generated from the Zod schemas. */
export function wireV0JsonSchemas(): Record<WireV0SchemaName, Record<string, unknown>> {
  const out = {} as Record<WireV0SchemaName, Record<string, unknown>>;
  for (const [name, schema] of Object.entries(WIRE_V0_SCHEMAS) as [WireV0SchemaName, z.ZodType][]) {
    out[name] = {
      ...z.toJSONSchema(schema, { io: 'input' }),
      $id: `https://voicebridge.dev/schema/v0/${name}.json`,
      title: name,
      description: `VoiceBridge wire contract v0 (experimental): ${name}`,
    };
  }
  return out;
}
