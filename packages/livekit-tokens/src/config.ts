import { applicationIdSchema } from '@voicebridge/core';
import { LiveKitTokenError } from './errors.ts';

export const DEFAULT_TOKEN_TTL_SECONDS = 600; // 10 minutes
export const MIN_TOKEN_TTL_SECONDS = 60;
export const MAX_TOKEN_TTL_SECONDS = 3600;
export const DEFAULT_BINDING_TIMEOUT_MS = 3000;

/** LiveKit agent names are server-selected. This pattern also rejects whitespace and control characters. */
export const AGENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Server credentials and endpoint. Load from server-side secrets only, never from a client. */
export interface LiveKitServerConfig {
  /** `wss://…` (or `ws://localhost…` for local development). Returned to clients as `serverUrl`. */
  serverUrl: string;
  /** LiveKit API key. Embedded in tokens as the issuer (`iss`); this is public by design. */
  apiKey: string;
  /** LiveKit API secret. Signs tokens. Never returned, logged, or included in errors. */
  apiSecret: string;
}

/** Per-application policy. The map of policies is the allowlist of applications that may get tokens. */
export interface ApplicationTokenPolicy {
  /** The LiveKit agent to dispatch for this application. Selected by the server, never by the client. */
  agentName: string;
  /**
   * Grant `canPublishData`. It's needed only for typed text input (`lk.chat` text streams).
   * Default false.
   */
  allowTextInput?: boolean;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Validates server configuration. Error messages never echo the secret. */
export function validateServerConfig(config: LiveKitServerConfig): LiveKitServerConfig {
  if (typeof config !== 'object' || config === null) {
    throw new LiveKitTokenError('config_error', 'LiveKit server config is missing');
  }
  const { serverUrl, apiKey, apiSecret } = config;
  let url: URL;
  try {
    url = new URL(String(serverUrl));
  } catch {
    throw new LiveKitTokenError('config_error', 'LiveKit serverUrl is not a valid URL');
  }
  const loopback = LOOPBACK.has(url.hostname);
  if (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && loopback)) {
    throw new LiveKitTokenError(
      'config_error',
      'LiveKit serverUrl must use wss:// (ws:// only for localhost)',
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new LiveKitTokenError(
      'config_error',
      'LiveKit serverUrl must not contain credentials, query, or fragment',
    );
  }
  if (typeof apiKey !== 'string' || !/^[A-Za-z0-9_-]{3,128}$/.test(apiKey)) {
    throw new LiveKitTokenError('config_error', 'LiveKit apiKey is missing or malformed');
  }
  if (typeof apiSecret !== 'string' || apiSecret.length < 32 || /\s/.test(apiSecret)) {
    throw new LiveKitTokenError(
      'config_error',
      'LiveKit apiSecret is missing or too short (min 32 characters, no whitespace)',
    );
  }
  return { serverUrl: url.href.replace(/\/+$/, ''), apiKey, apiSecret };
}

/** Validates the application allowlist. Returns a frozen copy. */
export function validateApplications(
  applications: Readonly<Record<string, ApplicationTokenPolicy>>,
): ReadonlyMap<string, Readonly<ApplicationTokenPolicy>> {
  if (typeof applications !== 'object' || applications === null) {
    throw new LiveKitTokenError('config_error', 'applications allowlist is missing');
  }
  const map = new Map<string, Readonly<ApplicationTokenPolicy>>();
  for (const [applicationId, policy] of Object.entries(applications)) {
    if (!applicationIdSchema.safeParse(applicationId).success) {
      throw new LiveKitTokenError(
        'config_error',
        `invalid applicationId in allowlist: "${applicationId}"`,
      );
    }
    if (typeof policy?.agentName !== 'string' || !AGENT_NAME_PATTERN.test(policy.agentName)) {
      throw new LiveKitTokenError(
        'config_error',
        `application "${applicationId}" has an invalid agentName`,
      );
    }
    if (policy.allowTextInput !== undefined && typeof policy.allowTextInput !== 'boolean') {
      throw new LiveKitTokenError(
        'config_error',
        `application "${applicationId}" has an invalid allowTextInput`,
      );
    }
    map.set(
      applicationId,
      Object.freeze({
        agentName: policy.agentName,
        allowTextInput: policy.allowTextInput === true,
      }),
    );
  }
  if (map.size === 0) {
    throw new LiveKitTokenError('config_error', 'applications allowlist is empty');
  }
  return map;
}

export function validateTtl(ttlSeconds: number | undefined): number {
  if (ttlSeconds === undefined) return DEFAULT_TOKEN_TTL_SECONDS;
  if (
    !Number.isInteger(ttlSeconds) ||
    ttlSeconds < MIN_TOKEN_TTL_SECONDS ||
    ttlSeconds > MAX_TOKEN_TTL_SECONDS
  ) {
    throw new LiveKitTokenError(
      'config_error',
      `ttlSeconds must be an integer between ${MIN_TOKEN_TTL_SECONDS} and ${MAX_TOKEN_TTL_SECONDS}`,
    );
  }
  return ttlSeconds;
}

/**
 * Reads `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET` from a server-side
 * environment. Throws `config_error` naming the missing variables (never their values).
 */
export function loadServerConfigFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): LiveKitServerConfig {
  const missing = ['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET'].filter((k) => !env[k]);
  if (missing.length > 0) {
    throw new LiveKitTokenError(
      'config_error',
      `missing environment variables: ${missing.join(', ')}`,
    );
  }
  return validateServerConfig({
    serverUrl: env.LIVEKIT_URL!,
    apiKey: env.LIVEKIT_API_KEY!,
    apiSecret: env.LIVEKIT_API_SECRET!,
  });
}
