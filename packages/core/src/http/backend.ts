import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { ConversationAdapter } from '../contracts/application.ts';
import { applicationIdSchema } from '../contracts/session.ts';
import { type BackendReply, backendReplySchema } from '../contracts/turn.ts';
import { VoiceBridgeError } from '../errors.ts';
import {
  type ToolDefinition,
  type ToolEffect,
  type ToolInputSchema,
  defineTool,
} from '../tools/registry.ts';
import { WIRE_PROTOCOL_VERSION } from '../version.ts';
import {
  type SessionEndRequest,
  type SessionStartRequest,
  type ToolInvocationRequest,
  type TurnRequest,
  WIRE_HEADERS,
  WIRE_V0_PATHS,
  sessionStartResponseSchema,
  toolInvocationResponseSchema,
} from '../wire/v0.ts';
import { postJson } from './client.ts';
import { assertEndpointPath, joinUrl, parseBackendBaseUrl } from './url.ts';

export const DEFAULT_HTTP_TIMEOUT_MS = 8_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;

export interface HttpBackendOptions {
  /** The application this backend serves. Sessions for other applications are refused. */
  applicationId: string;
  /** From server-side configuration only. `https`, or `http` for localhost. */
  baseUrl: string;
  /**
   * Bearer credential identifying VoiceBridge to **this application only**. Never sent to
   * clients, never logged, never included in errors.
   */
  serviceCredential: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  /**
   * Optional capabilities. Defaults: `turns` at `/v0/turns`; session start and end disabled.
   * Set `turns: false` for tool-only backends.
   */
  endpoints?: {
    turns?: string | false;
    sessionStart?: string | false;
    sessionEnd?: string | false;
  };
  /** Injectable for tests. */
  fetch?: typeof fetch;
}

export interface HttpToolOptions<I extends ToolInputSchema, O extends z.ZodType> {
  name: string;
  description: string;
  effect: ToolEffect;
  input: I;
  output: O;
  /** Fixed path from configuration. Never derived from LLM output. */
  path: string;
  timeoutMs?: number;
}

export interface HttpBackend {
  readonly applicationId: string;
  /** Conversation adapter over `/v0/turns` (and session endpoints, if configured). */
  conversation(): ConversationAdapter;
  /** A tool whose execution is a `POST` to a fixed path on this backend. */
  tool<I extends ToolInputSchema, O extends z.ZodType>(
    options: HttpToolOptions<I, O>,
  ): ToolDefinition<I, O>;
}

export function createHttpBackend(options: HttpBackendOptions): HttpBackend {
  if (!applicationIdSchema.safeParse(options.applicationId).success) {
    throw new VoiceBridgeError('config_error', 'invalid applicationId');
  }
  const baseUrl = parseBackendBaseUrl(options.baseUrl);
  const credential = options.serviceCredential;
  if (typeof credential !== 'string' || credential.length < 16 || /\s/.test(credential)) {
    throw new VoiceBridgeError(
      'config_error',
      'serviceCredential must be at least 16 characters with no whitespace',
    );
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const endpoint = (value: string | false | undefined, fallback: string | false) => {
    const resolved = value === undefined ? fallback : value;
    return resolved === false ? false : assertEndpointPath(resolved);
  };
  const turnsPath = endpoint(options.endpoints?.turns, WIRE_V0_PATHS.turns);
  const startPath = endpoint(options.endpoints?.sessionStart, false);
  const endPath = endpoint(options.endpoints?.sessionEnd, false);

  const post = (
    path: string,
    body: unknown,
    idempotencyKey: string | undefined,
    signal?: AbortSignal,
  ) =>
    postJson({
      url: joinUrl(baseUrl, path),
      body,
      headers: {
        authorization: `Bearer ${credential}`,
        [WIRE_HEADERS.version]: WIRE_PROTOCOL_VERSION,
        [WIRE_HEADERS.requestId]: randomUUID(),
        ...(idempotencyKey ? { [WIRE_HEADERS.idempotencyKey]: idempotencyKey } : {}),
      },
      timeoutMs,
      maxResponseBytes,
      ...(signal ? { signal } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });

  const parseReply = (body: unknown): BackendReply => {
    const parsed = backendReplySchema.safeParse(body);
    if (!parsed.success)
      throw new VoiceBridgeError('invalid_backend_reply', 'turn reply failed validation');
    return parsed.data;
  };

  return {
    applicationId: options.applicationId,

    conversation() {
      if (turnsPath === false) {
        throw new VoiceBridgeError('mode_not_supported', 'this backend has no turns endpoint');
      }
      const adapter: ConversationAdapter = {
        async respond(turn, ctx, signal) {
          const body: TurnRequest = {
            turnId: turn.turnId,
            sessionRef: ctx.sessionRef,
            text: turn.text,
            source: turn.source,
          };
          const res = await post(turnsPath, body, `${ctx.sessionId}:${turn.turnId}`, signal);
          return parseReply(res.body);
        },
      };
      if (startPath !== false) {
        adapter.start = async (ctx, signal) => {
          const body: SessionStartRequest = {
            sessionRef: ctx.sessionRef,
            ...(ctx.runtimeBinding ? { runtimeBinding: { ...ctx.runtimeBinding } } : {}),
          };
          // Non-2xx is rejected by postJson (fail closed). Only an explicit
          // `{ authorized: true }` counts as authorization.
          const res = await post(startPath, body, `${ctx.sessionId}:start`, signal);
          const parsed = sessionStartResponseSchema.safeParse(res.body);
          if (!parsed.success) {
            throw new VoiceBridgeError(
              'invalid_backend_reply',
              'session start response is not an explicit authorization',
            );
          }
          return parsed.data;
        };
      }
      if (endPath !== false) {
        adapter.end = async (ctx, reason) => {
          const body: SessionEndRequest = { sessionRef: ctx.sessionRef, reason };
          await post(endPath, body, `${ctx.sessionId}:end`);
        };
      }
      return adapter;
    },

    tool(toolOptions) {
      const path = assertEndpointPath(toolOptions.path);
      return defineTool({
        name: toolOptions.name,
        description: toolOptions.description,
        effect: toolOptions.effect,
        input: toolOptions.input,
        output: toolOptions.output,
        ...(toolOptions.timeoutMs !== undefined ? { timeoutMs: toolOptions.timeoutMs } : {}),
        async execute(args, ctx) {
          const body: ToolInvocationRequest = {
            invocationId: ctx.invocationId,
            sessionRef: ctx.session.sessionRef,
            arguments: args as Record<string, unknown>,
          };
          const res = await post(path, body, ctx.invocationId, ctx.signal);
          const parsed = toolInvocationResponseSchema.safeParse(res.body);
          if (!parsed.success) {
            throw new VoiceBridgeError('invalid_backend_reply', 'tool response failed validation');
          }
          if (!parsed.data.ok) {
            const { code, publicMessage } = parsed.data.error;
            throw new VoiceBridgeError(
              'tool_failed',
              `application error: ${code}`,
              publicMessage ? { publicMessage, applicationCode: code } : { applicationCode: code },
            );
          }
          return parsed.data.result as z.input<typeof toolOptions.output>;
        },
      });
    },
  };
}
