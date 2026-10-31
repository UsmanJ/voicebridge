import {
  type BackendReply,
  type ConversationAdapter,
  type SessionContext,
  type SessionStartResult,
  VoiceBridgeError,
  defineApplication,
} from '@voicebridge/core';
import { inMemoryConversation } from '@voicebridge/core/testing';
import type { VoiceBridgeAgentOptions } from '../src/agent.ts';
import type { VoiceBridgeLogger } from '../src/logger.ts';
import type {
  AgentSessionLike,
  JobContextLike,
  SdkBindings,
  SessionStartArgs,
  SpeechHandleLike,
  TextInputEventLike,
} from '../src/sdk-types.ts';

export const APP_ID = 'help-desk';
export const SESSION_REF = 'sr_synthetic_session_0001';
export const ROOM = 'vb_syntheticRoom0000000001';
export const SECRET_TRANSCRIPT = 'my account number is 99887766';
export const SECRET_REPLY = 'Your balance is 4,321 pounds';

export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

export function metadata(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ vb: 0, applicationId: APP_ID, sessionRef: SESSION_REF, ...overrides });
}

/** Ordered log of everything the job did, to prove ordering (verification before audio). */
export type Step =
  | 'verify:start'
  | 'verify:end'
  | 'createSession'
  | 'createAgent'
  | 'session.start'
  | 'connect'
  | 'shutdown';

export class FakeJob implements JobContextLike {
  readonly steps: Step[];
  readonly shutdownReasons: string[] = [];
  readonly shutdownCallbacks: Array<() => Promise<void>> = [];
  readonly room = { fake: 'room' };
  connectError: Error | undefined;
  job: { id: string; metadata: string; room?: { name: string } };

  constructor(steps: Step[], job: Partial<FakeJob['job']> = {}) {
    this.steps = steps;
    this.job = { id: 'AJ_synthetic1', metadata: metadata(), room: { name: ROOM }, ...job };
  }
  async connect() {
    this.steps.push('connect');
    if (this.connectError) throw this.connectError;
  }
  shutdown(reason?: string) {
    this.steps.push('shutdown');
    this.shutdownReasons.push(reason ?? '');
  }
  addShutdownCallback(cb: () => Promise<void>) {
    this.shutdownCallbacks.push(cb);
  }
  async runShutdownCallbacks() {
    for (const cb of this.shutdownCallbacks) await cb();
  }
}

export class FakeSpeech implements SpeechHandleLike {
  interrupted = false;
  readonly text: string;
  #resolve!: () => void;
  #reject!: (e: unknown) => void;
  readonly #done: Promise<void>;
  constructor(text: string, autoFinish: boolean) {
    this.text = text;
    this.#done = new Promise((res, rej) => {
      this.#resolve = res;
      this.#reject = rej;
    });
    if (autoFinish) queueMicrotask(() => this.#resolve());
  }
  waitForPlayout() {
    return this.#done;
  }
  finish() {
    this.#resolve();
  }
  interrupt() {
    this.interrupted = true;
    this.#resolve();
  }
  fail(error: unknown) {
    this.#reject(error);
  }
}

export class FakeAgentSession implements AgentSessionLike {
  readonly listeners = new Map<string, Array<(e: unknown) => void>>();
  readonly speeches: FakeSpeech[] = [];
  readonly shutdowns: Array<{ drain?: boolean; reason?: string }> = [];
  startArgs: SessionStartArgs | undefined;
  startError: Error | undefined;
  sayError: Error | undefined;
  interruptRejects = false;
  interruptCalls = 0;
  autoFinish = true;
  readonly #steps: Step[];
  constructor(steps: Step[]) {
    this.#steps = steps;
  }

