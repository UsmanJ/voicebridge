// Example VoiceBridge LiveKit worker for the help-desk backend.
// Usage (from examples/worker-livekit): pnpm start   (production-style; LiveKit SDK logs at LOG_LEVEL, default error)
//                                       pnpm dev     (connects to LiveKit Cloud for local testing)
import { ServerOptions, cli } from '@livekit/agents';
import { createVoiceBridgeAgent } from '@voicebridge/runtime-livekit';
import { fileURLToPath } from 'node:url';
import { loadWorkerConfig, sdkLogsMayContainTranscripts } from './config.ts';

let config: ReturnType<typeof loadWorkerConfig>;
try {
  config = loadWorkerConfig(process.env);
} catch (error) {
  console.error(
    JSON.stringify({
      level: 'error',
      src: 'worker',
      message: error instanceof Error ? error.message : 'invalid configuration',
    }),
  );
  process.exit(1);
}

export default createVoiceBridgeAgent(config.options);

// The LiveKit CLI reads LOG_LEVEL when it parses its options (an explicit --log-level flag would
// win, so the npm scripts don't pass one). Job processes inherit the level over IPC. Default
// `error`: at `warn` and below, @livekit/agents 1.9.5 can write raw user transcripts to local logs.
process.env.LOG_LEVEL = config.sdkLogLevel;

// Job subprocesses re-import this module. Print the startup diagnostics only once, in the main process.
if (!process.send) {
  console.warn(
    JSON.stringify({
      level: 'info',
      src: 'worker',
      message: 'starting VoiceBridge worker',
      ...config.summary,
    }),
  );
  if (sdkLogsMayContainTranscripts(config.sdkLogLevel)) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        src: 'worker',
        message: `LiveKit SDK logging at "${config.sdkLogLevel}": local worker logs may contain user transcripts. Treat them as sensitive and use LOG_LEVEL=error outside debugging.`,
      }),
    );
  }
}

cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: config.agentName,
    // SDK health endpoints: GET / (healthy or not), GET /worker (agent name, job count). No secrets.
    host: config.healthHost,
    port: config.healthPort,
  }),
);
