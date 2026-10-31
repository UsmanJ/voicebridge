import { createHelpDeskBackend } from '@voicebridge/backend-help-desk-example';
import { createLiveKitTokenIssuer, parseDispatchMetadata } from '@voicebridge/livekit-tokens';
import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { type Authenticator, DEV_SUBJECT, createDevAuthenticator } from '../src/auth.ts';
import { createSessionApi } from '../src/backend-client.ts';
import { loadHostConfig } from '../src/config.ts';
import { TOKEN_PATH, createHostApp } from '../src/host.ts';
import { createRateLimiter } from '../src/rate-limit.ts';

const LK = {
  serverUrl: 'wss://voice.synthetic.invalid',
  apiKey: 'APIsyntheticKey',
  apiSecret: 'synthetic-livekit-secret-'.padEnd(48, 'x'),
};
const APP = {
  applicationId: 'help-desk',
  workerCredential: 'wkr_'.padEnd(40, 'a'),
  hostCredential: 'hst_'.padEnd(40, 'b'),
};
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

async function listen(handler: (req: never, res: never) => void, host = '127.0.0.1') {
  const server = createServer((req, res) => void handler(req as never, res as never));
  await new Promise<void>((r) => server.listen(0, host, r));
  closers.push(() => new Promise((r) => server.close(() => r())));
  return `http://${host}:${(server.address() as AddressInfo).port}`;
}

const decode = (jwt: string) =>
  JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- decoded JWT in tests

