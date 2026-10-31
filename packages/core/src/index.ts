/**
 * @voicebridge/core: provider-neutral VoiceBridge core.
 *
 * Depends only on `zod`. Contains no voice-runtime, transport, or AI-provider code.
 */
export { RUNTIME_PORT_VERSION, WIRE_PROTOCOL_VERSION } from './version.ts';

export {
  ERROR_CODES,
  type PublicError,
  type VoiceBridgeErrorCode,
  type VoiceBridgeErrorOptions,
  VoiceBridgeError,
  isVoiceBridgeError,
  publicMessageFor,
  toVoiceBridgeError,
} from './errors.ts';

export {
  type BackendOperation,
  type EventInput,
  type ExecutionMode,
  type Observer,
  type VoiceBridgeEvent,
  type VoiceBridgeEventType,
  safeObserver,
} from './observability.ts';

export {
  SESSION_END_REASONS,
  type RuntimeBinding,
  type SessionContext,
  type SessionEndReason,
  applicationIdSchema,
  parseSessionContext,
  runtimeBindingSchema,
  sessionContextSchema,
  sessionIdSchema,
  sessionRefSchema,
} from './contracts/session.ts';

export {
  type BackendReply,
  MAX_REPLY_TEXT_LENGTH,
  type SessionStartResult,
  sessionStartResultSchema,
  MAX_TURN_TEXT_LENGTH,
  type TurnSource,
  type UserTurn,
  backendReplySchema,
  turnIdSchema,
  turnSourceSchema,
} from './contracts/turn.ts';

export {
  type Application,
  type ApplicationInput,
  type ConversationAdapter,
  assertModeSupported,
  assertSameApplication,
  defineApplication,
  supportedModes,
} from './contracts/application.ts';

export {
  DEFAULT_TOOL_TIMEOUT_MS,
  TOOL_NAME_PATTERN,
  type ToolCallContext,
  type ToolDefinition,
  type ToolEffect,
  type ToolInputSchema,
  ToolRegistry,
  defineTool,
} from './tools/registry.ts';

export {
  type ToolExecutor,
  type ToolExecutorOptions,
  type ToolInvocation,
  type ToolOutcome,
  createToolExecutor,
  invocationIdSchema,
} from './tools/executor.ts';

export type {
  RuntimeCapabilities,
  RuntimeEvents,
  RuntimeSession,
  SpeechHandle,
} from './runtime/port.ts';

export {
  type BackendControlledOptions,
  type BackendControlledSession,
  DEFAULT_BACKEND_TIMEOUT_MS,
  DEFAULT_FALLBACK_TEXT,
  DEFAULT_PENDING_TURN_HOLD_MS,
  DEFAULT_SESSION_END_TIMEOUT_MS,
  runBackendControlledSession,
} from './turns/backend-session.ts';

export {
  DEFAULT_HTTP_TIMEOUT_MS,
  DEFAULT_MAX_RESPONSE_BYTES,
  type HttpBackend,
  type HttpBackendOptions,
  type HttpToolOptions,
  createHttpBackend,
} from './http/backend.ts';
export { parseBackendBaseUrl } from './http/url.ts';

export {
  type SessionEndRequest,
  type SessionStartRequest,
  type SessionStartResponse,
  type ToolInvocationRequest,
  type ToolInvocationResponse,
  type TurnRequest,
  WIRE_HEADERS,
  WIRE_V0_PATHS,
  WIRE_V0_SCHEMAS,
  type WireV0SchemaName,
  applicationErrorCodeSchema,
  sessionEndRequestSchema,
  sessionStartRequestSchema,
  sessionStartResponseSchema,
  toolInvocationRequestSchema,
  toolInvocationResponseSchema,
  turnReplySchema,
  turnRequestSchema,
  wireV0JsonSchemas,
} from './wire/v0.ts';
