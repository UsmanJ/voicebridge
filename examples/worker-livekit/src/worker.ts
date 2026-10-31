// Example VoiceBridge LiveKit worker for the help-desk backend.
// Usage (from examples/worker-livekit): pnpm start   (production-style, --log-level warn)
//                                       pnpm dev     (connects to LiveKit Cloud for local testing)
import { ServerOptions, cli } from '@livekit/agents';
import { createVoiceBridgeAgent } from '@voicebridge/runtime-livekit';
import { fileURLToPath } from 'node:url';
import { loadWorkerConfig } from './config.ts';

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
