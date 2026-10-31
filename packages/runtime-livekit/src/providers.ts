import { inference, stt as sttNs, tts as ttsNs, voice } from '@livekit/agents';
import { VoiceBridgeError } from '@voicebridge/core';
import type { AgentSessionLike, SdkBindings } from './sdk-types.ts';

/** LiveKit Inference model id, for example `assemblyai/universal-3-6-pro`. */
const MODEL_PATTERN = /^[a-z0-9][a-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const LANGUAGE_PATTERN = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const VOICE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** STT: a LiveKit Inference model, or any pre-constructed `stt.STT` (provider plugin). */
export type SttProvider = { model: string; language?: string } | sttNs.STT;
/** TTS: a LiveKit Inference model and voice, or any pre-constructed `tts.TTS`. */
export type TtsProvider = { model: string; voice?: string } | ttsNs.TTS;

export interface ProviderConfig {
  stt: SttProvider;
  tts: TtsProvider;
  /**
   * `livekit` (default): LiveKit's turn detector with the SDK's default VAD.
   * `stt`: end-of-turn from the STT provider, no VAD (coarser turns).
   */
  turnDetection?: 'livekit' | 'stt';
}

function isSttInstance(value: unknown): value is sttNs.STT {
  return value instanceof sttNs.STT;
}
function isTtsInstance(value: unknown): value is ttsNs.TTS {
  return value instanceof ttsNs.TTS;
}

/** Validates provider configuration at startup (no SDK objects are created here). */
export function validateProviders(config: ProviderConfig): ProviderConfig {
  if (!config || typeof config !== 'object') {
    throw new VoiceBridgeError('config_error', 'providers are required');
  }
  const { stt, tts, turnDetection } = config;
  if (!isSttInstance(stt)) {
    if (!stt || typeof stt.model !== 'string' || !MODEL_PATTERN.test(stt.model)) {
      throw new VoiceBridgeError('config_error', 'providers.stt.model must be "provider/model"');
    }
    if (stt.language !== undefined && !LANGUAGE_PATTERN.test(stt.language)) {
      throw new VoiceBridgeError('config_error', 'providers.stt.language is invalid');
    }
  }
  if (!isTtsInstance(tts)) {
    if (!tts || typeof tts.model !== 'string' || !MODEL_PATTERN.test(tts.model)) {
      throw new VoiceBridgeError('config_error', 'providers.tts.model must be "provider/model"');
    }
    if (tts.voice !== undefined && !VOICE_PATTERN.test(tts.voice)) {
      throw new VoiceBridgeError('config_error', 'providers.tts.voice is invalid');
    }
  }
  if (turnDetection !== undefined && turnDetection !== 'livekit' && turnDetection !== 'stt') {
    throw new VoiceBridgeError(
      'config_error',
      'providers.turnDetection must be "livekit" or "stt"',
    );
  }
  return config;
}

/**
 * Real LiveKit Agents bindings. Providers are instantiated inside `createSession`, which the job
 * calls only after the session is verified.
 */
export function createLiveKitSdkBindings(providers: ProviderConfig): SdkBindings {
  return {
    createSession(): AgentSessionLike {
      const stt = isSttInstance(providers.stt)
        ? providers.stt
        : new inference.STT({
            model: providers.stt.model as never,
            ...(providers.stt.language ? { language: providers.stt.language } : {}),
          });
      const tts = isTtsInstance(providers.tts)
        ? providers.tts
        : new inference.TTS({
            model: providers.tts.model as never,
            ...(providers.tts.voice ? { voice: providers.tts.voice } : {}),
          });
      const sttTurns = providers.turnDetection === 'stt';
      const session = new voice.AgentSession({
        stt,
        tts,
        ...(sttTurns ? { vad: null } : {}),
        turnHandling: {
          turnDetection: sttTurns ? 'stt' : new inference.TurnDetector(),
          // No LLM in backend-controlled mode, so preemptive generation must stay off.
          preemptiveGeneration: { enabled: false },
        },
      });
      return session as unknown as AgentSessionLike;
    },

    createAgent(onUserTurn) {
      return voice.Agent.create({
        // No LLM is configured. Instructions are required by the type and unused.
        instructions: '',
        onUserTurnCompleted(_ctx, _chatCtx, newMessage) {
          // Return immediately: the core handles the turn asynchronously.
          onUserTurn(newMessage.textContent ?? '');
        },
      });
    },

    events: {
      userInputTranscribed: voice.AgentSessionEventTypes.UserInputTranscribed,
      close: voice.AgentSessionEventTypes.Close,
      error: voice.AgentSessionEventTypes.Error,
    },
  };
}
