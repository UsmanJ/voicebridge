/**
 * @voicebridge/livekit-tokens: server-side LiveKit participant credentials for VoiceBridge.
 *
 * Least-privilege, room-scoped, short-lived tokens with allowlisted agent dispatch. Server-side
 * only: never bundle this into a browser. It doesn't authenticate users (the host application
 * does) and doesn't contain the LiveKit Agents runtime.
 */
export {
  AGENT_NAME_PATTERN,
  type ApplicationTokenPolicy,
  DEFAULT_BINDING_TIMEOUT_MS,
  DEFAULT_TOKEN_TTL_SECONDS,
  type LiveKitServerConfig,
  MAX_TOKEN_TTL_SECONDS,
  MIN_TOKEN_TTL_SECONDS,
  loadServerConfigFromEnv,
} from './config.ts';
export {
  DISPATCH_METADATA_MAX_BYTES,
  type DispatchMetadataV0,
  parseDispatchMetadata,
} from './dispatch.ts';
export { LiveKitTokenError, type LiveKitTokenErrorCode } from './errors.ts';
export {
  type LiveKitTokenIssuer,
  type LiveKitTokenIssuerOptions,
  type SessionBindingVerifier,
  type VoiceSessionCredentials,
  type VoiceSessionRequest,
  createLiveKitTokenIssuer,
  toTokenSourceResponse,
} from './issuer.ts';
