import { applicationIdSchema, sessionRefSchema } from '@voicebridge/core';
import { AccessToken, RoomAgentDispatch, RoomConfiguration } from 'livekit-server-sdk';
import {
  type ApplicationTokenPolicy,
  DEFAULT_BINDING_TIMEOUT_MS,
  type LiveKitServerConfig,
  validateApplications,
  validateServerConfig,
  validateTtl,
} from './config.ts';
import { buildDispatchMetadata } from './dispatch.ts';
import { LiveKitTokenError } from './errors.ts';
import { generateParticipantIdentity, generateRoomName, voiceParticipantGrant } from './grants.ts';

/**
 * Server-derived, already-authenticated session binding. The host application builds it **after**
 * authenticating the user and creating the session record in its own store. Never build it from
 * request bodies, query strings, or headers sent by the browser.
 */
export interface VoiceSessionRequest {
  /** Server-selected application. Must be in the issuer's allowlist. */
  applicationId: string;
  /** Opaque reference the host created for this user and application. */
  sessionRef: string;
}

/**
 * Confirms, against the host's own server-side store, that `sessionRef` exists, is unexpired,
 * belongs to the authenticated user, and is bound to `applicationId`. Must return exactly `true`
 * to allow signing. Anything else (including throwing) refuses.
 *
 * Opaqueness is not authorization: a well-formed `sessionRef` is never trusted on its own.
 */
export type SessionBindingVerifier = (binding: Readonly<VoiceSessionRequest>) => Promise<boolean>;

export interface LiveKitTokenIssuerOptions extends LiveKitServerConfig {
  /** Allowlist: applicationId → policy (agent name, optional text input). */
  applications: Readonly<Record<string, ApplicationTokenPolicy>>;
  verifySessionBinding: SessionBindingVerifier;
  /** Token lifetime for the initial connection. Default 600 s. Allowed 60–3600 s. */
  ttlSeconds?: number;
  /** Max time to wait for `verifySessionBinding`. Default 3000 ms. */
  bindingTimeoutMs?: number;
}

/** What the browser needs to connect. Contains no server credentials. */
export interface VoiceSessionCredentials {
  serverUrl: string;
  participantToken: string;
  roomName: string;
  participantIdentity: string;
  /** Token expiry for the initial connection, in Unix epoch milliseconds. */
  expiresAt: number;
}

export interface LiveKitTokenIssuer {
  /** Applications this issuer can mint tokens for. */
  readonly applicationIds: readonly string[];
  /**
   * Mints credentials for one new voice session in a fresh, server-named room, with explicit
   * dispatch of the application's allowlisted agent.
   */
  issue(request: VoiceSessionRequest): Promise<VoiceSessionCredentials>;
}

const REQUEST_KEYS = 'applicationId,sessionRef';

export function createLiveKitTokenIssuer(options: LiveKitTokenIssuerOptions): LiveKitTokenIssuer {
  if (typeof options !== 'object' || options === null) {
    throw new LiveKitTokenError('config_error', 'issuer options are missing');
  }
  // Secrets live only in this closure, never on the returned object (safe to log or inspect).
  const { serverUrl, apiKey, apiSecret } = validateServerConfig(options);
  const applications = validateApplications(options.applications);
  const ttlSeconds = validateTtl(options.ttlSeconds);
  const verify = options.verifySessionBinding;
  if (typeof verify !== 'function') {
    throw new LiveKitTokenError('config_error', 'verifySessionBinding is required');
  }
  const bindingTimeoutMs = options.bindingTimeoutMs ?? DEFAULT_BINDING_TIMEOUT_MS;
  if (!Number.isInteger(bindingTimeoutMs) || bindingTimeoutMs <= 0) {
    throw new LiveKitTokenError('config_error', 'bindingTimeoutMs must be a positive integer');
  }
  const applicationIds = Object.freeze([...applications.keys()]);

  async function issue(request: VoiceSessionRequest): Promise<VoiceSessionCredentials> {
    // 1. Shape: exactly the two server-derived fields. Room names, identities, agent names, and
    //    metadata are never accepted from callers.
    if (typeof request !== 'object' || request === null || Array.isArray(request)) {
      throw new LiveKitTokenError('invalid_request', 'request must be an object');
    }
    if (Object.keys(request).sort().join(',') !== REQUEST_KEYS) {
      throw new LiveKitTokenError(
        'invalid_request',
        'request must contain exactly applicationId and sessionRef',
      );
    }
    const { applicationId, sessionRef } = request;
    if (
      !applicationIdSchema.safeParse(applicationId).success ||
      !sessionRefSchema.safeParse(sessionRef).success
    ) {
      throw new LiveKitTokenError('invalid_request', 'applicationId or sessionRef is malformed');
    }
    const policy = applications.get(applicationId);
    if (!policy) {
      throw new LiveKitTokenError('invalid_request', 'application is not in the allowlist');
    }

    // 2. Binding: the host must confirm this application/session association server-side.
    const binding = Object.freeze({ applicationId, sessionRef });
    let confirmed: unknown;
    try {
      confirmed = await withTimeout(verify(binding), bindingTimeoutMs);
    } catch (cause) {
      throw new LiveKitTokenError('session_not_authorized', 'session binding verification failed', {
        cause,
      });
    }
    if (confirmed !== true) {
      throw new LiveKitTokenError('session_not_authorized', 'session binding was not confirmed');
    }

    // 3. Sign: fresh room, opaque identity, least-privilege grant, allowlisted dispatch.
    const roomName = generateRoomName();
    const participantIdentity = generateParticipantIdentity();
    let participantToken: string;
    try {
      const token = new AccessToken(apiKey, apiSecret, {
        identity: participantIdentity,
        ttl: ttlSeconds,
      });
      token.addGrant(
        voiceParticipantGrant(roomName, { allowData: policy.allowTextInput === true }),
      );
      token.roomConfig = new RoomConfiguration({
        agents: [
          new RoomAgentDispatch({
            agentName: policy.agentName,
            metadata: buildDispatchMetadata(applicationId, sessionRef),
          }),
        ],
      });
      participantToken = await token.toJwt();
    } catch (cause) {
      // The SDK error is kept as the cause for operators. Its message isn't propagated.
      throw new LiveKitTokenError('signing_failed', 'failed to sign LiveKit access token', {
        cause,
      });
    }
    return {
      serverUrl,
      participantToken,
      roomName,
      participantIdentity,
      expiresAt: Date.now() + ttlSeconds * 1000,
    };
  }

  return Object.freeze({ applicationIds, issue });
}

/**
 * Shapes credentials as the JSON body that LiveKit client SDKs' endpoint `TokenSource` expects:
 * `{ server_url, participant_token }`.
 *
 * Your endpoint must **ignore** any `room_name`, `participant_identity`, or `room_config`
 * (including `agent_name` and `agent_metadata`) that the client sends. LiveKit's reference
 * endpoint honours them. VoiceBridge must not.
 */
export function toTokenSourceResponse(credentials: VoiceSessionCredentials): {
  server_url: string;
  participant_token: string;
} {
  return { server_url: credentials.serverUrl, participant_token: credentials.participantToken };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
