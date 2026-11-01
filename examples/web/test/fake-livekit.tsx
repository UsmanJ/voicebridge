// A controllable stand-in for the @livekit/components-react hooks used by the demo. Tests drive
// connection, agent state, and messages directly; nothing talks to LiveKit.
import type { AgentState, ReceivedMessage } from '@livekit/components-react';
import {
  ParticipantKind,
  type TokenSourceFixed,
  type TokenSourceResponseObject,
} from 'livekit-client';
import { type ReactNode, useState, useSyncExternalStore } from 'react';
import { vi } from 'vitest';

type Handler = (...args: unknown[]) => void;

export class FakeRoom {
  private handlers = new Map<string, Set<Handler>>();
  localParticipant = { identity: 'vbu_local_test' };
  remoteParticipants = new Map<string, { identity: string; kind: number }>();
  state: string = 'connected';
  on(event: string, h: Handler) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(h);
    return this;
  }
  off(event: string, h: Handler) {
    this.handlers.get(event)?.delete(h);
    return this;
  }
  emit(event: string, ...args: unknown[]) {
    for (const h of this.handlers.get(event) ?? []) h(...args);
  }
}

export interface StartCall {
  options: { signal?: AbortSignal; tracks?: unknown };
  resolve: () => void;
  reject: (error: unknown) => void;
}

export interface FakeSession {
  room: FakeRoom;
  tokenSource: TokenSourceFixed;
  starts: StartCall[];
  start: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  credentials: () => Promise<TokenSourceResponseObject>;
}

interface StoreState {
  connectionState: string;
  agentState: AgentState;
  messages: ReceivedMessage[];
  isSending: boolean;
  micEnabled: boolean;
  audioBlocked: boolean;
}

const initial = (): StoreState => ({
  connectionState: 'connected',
  agentState: 'connecting',
  messages: [],
  isSending: false,
  micEnabled: true,
  audioBlocked: false,
});

let state = initial();
const listeners = new Set<() => void>();

export const fake = {
  sessions: [] as FakeSession[],
  send: vi.fn<(text: string) => Promise<unknown>>(async () => ({})),
  get state() {
    return state;
  },
  set(patch: Partial<StoreState>) {
    state = { ...state, ...patch };
    for (const l of listeners) l();
  },
  reset() {
    state = initial();
    fake.sessions = [];
    fake.send = vi.fn(async () => ({}));
    for (const l of listeners) l();
  },
  /** Adds or removes the agent participant in the room, emitting the matching room event. */
  setAgentPresent(session: FakeSession, present: boolean) {
    if (present) {
      session.room.remoteParticipants.set('agent', {
        identity: 'agent-test',
        kind: ParticipantKind.AGENT,
      });
      session.room.emit('participantConnected');
    } else {
      session.room.remoteParticipants.delete('agent');
      session.room.emit('participantDisconnected');
    }
  },
  /** Sets the room connection state (room.state and the session's reactive connectionState). */
  setRoomState(session: FakeSession, value: string) {
    session.room.state = value;
    fake.set({ connectionState: value });
    session.room.emit('connectionStateChanged', value);
  },
  /** The session whose start() was actually called (Strict Mode may construct an extra one). */
  get started(): FakeSession[] {
    return fake.sessions.filter((s) => s.starts.length > 0);
  },
};

function useStore() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

function createSession(tokenSource: TokenSourceFixed): FakeSession {
  const room = new FakeRoom();
  const s: FakeSession = {
    room,
    tokenSource,
    starts: [],
    credentials: () => tokenSource.fetch(),
    start: vi.fn(
      (options: StartCall['options'] = {}) =>
        new Promise<void>((resolve, reject) => {
          s.starts.push({ options, resolve, reject });
          options.signal?.addEventListener('abort', () =>
            reject(new Error('useSession(/* ... */).waitUntilConnected - signal aborted')),
          );
        }),
    ),
    end: vi.fn(async () => {
      room.emit('disconnected', 1 /* CLIENT_INITIATED */);
    }),
  };
  fake.sessions.push(s);
  return s;
}

const CONNECTED: AgentState[] = ['listening', 'thinking', 'speaking'];

export const componentsReactMock = {
  useSession: (tokenSource: TokenSourceFixed) => {
    const [s] = useState(() => createSession(tokenSource));
    const st = useStore();
    return { ...s, connectionState: st.connectionState };
  },
  useAgent: () => {
    const st = useStore();
    return {
      attributes: { 'lk.agent.state': st.agentState === 'failed' ? 'listening' : st.agentState },
      state: st.agentState,
      isConnected: CONNECTED.includes(st.agentState),
      microphoneTrack: undefined,
    };
  },
  useSessionMessages: () => {
    const st = useStore();
    return { messages: st.messages, send: fake.send, isSending: st.isSending };
  },
  useTrackToggle: () => {
    const st = useStore();
    return {
      enabled: st.micEnabled,
      pending: false,
      toggle: async () => fake.set({ micEnabled: !state.micEnabled }),
    };
  },
  SessionProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  RoomAudioRenderer: () => null,
  BarVisualizer: () => <div data-testid="visualizer" />,
  StartAudio: ({ label }: { label: string }) => {
    const st = useStore();
    return st.audioBlocked ? (
      <button type="button" onClick={() => fake.set({ audioBlocked: false })}>
        {label}
      </button>
    ) : null;
  },
};

let seq = 0;
export function msg(
  type: ReceivedMessage['type'],
  message: string,
  extra: { id?: string; from?: string; final?: boolean } = {},
): ReceivedMessage {
  seq += 1;
  return {
    id: extra.id ?? `m${seq}`,
    timestamp: Date.now(),
    type,
    message,
    ...(extra.from ? { from: { identity: extra.from } as never } : {}),
    ...(extra.final !== undefined
      ? { attributes: { 'lk.transcription_final': String(extra.final) } }
      : {}),
  } as ReceivedMessage;
}
