import { z } from 'zod';
import type { SessionContext } from '../contracts/session.ts';
import { VoiceBridgeError } from '../errors.ts';

export const TOOL_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;
export const DEFAULT_TOOL_TIMEOUT_MS = 10_000;

/** Whether a tool reads or modifies application state. `write` tools are never retried automatically. */
export type ToolEffect = 'read' | 'write';

export interface ToolCallContext {
  /** Trusted session context. Injected by VoiceBridge, never derived from LLM arguments. */
  readonly session: SessionContext;
  /** Unique per invocation. Use it as the idempotency key for writes. */
  readonly invocationId: string;
  /** Aborted on timeout, cancellation, or session end. Aborting does not undo completed work. */
  readonly signal: AbortSignal;
}

/** Tool input must be an object schema, which LLM function-calling requires. */
export type ToolInputSchema = z.ZodObject;

export interface ToolDefinition<
  I extends ToolInputSchema = ToolInputSchema,
  O extends z.ZodType = z.ZodType,
> {
  readonly name: string;
  /** Application-supplied description for the LLM. Core never supplies prompts. */
  readonly description: string;
  readonly effect: ToolEffect;
  /** Validated in strict mode (unknown keys rejected) before `execute` runs. */
  readonly input: I;
  /** Validated before the result is returned to the runtime or LLM. */
  readonly output: O;
  readonly timeoutMs?: number;
  execute(input: z.output<I>, ctx: ToolCallContext): Promise<z.input<O>>;
}

/**
 * Defines a tool and validates its static configuration.
 * Throws `config_error` for invalid names, empty descriptions, or bad timeouts.
 */
export function defineTool<I extends ToolInputSchema, O extends z.ZodType>(
  definition: ToolDefinition<I, O>,
): ToolDefinition<I, O> {
  if (!TOOL_NAME_PATTERN.test(definition.name)) {
    throw new VoiceBridgeError('config_error', `invalid tool name "${definition.name}"`);
  }
  if (definition.description.trim().length === 0) {
    throw new VoiceBridgeError('config_error', `tool "${definition.name}" needs a description`);
  }
  if (definition.effect !== 'read' && definition.effect !== 'write') {
    throw new VoiceBridgeError('config_error', `tool "${definition.name}" has an invalid effect`);
  }
  if (!(definition.input instanceof z.ZodObject)) {
    throw new VoiceBridgeError(
      'config_error',
      `tool "${definition.name}" input must be an object schema`,
    );
  }
  if (
    definition.timeoutMs !== undefined &&
    (!Number.isInteger(definition.timeoutMs) || definition.timeoutMs <= 0)
  ) {
    throw new VoiceBridgeError('config_error', `tool "${definition.name}" has an invalid timeout`);
  }
  return Object.freeze({ ...definition, input: definition.input.strict() as I });
}

/**
 * Immutable allowlist of tools. A tool that isn't registered can't be executed, whatever the
 * LLM asks for.
 */
export class ToolRegistry {
  readonly #tools: ReadonlyMap<string, ToolDefinition>;

  private constructor(tools: ReadonlyMap<string, ToolDefinition>) {
    this.#tools = tools;
  }

  static from(tools: readonly ToolDefinition[]): ToolRegistry {
    const map = new Map<string, ToolDefinition>();
    for (const tool of tools) {
      const checked = defineTool(tool);
      if (map.has(checked.name)) {
        throw new VoiceBridgeError('config_error', `duplicate tool name "${checked.name}"`);
      }
      map.set(checked.name, checked);
    }
    return new ToolRegistry(map);
  }

  has(name: string): boolean {
    return this.#tools.has(name);
  }

  get(name: string): ToolDefinition | undefined {
    return this.#tools.get(name);
  }

  get size(): number {
    return this.#tools.size;
  }

  names(): string[] {
    return [...this.#tools.keys()];
  }

  list(): ToolDefinition[] {
    return [...this.#tools.values()];
  }
}
