/**
 * Errors raised by the token issuer.
 *
 * Messages are written for operators. They never contain API keys or secrets, tokens, session
 * refs, or values supplied in a request. `publicMessage` is safe to return to a browser.
 */
export type LiveKitTokenErrorCode =
  /** Server configuration is missing or invalid. Fix the deployment. */
  | 'config_error'
  /** The request shape is invalid (unknown fields, bad formats, unknown application). */
  | 'invalid_request'
  /** The host's binding verifier didn't confirm this application/session association. */
  | 'session_not_authorized'
  /** The LiveKit SDK failed to sign the token. */
  | 'signing_failed';

const PUBLIC_MESSAGES: Readonly<Record<LiveKitTokenErrorCode, string>> = {
  config_error: 'Voice sessions are not available right now.',
  invalid_request: 'The voice session request was invalid.',
  session_not_authorized: 'You are not allowed to start this voice session.',
  signing_failed: 'Voice sessions are not available right now.',
};

export class LiveKitTokenError extends Error {
  readonly code: LiveKitTokenErrorCode;
  /** Generic message safe to show to end users. */
  readonly publicMessage: string;

  constructor(code: LiveKitTokenErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'LiveKitTokenError';
    this.code = code;
    this.publicMessage = PUBLIC_MESSAGES[code];
  }

  /** Suggested HTTP status for an endpoint that surfaces this error. */
  get httpStatus(): number {
    switch (this.code) {
      case 'invalid_request':
        return 400;
      case 'session_not_authorized':
        return 403;
      default:
        return 503;
    }
  }
}
