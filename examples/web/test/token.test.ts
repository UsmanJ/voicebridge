import { describe, expect, it, vi } from 'vitest';
import { toUserFacingError } from '../src/errors';
import { TokenRequestError, fetchSessionCredentials } from '../src/token';

const ENDPOINT = 'http://127.0.0.1:8790/api/voice/token';
// A synthetic, unsigned JWT-shaped value built at runtime (not a real credential).
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
const TOKEN = [b64({ alg: 'none' }), b64({ synthetic: true }), 'synthetic'].join('.');
const ok = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

async function kindOf(p: Promise<unknown>) {
  try {
    await p;
    return 'resolved';
  } catch (e) {
    expect(e).toBeInstanceOf(TokenRequestError);
    return (e as TokenRequestError).kind;
  }
}

describe('fetchSessionCredentials', () => {
  it('POSTs without a body or cookies and maps the standard response', async () => {
    const fetchImpl = vi.fn(async () =>
      ok({ server_url: 'wss://synthetic.livekit.invalid', participant_token: TOKEN }),
    );
    const result = await fetchSessionCredentials({
      endpoint: ENDPOINT,
      timeoutMs: 1000,
      fetchImpl,
    });
    expect(result).toEqual({
      serverUrl: 'wss://synthetic.livekit.invalid',
      participantToken: TOKEN,
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(ENDPOINT);
    expect(init).toMatchObject({
      method: 'POST',
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
    });
    expect(init.body).toBeUndefined();
    expect(init.headers).toBeUndefined();
  });

  it.each([
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [429, 'rate_limited'],
    [409, 'unavailable'],
    [500, 'unavailable'],
    [503, 'unavailable'],
  ])('maps HTTP %i to %s without exposing the body', async (status, kind) => {
    const fetchImpl = vi.fn(
      async () => new Response('{"error":"internal detail: db at 10.0.0.5"}', { status }),
    );
    const p = fetchSessionCredentials({ endpoint: ENDPOINT, timeoutMs: 1000, fetchImpl });
    const error = await p.catch((e: unknown) => e);
    expect((error as TokenRequestError).kind).toBe(kind);
    expect(String((error as Error).message)).not.toContain('10.0.0.5');
    expect(toUserFacingError(error).message).not.toContain('10.0.0.5');
  });

  it.each([
    ['missing token', { server_url: 'wss://x.livekit.invalid' }],
    ['non-JWT token', { server_url: 'wss://x.livekit.invalid', participant_token: 'abc' }],
    ['plain ws to a remote host', { server_url: 'ws://evil.example', participant_token: TOKEN }],
    ['javascript URL', { server_url: 'javascript:alert(1)', participant_token: TOKEN }],
    [
      'oversized token',
      { server_url: 'wss://x.livekit.invalid', participant_token: `${'a'.repeat(9000)}.b.c` },
    ],
  ])('rejects an invalid response (%s)', async (_label, body) => {
    const fetchImpl = vi.fn(async () => ok(body));
    expect(
      await kindOf(fetchSessionCredentials({ endpoint: ENDPOINT, timeoutMs: 1000, fetchImpl })),
    ).toBe('invalid_response');
  });

  it('rejects non-JSON and oversized bodies', async () => {
    for (const body of ['<html>not json</html>', JSON.stringify({ pad: 'x'.repeat(20_000) })]) {
      const fetchImpl = vi.fn(async () => new Response(body, { status: 200 }));
      expect(
        await kindOf(fetchSessionCredentials({ endpoint: ENDPOINT, timeoutMs: 1000, fetchImpl })),
      ).toBe('invalid_response');
    }
  });

  it('accepts ws:// only for a local LiveKit dev server', async () => {
    const fetchImpl = vi.fn(async () =>
      ok({ server_url: 'ws://localhost:7880', participant_token: TOKEN }),
    );
    await expect(
      fetchSessionCredentials({ endpoint: ENDPOINT, timeoutMs: 1000, fetchImpl }),
    ).resolves.toMatchObject({ serverUrl: 'ws://localhost:7880' });
  });

  it('distinguishes network failure, timeout, and caller abort', async () => {
    const network = vi.fn(async () => Promise.reject(new TypeError('Failed to fetch')));
    expect(
      await kindOf(
        fetchSessionCredentials({ endpoint: ENDPOINT, timeoutMs: 1000, fetchImpl: network }),
      ),
    ).toBe('network');

    const hang = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_r, reject) =>
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          ),
        ),
    );
    expect(
      await kindOf(fetchSessionCredentials({ endpoint: ENDPOINT, timeoutMs: 20, fetchImpl: hang })),
    ).toBe('timeout');

    const controller = new AbortController();
    const p = fetchSessionCredentials({
      endpoint: ENDPOINT,
      timeoutMs: 5000,
      fetchImpl: hang,
      signal: controller.signal,
    });
    controller.abort();
    expect(await kindOf(p)).toBe('aborted');
  });
});
