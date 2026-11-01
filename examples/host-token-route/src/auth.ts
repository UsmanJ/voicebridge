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

/**
 * Headers added by reverse proxies, tunnels, CDNs, and load balancers. A request carrying any of
 * them reached the host through something else, so its loopback source address proves nothing.
 */
export const FORWARDING_HEADERS = [
  'forwarded',
  'via',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-port',
  'x-forwarded-server',
  'x-original-forwarded-for',
  'x-real-ip',
  'x-client-ip',
  'x-cluster-client-ip',
  'true-client-ip',
  'cf-connecting-ip',
  'fastly-client-ip',
  'x-azure-clientip',
  'x-envoy-external-address',
] as const;

/**
 * Environment variables set by common hosting platforms and orchestrators. Their presence means the
 * process is deployed, so the development identity refuses to start. A heuristic, not a guarantee.
 */
export const HOSTING_ENV_MARKERS = [
  'KUBERNETES_SERVICE_HOST',
  'K_SERVICE',
  'AWS_EXECUTION_ENV',
  'ECS_CONTAINER_METADATA_URI',
  'ECS_CONTAINER_METADATA_URI_V4',
  'WEBSITE_SITE_NAME',
  'FLY_APP_NAME',
  'RENDER',
  'DYNO',
  'RAILWAY_ENVIRONMENT',
  'VERCEL',
  'NETLIFY',
  'HEROKU_APP_ID',
] as const;

export interface DevAuthOptions {
  /** Must be exactly `'localhost'` (from `VB_DEV_AUTH=localhost`) to enable. */
  mode: string | undefined;
  nodeEnv: string | undefined;
  /** The address the host server binds to. */
  bindHost: string;
  /** Process environment, checked for hosting-platform markers. */
  env?: Readonly<Record<string, string | undefined>>;
}

/**
 * DEVELOPMENT ONLY. Authenticates every local request as one synthetic user.
 *
 * Guards:
 * - off unless `VB_DEV_AUTH=localhost`
 * - throws (refuses to start) when `NODE_ENV=production`
 * - throws when the server binds to a non-loopback address
 * - throws when a hosting-platform environment marker is present (Kubernetes, Cloud Run, ECS, …)
 * - per request: the client must be loopback, the Host header must be localhost (blocks DNS
 *   rebinding from a malicious web page), and no proxy forwarding header may be present (blocks
 *   most reverse proxies and tunnels: ngrok, cloudflared, Caddy, Traefik, load balancers)
 *
 * Not detectable: a reverse proxy on the same machine that adds no forwarding headers (for example
 * a bare nginx `proxy_pass http://127.0.0.1:8790`). Its requests are genuinely local. Never run the
 * development identity on a machine that exposes this port through a proxy or tunnel.
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
  const marker = HOSTING_ENV_MARKERS.find((name) => options.env?.[name] !== undefined);
  if (marker) {
    throw new Error(
      `development authentication cannot be enabled on a hosting platform (${marker} is set)`,
    );
  }
  return async (req) => {
    const remote = req.socket.remoteAddress ?? '';
    const hostHeader = (req.headers.host ?? '').toLowerCase();
    const hostname = hostHeader.startsWith('[')
      ? hostHeader.slice(0, hostHeader.indexOf(']') + 1)
      : hostHeader.split(':')[0]!;
    if (!LOOPBACK_ADDRESSES.has(remote) || !LOOPBACK_HOSTNAMES.has(hostname)) return null;
    if (FORWARDING_HEADERS.some((name) => req.headers[name] !== undefined)) return null;
    return { subject: DEV_SUBJECT, synthetic: true };
  };
}
