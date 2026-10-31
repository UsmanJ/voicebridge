import { defineAgent } from '@livekit/agents';
import {
  type Application,
  type BackendControlledOptions,
  type Observer,
  VoiceBridgeError,
  assertModeSupported,
} from '@voicebridge/core';
import { type JobConfig, runVoiceBridgeJob } from './job.ts';
import { type VoiceBridgeLogger, consoleLogger, safeLogger } from './logger.ts';
import { type ProviderConfig, createLiveKitSdkBindings, validateProviders } from './providers.ts';
import type { JobContextLike, RecordingOptionsLike, SdkBindings } from './sdk-types.ts';
import { DEFAULT_VERIFICATION_TIMEOUT_MS } from './verification.ts';

/** The SDK warns if a job hasn't connected 10 s after entry, so verification must finish well before. */
export const MAX_VERIFICATION_TIMEOUT_MS = 9_000;

export interface VoiceBridgeAgentOptions {
  /**
   * The one application this worker serves. Its conversation adapter **must** implement an
   * authorizing `start` (for HTTP backends, configure `endpoints.sessionStart`).
   */
  application: Application;
  /** Only backend-controlled mode is implemented by this adapter version. */
  mode: 'backend-controlled';
  providers: ProviderConfig;
  /** Accept typed text (`lk.chat`). Must match the token policy's `allowTextInput`. Default false. */
  textInput?: boolean;
  /** Timeout for pre-connection session verification. Default 5000 ms, max 9000 ms. */
  verificationTimeoutMs?: number;
  /** Turn handling passed to the core (timeouts, fallback text, hold window). */
  backend?: Pick<BackendControlledOptions, 'timeoutMs' | 'fallbackText' | 'pendingTurnHoldMs'>;
  /**
   * LiveKit Cloud Agent Observability upload. Default `false`: nothing is recorded. Pass explicit
   * categories to opt in (also sends `enable_user_data_training` to LiveKit, see docs).
   */
  recording?: false | RecordingOptionsLike;
  /** VoiceBridge's own warnings and errors. Default: JSON lines on stderr, without payloads. */
  logger?: VoiceBridgeLogger;
  /** Privacy-safe core events (ids, outcomes, durations, lengths). */
  observer?: Observer;
}

/** Validates options once at startup. Throws `config_error` / `mode_not_supported`. */
export function resolveJobConfig(
  options: VoiceBridgeAgentOptions,
): JobConfig & { providers: ProviderConfig } {
  if (!options || typeof options !== 'object') {
    throw new VoiceBridgeError('config_error', 'options are required');
  }
  if (options.mode !== 'backend-controlled') {
    throw new VoiceBridgeError('mode_not_supported', 'only backend-controlled mode is implemented');
  }
  assertModeSupported(options.application, 'backend-controlled');
  if (typeof options.application.conversation?.start !== 'function') {
    throw new VoiceBridgeError(
      'config_error',
      'LiveKit deployments require an authorizing sessions/start (configure endpoints.sessionStart)',
    );
  }
  const providers = validateProviders(options.providers);
  const verificationTimeoutMs = options.verificationTimeoutMs ?? DEFAULT_VERIFICATION_TIMEOUT_MS;
  if (
    !Number.isInteger(verificationTimeoutMs) ||
    verificationTimeoutMs <= 0 ||
    verificationTimeoutMs > MAX_VERIFICATION_TIMEOUT_MS
  ) {
    throw new VoiceBridgeError(
      'config_error',
      `verificationTimeoutMs must be 1-${MAX_VERIFICATION_TIMEOUT_MS} ms`,
    );
  }
  const recording = options.recording ?? false;
  if (recording !== false) {
    const allowed = new Set(['audio', 'transcript', 'traces', 'logs', 'redaction']);
    if (
      typeof recording !== 'object' ||
      Object.entries(recording).some(([k, v]) => !allowed.has(k) || typeof v !== 'boolean')
    ) {
      throw new VoiceBridgeError(
        'config_error',
        'recording must be false or explicit boolean categories',
      );
    }
  }
  if (options.textInput !== undefined && typeof options.textInput !== 'boolean') {
    throw new VoiceBridgeError('config_error', 'textInput must be a boolean');
  }
  return {
    application: options.application,
    providers,
    verificationTimeoutMs,
    textInput: options.textInput === true,
    recording,
    session: { ...options.backend },
    logger: safeLogger(options.logger ?? consoleLogger),
    ...(options.observer ? { observer: options.observer } : {}),
  };
}

/**
 * Returns the job entry function. Exposed for custom bootstraps and for tests (which inject fake
 * SDK bindings). Most hosts should use {@link createVoiceBridgeAgent}.
 */
export function createVoiceBridgeJobHandler(
  options: VoiceBridgeAgentOptions,
  sdk?: SdkBindings,
): (ctx: JobContextLike) => Promise<void> {
  const config = resolveJobConfig(options);
  const bindings = sdk ?? createLiveKitSdkBindings(config.providers);
  return async (ctx) => {
    await runVoiceBridgeJob(ctx, bindings, config);
  };
}

/**
 * Creates a LiveKit agent definition for VoiceBridge backend-controlled mode. Export it as the
 * worker module's default, and register the worker under the agent name your token issuer
 * dispatches:
 *
 * ```ts
 * export default createVoiceBridgeAgent({ application, mode: 'backend-controlled', providers });
 * cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url), agentName: 'voicebridge-agent' }));
 * ```
 */
export function createVoiceBridgeAgent(options: VoiceBridgeAgentOptions) {
  const entry = createVoiceBridgeJobHandler(options);
  return defineAgent({ entry: (ctx) => entry(ctx as unknown as JobContextLike) });
}
