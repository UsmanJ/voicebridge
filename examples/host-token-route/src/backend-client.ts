import { parseBackendBaseUrl } from '@voicebridge/core';

/** The host's client for the application backend's internal session API (host credential). */
export interface SessionApi {
  create(subject: string): Promise<{ sessionRef: string }>;
  canIssue(sessionRef: string): Promise<boolean>;
  /** Throws if the room can't be recorded (including an existing binding: never overwritten). */
  attachRoom(sessionRef: string, roomName: string): Promise<void>;
  revoke(sessionRef: string): Promise<void>;
}

export class SessionApiError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'SessionApiError';
    this.status = status;
  }
}

export function createSessionApi(options: {
  baseUrl: string;
  hostCredential: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}): SessionApi {
  const base = parseBackendBaseUrl(options.baseUrl);
  if (options.hostCredential.length < 32 || /\s/.test(options.hostCredential)) {
    throw new Error('host credential must be at least 32 characters with no whitespace');
  }
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 3000;

  async function post(path: string, body: unknown): Promise<{ status: number; json: unknown }> {
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${options.hostCredential}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      // No URL, credential, or cause in the message.
      throw new SessionApiError('session backend unreachable');
    }
    const text = await res.text().catch(() => '');
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: res.status, json };
  }

  return {
    async create(subject) {
      const r = await post('/internal/v0/sessions', { subject });
      const ref = (r.json as { sessionRef?: unknown } | undefined)?.sessionRef;
      if (r.status !== 201 || typeof ref !== 'string')
        throw new SessionApiError('session creation failed', r.status);
      return { sessionRef: ref };
    },
    async canIssue(sessionRef) {
      const r = await post('/internal/v0/sessions/verify-issuance', { sessionRef });
      return r.status === 200 && (r.json as { issuable?: unknown } | undefined)?.issuable === true;
    },
    async attachRoom(sessionRef, roomName) {
      const r = await post('/internal/v0/sessions/attach-room', { sessionRef, roomName });
      if (r.status !== 204) throw new SessionApiError('room binding refused', r.status);
    },
    async revoke(sessionRef) {
      const r = await post('/internal/v0/sessions/revoke', { sessionRef });
      if (r.status !== 204) throw new SessionApiError('revocation failed', r.status);
    },
  };
}
