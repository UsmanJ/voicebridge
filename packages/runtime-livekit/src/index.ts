/**
 * @voicebridge/runtime-livekit: VoiceBridge runtime adapter for LiveKit Agents (Node.js).
 *
 * Backend-controlled mode only: every session is verified (dispatch metadata, application, room,
 * and an authorizing `sessions/start`) before connecting. Then final transcripts go to the
 * provider-neutral core, and backend-approved replies are spoken verbatim. No LLM.
 */
export {
  MAX_VERIFICATION_TIMEOUT_MS,
  type VoiceBridgeAgentOptions,
  createVoiceBridgeAgent,
  createVoiceBridgeJobHandler,
} from './agent.ts';
export { type SafeLogFields, type VoiceBridgeLogger, consoleLogger } from './logger.ts';
export { type ProviderConfig, type SttProvider, type TtsProvider } from './providers.ts';
export { liveKitCapabilities } from './runtime-session.ts';
export type {
  AgentSessionLike,
  JobContextLike,
  RecordingOptionsLike,
  SdkBindings,
  SpeechHandleLike,
} from './sdk-types.ts';
export {
  DEFAULT_VERIFICATION_TIMEOUT_MS,
  type RejectionReason,
  type VerificationOutcome,
  verifyLiveKitSession,
} from './verification.ts';
