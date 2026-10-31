import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadServerConfigFromEnv } from '../src/config.ts';
import { buildDispatchMetadata, parseDispatchMetadata } from '../src/dispatch.ts';
import { createLiveKitTokenIssuer } from '../src/issuer.ts';
import { API_KEY, API_SECRET, SERVER_URL, SESSION_REF, options } from './helpers.ts';

function configError(fn: () => unknown): Error & { code?: string } {
  try {
    fn();
  } catch (e) {
    return e as Error & { code?: string };
  }
  throw new Error('expected a config error');
}

describe('server configuration', () => {
  it.each([
    ['https URL', { serverUrl: 'https://voice.synthetic.invalid' }],
    ['plain ws to a remote host', { serverUrl: 'ws://voice.synthetic.invalid' }],
    ['URL with credentials', { serverUrl: 'wss://user:pass@voice.synthetic.invalid' }],
    ['URL with query', { serverUrl: 'wss://voice.synthetic.invalid/?token=x' }],
    ['not a URL', { serverUrl: 'voice.synthetic.invalid' }],
    ['missing apiKey', { apiKey: '' }],
    ['apiKey with spaces', { apiKey: 'API key' }],
    ['short apiSecret', { apiSecret: 'too-short' }],
    ['apiSecret with whitespace', { apiSecret: `${'x'.repeat(40)} y` }],
    ['missing verifier', { verifySessionBinding: undefined as never }],
    ['empty application allowlist', { applications: {} }],
    ['invalid application id', { applications: { 'Help Desk': { agentName: 'a' } } }],
    ['invalid binding timeout', { bindingTimeoutMs: 0 }],
  ])('rejects %s with config_error', (_name, override) => {
    const err = configError(() => createLiveKitTokenIssuer(options(override)));
    expect(err.code).toBe('config_error');
    expect(err.message).not.toContain(API_SECRET);
  });

  it('accepts ws://localhost for local development', () => {
    expect(() =>
      createLiveKitTokenIssuer(options({ serverUrl: 'ws://localhost:7880' })),
    ).not.toThrow();
  });

  it('never echoes a bad secret in the error', () => {
    const bad = 'leaky secret value with spaces 0123456789';
    expect(
      configError(() => createLiveKitTokenIssuer(options({ apiSecret: bad }))).message,
    ).not.toContain(bad);
  });

  it('loads from environment variables, naming only missing variables', () => {
    expect(
      loadServerConfigFromEnv({
        LIVEKIT_URL: SERVER_URL,
        LIVEKIT_API_KEY: API_KEY,
        LIVEKIT_API_SECRET: API_SECRET,
      }),
    ).toEqual({
      serverUrl: SERVER_URL,
      apiKey: API_KEY,
      apiSecret: API_SECRET,
    });
    const err = configError(() =>
      loadServerConfigFromEnv({ LIVEKIT_URL: SERVER_URL, LIVEKIT_API_SECRET: API_SECRET }),
    );
    expect(err.message).toBe('missing environment variables: LIVEKIT_API_KEY');
    expect(err.message).not.toContain(API_SECRET);
  });
});

describe('dispatch metadata v0', () => {
  it('round-trips opaque references only', () => {
    const raw = buildDispatchMetadata('help-desk', SESSION_REF);
    expect(JSON.parse(raw)).toEqual({ vb: 0, applicationId: 'help-desk', sessionRef: SESSION_REF });
    expect(parseDispatchMetadata(raw)).toEqual({
      vb: 0,
      applicationId: 'help-desk',
      sessionRef: SESSION_REF,
    });
  });

  it.each([
    ['empty', ''],
    ['not JSON', 'not json'],
    ['array', '[]'],
    [
      'wrong version',
      JSON.stringify({ vb: 1, applicationId: 'help-desk', sessionRef: SESSION_REF }),
    ],
    [
      'extra field (smuggled secret)',
      JSON.stringify({ vb: 0, applicationId: 'help-desk', sessionRef: SESSION_REF, token: 'x' }),
    ],
    ['missing sessionRef', JSON.stringify({ vb: 0, applicationId: 'help-desk' })],
    ['bad sessionRef', JSON.stringify({ vb: 0, applicationId: 'help-desk', sessionRef: 'x' })],
    [
      'bad applicationId',
      JSON.stringify({ vb: 0, applicationId: 'HELP', sessionRef: SESSION_REF }),
    ],
    [
      'oversized',
      JSON.stringify({ vb: 0, applicationId: 'help-desk', sessionRef: 's'.repeat(600) }),
    ],
  ])('rejects %s without echoing the input', (_name, raw) => {
    let error: (Error & { code?: string }) | undefined;
    try {
      parseDispatchMetadata(raw);
    } catch (e) {
      error = e as Error & { code?: string };
    }
    expect(error?.code).toBe('invalid_request');
    if (raw.length > 0) expect(error?.message).not.toContain(raw);
  });
});

describe('package boundaries', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    dependencies: Record<string, string>;
  };

  it('depends only on the server SDK and the provider-neutral core', () => {
    expect(Object.keys(pkg.dependencies).sort()).toEqual([
      '@voicebridge/core',
      'livekit-server-sdk',
    ]);
  });

  it('does not depend on the agents runtime, client SDKs, or frontend frameworks', () => {
    for (const forbidden of [
      '@livekit/agents',
      '@livekit/rtc-node',
      'livekit-client',
      'next',
      'react',
    ]) {
      expect(pkg.dependencies).not.toHaveProperty(forbidden);
    }
  });
});
