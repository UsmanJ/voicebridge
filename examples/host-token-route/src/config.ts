import { createLiveKitTokenIssuer, loadServerConfigFromEnv } from '@voicebridge/livekit-tokens';
import { type Authenticator, createDevAuthenticator } from './auth.ts';
import { createSessionApi } from './backend-client.ts';
import { type HostAppOptions } from './host.ts';
import { createRateLimiter } from './rate-limit.ts';

export interface HostConfig {
  bindHost: string;
  port: number;
  app: HostAppOptions;
}

type Env = Readonly<Record<string, string | undefined>>;

function isLoopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (
      url.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
      url.origin === origin
    );
  } catch {
    return false;
  }
}

function required(env: Env, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`missing environment variable ${name}`);
  return v;
}

/**
 * Builds the host from environment variables. Throws (refusing to start) on any missing or unsafe
 * setting. There's no unauthenticated mode: without a real authenticator, only the
 * explicitly enabled, localhost-only development identity is available.
 */
export function loadHostConfig(env: Env, authenticate?: Authenticator): HostConfig {
  const bindHost = env.HOST_BIND ?? '127.0.0.1';
  const port = Number(env.HOST_PORT ?? 8790);
  const applicationId = env.VB_APPLICATION_ID ?? 'help-desk';
  const agentName = env.VB_AGENT_NAME ?? 'voicebridge-help-desk';
  const allowTextInput = env.VB_TEXT_INPUT === 'true';

  const auth =
    authenticate ??
    (() => {
      if (!env.VB_DEV_AUTH) {
        throw new Error(
          'no authenticator configured: wire your own, or set VB_DEV_AUTH=localhost for local development',
        );
      }
      return createDevAuthenticator({
        mode: env.VB_DEV_AUTH,
        nodeEnv: env.NODE_ENV,
        bindHost,
        env,
      });
    })();

  const allowedOrigins = (env.HOST_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  // The development identity serves local pages only: refuse to pair it with a public origin.
  if (!authenticate) {
    const nonLocal = allowedOrigins.find((o) => !isLoopbackOrigin(o));
    if (nonLocal !== undefined) {
      throw new Error(
        'development authentication allows only http://localhost or http://127.0.0.1 origins in HOST_ALLOWED_ORIGINS',
      );
    }
  }

  const sessions = createSessionApi({
    baseUrl: required(env, 'HELP_DESK_URL'),
    hostCredential: required(env, 'HELP_DESK_HOST_CREDENTIAL'),
  });
  const issuer = createLiveKitTokenIssuer({
    ...loadServerConfigFromEnv(env),
    applications: { [applicationId]: { agentName, allowTextInput } },
    verifySessionBinding: async ({ sessionRef }) => sessions.canIssue(sessionRef),
    recordIssuance: async ({ sessionRef, roomName }) => sessions.attachRoom(sessionRef, roomName),
    ttlSeconds: Number(env.VB_TOKEN_TTL_SECONDS ?? 600),
  });

  return {
    bindHost,
    port,
    app: {
      authenticate: auth,
      issuer,
      sessions,
      applicationId,
      allowedOrigins,
      limits: {
        perClient: createRateLimiter({
          limit: Number(env.HOST_RATE_PER_CLIENT ?? 20),
          windowMs: 60_000,
        }),
        perSubject: createRateLimiter({
          limit: Number(env.HOST_RATE_PER_SUBJECT ?? 5),
          windowMs: 60_000,
        }),
      },
    },
  };
}
