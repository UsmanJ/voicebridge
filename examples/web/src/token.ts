import type { TokenSourceResponseObject } from 'livekit-client';

/** Why a credential request failed. Never carries server text, URLs, or tokens. */
export type TokenErrorKind =
  | 'unauthorized'
  | 'forbidden'
  | 'rate_limited'
  | 'unavailable'
  | 'timeout'
  | 'network'
  | 'invalid_response'
  | 'aborted';

export class TokenRequestError extends Error {
  constructor(readonly kind: TokenErrorKind) {
    super(`voice session request failed: ${kind}`);
    this.name = 'TokenRequestError';
  }
}

const MAX_RESPONSE_BYTES = 16 * 1024;
const MAX_TOKEN_LENGTH = 8 * 1024;
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

function isAllowedServerUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === 'wss:' || url.protocol === 'https:') return true;
    // Local LiveKit servers (`livekit-server --dev`) only.
    return (
      (url.protocol === 'ws:' || url.protocol === 'http:') &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

export interface FetchCredentialsOptions {
  endpoint: string;
  timeoutMs: number;
  /** Cancels the request (End Conversation, unmount). */
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

/**
 * Requests credentials for ONE new voice session from the host token route, in the LiveKit
 * standard endpoint response format (`{ server_url, participant_token }`).
 *
 * Call it once per Start click. Every call creates a new backend session and a new room on the
 * server, so the result must never be cached or reused for a later conversation.
 *
 * The request carries no body, no cookies, and no client-chosen room, identity, or agent: the host
 * derives all of that server-side. Errors are mapped to a {@link TokenErrorKind}; server text is
 * never surfaced.
 */
export async function fetchSessionCredentials(
  options: FetchCredentialsOptions,
): Promise<TokenSourceResponseObject> {
  const doFetch = options.fetchImpl ?? fetch;
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await doFetch(options.endpoint, {
      method: 'POST',
      // The host ignores request bodies. Sending none keeps this a CORS "simple" request.
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      signal,
    });
  } catch {
    if (options.signal?.aborted) throw new TokenRequestError('aborted');
    if (timeout.aborted) throw new TokenRequestError('timeout');
    throw new TokenRequestError('network');
  }

  if (!response.ok) {
    // Drain without reading the body into the UI.
    void response.body?.cancel().catch(() => {});
    if (response.status === 401) throw new TokenRequestError('unauthorized');
    if (response.status === 403) throw new TokenRequestError('forbidden');
    if (response.status === 429) throw new TokenRequestError('rate_limited');
    throw new TokenRequestError('unavailable');
  }

  let body: unknown;
  try {
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) throw new Error('too large');
    body = JSON.parse(text);
  } catch {
    if (options.signal?.aborted) throw new TokenRequestError('aborted');
    if (timeout.aborted) throw new TokenRequestError('timeout');
    throw new TokenRequestError('invalid_response');
  }

  const record = (body ?? {}) as Record<string, unknown>;
  const serverUrl = record.server_url;
  const participantToken = record.participant_token;
  if (
    typeof serverUrl !== 'string' ||
    typeof participantToken !== 'string' ||
    !isAllowedServerUrl(serverUrl) ||
    participantToken.length > MAX_TOKEN_LENGTH ||
    !JWT_SHAPE.test(participantToken)
  ) {
    throw new TokenRequestError('invalid_response');
  }
  return { serverUrl, participantToken };
}
