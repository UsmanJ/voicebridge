import type { IncomingMessage } from 'node:http';

/** The host's authenticated caller. `subject` is an opaque user id (never a name or email). */
export interface AuthenticatedCaller {
  subject: string;
  /** True only for the synthetic development identity. */
  synthetic: boolean;
}

/**
 * The integration boundary: plug in YOUR application's authentication (session cookie, OAuth
 * bearer token, mTLS, …). Return `null` for unauthenticated requests.
 */
export type Authenticator = (req: IncomingMessage) => Promise<AuthenticatedCaller | null>;

export const DEV_SUBJECT = 'dev-user-0001';
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

export interface DevAuthOptions {
  /** Must be exactly `'localhost'` (from `VB_DEV_AUTH=localhost`) to enable. */
  mode: string | undefined;
  nodeEnv: string | undefined;
  /** The address the host server binds to. */
  bindHost: string;
}

/**
 * DEVELOPMENT ONLY. Authenticates every local request as one synthetic user.
 *
 * Guards:
 * - off unless `VB_DEV_AUTH=localhost`
 * - throws (refuses to start) when `NODE_ENV=production`
 * - throws when the server binds to a non-loopback address
 * - per request: the client must be loopback AND the Host header must be localhost (blocks DNS
 *   rebinding from a malicious web page)
 */
export function createDevAuthenticator(options: DevAuthOptions): Authenticator {
  if (options.mode !== 'localhost') {
    throw new Error('development authentication requires VB_DEV_AUTH=localhost');
  }
  if (options.nodeEnv === 'production') {
    throw new Error('development authentication cannot be enabled when NODE_ENV=production');
  }
  if (!LOOPBACK_ADDRESSES.has(options.bindHost) && options.bindHost !== 'localhost') {
    throw new Error('development authentication requires binding to a loopback address');
  }
  return async (req) => {
    const remote = req.socket.remoteAddress ?? '';
    const hostHeader = (req.headers.host ?? '').toLowerCase();
    const hostname = hostHeader.startsWith('[')
      ? hostHeader.slice(0, hostHeader.indexOf(']') + 1)
      : hostHeader.split(':')[0]!;
    if (!LOOPBACK_ADDRESSES.has(remote) || !LOOPBACK_HOSTNAMES.has(hostname)) return null;
    return { subject: DEV_SUBJECT, synthetic: true };
  };
}
