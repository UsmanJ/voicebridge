'use client';

import {
  type AgentState,
  BarVisualizer,
  RoomAudioRenderer,
  SessionProvider,
  StartAudio,
  useAgent,
  useSession,
  useSessionMessages,
  useTrackToggle,
} from '@livekit/components-react';
import {
  ConnectionState,
  DisconnectReason,
  ParticipantKind,
  type Room,
  RoomEvent,
  TokenSource,
  type TokenSourceResponseObject,
  Track,
} from 'livekit-client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AGENT_JOIN_TIMEOUT_MS, CONNECT_TIMEOUT_MS, MAX_TYPED_MESSAGE_LENGTH } from '../config';
import type { DemoApplication } from '../demo-app';
import { type UserFacingError, toUserFacingError, userError } from '../errors';
import { deriveStatus } from '../status';
import { type FailedSend, buildTranscript, isAwaitingReply } from '../transcript';
import { Composer } from './Composer';
import { StatusIndicator } from './StatusIndicator';
import { Transcript } from './Transcript';

/** How the conversation ended. Exactly one of these is reported, exactly once. */
export type SessionOutcome =
  { kind: 'user_ended' } | { kind: 'agent_ended' } | { kind: 'error'; error: UserFacingError };

/** "Processing" is shown at most this long if the backend chose not to answer a turn. */
const AWAITING_REPLY_MAX_MS = 10_000;
/**
 * How long the agent must be gone, with the room connected, before the conversation counts as
 * ended by the agent. Covers the moment between the SDK dropping participants for a full
 * reconnect and the room reporting Reconnecting.
 */
const AGENT_GONE_GRACE_MS = 2_000;

function agentInRoom(room: Room): boolean {
  for (const p of room.remoteParticipants.values()) {
    if (p.kind === ParticipantKind.AGENT) return true;
  }
  return false;
}

/** Whether an agent participant is in the room right now, from room events. */
function useAgentPresent(room: Room): boolean {
  const [present, setPresent] = useState(() => agentInRoom(room));
  useEffect(() => {
    const update = () => setPresent(agentInRoom(room));
    const events = [
      RoomEvent.ParticipantConnected,
      RoomEvent.ParticipantDisconnected,
      RoomEvent.Reconnected,
      RoomEvent.ConnectionStateChanged,
    ] as const;
    for (const e of events) room.on(e, update);
    update();
    return () => {
      for (const e of events) room.off(e, update);
    };
  }, [room]);
  return present;
}

export interface ConversationSessionProps {
  /** Credentials for exactly this conversation. Never reused: a new conversation remounts. */
  credentials: TokenSourceResponseObject;
  app: DemoApplication;
  onEnded: (outcome: SessionOutcome) => void;
}

/**
 * One voice conversation, from connecting to ending. Mounted when the user clicks Start (after
 * fresh credentials were issued) and unmounted when it ends, so all conversation state (room,
 * transcript, failed sends) is discarded with it.
 */
