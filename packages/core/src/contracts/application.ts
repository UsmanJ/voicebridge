import { VoiceBridgeError } from '../errors.ts';
import type { ExecutionMode } from '../observability.ts';
import { type ToolDefinition, ToolRegistry } from '../tools/registry.ts';
import { type SessionContext, type SessionEndReason, applicationIdSchema } from './session.ts';
import type { BackendReply, SessionStartResult, UserTurn } from './turn.ts';

/** Backend-controlled mode: the application decides what is said for each turn. */
export interface ConversationAdapter {
  /**
   * Returns the approved reply for a turn. Must honour `signal`: it aborts when a newer turn
   * supersedes this one, on timeout, or when the session ends. The request may still have been
   * processed, so treat `turnId` as an idempotency key.
   */
  respond(turn: UserTurn, ctx: SessionContext, signal: AbortSignal): Promise<BackendReply>;
  /**
   * Session start and authorization. Resolve with `{ authorized: true, greeting? }` only after
   * verifying `ctx.sessionRef` against a trusted, active, server-stored binding for
   * `ctx.applicationId` (and `ctx.runtimeBinding.roomName`, when present). Reject otherwise.
   *
   * Optional in the core. Runtime adapters may require it (the LiveKit adapter does, and fails
   * closed). Must be idempotent: the same session may be started more than once.
   */
  start?(ctx: SessionContext, signal: AbortSignal): Promise<SessionStartResult>;
  /** Optional best-effort notification that the session ended. */
  end?(ctx: SessionContext, reason: SessionEndReason): Promise<void>;
}

/**
 * One application bound to one backend. Every capability is optional: implement only the modes
 * you use.
 */
export interface Application {
  readonly applicationId: string;
  /** Required for backend-controlled mode. */
  readonly conversation?: ConversationAdapter;
  /** Required (non-empty) for agent-controlled mode. This is the tool allowlist. */
  readonly tools?: ToolRegistry;
}

export interface ApplicationInput {
  applicationId: string;
  conversation?: ConversationAdapter;
  tools?: ToolRegistry | readonly ToolDefinition[];
}

/** Validates and freezes an application definition. */
export function defineApplication(input: ApplicationInput): Application {
  if (!applicationIdSchema.safeParse(input.applicationId).success) {
    throw new VoiceBridgeError('config_error', 'invalid applicationId');
  }
  const tools =
    input.tools === undefined
      ? undefined
      : input.tools instanceof ToolRegistry
        ? input.tools
        : ToolRegistry.from(input.tools);
  if (!input.conversation && (!tools || tools.size === 0)) {
    throw new VoiceBridgeError(
      'config_error',
      `application "${input.applicationId}" implements no capabilities (needs a conversation adapter or tools)`,
    );
  }
  return Object.freeze({
    applicationId: input.applicationId,
    ...(input.conversation ? { conversation: input.conversation } : {}),
    ...(tools ? { tools } : {}),
  });
}

/** The execution modes an application supports, derived from its capabilities. */
export function supportedModes(app: Application): ExecutionMode[] {
  const modes: ExecutionMode[] = [];
  if (app.conversation) modes.push('backend-controlled');
  if (app.tools && app.tools.size > 0) modes.push('agent-controlled');
  return modes;
}

/** Throws `mode_not_supported` at startup if the application lacks the required capability. */
export function assertModeSupported(app: Application, mode: ExecutionMode): void {
  if (!supportedModes(app).includes(mode)) {
    throw new VoiceBridgeError(
      'mode_not_supported',
      `application "${app.applicationId}" does not support ${mode} mode`,
    );
  }
}

/**
 * Cross-application guard. A session may only run against the application it was minted for.
 * `applicationId` in the session context comes from trusted server-side configuration.
 */
export function assertSameApplication(app: Application, ctx: SessionContext): void {
  if (app.applicationId !== ctx.applicationId) {
    throw new VoiceBridgeError(
      'invalid_session_context',
      'session belongs to a different application',
    );
  }
}
