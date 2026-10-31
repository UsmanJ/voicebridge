import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createHttpBackend } from '../src/http/backend.ts';
import { parseBackendBaseUrl } from '../src/http/url.ts';
import { createToolExecutor } from '../src/tools/executor.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import { APP_ID, SERVICE_CREDENTIAL, ctx, json, startStubServer, tick } from './helpers.ts';

type Stub = Awaited<ReturnType<typeof startStubServer>>;
let stub: Stub | undefined;
afterEach(async () => {
  await stub?.close();
  stub = undefined;
});

const turn = { turnId: 't1', text: 'What are your hours?', source: 'speech' as const };

function backend(baseUrl: string, extra: Partial<Parameters<typeof createHttpBackend>[0]> = {}) {
  return createHttpBackend({
    applicationId: APP_ID,
    baseUrl,
    serviceCredential: SERVICE_CREDENTIAL,
    ...extra,
  });
}

async function capture(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (e) {
    return e as Error & { code?: string };
  }
  throw new Error('expected rejection');
}

describe('parseBackendBaseUrl', () => {
  it.each([
    'https://api.example.com',
    'https://api.example.com/base/',
    'http://localhost:8787',
    'http://127.0.0.1:1',
    'http://[::1]:9',
  ])('accepts %s', (url) => expect(() => parseBackendBaseUrl(url)).not.toThrow());
  it.each([
    'http://api.example.com', // plain http to a non-loopback host
    'ftp://example.com',
    'https://user:pass@example.com',
    'https://example.com/?redirect=x',
    'https://example.com/#frag',
    'not a url',
    'file:///etc/passwd',
  ])('rejects %s', (url) => {
    expect(() => parseBackendBaseUrl(url)).toThrowError(
      expect.objectContaining({ code: 'config_error' }),
    );
  });
  it('strips trailing slashes', () =>
    expect(parseBackendBaseUrl('https://a.example/b//')).toBe('https://a.example/b'));
});

describe('createHttpBackend: configuration', () => {
  it.each(['short', 'has whitespace in it 1234567', ''])(
    'rejects weak or malformed credential %j',
    (c) => {
      expect(() => backend('https://a.example', { serviceCredential: c })).toThrow();
    },
  );
  it.each(['../admin', 'no-leading-slash', '/a//b', '/a/../b', '/a?b=1'])(
    'rejects unsafe endpoint path %j',
    (p) => {
      expect(() => backend('https://a.example', { endpoints: { turns: p } })).toThrow();
    },
  );
  it('makes capabilities optional: a tool-only backend has no conversation adapter', () => {
    expect(() =>
      backend('https://a.example', { endpoints: { turns: false } }).conversation(),
    ).toThrowError(expect.objectContaining({ code: 'mode_not_supported' }));
  });
  it('only exposes session start/end when configured', () => {
    const plain = backend('https://a.example').conversation();
    expect(plain.start).toBeUndefined();
    expect(plain.end).toBeUndefined();
    const full = backend('https://a.example', {
      endpoints: { sessionStart: '/v0/sessions/start', sessionEnd: '/v0/sessions/end' },
    }).conversation();
    expect(full.start).toBeTypeOf('function');
    expect(full.end).toBeTypeOf('function');
  });
});

