import {
  type Application,
  createHttpBackend,
  defineApplication,
  parseBackendBaseUrl,
} from '@voicebridge/core';
import type { VoiceBridgeAgentOptions } from '@voicebridge/runtime-livekit';

type Env = Readonly<Record<string, string | undefined>>;

/** Log levels accepted by the LiveKit Agents CLI (`--log-level` / `LOG_LEVEL`). */
export const SDK_LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;
export type SdkLogLevel = (typeof SDK_LOG_LEVELS)[number];

/**
 * Default LiveKit SDK log level for this worker. `@livekit/agents` 1.9.5 writes raw user
 * transcripts to its local logs at WARN (for example "skipping user input, speech scheduling is
 * paused", carrying `lk.pii.user_input`, when a session closes with an uncommitted user turn),
 * and more at INFO and DEBUG. Its PII redaction applies only to LiveKit Cloud telemetry export,
 * not to local stdout. At `error` no known SDK path in 1.9.5 logs transcripts.
 */
export const DEFAULT_SDK_LOG_LEVEL: SdkLogLevel = 'error';

/** True when the LiveKit SDK may write user transcripts to local logs at this level. */
export function sdkLogsMayContainTranscripts(level: SdkLogLevel): boolean {
  return level !== 'error' && level !== 'fatal';
}

export interface WorkerConfig {
  agentName: string;
  healthHost: string;
  healthPort: number;
  /** Applied as `LOG_LEVEL` before the LiveKit CLI parses its options (also used by job processes). */
  sdkLogLevel: SdkLogLevel;
  options: VoiceBridgeAgentOptions;
  /** Safe to print: no credentials, URLs, or secrets. */
  summary: Record<string, string | number | boolean>;
}

function required(env: Env, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`missing environment variable ${name}`);
  return v;
}

/** Validates the worker configuration. Throws on anything missing or unsafe (fail fast). */
export function loadWorkerConfig(env: Env): WorkerConfig {
  for (const name of ['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET']) required(env, name);
  const applicationId = env.VB_APPLICATION_ID ?? 'help-desk';
  const backendUrl = parseBackendBaseUrl(required(env, 'HELP_DESK_URL'));
  const backend = createHttpBackend({
    applicationId,
    baseUrl: backendUrl,
    serviceCredential: required(env, 'HELP_DESK_WORKER_CREDENTIAL'),
    timeoutMs: Number(env.VB_BACKEND_TIMEOUT_MS ?? 8000),
    // sessions/start is mandatory for LiveKit (authorization); sessions/end notifies the backend.
    endpoints: { sessionStart: '/v0/sessions/start', sessionEnd: '/v0/sessions/end' },
  });
  const application: Application = defineApplication({
    applicationId,
    conversation: backend.conversation(),
  });
  const sdkLogLevel = (env.LOG_LEVEL ?? DEFAULT_SDK_LOG_LEVEL) as SdkLogLevel;
  if (!SDK_LOG_LEVELS.includes(sdkLogLevel)) {
    throw new Error(`LOG_LEVEL must be one of ${SDK_LOG_LEVELS.join(', ')}`);
  }
  const textInput = env.VB_TEXT_INPUT === 'true';
  const sttModel = env.VB_STT_MODEL ?? 'assemblyai/universal-3-6-pro';
  const ttsModel = env.VB_TTS_MODEL ?? 'fishaudio/s2.1-pro';
  const ttsVoice = env.VB_TTS_VOICE ?? 'fa4c9eb3dccc4806b382b40d61c6b10a';
  const options: VoiceBridgeAgentOptions = {
    application,
    mode: 'backend-controlled',
    providers: {
      stt: { model: sttModel, language: env.VB_STT_LANGUAGE ?? 'en' },
      tts: { model: ttsModel, voice: ttsVoice },
      turnDetection: env.VB_TURN_DETECTION === 'stt' ? 'stt' : 'livekit',
    },
    textInput,
    recording: false, // explicit: no audio, transcript, traces, or logs uploaded
    backend: { timeoutMs: Number(env.VB_BACKEND_TIMEOUT_MS ?? 8000) },
  };
  return {
    agentName: env.VB_AGENT_NAME ?? 'voicebridge-help-desk',
    healthHost: env.VB_HEALTH_HOST ?? '127.0.0.1',
    healthPort: Number(env.VB_HEALTH_PORT ?? 8081),
    sdkLogLevel,
    options,
    summary: {
      sdkLogLevel,
      sdkLogsMayContainTranscripts: sdkLogsMayContainTranscripts(sdkLogLevel),
      applicationId,
      agentName: env.VB_AGENT_NAME ?? 'voicebridge-help-desk',
      mode: 'backend-controlled',
      llm: false,
      recording: false,
      textInput,
      sttModel,
      ttsModel,
      turnDetection: env.VB_TURN_DETECTION === 'stt' ? 'stt' : 'livekit',
      backendTls: backendUrl.startsWith('https://'),
      livekitConfigured: true,
    },
  };
}
