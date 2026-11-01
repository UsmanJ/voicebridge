'use client';

import { resolveTokenEndpoint } from '../config';
import { DEMO_APPLICATION } from '../demo-app';
import { VoiceDemo } from './VoiceDemo';

// Inlined at build time by Next.js. Validated again here so a bad value fails loudly.
const TOKEN_ENDPOINT = resolveTokenEndpoint(process.env.NEXT_PUBLIC_VB_TOKEN_ENDPOINT);

export function VoiceDemoClient() {
  return <VoiceDemo app={DEMO_APPLICATION} tokenEndpoint={TOKEN_ENDPOINT} />;
}
