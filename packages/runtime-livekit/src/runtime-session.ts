import type {
  RuntimeCapabilities,
  RuntimeSession,
  SessionContext,
  SessionEndReason,
  SpeechHandle,
} from '@voicebridge/core';
import { type VoiceBridgeLogger, errorName } from './logger.ts';
import type { AgentSessionLike } from './sdk-types.ts';

/**
 * Capabilities verified against LiveKit Agents 1.9.5 in the M0.5 spikes (barge-in, custom text
 * callback, final-transcript signal, job metadata). Streaming speech is source-level only (not
 * exercised), so it's reported as unavailable. No LLM in backend-controlled mode, so no native
 * tool calling.
 */
export function liveKitCapabilities(textInput: boolean): RuntimeCapabilities {
  return Object.freeze({
    interruption: 'barge-in',
    textInput,
    pendingTurnSignal: true,
    streamingSpeech: false,
    trustedSessionContext: true,
    nativeToolCalling: false,
  });
}

export interface LiveKitRuntimeSessionOptions {
  session: AgentSessionLike;
  context: SessionContext;
  textInput: boolean;
  /** Ends the LiveKit job (`JobContext.shutdown`). */
  shutdownJob(reason: string): void;
  logger: VoiceBridgeLogger;
}

/** Maps the VoiceBridge runtime port onto a LiveKit `AgentSession`. */
export function createLiveKitRuntimeSession(options: LiveKitRuntimeSessionOptions): RuntimeSession {
  const { session, logger } = options;
  let ended = false;

  return {
    capabilities: liveKitCapabilities(options.textInput),
    context: options.context,

    speak(text): SpeechHandle {
      if (ended) return { done: Promise.resolve({ interrupted: true }) };
      try {
        const handle = session.say(text, { allowInterruptions: true });
        return {
          done: handle.waitForPlayout().then(
            () => ({ interrupted: handle.interrupted }),
            (error: unknown) => {
              logger.error('speech playout failed', { error: errorName(error) });
              return { interrupted: true };
            },
          ),
        };
      } catch (error) {
        logger.error('speech could not be started', { error: errorName(error) });
        return { done: Promise.resolve({ interrupted: true }) };
      }
    },

    interrupt() {
      try {
        const future = session.interrupt();
        // `interrupt()` returns a Future whose promise may reject (session not running, or
        // uninterruptible speech). Never leave it unhandled.
        const pending = (future as { await?: Promise<unknown> } | undefined)?.await;
        pending?.catch(() => {});
      } catch {
        // The session isn't running, or the current speech is uninterruptible: nothing to stop.
      }
    },

    async end(reason: SessionEndReason) {
      if (ended) return;
      ended = true;
      try {
        session.shutdown({ drain: true, reason });
      } catch (error) {
        logger.warn('session shutdown failed', { error: errorName(error) });
      }
      options.shutdownJob(`voicebridge:${reason}`);
    },
  };
}
