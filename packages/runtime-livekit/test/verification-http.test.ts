/**
 * Verification through the real HTTP adapter against a local stub backend that implements correct
 * server-side binding checks. Proves authenticated server-to-server calls and fail-closed behaviour.
 */
import { createHttpBackend, defineApplication } from '@voicebridge/core';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyLiveKitSession } from '../src/verification.ts';
import { APP_ID, ROOM, SESSION_REF, metadata } from './fakes.ts';

const CREDENTIAL = 'svc_synthetic_help_desk_credential_01';
type Handler = (
  req: { url: string; headers: Record<string, unknown>; body: unknown },
  res: import('node:http').ServerResponse,
) => void;

let server: ReturnType<typeof createServer> | undefined;
afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
});

const requests: Array<{ url: string; headers: Record<string, unknown>; body: unknown }> = [];
async function stub(handler: Handler): Promise<string> {
  requests.length = 0;
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      const rec = {
        url: req.url ?? '',
        headers: req.headers as Record<string, unknown>,
        body: raw ? JSON.parse(raw) : undefined,
      };
      requests.push(rec);
      handler(rec, res);
    });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

/** Correct backend logic: credential, active binding, application, and room must all match. */
const correctBackend: Handler = (req, res) => {
  const body = req.body as { sessionRef?: string; runtimeBinding?: { roomName?: string } };
  const ok =
    req.headers.authorization === `Bearer ${CREDENTIAL}` &&
    body.sessionRef === SESSION_REF &&
    body.runtimeBinding?.roomName === ROOM;
  res.writeHead(ok ? 200 : 403, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify(
      ok ? { authorized: true, greeting: { kind: 'speak', text: 'Hi.' } } : { error: 'forbidden' },
    ),
  );
};

function app(baseUrl: string, timeoutMs = 2000) {
  const backend = createHttpBackend({
    applicationId: APP_ID,
    baseUrl,
    serviceCredential: CREDENTIAL,
    timeoutMs,
    endpoints: { sessionStart: '/v0/sessions/start' },
  });
  return defineApplication({ applicationId: APP_ID, conversation: backend.conversation() });
}

const job = (over: Partial<{ id: string; metadata: string; room: { name: string } }> = {}) => ({
  id: 'AJ_http1',
  metadata: metadata(),
  room: { name: ROOM },
  ...over,
});

describe('verification over the authenticated HTTP sessions/start', () => {
  it('authorizes with credential, binding, and idempotency key', async () => {
    const base = await stub(correctBackend);
    const outcome = await verifyLiveKitSession({ job: job(), application: app(base) });
    expect(outcome).toMatchObject({ ok: true, startResult: { authorized: true } });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('/v0/sessions/start');
    expect(requests[0]?.body).toEqual({
      sessionRef: SESSION_REF,
      runtimeBinding: { runtime: 'livekit', roomName: ROOM },
    });
    expect(requests[0]?.headers.authorization).toBe(`Bearer ${CREDENTIAL}`);
    expect(requests[0]?.headers['idempotency-key']).toBe('AJ_http1:start');
  });

  it('is refused when the actual room differs from the stored binding', async () => {
    const base = await stub(correctBackend);
    expect(
      await verifyLiveKitSession({
        job: job({ room: { name: 'vb_attackerRoom' } }),
        application: app(base),
      }),
    ).toEqual({
      ok: false,
      reason: 'session_not_authorized',
    });
  });

  it.each([
    ['500', (res: import('node:http').ServerResponse) => (res.writeHead(500), res.end())],
    [
      '200 greeting without authorization',
      (res: import('node:http').ServerResponse) => (
        res.writeHead(200, { 'content-type': 'application/json' }),
        res.end('{"kind":"speak","text":"hi"}')
      ),
    ],
    [
      '200 non-JSON',
      (res: import('node:http').ServerResponse) => (res.writeHead(200), res.end('<html>')),
    ],
    [
      '302 redirect',
      (res: import('node:http').ServerResponse) => (
        res.writeHead(302, { location: 'https://evil.invalid' }),
        res.end()
      ),
    ],
  ])('fails closed on %s', async (_name, respond) => {
    const base = await stub((_req, res) => void respond(res));
    const outcome = await verifyLiveKitSession({ job: job(), application: app(base) });
    expect(outcome.ok).toBe(false);
  });

  it('fails closed on a network error', async () => {
    const outcome = await verifyLiveKitSession({
      job: job(),
      application: app('http://127.0.0.1:1'),
    });
    expect(outcome).toEqual({ ok: false, reason: 'verification_unavailable' });
  });

  it('fails closed on a slow backend', async () => {
    const base = await stub(() => {}); // never responds
    const outcome = await verifyLiveKitSession({
      job: job(),
      application: app(base, 5000),
      timeoutMs: 50,
    });
    expect(outcome).toEqual({ ok: false, reason: 'verification_timeout' });
  });
});
