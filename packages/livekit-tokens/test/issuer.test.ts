import { AccessToken, TokenVerifier } from 'livekit-server-sdk';
import { inspect } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseDispatchMetadata } from '../src/dispatch.ts';
import { LiveKitTokenError } from '../src/errors.ts';
import { createLiveKitTokenIssuer, toTokenSourceResponse } from '../src/issuer.ts';
import {
  API_KEY,
  API_SECRET,
  REQUEST,
  SERVER_URL,
  SESSION_REF,
  decode,
  options,
  rejection,
} from './helpers.ts';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const PRIVILEGED = [
  'roomCreate',
  'roomList',
  'roomRecord',
  'roomAdmin',
  'ingressAdmin',
  'recorder',
  'agent',
  'hidden',
  'canUpdateOwnMetadata',
  'canSubscribeMetrics',
  'canManageAgentSession',
] as const;

describe('issue(): valid token', () => {
  it('returns connection info and a token whose decoded payload is exactly the least-privilege grant', async () => {
    const before = Math.floor(Date.now() / 1000);
    const creds = await createLiveKitTokenIssuer(options()).issue(REQUEST);
    const p = decode(creds.participantToken);

    expect(creds.serverUrl).toBe(SERVER_URL);
    expect(p.iss).toBe(API_KEY); // the API key id is public by design; the secret is not
    expect(p.sub).toBe(creds.participantIdentity);
    expect(p.video).toEqual({
      room: creds.roomName,
      roomJoin: true,
      canPublish: true,
      canPublishSources: ['microphone'],
      canSubscribe: true,
      canPublishData: false,
      canUpdateOwnMetadata: false,
      hidden: false,
      recorder: false,
      agent: false,
      roomCreate: false,
      roomList: false,
      roomRecord: false,
      roomAdmin: false,
      ingressAdmin: false,
      canSubscribeMetrics: false,
      canManageAgentSession: false,
    });
    // No other grant families, display name, metadata, or attributes.
    for (const claim of [
      'sip',
      'inference',
      'observability',
      'name',
      'metadata',
      'attributes',
      'kind',
      'sha256',
      'roomPreset',
    ]) {
      expect(p, `unexpected claim ${claim}`).not.toHaveProperty(claim);
    }
    expect(p.exp! - before).toBeGreaterThanOrEqual(599);
    expect(p.exp! - before).toBeLessThanOrEqual(601);
    expect(Math.abs(creds.expiresAt - p.exp! * 1000)).toBeLessThan(2000);
  });

  it('is accepted by the SDK verifier with the right secret and rejected with a wrong one', async () => {
    const { participantToken } = await createLiveKitTokenIssuer(options()).issue(REQUEST);
    const claims = await new TokenVerifier(API_KEY, API_SECRET).verify(participantToken);
    expect(claims.video?.roomJoin).toBe(true);
    await expect(
      new TokenVerifier(API_KEY, 'wrong-secret-'.padEnd(48, 'y')).verify(participantToken),
    ).rejects.toThrow();
  });

  it('shapes the endpoint body expected by LiveKit client TokenSource', async () => {
    const creds = await createLiveKitTokenIssuer(options()).issue(REQUEST);
    expect(toTokenSourceResponse(creds)).toEqual({
      server_url: SERVER_URL,
      participant_token: creds.participantToken,
    });
  });
});

describe('issue(): permissions', () => {
  it('scopes the token to exactly one room, a new one each time', async () => {
    const issuer = createLiveKitTokenIssuer(options());
    const a = await issuer.issue(REQUEST);
    const b = await issuer.issue(REQUEST);
    expect(decode(a.participantToken).video?.room).toBe(a.roomName);
    expect(a.roomName).not.toBe(b.roomName);
    expect(a.roomName).not.toMatch(/[*?]/);
  });

  it('allows microphone publishing only (no camera or screen share)', async () => {
    const p = decode((await createLiveKitTokenIssuer(options()).issue(REQUEST)).participantToken);
    expect(p.video?.canPublish).toBe(true);
    expect(p.video?.canPublishSources).toEqual(['microphone']);
  });

  it('sets every privileged grant explicitly to false', async () => {
    const p = decode((await createLiveKitTokenIssuer(options()).issue(REQUEST)).participantToken);
    for (const flag of PRIVILEGED) expect(p.video?.[flag], flag).toBe(false);
  });

  it('enables data publishing only for applications that need typed text input', async () => {
    const issuer = createLiveKitTokenIssuer(options());
    const helpDesk = decode((await issuer.issue(REQUEST)).participantToken);
    const taskList = decode(
      (await issuer.issue({ applicationId: 'task-list', sessionRef: SESSION_REF }))
        .participantToken,
    );
    expect(helpDesk.video?.canPublishData).toBe(false);
    expect(taskList.video?.canPublishData).toBe(true);
  });
});

