/**
 * Structural views of the LiveKit Agents surface this adapter uses (`@livekit/agents` 1.9.x).
 * The real SDK objects satisfy them (see `sdk.ts`). Tests supply fakes, so the orchestration
 * logic can be verified without network, audio, or credentials.
 */

/** Subset of `voice.SpeechHandle`. */
export interface SpeechHandleLike {
  readonly interrupted: boolean;
  waitForPlayout(): Promise<void>;
}

export interface TextInputEventLike {
  readonly text: string;
}

export interface SessionStartArgs {
  agent: unknown;
  room: unknown;
  /** Always passed explicitly. Defaults to `false` (no audio, transcript, traces, or logs upload). */
  record: false | RecordingOptionsLike;
  inputOptions: {
    textEnabled: boolean;
    textInputCallback?: (session: unknown, event: TextInputEventLike) => void;
  };
}

/** Explicit opt-in recording categories (mirrors `voice.RecordingOptions`). */
export interface RecordingOptionsLike {
  audio?: boolean;
  transcript?: boolean;
  traces?: boolean;
  logs?: boolean;
  redaction?: boolean;
}

/** Subset of `voice.AgentSession`. */
export interface AgentSessionLike {
  start(args: SessionStartArgs): Promise<void>;
  say(text: string, options: { allowInterruptions: boolean }): SpeechHandleLike;
  interrupt(options?: { force?: boolean }): unknown;
  shutdown(options?: { drain?: boolean; reason?: string }): void;
  on(event: string, listener: (event: unknown) => void): unknown;
}

/** Subset of `JobContext`. Every field read before verification is server-minted. */
export interface JobContextLike {
  readonly job: {
    readonly id: string;
    readonly metadata: string;
    readonly room?: { readonly name: string } | undefined;
  };
  readonly room: unknown;
  connect(): Promise<void>;
  shutdown(reason?: string): void;
  addShutdownCallback(callback: () => Promise<void>): void;
}

/** Factory functions bound to the real SDK in production and to fakes in tests. */
export interface SdkBindings {
  /** Creates STT/TTS/turn detection and the session (no LLM). Called only after verification. */
  createSession(): AgentSessionLike;
  /** Creates an agent whose end-of-turn hook forwards the final transcript and returns immediately. */
  createAgent(onUserTurn: (transcript: string) => void): unknown;
  /** SDK event names. */
  readonly events: {
    readonly userInputTranscribed: string;
    readonly close: string;
    readonly error: string;
  };
}
