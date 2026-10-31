import { WIRE_V0_SCHEMAS } from '@voicebridge/core';
import { loadConformanceVectorsV0 } from '@voicebridge/core/testing';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createHelpDeskBackend } from '../src/backend.ts';
import { FALLBACK_ANSWER, FAQ, GOODBYE, GREETING, SESSION_INACTIVE } from '../src/faq.ts';
import { InMemorySessionStore } from '../src/session-store.ts';

const A = {
  applicationId: 'help-desk',
  workerCredential: 'wkr_A_'.padEnd(40, 'a'),
  hostCredential: 'hst_A_'.padEnd(40, 'b'),
};
const B = {
  applicationId: 'other-app',
  workerCredential: 'wkr_B_'.padEnd(40, 'c'),
  hostCredential: 'hst_B_'.padEnd(40, 'd'),
};
const ROOM = 'vb_room_synthetic_000000001';

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function start(opts: { now?: () => number; ttlMs?: number } = {}) {
  const logs: string[] = [];
  const store = new InMemorySessionStore({
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.ttlMs ? { ttlMs: opts.ttlMs } : {}),
  });
  const { handler } = createHelpDeskBackend({
    applications: [A, B],
    store,
    logger: (e, f) => logs.push(JSON.stringify({ e, ...f })),
  });
  const server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => new Promise((r) => server.close(() => r()));
  const responses: string[] = [];
  const call = async (
    path: string,
    credential: string | undefined,
    body: unknown,
    headers: Record<string, string> = {},
  ) => {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(path.startsWith('/v0/') ? { 'voicebridge-version': '0' } : {}),
        ...(credential ? { authorization: `Bearer ${credential}` } : {}),
        ...headers,
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await res.text();
    responses.push(text);
    return {
      status: res.status,
      json: text ? (JSON.parse(text) as Record<string, unknown>) : undefined,
    };
  };
  const host = (path: string, body: unknown, app = A) =>
    call(`/internal/v0/sessions${path}`, app.hostCredential, body);
  const wire = (path: string, body: unknown, app = A, headers?: Record<string, string>) =>
    call(`/v0/${path}`, app.workerCredential, body, headers);
  /** Creates a session and binds it to ROOM, as the host's token route does. */
  const issued = async (app = A) => {
    const created = await host('', { subject: 'user_synthetic_1' }, app);
    const sessionRef = created.json!.sessionRef as string;
    expect((await host('/attach-room', { sessionRef, roomName: ROOM }, app)).status).toBe(204);
    return sessionRef;
  };
  const started = async (app = A) => {
    const sessionRef = await issued(app);
    expect(
      (
        await wire(
          'sessions/start',
          { sessionRef, runtimeBinding: { runtime: 'livekit', roomName: ROOM } },
          app,
        )
      ).status,
    ).toBe(200);
    return sessionRef;
  };
  const turn = (sessionRef: string, text: string, app = A) =>
    wire('turns', { turnId: 't1', sessionRef, text, source: 'speech' }, app);
  return { base, store, logs, responses, call, host, wire, issued, started, turn };
}

describe('session creation and room binding', () => {
  it('creates an opaque 256-bit session ref bound to the application, then binds the room once', async () => {
    const s = await start();
    const created = await s.host('', { subject: 'user_synthetic_1' });
    expect(created.status).toBe(201);
    const ref = created.json!.sessionRef as string;
    expect(ref).toMatch(/^sr_[A-Za-z0-9_-]{43}$/);
    expect(s.store.inspect(ref)).toMatchObject({ applicationId: 'help-desk', status: 'active' });
    expect((await s.host('/verify-issuance', { sessionRef: ref })).json).toEqual({
      issuable: true,
    });
    expect((await s.host('/attach-room', { sessionRef: ref, roomName: ROOM })).status).toBe(204);
    expect(s.store.inspect(ref)?.roomName).toBe(ROOM);
  });

  it('never overwrites a room binding: repeated issuance is refused (replay protection)', async () => {
    const s = await start();
    const ref = await s.issued();
    expect((await s.host('/verify-issuance', { sessionRef: ref })).json).toEqual({
      issuable: false,
    });
    const again = await s.host('/attach-room', { sessionRef: ref, roomName: 'vb_attacker_room' });
    expect(again).toEqual({ status: 409, json: { error: 'room_already_bound' } });
    expect(s.store.inspect(ref)?.roomName).toBe(ROOM);
  });

  it('lets exactly one of many concurrent issuance attempts bind the room', async () => {
    const s = await start();
    const ref = (await s.host('', { subject: 'user_synthetic_1' })).json!.sessionRef as string;
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        s.host('/attach-room', { sessionRef: ref, roomName: `vb_room_${i}` }),
      ),
    );
    expect(results.filter((r) => r.status === 204)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(11);
    const winner = results.findIndex((r) => r.status === 204);
    expect(s.store.inspect(ref)?.roomName).toBe(`vb_room_${winner}`);
  });

  it('rejects subjects that are not opaque ids', async () => {
    const s = await start();
    expect((await s.host('', { subject: 'jane.doe@example.com' })).status).toBe(400);
    expect((await s.host('', { subject: 'Jane Doe' })).status).toBe(400);
  });
});

