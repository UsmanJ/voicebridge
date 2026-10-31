import type { LiveKitTokenIssuerOptions, VoiceSessionRequest } from '../src/issuer.ts';

// Synthetic, obviously fake values. No real LiveKit project is contacted by these tests.
export const SERVER_URL = 'wss://voice.synthetic.invalid';
export const API_KEY = 'APIsyntheticTestKey';
export const API_SECRET = 'synthetic-test-secret-'.padEnd(48, 'x');
export const SESSION_REF = 'sr_synthetic_0123456789abcdef';

export const REQUEST: VoiceSessionRequest = { applicationId: 'help-desk', sessionRef: SESSION_REF };

export function options(
  overrides: Partial<LiveKitTokenIssuerOptions> = {},
): LiveKitTokenIssuerOptions {
  return {
    serverUrl: SERVER_URL,
    apiKey: API_KEY,
    apiSecret: API_SECRET,
    applications: {
      'help-desk': { agentName: 'voicebridge-agent' },
      'task-list': { agentName: 'voicebridge-agent', allowTextInput: true },
    },
    verifySessionBinding: async () => true,
    ...overrides,
  };
}

export interface DecodedPayload {
  iss?: string;
  sub?: string;
  nbf?: number;
  exp?: number;
  name?: string;
  metadata?: string;
  attributes?: Record<string, string>;
  video?: Record<string, unknown>;
  roomConfig?: { agents?: Array<{ agentName?: string; metadata?: string }> } & Record<
    string,
    unknown
  >;
  [key: string]: unknown;
}

/** Decodes a JWT payload exactly as any client holding the token could, without the secret. */
export function decode(token: string): DecodedPayload {
  const [, payload] = token.split('.');
  return JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8')) as DecodedPayload;
}

export async function rejection(
  promise: Promise<unknown>,
): Promise<Error & { code?: string; publicMessage?: string }> {
  try {
    await promise;
  } catch (e) {
    return e as Error & { code?: string };
  }
  throw new Error('expected the promise to reject');
}
