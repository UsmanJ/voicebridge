/**
 * Runtime port (version 0.x, **unstable**).
 *
 * The minimal surface a voice runtime adapter (for example LiveKit Agents) implements so that the
 * provider-neutral core can drive it. It deliberately excludes media transport, STT/LLM/TTS
 * provider configuration, and LLM orchestration: those belong to the runtime.
 *
 * Everything except callbacks and handles is plain data, so the shape could later be carried
 * over a socket.
 */
import type { SessionContext, SessionEndReason } from '../contracts/session.ts';
import type { TurnSource } from '../contracts/turn.ts';

/** What a runtime can do. The core degrades explicitly when a capability is missing. */
export interface RuntimeCapabilities {
  /** `none`: speech can't be stopped. `programmatic`: the core can stop it. `barge-in`: the user's voice also stops it. */
  readonly interruption: 'none' | 'programmatic' | 'barge-in';
  /** The runtime can deliver typed user input. */
  readonly textInput: boolean;
  /** The runtime signals a final transcript before the turn is committed (enables the hold rule). */
  readonly pendingTurnSignal: boolean;
  /** `speak` could accept incremental text (unused by the core in 0.x). */
  readonly streamingSpeech: boolean;
  /** The session context comes from a server-minted, trusted channel. Required to run sessions. */
  readonly trustedSessionContext: boolean;
  /** The runtime's LLM can invoke registered tools (agent-controlled mode). */
  readonly nativeToolCalling: boolean;
}

export interface SpeechHandle {
  /** Resolves when playout ends. `interrupted` is true if it was cut short. */
  readonly done: Promise<{ interrupted: boolean }>;
}

/** Implemented by a runtime adapter for one live session. */
export interface RuntimeSession {
  readonly capabilities: RuntimeCapabilities;
  /** Trusted session context (validated by the core before use). */
  readonly context: SessionContext;
  /** Speaks text verbatim. */
  speak(text: string): SpeechHandle;
  /** Stops current speech, if the runtime supports it. */
  interrupt(): void;
  /** Ends the session from the agent side. */
  end(reason: SessionEndReason): Promise<void>;
}

/** Implemented by the core. The runtime adapter calls these from its SDK events. */
export interface RuntimeEvents {
  /** A committed user turn. The core returns immediately and handles the turn asynchronously. */
  onUserTurn(input: { text: string; source: TurnSource }): void;
  /** A final transcript arrived but the turn isn't committed yet. Only if `pendingTurnSignal`. */
  onFinalTranscriptPending(): void;
  /** The session ended on the runtime side (for example, the user left). */
  onEnded(reason: SessionEndReason): void;
}
