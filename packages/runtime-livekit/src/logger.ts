/**
 * Minimal logger for VoiceBridge's own messages. Fields are restricted to primitive values, and
 * callers only ever pass codes, reasons, job ids, and error class names, never transcripts, reply
 * text, session refs, room names, credentials, or backend responses.
 */
export type SafeLogFields = Readonly<Record<string, string | number | boolean>>;

export interface VoiceBridgeLogger {
  warn(message: string, fields?: SafeLogFields): void;
  error(message: string, fields?: SafeLogFields): void;
}

/** Default: one JSON line per message on stderr, warnings and errors only. */
export const consoleLogger: VoiceBridgeLogger = {
  warn: (message, fields = {}) =>
    console.warn(JSON.stringify({ level: 'warn', src: 'voicebridge', message, ...fields })),
  error: (message, fields = {}) =>
    console.error(JSON.stringify({ level: 'error', src: 'voicebridge', message, ...fields })),
};

/** Wraps a logger so that a failing logger never breaks a session. */
export function safeLogger(logger: VoiceBridgeLogger): VoiceBridgeLogger {
  return {
    warn: (m, f) => {
      try {
        logger.warn(m, f);
      } catch {
        /* never let logging break the session */
      }
    },
    error: (m, f) => {
      try {
        logger.error(m, f);
      } catch {
        /* never let logging break the session */
      }
    },
  };
}

/** Name of a thrown value's class, for logs (never its message, which may contain payloads). */
export function errorName(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return error instanceof Error ? error.name : typeof error;
}