async function setup(
  over: {
    authenticate?: Authenticator;
    perSubject?: number;
    perClient?: number;
    origins?: string[];
    backendUrl?: string;
  } = {},
) {
  const backend = createHelpDeskBackend({ applications: [APP] });
  const backendUrl = over.backendUrl ?? (await listen(backend.handler as never));
  const sessions = createSessionApi({
    baseUrl: backendUrl,
    hostCredential: APP.hostCredential,
    timeoutMs: 1000,
  });
  const issuer = createLiveKitTokenIssuer({
    ...LK,
    applications: { 'help-desk': { agentName: 'voicebridge-help-desk', allowTextInput: true } },
    verifySessionBinding: async ({ sessionRef }) => sessions.canIssue(sessionRef),
    recordIssuance: async ({ sessionRef, roomName }) => sessions.attachRoom(sessionRef, roomName),
  });
  const logs: string[] = [];
  const { handler } = createHostApp({
    authenticate:
      over.authenticate ??
      createDevAuthenticator({ mode: 'localhost', nodeEnv: 'development', bindHost: '127.0.0.1' }),
    issuer,
    sessions,
    applicationId: 'help-desk',
    allowedOrigins: over.origins ?? ['http://localhost:3000'],
    limits: {
      perClient: createRateLimiter({ limit: over.perClient ?? 100, windowMs: 60_000 }),
      perSubject: createRateLimiter({ limit: over.perSubject ?? 100, windowMs: 60_000 }),
    },
    logger: (e, f) => logs.push(JSON.stringify({ e, ...f })),
  });
  const hostUrl = await listen(handler as never);
  const post = (body: unknown = {}, headers: Record<string, string> = {}) =>
    fetch(`${hostUrl}${TOKEN_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  return { backend, sessions, hostUrl, post, logs };
}

describe('token route: happy path', () => {
  it('authenticates, creates and binds a session, and returns the token-source response', async () => {
    const h = await setup();
    const res = await h.post();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as { server_url: string; participant_token: string };
    expect(Object.keys(body).sort()).toEqual(['participant_token', 'server_url']);
    expect(body.server_url).toBe(LK.serverUrl);
    const p = decode(body.participant_token);
    const meta = parseDispatchMetadata(p.roomConfig.agents[0].metadata);
    expect(meta.applicationId).toBe('help-desk');
    expect(p.roomConfig.agents[0].agentName).toBe('voicebridge-help-desk');
    // The backend recorded exactly the room in the token.
    expect(h.backend.store.inspect(meta.sessionRef)).toMatchObject({
      roomName: p.video.room,
      subject: DEV_SUBJECT,
      status: 'active',
    });
  });

  it('ignores every browser-supplied field (room, identity, agent, metadata, application)', async () => {
    const h = await setup();
    const res = await h.post({
      room_name: 'attacker-room',
      participant_identity: 'admin',
      applicationId: 'other-app',
      agentName: 'evil-agent',
      room_config: {
        agents: [{ agent_name: 'evil-agent', metadata: '{"vb":0,"applicationId":"other-app"}' }],
      },
    });
    const p = decode(((await res.json()) as { participant_token: string }).participant_token);
    expect(p.video.room).toMatch(/^vb_/);
    expect(p.sub).toMatch(/^vbu_/);
    expect(p.roomConfig.agents).toHaveLength(1);
    expect(p.roomConfig.agents[0].agentName).toBe('voicebridge-help-desk');
    expect(parseDispatchMetadata(p.roomConfig.agents[0].metadata).applicationId).toBe('help-desk');
  });

  it('issues a fresh session per request (no reuse)', async () => {
    const h = await setup();
    const a = decode(
      ((await (await h.post()).json()) as { participant_token: string }).participant_token,
    );
    const b = decode(
      ((await (await h.post()).json()) as { participant_token: string }).participant_token,
    );
    expect(a.video.room).not.toBe(b.video.room);
    expect(parseDispatchMetadata(a.roomConfig.agents[0].metadata).sessionRef).not.toBe(
      parseDispatchMetadata(b.roomConfig.agents[0].metadata).sessionRef,
    );
  });
});

describe('replay and concurrent issuance for one session', () => {
  it('only one of two concurrent issuances for the same session returns a token', async () => {
    const h = await setup();
    const { sessionRef } = await h.sessions.create('user_synthetic_9');
    const issuer = createLiveKitTokenIssuer({
      ...LK,
      applications: { 'help-desk': { agentName: 'voicebridge-help-desk' } },
      verifySessionBinding: async ({ sessionRef: r }) => h.sessions.canIssue(r),
      recordIssuance: async ({ sessionRef: r, roomName }) => h.sessions.attachRoom(r, roomName),
    });
    const results = await Promise.allSettled(
      [1, 2, 3].map(() => issuer.issue({ applicationId: 'help-desk', sessionRef })),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    // A later replay is refused at verification (room already bound).
    await expect(issuer.issue({ applicationId: 'help-desk', sessionRef })).rejects.toMatchObject({
      code: 'session_not_authorized',
    });
  });
});

describe('authentication boundary', () => {
  it('rejects unauthenticated callers', async () => {
    const h = await setup({ authenticate: async () => null });
    const res = await h.post();
    expect(res.status).toBe(401);
  });

  it('development identity refuses non-localhost Host headers (DNS rebinding)', async () => {
    const h = await setup();
    const status = await new Promise<number>((resolve) => {
      const url = new URL(`${h.hostUrl}${TOKEN_PATH}`);
      const req = httpRequest(
        {
          host: url.hostname,
          port: url.port,
          path: url.pathname,
          method: 'POST',
          headers: { host: 'evil.example' },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.end('{}');
    });
    expect(status).toBe(401);
  });

  it.each([
    ['not enabled', { mode: undefined, nodeEnv: 'development', bindHost: '127.0.0.1' }],
    ['wrong value', { mode: 'true', nodeEnv: 'development', bindHost: '127.0.0.1' }],
    ['production', { mode: 'localhost', nodeEnv: 'production', bindHost: '127.0.0.1' }],
    ['public bind address', { mode: 'localhost', nodeEnv: 'development', bindHost: '0.0.0.0' }],
  ])('development identity cannot be enabled: %s', (_name, opts) => {
    expect(() => createDevAuthenticator(opts)).toThrow();
  });

  it('the host refuses to start without any authenticator', () => {
    const env = {
      HELP_DESK_URL: 'http://127.0.0.1:1',
      HELP_DESK_HOST_CREDENTIAL: APP.hostCredential,
      LIVEKIT_URL: LK.serverUrl,
      LIVEKIT_API_KEY: LK.apiKey,
      LIVEKIT_API_SECRET: LK.apiSecret,
    };
    expect(() => loadHostConfig(env)).toThrow(/no authenticator/);
    expect(() =>
      loadHostConfig({ ...env, VB_DEV_AUTH: 'localhost', NODE_ENV: 'production' }),
    ).toThrow(/production/);
    expect(() =>
      loadHostConfig({ ...env, VB_DEV_AUTH: 'localhost', HOST_BIND: '0.0.0.0' }),
    ).toThrow(/loopback/);
    expect(loadHostConfig({ ...env, VB_DEV_AUTH: 'localhost' }).app.applicationId).toBe(
      'help-desk',
    );
  });
});

describe('origins, rate limits, and errors', () => {
  it('refuses disallowed browser origins and answers CORS only for allowed ones', async () => {
    const h = await setup();
    expect((await h.post({}, { origin: 'https://evil.example' })).status).toBe(403);
    const ok = await h.post({}, { origin: 'http://localhost:3000' });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');
    const pre = await fetch(`${h.hostUrl}${TOKEN_PATH}`, {
      method: 'OPTIONS',
      headers: { origin: 'http://localhost:3000' },
    });
    expect(pre.status).toBe(204);
  });

  it('rate-limits per subject and per client', async () => {
    const h = await setup({ perSubject: 2 });
    expect((await h.post()).status).toBe(200);
    expect((await h.post()).status).toBe(200);
    expect((await h.post()).status).toBe(429);
    const c = await setup({ perClient: 1 });
    expect((await c.post()).status).toBe(200);
    expect((await c.post()).status).toBe(429);
  });

  it('returns a generic 503 when the backend is unavailable', async () => {
    const h = await setup({ backendUrl: 'http://127.0.0.1:1' });
    const res = await h.post();
    expect(res.status).toBe(503);
    expect(await res.text()).not.toMatch(/127\.0\.0\.1|ECONNREFUSED/);
  });

  it('rejects oversized bodies and unknown routes', async () => {
    const h = await setup();
    expect((await h.post({ pad: 'x'.repeat(10_000) })).status).toBe(413);
    expect((await fetch(`${h.hostUrl}/api/other`, { method: 'POST' })).status).toBe(404);
  });

  it('never exposes secrets, tokens, or session refs in logs or error responses', async () => {
    const h = await setup();
    const ok = (await (await h.post()).json()) as { participant_token: string };
    const errors = [await (await h.post({}, { origin: 'https://evil.example' })).text()];
    const ref = parseDispatchMetadata(
      decode(ok.participant_token).roomConfig.agents[0].metadata,
    ).sessionRef;
    const all = [...h.logs, ...errors].join('\n');
    for (const secret of [
      LK.apiSecret,
      APP.hostCredential,
      APP.workerCredential,
      ok.participant_token,
      ref,
    ]) {
      expect(all).not.toContain(secret);
    }
  });
});