describe('sessions/start authorization', () => {
  const startBody = (sessionRef: string, roomName = ROOM) => ({
    sessionRef,
    runtimeBinding: { runtime: 'livekit', roomName },
  });

  it('authorizes a bound session in its room and returns the greeting', async () => {
    const s = await start();
    const ref = await s.issued();
    const r = await s.wire('sessions/start', startBody(ref));
    expect(r).toEqual({
      status: 200,
      json: { authorized: true, greeting: { kind: 'speak', text: GREETING } },
    });
  });

  it('is idempotent per logical session across different job ids (one side effect)', async () => {
    const s = await start();
    const ref = await s.issued();
    const first = await s.wire('sessions/start', startBody(ref), A, {
      'idempotency-key': 'AJ_job1:start',
    });
    const second = await s.wire('sessions/start', startBody(ref), A, {
      'idempotency-key': 'AJ_job2:start',
    });
    expect(first).toEqual(second);
    expect(s.store.inspect(ref)?.startEffects).toBe(1);
  });

  it.each([
    ['wrong room', (ref: string) => startBody(ref, 'vb_other_room')],
    ['no runtime binding', (ref: string) => ({ sessionRef: ref })],
  ])('refuses %s', async (_name, body) => {
    const s = await start();
    const ref = await s.issued();
    expect(await s.wire('sessions/start', body(ref))).toEqual({
      status: 403,
      json: { error: 'session_not_authorized' },
    });
  });

  it('refuses a session that never had a room bound', async () => {
    const s = await start();
    const ref = (await s.host('', { subject: 'user_synthetic_1' })).json!.sessionRef as string;
    expect((await s.wire('sessions/start', startBody(ref))).status).toBe(403);
  });

  it('refuses revoked, ended, expired, and unknown sessions', async () => {
    let now = 1_000_000;
    const s = await start({ now: () => now, ttlMs: 60_000 });
    const revoked = await s.issued();
    await s.host('/revoke', { sessionRef: revoked });
    const ended = await s.started();
    expect(
      (await s.wire('sessions/end', { sessionRef: ended, reason: 'client_left' })).status,
    ).toBe(204);
    const expired = await s.issued();
    now += 61_000;
    for (const ref of [revoked, ended, expired, 'sr_unknown_000000000000000000000']) {
      expect((await s.wire('sessions/start', startBody(ref))).status).toBe(403);
    }
  });

  it("refuses another application's session without revealing it exists", async () => {
    const s = await start();
    const refB = await s.issued(B);
    const viaA = await s.wire('sessions/start', startBody(refB), A);
    expect(viaA).toEqual({ status: 403, json: { error: 'session_not_authorized' } });
    expect((await s.turn(refB, 'opening hours', A)).status).toBe(403);
    expect((await s.host('/revoke', { sessionRef: refB }, A)).status).toBe(404);
    expect((await s.host('/verify-issuance', { sessionRef: refB }, A)).json).toEqual({
      issuable: false,
    });
  });
});

describe('turns', () => {
  it.each(FAQ.map((e) => [e.id, e] as const))(
    'answers "%s" verbatim from the knowledge base',
    async (_id, entry) => {
      const s = await start();
      const ref = await s.started();
      const r = await s.turn(ref, `Can you tell me about ${entry.keywords[0]}?`);
      expect(r).toEqual({ status: 200, json: { kind: 'speak', text: entry.answer } });
    },
  );

  it('falls back deterministically, and ends on goodbye', async () => {
    const s = await start();
    const ref = await s.started();
    expect((await s.turn(ref, 'Tell me a joke')).json).toEqual({
      kind: 'speak',
      text: FALLBACK_ANSWER,
    });
    expect((await s.turn(ref, "That's all, goodbye.")).json).toEqual({
      kind: 'end',
      text: GOODBYE,
    });
  });

  it('rechecks authorization on every turn: revocation between turns ends the session', async () => {
    const s = await start();
    const ref = await s.started();
    expect((await s.turn(ref, 'opening hours')).json?.kind).toBe('speak');
    await s.host('/revoke', { sessionRef: ref });
    expect(await s.turn(ref, 'returns')).toEqual({
      status: 200,
      json: { kind: 'end', text: SESSION_INACTIVE },
    });
  });

  it('ends turns for an expired session, and refuses turns before start', async () => {
    let now = 5_000_000;
    const s = await start({ now: () => now, ttlMs: 60_000 });
    const ref = await s.started();
    now += 60_001;
    expect((await s.turn(ref, 'hours')).json).toEqual({ kind: 'end', text: SESSION_INACTIVE });
    const notStarted = await s.issued();
    expect((await s.turn(notStarted, 'hours')).status).toBe(403);
  });
});