  async start(args: SessionStartArgs) {
    this.#steps.push('session.start');
    this.startArgs = args;
    if (this.startError) throw this.startError;
  }
  say(text: string): SpeechHandleLike {
    if (this.sayError) throw this.sayError;
    const speech = new FakeSpeech(text, this.autoFinish);
    this.speeches.push(speech);
    return speech;
  }
  interrupt() {
    this.interruptCalls++;
    for (const s of this.speeches) if (!s.interrupted) s.interrupt();
    return {
      await: this.interruptRejects
        ? Promise.reject(new Error('uninterruptible'))
        : Promise.resolve(),
    };
  }
  shutdown(options?: { drain?: boolean; reason?: string }) {
    this.shutdowns.push(options ?? {});
  }
  on(event: string, listener: (e: unknown) => void) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }
  emit(event: string, payload: unknown) {
    for (const l of this.listeners.get(event) ?? []) l(payload);
  }
  get spoken() {
    return this.speeches.map((s) => s.text);
  }
  /** Simulates the user typing (only possible when text input is enabled). */
  type(text: string) {
    const cb = this.startArgs?.inputOptions.textInputCallback;
    if (!cb) throw new Error('text input is disabled');
    cb(this, { text } satisfies TextInputEventLike);
  }
}

export const EVENTS = { userInputTranscribed: 'uit', close: 'close', error: 'error' } as const;

export function fakeSdk(steps: Step[]) {
  const session = new FakeAgentSession(steps);
  let onUserTurn: ((t: string) => void) | undefined;
  const bindings: SdkBindings & { createSessionError?: Error } = {
    createSession() {
      steps.push('createSession');
      if (bindings.createSessionError) throw bindings.createSessionError;
      return session;
    },
    createAgent(cb) {
      steps.push('createAgent');
      onUserTurn = cb;
      return { fakeAgent: true };
    },
    events: EVENTS,
  };
  return {
    bindings,
    session,
    /** The SDK's end-of-turn hook delivering a final transcript. Returns what the hook returned. */
    userSays(text: string): unknown {
      session.emit(EVENTS.userInputTranscribed, { transcript: text, isFinal: true });
      if (!onUserTurn) throw new Error('agent not created');
      return onUserTurn(text);
    },
  };
}

/** A server-side binding store, as a correct application backend would keep it. */
export interface StoredBinding {
  applicationId: string;
  roomName?: string;
  status: 'active' | 'revoked';
  expiresAt: number;
}

export function bindingStore(initial: Record<string, StoredBinding> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    /** Correct authorization logic for `sessions/start`. Rejects unless every check passes. */
    async authorize(ctx: SessionContext): Promise<SessionStartResult> {
      const b = store.get(ctx.sessionRef);
      const reject = (why: string) => {
        throw new VoiceBridgeError('backend_rejected', `session start rejected: ${why}`);
      };
      if (!b) reject('unknown');
      if (b!.status !== 'active') reject('revoked');
      if (b!.expiresAt <= Date.now()) reject('expired');
      if (b!.applicationId !== ctx.applicationId) reject('application');
      if (b!.roomName !== undefined && b!.roomName !== ctx.runtimeBinding?.roomName) reject('room');
      return { authorized: true, greeting: { kind: 'speak', text: 'Welcome to the help desk.' } };
    },
  };
}

export function activeBinding(over: Partial<StoredBinding> = {}): StoredBinding {
  return {
    applicationId: APP_ID,
    roomName: ROOM,
    status: 'active',
    expiresAt: Date.now() + 60_000,
    ...over,
  };
}

export function recordingLogger() {
  const lines: string[] = [];
  const logger: VoiceBridgeLogger = {
    warn: (m, f) => lines.push(JSON.stringify({ level: 'warn', m, ...f })),
    error: (m, f) => lines.push(JSON.stringify({ level: 'error', m, ...f })),
  };
  return { lines, logger };
}

export function options(
  conversation: ConversationAdapter,
  over: Partial<VoiceBridgeAgentOptions> = {},
): VoiceBridgeAgentOptions {
  return {
    application: defineApplication({ applicationId: APP_ID, conversation }),
    mode: 'backend-controlled',
    providers: {
      stt: { model: 'assemblyai/universal-3-6-pro', language: 'en' },
      tts: { model: 'fishaudio/s2.1-pro' },
    },
    verificationTimeoutMs: 200,
    ...over,
  };
}

/** A conversation whose start is the binding store's authorize, and whose turns reply via `respond`. */
export function conversation(
  respond: Parameters<typeof inMemoryConversation>[0],
  authorize: (ctx: SessionContext, signal: AbortSignal) => Promise<SessionStartResult>,
) {
  return inMemoryConversation(respond, { start: authorize });
}

export type { BackendReply };