describe('issue(): expiry', () => {
  it('uses a configurable short TTL', async () => {
    const p = decode(
      (await createLiveKitTokenIssuer(options({ ttlSeconds: 120 })).issue(REQUEST))
        .participantToken,
    );
    expect(p.exp! - p.nbf!).toBe(120);
  });

  it('defaults to 10 minutes', async () => {
    const p = decode((await createLiveKitTokenIssuer(options()).issue(REQUEST)).participantToken);
    expect(p.exp! - p.nbf!).toBe(600);
  });

  it('is rejected by the SDK verifier after expiry', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-01T10:00:00Z'));
    const { participantToken } = await createLiveKitTokenIssuer(options({ ttlSeconds: 60 })).issue(
      REQUEST,
    );
    const verifier = new TokenVerifier(API_KEY, API_SECRET);
    await expect(verifier.verify(participantToken)).resolves.toBeTruthy();
    vi.setSystemTime(new Date('2026-11-01T10:01:01Z'));
    await expect(verifier.verify(participantToken, 0)).rejects.toThrow(/exp/i);
  });

  it.each([0, 59, 3601, 1.5, -600])('rejects TTL %s outside 60-3600 s', (ttlSeconds) => {
    expect(() => createLiveKitTokenIssuer(options({ ttlSeconds }))).toThrowError(
      expect.objectContaining({ code: 'config_error' }),
    );
  });
});

describe('issue(): identities', () => {
  it('generates unique, opaque room names and participant identities', async () => {
    const issuer = createLiveKitTokenIssuer(options());
    const all = await Promise.all(Array.from({ length: 300 }, () => issuer.issue(REQUEST)));
    expect(new Set(all.map((c) => c.roomName)).size).toBe(300);
    expect(new Set(all.map((c) => c.participantIdentity)).size).toBe(300);
    for (const c of all.slice(0, 20)) {
      expect(c.roomName).toMatch(/^vb_[A-Za-z0-9_-]{22}$/);
      expect(c.participantIdentity).toMatch(/^vbu_[A-Za-z0-9_-]{22}$/);
    }
  });

  it('never derives room or identity from application, session, or user data', async () => {
    const c = await createLiveKitTokenIssuer(options()).issue(REQUEST);
    for (const value of [c.roomName, c.participantIdentity]) {
      expect(value).not.toContain('help-desk');
      expect(value).not.toContain(SESSION_REF);
      expect(value).not.toContain('synthetic');
    }
  });
});

describe('issue(): untrusted input is rejected before signing', () => {
  it.each([
    ['client-selected room name', { ...REQUEST, roomName: 'my-room' }],
    ['client-selected agent name', { ...REQUEST, agentName: 'admin-agent' }],
    ['client-selected identity', { ...REQUEST, participantIdentity: 'alice@example.com' }],
    ['client-supplied metadata', { ...REQUEST, metadata: '{"role":"admin"}' }],
    ['client-supplied room_config', { ...REQUEST, room_config: { agents: [{ agent_name: 'x' }] } }],
    ['missing sessionRef', { applicationId: 'help-desk' }],
    ['malformed sessionRef', { applicationId: 'help-desk', sessionRef: 'short' }],
    [
      'sessionRef with unsafe characters',
      { applicationId: 'help-desk', sessionRef: 'sr_0123456789abcdef"},{' },
    ],
    ['malformed applicationId', { applicationId: 'Help Desk', sessionRef: SESSION_REF }],
    ['application not in the allowlist', { applicationId: 'unknown-app', sessionRef: SESSION_REF }],
  ])('%s', async (_name, request) => {
    const verify = vi.fn(async () => true);
    const sign = vi.spyOn(AccessToken.prototype, 'toJwt');
    const err = await rejection(
      createLiveKitTokenIssuer(options({ verifySessionBinding: verify })).issue(request as never),
    );
    expect(err).toBeInstanceOf(LiveKitTokenError);
    expect(err.code).toBe('invalid_request');
    expect(verify).not.toHaveBeenCalled();
    expect(sign).not.toHaveBeenCalled();
  });

  it.each([null, undefined, 'help-desk', [], 42])(
    'rejects non-object request %j',
    async (request) => {
      const err = await rejection(createLiveKitTokenIssuer(options()).issue(request as never));
      expect(err.code).toBe('invalid_request');
    },
  );
});