describe('authentication and API errors', () => {
  it('requires the right credential for each route family (least privilege)', async () => {
    const s = await start();
    const ref = await s.issued();
    const body = { sessionRef: ref, runtimeBinding: { runtime: 'livekit', roomName: ROOM } };
    expect((await s.call('/v0/sessions/start', undefined, body)).status).toBe(401);
    expect(
      (await s.call('/v0/sessions/start', 'not-a-real-credential-00000000000000', body)).status,
    ).toBe(401);
    expect((await s.call('/v0/sessions/start', A.hostCredential, body)).status).toBe(403); // host cred on wire route
    expect(
      (await s.call('/internal/v0/sessions', A.workerCredential, { subject: 'x' })).status,
    ).toBe(403); // worker cred on internal
  });

  it('rejects malformed JSON, oversized bodies, wrong versions, methods, and routes', async () => {
    const s = await start();
    expect((await s.call('/v0/turns', A.workerCredential, '{not json')).status).toBe(400);
    expect(
      (await s.call('/v0/turns', A.workerCredential, { pad: 'x'.repeat(20_000) })).status,
    ).toBe(413);
    expect(
      (await s.call('/v0/turns', A.workerCredential, {}, { 'voicebridge-version': '9' })).status,
    ).toBe(400);
    expect((await s.call('/v0/nope', A.workerCredential, {})).status).toBe(404);
    expect((await fetch(`${s.base}/v0/turns`)).status).toBe(405);
    expect((await fetch(`${s.base}/healthz`)).status).toBe(200);
  });

  it('refuses to start with weak or shared credentials', () => {
    expect(() =>
      createHelpDeskBackend({ applications: [{ ...A, workerCredential: 'short' }] }),
    ).toThrow();
    expect(() =>
      createHelpDeskBackend({ applications: [{ ...A, hostCredential: A.workerCredential }] }),
    ).toThrow();
    expect(() => createHelpDeskBackend({ applications: [] })).toThrow();
  });

  it('never puts credentials, session refs, user text, or rooms in responses or logs', async () => {
    const s = await start();
    const ref = await s.started();
    await s.turn(ref, 'my card number is 4111 1111 1111 1111');
    await s.call('/v0/turns', 'wrong-credential-'.padEnd(40, 'z'), {});
    await s.wire('sessions/start', {
      sessionRef: ref,
      runtimeBinding: { runtime: 'livekit', roomName: 'vb_x' },
    });
    const errorBodies = s.responses.filter((r) => r.includes('"error"')).join('\n');
    const logs = s.logs.join('\n');
    for (const secret of [A.workerCredential, A.hostCredential, B.workerCredential, '4111', ROOM]) {
      expect(errorBodies).not.toContain(secret);
      expect(logs).not.toContain(secret);
    }
    expect(logs).not.toContain(ref);
  });
});

describe('wire contract v0 conformance', () => {
  const vectors = loadConformanceVectorsV0().vectors;

  it('every backend response to the worker conforms to the v0 schemas', async () => {
    const s = await start();
    const ref = await s.issued();
    const startRes = await s.wire('sessions/start', {
      sessionRef: ref,
      runtimeBinding: { runtime: 'livekit', roomName: ROOM },
    });
    expect(WIRE_V0_SCHEMAS.sessionStartResponse.safeParse(startRes.json).success).toBe(true);
    for (const text of ['opening hours', 'returns', 'what?', 'goodbye']) {
      const r = await s.turn(ref, text);
      expect(WIRE_V0_SCHEMAS.turnReply.safeParse(r.json).success, text).toBe(true);
    }
  });

  it.each(
    vectors
      .filter(
        (v) =>
          !v.valid &&
          ['turnRequest', 'sessionStartRequest', 'sessionEndRequest'].includes(v.schema),
      )
      .map((v) => [v.name, v] as const),
  )('rejects invalid request vector: %s', async (_name, vector) => {
    const s = await start();
    const path = {
      turnRequest: 'turns',
      sessionStartRequest: 'sessions/start',
      sessionEndRequest: 'sessions/end',
    }[vector.schema as 'turnRequest'];
    expect((await s.wire(path, vector.value)).status).toBe(400);
  });

  it.each(
    vectors
      .filter((v) => v.valid && ['turnRequest', 'sessionStartRequest'].includes(v.schema))
      .map((v) => [v.name, v] as const),
  )(
    'accepts the shape of valid request vector (refused only by authorization): %s',
    async (_name, vector) => {
      const s = await start();
      const path = vector.schema === 'turnRequest' ? 'turns' : 'sessions/start';
      // The vectors' sessionRef doesn't exist here, so a valid shape must reach authorization (403), not 400.
      expect((await s.wire(path, vector.value)).status).toBe(403);
    },
  );
});
