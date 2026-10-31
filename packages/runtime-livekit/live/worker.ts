// LIVE HARNESS worker (opt-in). Run from packages/runtime-livekit:
//   node --env-file=../../.env.local live/worker.ts dev --log-level warn
import { ServerOptions, cli } from '@livekit/agents';
import { createHttpBackend, defineApplication } from '@voicebridge/core';
import { fileURLToPath } from 'node:url';
import { createVoiceBridgeAgent } from '../src/index.ts';

const backend = createHttpBackend({
  applicationId: 'help-desk',
  baseUrl: `http://127.0.0.1:${process.env.VB_LIVE_BACKEND_PORT ?? 8788}`,
  serviceCredential:
    process.env.VB_LIVE_SERVICE_CREDENTIAL ?? 'svc_live_harness_synthetic_credential',
  timeoutMs: 8000,
  endpoints: { sessionStart: '/v0/sessions/start' },
});

export default createVoiceBridgeAgent({
  application: defineApplication({
    applicationId: 'help-desk',
    conversation: backend.conversation(),
  }),
  mode: 'backend-controlled',
  providers: {
    stt: { model: 'assemblyai/universal-3-6-pro', language: 'en' },
    tts: { model: 'fishaudio/s2.1-pro', voice: 'fa4c9eb3dccc4806b382b40d61c6b10a' },
  },
  textInput: true,
  backend: { timeoutMs: 8000 },
  observer: (e) => console.log(`[VB] ${JSON.stringify(e)}`),
});

cli.runApp(
  new ServerOptions({ agent: fileURLToPath(import.meta.url), agentName: 'voicebridge-live' }),
);