describe('issue(): application/session binding', () => {
  it('passes exactly the requested binding to the host verifier, frozen', async () => {
    const verify = vi.fn(async (b: { applicationId: string; sessionRef: string }) => {
      expect(Object.isFrozen(b)).toBe(true);
      return true;
    });
    await createLiveKitTokenIssuer(options({ verifySessionBinding: verify })).issue(REQUEST);
    expect(verify).toHaveBeenCalledWith({ applicationId: 'help-desk', sessionRef: SESSION_REF });
  });

  it.each([
    ['false', async () => false],
    ['truthy non-boolean', async () => 'yes' as unknown as boolean],
    ['throws', async () => Promise.reject(new Error('db down'))],
    ['never settles (timeout)', () => new Promise<boolean>(() => {})],
  ])('refuses to sign when the verifier returns %s', async (_name, verify) => {
    const sign = vi.spyOn(AccessToken.prototype, 'toJwt');
    const issuer = createLiveKitTokenIssuer(
      options({ verifySessionBinding: verify, bindingTimeoutMs: 50 }),
    );
    const err = await rejection(issuer.issue(REQUEST));
    expect(err.code).toBe('session_not_authorized');
    expect(err.publicMessage).toBe('You are not allowed to start this voice session.');
    expect(sign).not.toHaveBeenCalled();
  });

  it('binds the verified application and session into dispatch metadata, and nothing else', async () => {
    const p = decode((await createLiveKitTokenIssuer(options()).issue(REQUEST)).participantToken);
    const agents = p.roomConfig?.agents ?? [];
    expect(agents).toHaveLength(1);
    expect(parseDispatchMetadata(agents[0]!.metadata!)).toEqual({
      vb: 0,
      applicationId: 'help-desk',
      sessionRef: SESSION_REF,
    });
  });
});

describe('issue(): agent dispatch allowlist', () => {
  it('dispatches the agent configured for the application, selected server-side', async () => {
    const issuer = createLiveKitTokenIssuer(
      options({
        applications: {
          'help-desk': { agentName: 'help-desk-agent' },
          'task-list': { agentName: 'task-agent' },
        },
      }),
    );
    expect(
      decode((await issuer.issue(REQUEST)).participantToken).roomConfig?.agents?.[0]?.agentName,
    ).toBe('help-desk-agent');
    expect(
      decode(
        (await issuer.issue({ applicationId: 'task-list', sessionRef: SESSION_REF }))
          .participantToken,
      ).roomConfig?.agents?.[0]?.agentName,
    ).toBe('task-agent');
  });

  it.each(['', 'has space', 'a'.repeat(65), 'agent\nname', '../agent', '-leading-dash'])(
    'rejects invalid configured agent name %j',
    (agentName) => {
      expect(() =>
        createLiveKitTokenIssuer(options({ applications: { 'help-desk': { agentName } } })),
      ).toThrowError(expect.objectContaining({ code: 'config_error' }));
    },
  );
});

describe('payload privacy', () => {
  it('contains no secret, PII-shaped values, or display name', async () => {
    const creds = await createLiveKitTokenIssuer(options()).issue(REQUEST);
    const raw = Buffer.from(creds.participantToken.split('.')[1]!, 'base64url').toString('utf8');
    expect(raw).not.toContain(API_SECRET);
    // Every string value in the payload (numeric claims like exp/nbf are numbers, not strings).
    const strings: string[] = [];
    const walk = (v: unknown): void => {
      if (typeof v === 'string') {
        if (v.startsWith('{'))
          walk(JSON.parse(v)); // nested JSON (dispatch metadata)
        else strings.push(v);
      } else if (v && typeof v === 'object') Object.values(v).forEach(walk);
    };
    walk(decode(creds.participantToken));
    for (const value of strings.filter((v) => v !== SESSION_REF)) {
      expect(value, 'email-like').not.toMatch(/@[a-z0-9-]+\.[a-z]/i);
      expect(value, 'phone-like').not.toMatch(/\+?\d[\d\s-]{8,}\d/);
    }
    expect(decode(creds.participantToken)).not.toHaveProperty('name');
    expect(JSON.stringify(creds)).not.toContain(API_SECRET);
  });
});

describe('failure handling and leakage', () => {
  it('maps SDK signing failures to signing_failed without exposing the SDK message', async () => {
    vi.spyOn(AccessToken.prototype, 'toJwt').mockRejectedValue(
      new Error(`jose failure key=${API_SECRET}`),
    );
    const err = await rejection(createLiveKitTokenIssuer(options()).issue(REQUEST));
    expect(err.code).toBe('signing_failed');
    expect(err.message).not.toContain(API_SECRET);
    expect(err.publicMessage).not.toContain(API_SECRET);
    expect((err as LiveKitTokenError).httpStatus).toBe(503);
  });

  it('never exposes the secret through the issuer object, inspection, or JSON', () => {
    const issuer = createLiveKitTokenIssuer(options());
    expect(JSON.stringify(issuer)).not.toContain(API_SECRET);
    expect(inspect(issuer, { depth: 5, showHidden: true })).not.toContain(API_SECRET);
    expect(Object.isFrozen(issuer)).toBe(true);
    expect(issuer.applicationIds).toEqual(['help-desk', 'task-list']);
  });

  it('never logs anything, on success or failure', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m),
    );
    const issuer = createLiveKitTokenIssuer(options());
    await issuer.issue(REQUEST);
    await rejection(issuer.issue({ ...REQUEST, roomName: 'x' } as never));
    vi.spyOn(AccessToken.prototype, 'toJwt').mockRejectedValue(new Error('boom'));
    await rejection(issuer.issue(REQUEST));
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});
