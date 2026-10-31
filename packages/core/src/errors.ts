/**
 * Error taxonomy for VoiceBridge.
 *
 * Every error has a machine-readable `code`, an internal `message` for operators (never contains
 * credentials, response bodies, or user transcripts), and a generic `publicMessage` that is safe to
 * show to end users or to an LLM.
 */

export const ERROR_CODES = [
  'config_error',
  'invalid_session_context',
  'mode_not_supported',
  'backend_unavailable',
  'backend_timeout',
  'backend_rejected',
  'invalid_backend_reply',
  'response_too_large',
  'tool_not_allowed',
  'invalid_tool_arguments',
  'invalid_tool_result',
  'tool_failed',
  'cancelled',
  'session_closed',
] as const;

export type VoiceBridgeErrorCode = (typeof ERROR_CODES)[number];

const PUBLIC_MESSAGES: Readonly<Record<VoiceBridgeErrorCode, string>> = {
  config_error: 'The voice service is not configured correctly.',
  invalid_session_context: 'This session could not be verified.',
  mode_not_supported: 'This feature is not available for this application.',
  backend_unavailable: 'The service is temporarily unavailable.',
  backend_timeout: 'The service took too long to respond.',
  backend_rejected: 'The service could not complete the request.',
  invalid_backend_reply: 'The service returned an unexpected response.',
  response_too_large: 'The service returned an unexpected response.',
  tool_not_allowed: 'That action is not available.',
  invalid_tool_arguments: 'That request was missing or had invalid details.',
  invalid_tool_result: 'The service returned an unexpected response.',
  tool_failed: 'That action could not be completed.',
  cancelled: 'The request was cancelled.',
  session_closed: 'The session has ended.',
};

/** Error shape that is safe to show to end users, LLMs, and logs. */
export interface PublicError {
  code: VoiceBridgeErrorCode;
  publicMessage: string;
  applicationCode?: string;
}

export interface VoiceBridgeErrorOptions {
  /** Underlying cause, kept for operators. Not serialized into public output. */
  cause?: unknown;
  /** Overrides the generic public message (for example, a backend-approved message). */
  publicMessage?: string;
  /** Backend-approved machine-readable code (for example `not_found`). Safe to expose. */
  applicationCode?: string;
}

export class VoiceBridgeError extends Error {
  readonly code: VoiceBridgeErrorCode;
  readonly publicMessage: string;
  readonly applicationCode: string | undefined;

  constructor(code: VoiceBridgeErrorCode, message: string, options: VoiceBridgeErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'VoiceBridgeError';
    this.code = code;
    this.publicMessage = options.publicMessage ?? PUBLIC_MESSAGES[code];
    this.applicationCode = options.applicationCode;
  }

  /** A representation safe for end users, LLMs, and logs: no cause, no stack, no internal message. */
  toPublic(): PublicError {
    return this.applicationCode === undefined
      ? { code: this.code, publicMessage: this.publicMessage }
      : {
          code: this.code,
          publicMessage: this.publicMessage,
          applicationCode: this.applicationCode,
        };
  }
}

export function isVoiceBridgeError(value: unknown): value is VoiceBridgeError {
  return value instanceof VoiceBridgeError;
}

/** Wraps any thrown value. Unknown errors become `fallbackCode` without exposing their message publicly. */
export function toVoiceBridgeError(
  value: unknown,
  fallbackCode: VoiceBridgeErrorCode,
): VoiceBridgeError {
  if (value instanceof VoiceBridgeError) return value;
  return new VoiceBridgeError(fallbackCode, `unexpected ${describeThrown(value)}`, {
    cause: value,
  });
}

/** Default public message for a code. */
export function publicMessageFor(code: VoiceBridgeErrorCode): string {
  return PUBLIC_MESSAGES[code];
}

function describeThrown(value: unknown): string {
  if (value instanceof Error) return value.name;
  return typeof value;
}
