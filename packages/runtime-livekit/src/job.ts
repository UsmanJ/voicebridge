import {
  type Application,
  type BackendControlledOptions,
  type BackendControlledSession,
  type Observer,
  type SessionEndReason,
  runBackendControlledSession,
} from '@voicebridge/core';
import { type VoiceBridgeLogger, errorName } from './logger.ts';
import { createLiveKitRuntimeSession } from './runtime-session.ts';
import type { JobContextLike, RecordingOptionsLike, SdkBindings } from './sdk-types.ts';
import { verifyLiveKitSession } from './verification.ts';

export interface JobConfig {
  application: Application;
  verificationTimeoutMs: number;
  textInput: boolean;
  recording: false | RecordingOptionsLike;
  session: Pick<BackendControlledOptions, 'timeoutMs' | 'fallbackText' | 'pendingTurnHoldMs'>;
  logger: VoiceBridgeLogger;
  observer?: Observer;
}

export type JobOutcome =
  | { status: 'rejected'; reason: string }
  | { status: 'failed'; reason: 'session_create_failed' | 'session_start_failed' }
  | { status: 'running' };

/** Maps an SDK close reason onto a VoiceBridge end reason. */
function endReasonFor(reason: unknown): SessionEndReason {
  switch (reason) {
    case 'participant_disconnected':
      return 'client_left';
    case 'error':
      return 'runtime_error';
    case 'job_shutdown':
      return 'shutdown';
    default:
      return 'shutdown';
  }
}

/**
 * Runs one LiveKit job in backend-controlled mode.
 *
 * Order matters for security. Nothing that touches audio, providers, or application logic runs
 * until `verifyLiveKitSession` has succeeded:
 * 1. verify → on failure, shut the job down **without connecting** and return
 * 2. create the session (STT/TTS/turn detection, no LLM)
 * 3. start it (explicit `record`) and connect to the room
 * 4. hand turns to the core coordinator
 */
export async function runVoiceBridgeJob(
  ctx: JobContextLike,
  sdk: SdkBindings,
  config: JobConfig,
): Promise<JobOutcome> {
  const { logger } = config;
  const jobId = ctx.job.id;

  // 1. Verify. No connection, no audio, no providers yet.
  const verification = await verifyLiveKitSession({
    job: ctx.job,
    application: config.application,
    timeoutMs: config.verificationTimeoutMs,
  });
  if (!verification.ok) {
    logger.warn('session rejected before connecting', { jobId, reason: verification.reason });
    ctx.shutdown(`voicebridge:${verification.reason}`);
    return { status: 'rejected', reason: verification.reason };
  }

  // 2. Create the voice pipeline (no LLM).
  let session: ReturnType<SdkBindings['createSession']>;
  try {
    session = sdk.createSession();
  } catch (error) {
    logger.error('voice session could not be created', { jobId, error: errorName(error) });
    ctx.shutdown('voicebridge:session_create_failed');
    return { status: 'failed', reason: 'session_create_failed' };
  }

  const runtime = createLiveKitRuntimeSession({
    session,
    context: verification.context,
    textInput: config.textInput,
    shutdownJob: (reason) => ctx.shutdown(reason),
    logger,
  });

  // Turns that arrive before the core session exists are queued, never dropped or processed early.
  const state: { core?: BackendControlledSession } = {};
  const queued: Array<{ text: string; source: 'speech' | 'text' }> = [];
  const forwardTurn = (turn: { text: string; source: 'speech' | 'text' }) => {
    try {
      if (state.core) state.core.onUserTurn(turn);
      else queued.push(turn);
    } catch (error) {
      logger.error('turn could not be handled', { jobId, error: errorName(error) });
    }
  };

  // End-of-turn hook: forwards the final transcript and returns immediately (the SDK serializes
  // these hooks, so awaiting the backend here would block later turns).
  const agent = sdk.createAgent((transcript) =>
    forwardTurn({ text: transcript, source: 'speech' }),
  );

  session.on(sdk.events.userInputTranscribed, (event) => {
    if ((event as { isFinal?: boolean } | undefined)?.isFinal)
      state.core?.onFinalTranscriptPending();
  });
  session.on(sdk.events.close, (event) => {
    state.core?.onEnded(endReasonFor((event as { reason?: unknown } | undefined)?.reason));
  });
  session.on(sdk.events.error, (event) => {
    const error = (event as { error?: unknown } | undefined)?.error;
    logger.error('voice session error', { jobId, error: errorName(error) });
  });

  const inputOptions: Parameters<typeof session.start>[0]['inputOptions'] = config.textInput
    ? {
        textEnabled: true,
        // Custom callback: the SDK's default calls generateReply(), which throws without an LLM.
        // It also replaces the default's interruption, so stop current speech first.
        textInputCallback: (_session, event) => {
          runtime.interrupt();
          forwardTurn({ text: event.text, source: 'text' });
        },
      }
    : { textEnabled: false };

  // 3. Start the pipeline with recording explicitly off (unless opted in), then connect.
  try {
    await session.start({ agent, room: ctx.room, record: config.recording, inputOptions });
  } catch (error) {
    logger.error('voice session failed to start', { jobId, error: errorName(error) });
    ctx.shutdown('voicebridge:session_start_failed');
    return { status: 'failed', reason: 'session_start_failed' };
  }

  // 4. The core owns turn coordination, cancellation, and stale-reply protection.
  const core = runBackendControlledSession(runtime, config.application, {
    ...config.session,
    startResult: verification.startResult,
    ...(config.observer ? { observer: config.observer } : {}),
  });
  state.core = core;
  for (const turn of queued.splice(0)) core.onUserTurn(turn);

  ctx.addShutdownCallback(async () => {
    await core.close('shutdown').catch(() => {});
  });

  try {
    await ctx.connect();
  } catch (error) {
    logger.error('room connection failed', { jobId, error: errorName(error) });
    await core.close('runtime_error').catch(() => {});
    ctx.shutdown('voicebridge:connect_failed');
    return { status: 'failed', reason: 'session_start_failed' };
  }
  return { status: 'running' };
}
