import {
  LiveKitTokenError,
  type LiveKitTokenIssuer,
  toTokenSourceResponse,
} from '@voicebridge/livekit-tokens';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Authenticator } from './auth.ts';
import type { SessionApi } from './backend-client.ts';
import type { RateLimiter } from './rate-limit.ts';

export const TOKEN_PATH = '/api/voice/token';
const MAX_IGNORED_BODY_BYTES = 8 * 1024;

export type HostLogger = (
  event: string,
  fields?: Record<string, string | number | boolean>,
) => void;

export interface HostAppOptions {
  authenticate: Authenticator;
  /** Built with the session API's canIssue/attachRoom as verifySessionBinding/recordIssuance. */
  issuer: LiveKitTokenIssuer;
  sessions: SessionApi;
  /** From trusted server configuration. Never from the request. */
  applicationId: string;
  /** Browser origins allowed to call the token route (exact match). Empty = no browser origin. */
  allowedOrigins: readonly string[];
  limits: { perClient: RateLimiter; perSubject: RateLimiter };
  logger?: HostLogger;
}

/**
 * Minimal host app with one authenticated route: `POST /api/voice/token`.
 *
 * The request body is drained and **ignored**. Room names, identities, agent names, and metadata
 * sent by the browser have no effect. The application comes from server config, and the subject
 * from authentication.
 */
export function createHostApp(options: HostAppOptions) {
  const log: HostLogger = options.logger ?? (() => {});
  const origins = new Set(options.allowedOrigins);

  function send(res: ServerResponse, status: number, body: unknown, origin?: string) {
    if (res.writableEnded) return;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    };
    if (origin) {
      headers['access-control-allow-origin'] = origin;
      headers.vary = 'Origin';
    }
    res.writeHead(status, headers);
    res.end(JSON.stringify(body));
  }

  async function drain(req: IncomingMessage) {
    let size = 0;
    for await (const chunk of req as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > MAX_IGNORED_BODY_BYTES)
        throw Object.assign(new Error('too large'), { status: 413 });
    }
  }

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? '/').split('?')[0];
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    const allowedOrigin = origin && origins.has(origin) ? origin : undefined;
    try {
      if (req.method === 'GET' && path === '/healthz') return send(res, 200, { status: 'ok' });
      if (path !== TOKEN_PATH) return send(res, 404, { error: 'not_found' });

      // Browser requests must come from an allowed origin (no wildcard CORS, ever).
      if (origin && !allowedOrigin) {
        log('origin_refused');
        return send(res, 403, { error: 'origin_not_allowed' });
      }
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'access-control-allow-origin': allowedOrigin ?? '',
          'access-control-allow-methods': 'POST',
          'access-control-allow-headers': 'content-type, authorization',
          'access-control-max-age': '600',
          vary: 'Origin',
        });
        return res.end();
      }
      if (req.method !== 'POST')
        return send(res, 405, { error: 'method_not_allowed' }, allowedOrigin);

      const client = req.socket.remoteAddress ?? 'unknown';
      if (!options.limits.perClient.allow(client)) {
        log('rate_limited', { scope: 'client' });
        return send(res, 429, { error: 'rate_limited' }, allowedOrigin);
      }
      const caller = await options.authenticate(req);
      if (!caller) {
        log('unauthenticated');
        return send(res, 401, { error: 'unauthenticated' }, allowedOrigin);
      }
      if (!options.limits.perSubject.allow(caller.subject)) {
        log('rate_limited', { scope: 'subject' });
        return send(res, 429, { error: 'rate_limited' }, allowedOrigin);
      }
      await drain(req); // ignored entirely

      // 1. Create and authorize the session server-side, bound to the configured application.
      const { sessionRef } = await options.sessions.create(caller.subject);
      // 2. Issue (the issuer verifies the binding, signs, then records the room atomically).
      const credentials = await options.issuer.issue({
        applicationId: options.applicationId,
        sessionRef,
      });
      log('token_issued', { synthetic: caller.synthetic });
      return send(res, 200, toTokenSourceResponse(credentials), allowedOrigin);
    } catch (error) {
      if ((error as { status?: number }).status === 413)
        return send(res, 413, { error: 'payload_too_large' }, allowedOrigin);
      if (error instanceof LiveKitTokenError) {
        log('token_refused', { code: error.code });
        return send(res, error.httpStatus, { error: error.publicMessage }, allowedOrigin);
      }
      log('token_route_error', { error: error instanceof Error ? error.name : typeof error });
      return send(
        res,
        503,
        { error: 'Voice sessions are not available right now.' },
        allowedOrigin,
      );
    }
  };

  return { handler };
}
