import type { SessionContext, SessionEndReason } from '../contracts/session.ts';
import type {
  RuntimeCapabilities,
  RuntimeEvents,
  RuntimeSession,
  SpeechHandle,
} from '../runtime/port.ts';

export const ALL_CAPABILITIES: RuntimeCapabilities = Object.freeze({
  interruption: 'barge-in',
  textInput: true,
  pendingTurnSignal: true,
  streamingSpeech: false,
  trustedSessionContext: true,
  nativeToolCalling: true,
});

export interface FakeRuntimeOptions {
  /** Trusted context the fake runtime presents. Passed through unvalidated (the core validates it). */
  context: SessionContext;
  capabilities?: Partial<RuntimeCapabilities>;
  /** If false, speech stays "playing" until `finishSpeech()` or `bargeIn()`. Default true. */
  autoFinishSpeech?: boolean;
}

export interface FakeSpeech {
  readonly text: string;
  interrupted: boolean;
  finished: boolean;
}

/**
 * An in-memory runtime with no media, network, or vendor SDK. It simulates user turns, typed
 * text, pending transcripts, barge-in, and session end, and records everything the core asks it
 * to say.
 */
export class FakeRuntime {
  readonly session: RuntimeSession;
  readonly speeches: FakeSpeech[] = [];
  readonly endCalls: SessionEndReason[] = [];
  /** `speak()` calls received after the session ended (should stay 0). */
  speakCallsAfterEnd = 0;

  #events: RuntimeEvents | undefined;
  #ended = false;
  readonly #autoFinish: boolean;
  readonly #pending = new Map<FakeSpeech, (r: { interrupted: boolean }) => void>();
  readonly #waiters: Array<{ count: number; resolve: () => void }> = [];

  constructor(options: FakeRuntimeOptions) {
    this.#autoFinish = options.autoFinishSpeech ?? true;
    const capabilities = Object.freeze({ ...ALL_CAPABILITIES, ...options.capabilities });
    this.session = {
      capabilities,
      context: options.context,
      speak: (text) => this.#speak(text),
      interrupt: () => {
        if (capabilities.interruption !== 'none') this.#interruptAll();
      },
      end: async (reason) => {
        this.endCalls.push(reason);
        this.#ended = true;
      },
    };
  }

  /** Connects the core's event handlers (what a real adapter does with SDK events). */
  attach(events: RuntimeEvents): this {
    this.#events = events;
    return this;
  }

  /** A committed spoken turn. */
  userSays(text: string): void {
    this.#requireEvents().onUserTurn({ text, source: 'speech' });
  }

  /** A typed message. */
  userTypes(text: string): void {
    this.#requireEvents().onUserTurn({ text, source: 'text' });
  }

  /** A final transcript arrived, but the runtime hasn't committed the turn yet. */
  finalTranscriptPending(): void {
    this.#requireEvents().onFinalTranscriptPending();
  }

  /** The user talks over the agent: current speech is interrupted (if supported). */
  bargeIn(): void {
    if (this.session.capabilities.interruption === 'barge-in') this.#interruptAll();
  }

  /** Completes all playing speech normally. */
  finishSpeech(): void {
    for (const [speech, resolve] of this.#pending) {
      speech.finished = true;
      resolve({ interrupted: false });
    }
    this.#pending.clear();
  }

  /** The session ends on the runtime side (for example, the user leaves). */
  end(reason: SessionEndReason = 'client_left'): void {
    this.#ended = true;
    this.#requireEvents().onEnded(reason);
  }

  get spoken(): string[] {
    return this.speeches.map((s) => s.text);
  }

  /** Resolves once at least `count` utterances have been spoken. Rejects after `timeoutMs`. */
  untilSpoken(count: number, timeoutMs = 2000): Promise<void> {
    if (this.speeches.length >= count) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`expected ${count} utterance(s), got ${this.speeches.length}`)),
        timeoutMs,
      );
      this.#waiters.push({
        count,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
      });
    });
  }

  #speak(text: string): SpeechHandle {
    if (this.#ended) this.speakCallsAfterEnd++;
    const speech: FakeSpeech = { text, interrupted: false, finished: false };
    this.speeches.push(speech);
    for (const w of [...this.#waiters]) {
      if (this.speeches.length >= w.count) {
        this.#waiters.splice(this.#waiters.indexOf(w), 1);
        w.resolve();
      }
    }
    const done = new Promise<{ interrupted: boolean }>((resolve) => {
      if (this.#autoFinish) {
        speech.finished = true;
        queueMicrotask(() => resolve({ interrupted: false }));
      } else {
        this.#pending.set(speech, resolve);
      }
    });
    return { done };
  }

  #interruptAll(): void {
    for (const [speech, resolve] of this.#pending) {
      speech.interrupted = true;
      resolve({ interrupted: true });
    }
    this.#pending.clear();
  }

  #requireEvents(): RuntimeEvents {
    if (!this.#events) throw new Error('FakeRuntime: call attach() with the core session first');
    return this.#events;
  }
}