describe('createHttpBackend: turns', () => {
  it('posts the wire request with auth, version, request id, and idempotency headers', async () => {
    stub = await startStubServer((_req, res) =>
      json(res, 200, { kind: 'speak', text: 'Nine to five.' }),
    );
    const reply = await backend(stub.baseUrl)
      .conversation()
      .respond(turn, ctx(), new AbortController().signal);
    expect(reply).toEqual({ kind: 'speak', text: 'Nine to five.' });
    const req = stub.requests[0]!;
    expect(req.url).toBe('/v0/turns');
    expect(req.body).toEqual({
      turnId: 't1',
      sessionRef: ctx().sessionRef,
      text: 'What are your hours?',
      source: 'speech',
    });
    expect(req.headers.authorization).toBe(`Bearer ${SERVICE_CREDENTIAL}`);
    expect(req.headers['voicebridge-version']).toBe('0');
    expect(req.headers['voicebridge-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(req.headers['idempotency-key']).toBe('sess-1:t1');
    expect(req.body).not.toHaveProperty('applicationId'); // identity comes from the credential, not the body
  });

  it('maps non-2xx to backend_rejected without exposing the body', async () => {
    stub = await startStubServer((_req, res) =>
      json(res, 500, { stack: 'at db.ts:42 password=hunter2' }),
    );
    const err = await capture(
      backend(stub.baseUrl).conversation().respond(turn, ctx(), new AbortController().signal),
    );
    expect(err.code).toBe('backend_rejected');
    expect(err.message).not.toContain('hunter2');
  });

  it('rejects schema-invalid replies', async () => {
    stub = await startStubServer((_req, res) =>
      json(res, 200, { kind: 'speak', text: 'ok', extra: true }),
    );
    const err = await capture(
      backend(stub.baseUrl).conversation().respond(turn, ctx(), new AbortController().signal),
    );
    expect(err.code).toBe('invalid_backend_reply');
  });

  it('rejects non-JSON replies', async () => {
    stub = await startStubServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>login page</html>');
    });
    const err = await capture(
      backend(stub.baseUrl).conversation().respond(turn, ctx(), new AbortController().signal),
    );
    expect(err.code).toBe('invalid_backend_reply');
  });

  it('enforces the response size cap (declared and streamed)', async () => {
    stub = await startStubServer((_req, res) =>
      json(res, 200, { kind: 'speak', text: 'x'.repeat(5000) }),
    );
    const err = await capture(
      backend(stub.baseUrl, { maxResponseBytes: 1024 })
        .conversation()
        .respond(turn, ctx(), new AbortController().signal),
    );
    expect(err.code).toBe('response_too_large');

    await stub.close();
    stub = await startStubServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' }); // chunked, no content-length
      res.write('{"kind":"speak","text":"');
      res.end(`${'y'.repeat(5000)}"}`);
    });
    const err2 = await capture(
      backend(stub.baseUrl, { maxResponseBytes: 1024 })
        .conversation()
        .respond(turn, ctx(), new AbortController().signal),
    );
    expect(err2.code).toBe('response_too_large');
  });

  it('times out and closes the connection', async () => {
    stub = await startStubServer(() => {}); // never responds
    const err = await capture(
      backend(stub.baseUrl, { timeoutMs: 50 })
        .conversation()
        .respond(turn, ctx(), new AbortController().signal),
    );
    expect(err.code).toBe('backend_timeout');
    await tick(30);
    expect(stub.requests[0]?.aborted).toBe(true);
  });

  it('distinguishes cancellation from timeout and aborts the request', async () => {
    stub = await startStubServer(() => {});
    const controller = new AbortController();
    const pending = backend(stub.baseUrl).conversation().respond(turn, ctx(), controller.signal);
    await tick(30);
    controller.abort();
    expect((await capture(pending)).code).toBe('cancelled');
    await tick(30);
    expect(stub.requests[0]?.aborted).toBe(true);
  });

  it('refuses to follow redirects', async () => {
    stub = await startStubServer((_req, res) => {
      res.writeHead(302, { location: 'https://evil.example/steal' });
      res.end();
    });
    const err = await capture(
      backend(stub.baseUrl).conversation().respond(turn, ctx(), new AbortController().signal),
    );
    expect(['backend_unavailable', 'backend_rejected']).toContain(err.code);
  });

  it('reports an unreachable backend as backend_unavailable', async () => {
    const err = await capture(
      backend('http://127.0.0.1:1')
        .conversation()
        .respond(turn, ctx(), new AbortController().signal),
    );
    expect(err.code).toBe('backend_unavailable');
  });

  it('never includes the service credential in errors', async () => {
    stub = await startStubServer((_req, res) => json(res, 401, { error: 'bad token' }));
    const err = await capture(
      backend(stub.baseUrl).conversation().respond(turn, ctx(), new AbortController().signal),
    );
    expect(`${err.message} ${String(err.cause ?? '')} ${JSON.stringify(err)}`).not.toContain(
      SERVICE_CREDENTIAL,
    );
  });

  it('sends session start and end when configured', async () => {
    stub = await startStubServer((req, res) => {
      if (req.url === '/v0/sessions/end') {
        res.writeHead(204);
        res.end();
      } else {
        json(res, 200, { authorized: true, greeting: { kind: 'speak', text: 'Hello!' } });
      }
    });
    const conv = backend(stub.baseUrl, {
      endpoints: { sessionStart: '/v0/sessions/start', sessionEnd: '/v0/sessions/end' },
    }).conversation();
    await expect(conv.start!(ctx(), new AbortController().signal)).resolves.toEqual({
      authorized: true,
      greeting: { kind: 'speak', text: 'Hello!' },
    });
    await conv.end!(ctx(), 'client_left');
    expect(stub.requests.map((r) => [r.url, r.body])).toEqual([
      ['/v0/sessions/start', { sessionRef: ctx().sessionRef }],
      ['/v0/sessions/end', { sessionRef: ctx().sessionRef, reason: 'client_left' }],
    ]);
    expect(stub.requests[0]?.headers['idempotency-key']).toBe('sess-1:start');
  });

  it('sends the runtime binding (actual room) on session start', async () => {
    stub = await startStubServer((_req, res) => json(res, 200, { authorized: true }));
    const conv = backend(stub.baseUrl, {
      endpoints: { sessionStart: '/v0/sessions/start' },
    }).conversation();
    const bound = ctx({ runtimeBinding: { runtime: 'livekit', roomName: 'vb_room123' } });
    await expect(conv.start!(bound, new AbortController().signal)).resolves.toEqual({
      authorized: true,
    });
    expect(stub.requests[0]?.body).toEqual({
      sessionRef: ctx().sessionRef,
      runtimeBinding: { runtime: 'livekit', roomName: 'vb_room123' },
    });
  });

  it.each([
    ['a greeting without explicit authorization', 200, { kind: 'speak', text: 'Hi' }],
    ['authorized: false', 200, { authorized: false }],
    ['an empty body', 204, undefined],
    ['extra fields', 200, { authorized: true, userId: 'u_1' }],
    ['403 forbidden', 403, { error: 'revoked' }],
    ['404 unknown session', 404, { error: 'not found' }],
    ['500 server error', 500, { error: 'db down' }],
  ])('fails closed on session start with %s', async (_name, status, body) => {
    stub = await startStubServer((_req, res) => {
      if (body === undefined) {
        res.writeHead(status);
        res.end();
      } else {
        json(res, status, body);
      }
    });
    const conv = backend(stub.baseUrl, {
      endpoints: { sessionStart: '/v0/sessions/start' },
    }).conversation();
    const err = await capture(conv.start!(ctx(), new AbortController().signal));
    expect(['invalid_backend_reply', 'backend_rejected']).toContain(err.code);
  });

  it('fails closed when session start times out', async () => {
    stub = await startStubServer(() => {});
    const conv = backend(stub.baseUrl, {
      timeoutMs: 50,
      endpoints: { sessionStart: '/v0/sessions/start' },
    }).conversation();
    expect((await capture(conv.start!(ctx(), new AbortController().signal))).code).toBe(
      'backend_timeout',
    );
  });
});