export function ConversationSession({ credentials, app, onEnded }: ConversationSessionProps) {
  // A fixed token source: the SDK never fetches on its own (on mount, on end, or on reconnect).
  // useSession would otherwise refetch credentials on mount (prepareConnection), on end(), and on
  // unexpected disconnect, and each fetch creates a new backend session.
  const tokenSource = useMemo(() => TokenSource.literal(credentials), [credentials]);
  const session = useSession(tokenSource, {
    agentConnectTimeoutMilliseconds: AGENT_JOIN_TIMEOUT_MS,
  });
  const agent = useAgent(session);
  const { messages, send, isSending } = useSessionMessages(session);
  const agentPresent = useAgentPresent(session.room);

  const [connected, setConnected] = useState(false);
  const [failedSends, setFailedSends] = useState<FailedSend[]>([]);
  const [messageError, setMessageError] = useState<UserFacingError | null>(null);
  const [ending, setEnding] = useState(false);

  // One controller per conversation: aborts connecting on End, timeout, or unmount.
  const [controller] = useState(() => new AbortController());
  const startedRef = useRef(false);
  const endedRef = useRef(false);
  const agentWasConnectedRef = useRef(false);
  const unmountTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const failedIdRef = useRef(0);

  const sessionRef = useRef(session);
  const onEndedRef = useRef(onEnded);
  useEffect(() => {
    sessionRef.current = session;
    onEndedRef.current = onEnded;
  });

  /** Ends the conversation once: aborts connecting, disconnects (stopping the mic), reports. */
  const finish = useCallback(
    (outcome: SessionOutcome) => {
      if (endedRef.current) return;
      endedRef.current = true;
      setEnding(true);
      controller.abort();
      void sessionRef.current
        .end()
        .catch(() => {})
        .finally(() => onEndedRef.current(outcome));
    },
    [controller],
  );

  // Start exactly once per mount. React Strict Mode runs effects twice in development; the ref
  // guard makes the second run a no-op, and the deferred abort below only fires on a real unmount.
  useEffect(() => {
    clearTimeout(unmountTimerRef.current);
    if (!startedRef.current) {
      startedRef.current = true;
      const timer = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS);
      sessionRef.current
        .start({
          signal: controller.signal,
          tracks: { microphone: { enabled: true, publishOptions: { preConnectBuffer: true } } },
        })
        .then(() => {
          clearTimeout(timer);
          if (!endedRef.current) setConnected(true);
        })
        .catch((error: unknown) => {
          clearTimeout(timer);
          if (endedRef.current) return;
          finish({
            kind: 'error',
            error: controller.signal.aborted ? userError('timeout') : toUserFacingError(error),
          });
        });
    }
    return () => {
      unmountTimerRef.current = setTimeout(() => {
        endedRef.current = true;
        controller.abort();
      }, 0);
    };
  }, [controller, finish]);

  // The agent never joining (SDK timeout) is an error.
  useEffect(() => {
    if (agent.state === 'failed' && !agentWasConnectedRef.current) {
      finish({ kind: 'error', error: userError('agent_unavailable') });
    }
  }, [agent.state, finish]);

  // The agent leaving after it joined means the backend ended the conversation (goodbye, or the
  // session was revoked/expired at its next turn). This is decided from presence and room state,
  // not from useAgent's 'failed' state: during a full reconnect the SDK removes every remote
  // participant before it reports Reconnecting, and useAgent then stays 'failed' even after the
  // agent is back (observed with @livekit/components-react 2.9.24).
  const roomState = session.connectionState;
  useEffect(() => {
    if (agentPresent) {
      agentWasConnectedRef.current = true;
      return;
    }
    if (!agentWasConnectedRef.current || roomState !== ConnectionState.Connected) return;
    const t = setTimeout(() => {
      const room = sessionRef.current.room;
      if (room.state === ConnectionState.Connected && !agentInRoom(room)) {
        finish({ kind: 'agent_ended' });
      }
    }, AGENT_GONE_GRACE_MS);
    return () => clearTimeout(t);
  }, [agentPresent, roomState, finish]);

  // Unexpected disconnects (network loss, room closed by the server).
  useEffect(() => {
    const room = session.room;
    const onDisconnected = (reason?: DisconnectReason) => {
      if (endedRef.current || reason === DisconnectReason.CLIENT_INITIATED) return;
      finish(
        agentWasConnectedRef.current &&
          (reason === DisconnectReason.ROOM_DELETED ||
            reason === DisconnectReason.PARTICIPANT_REMOVED)
          ? { kind: 'agent_ended' }
          : { kind: 'error', error: userError('connection_lost') },
      );
    };
    room.on(RoomEvent.Disconnected, onDisconnected);
    return () => {
      room.off(RoomEvent.Disconnected, onDisconnected);
    };
  }, [session.room, finish]);

  const localIdentity = session.room.localParticipant?.identity;
  const entries = useMemo(
    () => buildTranscript(messages, localIdentity, failedSends),
    [messages, localIdentity, failedSends],
  );

  // "Processing" between the end of a user turn and the start of the agent's reply, capped.
  const lastId = entries.at(-1)?.id;
  const [staleId, setStaleId] = useState<string | undefined>(undefined);
  const awaiting = isAwaitingReply(entries) && staleId !== lastId;
  useEffect(() => {
    if (!awaiting) return;
    const t = setTimeout(() => setStaleId(lastId), AWAITING_REPLY_MAX_MS);
    return () => clearTimeout(t);
  }, [awaiting, lastId]);

  const sendTyped = useCallback(
    async (text: string) => {
      const value = text.slice(0, MAX_TYPED_MESSAGE_LENGTH);
      setMessageError(null);
      try {
        // useSessionMessages().send publishes on the lk.chat text stream topic. The worker
        // handles it through the same backend adapter as speech (POST /v0/turns).
        await send(value);
      } catch {
        failedIdRef.current += 1;
        const localId = `failed-${failedIdRef.current}`;
        setFailedSends((prev) => [...prev, { localId, text: value }]);
        setMessageError(userError('message_failed'));
        throw new Error('not sent');
      }
    },
    [send],
  );

  // Work around the sticky 'failed' state after a full reconnect: if the agent is back and the
  // room is connected, read its published state attribute directly.
  const reconnecting =
    roomState === ConnectionState.Reconnecting || roomState === ConnectionState.SignalReconnecting;
  // Once connected (start() resolves only after the agent joined), a missing agent is shown as
  // disconnected while the grace period decides whether the conversation ended.
  const agentState: AgentState =
    agent.state !== 'failed' || !connected
      ? agent.state
      : agentPresent && roomState === ConnectionState.Connected
        ? ((agent.attributes?.['lk.agent.state'] as AgentState | undefined) ?? 'listening')
        : 'disconnected';
  const status = ending
    ? 'disconnected'
    : reconnecting
      ? 'connecting'
      : deriveStatus(agentState, awaiting);

  return (
    <SessionProvider session={session}>
      <RoomAudioRenderer />
      <div className="panel">
        <div className="panel-top">
          <StatusIndicator status={status} />
          <BarVisualizer
            className="visualizer"
            state={agentState}
            track={agent.microphoneTrack}
            barCount={7}
            aria-hidden="true"
          />
        </div>
        <StartAudio className="start-audio" label="Allow audio playback" />
        <div className="controls">
          <MicrophoneToggle disabled={!connected || ending} />
          <button
            type="button"
            className="danger"
            onClick={() => finish({ kind: 'user_ended' })}
            disabled={ending}
          >
            End Conversation
          </button>
        </div>
        {messageError ? (
          <p className="notice notice-error" role="alert">
            {messageError.message}
          </p>
        ) : null}
        <Transcript entries={entries} />
        <Composer
          onSend={sendTyped}
          prompts={app.examplePrompts}
          disabled={!connected || ending}
          sending={isSending}
        />
      </div>
    </SessionProvider>
  );
}

function MicrophoneToggle({ disabled }: { disabled: boolean }) {
  const { toggle, enabled, pending } = useTrackToggle({ source: Track.Source.Microphone });
  return (
    <button
      type="button"
      aria-pressed={!enabled}
      disabled={disabled || pending}
      onClick={() => void Promise.resolve(toggle()).catch(() => {})}
    >
      {enabled ? 'Mute microphone' : 'Unmute microphone'}
    </button>
  );
}