describe('createHttpBackend: tools', () => {
  function taskTools(baseUrl: string) {
    const be = backend(baseUrl, { endpoints: { turns: false } });
    return ToolRegistry.from([
      be.tool({
        name: 'add_task',
        description: 'Add a task.',
        effect: 'write',
        path: '/tools/add-task',
        input: z.object({ title: z.string().min(1) }),
        output: z.object({ taskId: z.string() }),
      }),
    ]);
  }

  it('posts validated arguments with the invocation id as idempotency key', async () => {
    stub = await startStubServer((_req, res) =>
      json(res, 200, { ok: true, result: { taskId: 'task_9' } }),
    );
    const exec = createToolExecutor({ registry: taskTools(stub.baseUrl), session: ctx() });
    await expect(
      exec.execute('add_task', { title: 'Buy milk' }, { invocationId: 'call_7' }),
    ).resolves.toEqual({
      ok: true,
      result: { taskId: 'task_9' },
    });
    const req = stub.requests[0]!;
    expect(req.url).toBe('/tools/add-task');
    expect(req.body).toEqual({
      invocationId: 'call_7',
      sessionRef: ctx().sessionRef,
      arguments: { title: 'Buy milk' },
    });
    expect(req.headers['idempotency-key']).toBe('call_7');
  });

  it('passes the backend-approved error code and public message to the LLM', async () => {
    stub = await startStubServer((_req, res) =>
      json(res, 200, {
        ok: false,
        error: { code: 'not_found', publicMessage: "I couldn't find that task." },
      }),
    );
    const exec = createToolExecutor({ registry: taskTools(stub.baseUrl), session: ctx() });
    await expect(exec.execute('add_task', { title: 'x' })).resolves.toEqual({
      ok: false,
      error: {
        code: 'tool_failed',
        applicationCode: 'not_found',
        publicMessage: "I couldn't find that task.",
      },
    });
  });

  it('never contacts the backend when arguments are invalid', async () => {
    stub = await startStubServer((_req, res) =>
      json(res, 200, { ok: true, result: { taskId: 'x' } }),
    );
    const exec = createToolExecutor({ registry: taskTools(stub.baseUrl), session: ctx() });
    await exec.execute('add_task', { title: '' });
    expect(stub.requests).toHaveLength(0);
  });

  it('rejects tool results that violate the wire or output schema', async () => {
    stub = await startStubServer((_req, res) => json(res, 200, { ok: true, result: { wrong: 1 } }));
    const exec = createToolExecutor({ registry: taskTools(stub.baseUrl), session: ctx() });
    const outcome = await exec.execute('add_task', { title: 'x' });
    expect(!outcome.ok && outcome.error.code).toBe('invalid_tool_result');
  });
});
