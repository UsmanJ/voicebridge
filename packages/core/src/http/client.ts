import { VoiceBridgeError } from '../errors.ts';

export interface PostJsonOptions {
  url: string;
  body: unknown;
  headers: Readonly<Record<string, string>>;
  timeoutMs: number;
  maxResponseBytes: number;
  /** External cancellation (superseded turn, session end). */
  signal?: AbortSignal;
  fetch?: typeof fetch;
}

export interface JsonResponse {
  status: number;
  /** Parsed JSON, or `undefined` for 204 and empty bodies. */
  body: unknown;
}

/**
 * POSTs JSON with a timeout, an external abort signal, a response size cap, and no redirects.
 *
 * Failures map to the VoiceBridge error taxonomy. Error messages never include the URL,
 * credentials, request or response bodies, or headers.
 */
export async function postJson(options: PostJsonOptions): Promise<JsonResponse> {
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const doFetch = options.fetch ?? fetch;

  const classifyAbort = (cause: unknown): VoiceBridgeError =>
    options.signal?.aborted
      ? new VoiceBridgeError('cancelled', 'request cancelled', { cause })
      : new VoiceBridgeError('backend_timeout', `no response within ${options.timeoutMs} ms`, {
          cause,
        });

  let response: Response;
  try {
    response = await doFetch(options.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        ...options.headers,
      },
      body: JSON.stringify(options.body),
      redirect: 'error',
      signal,
    });
  } catch (cause) {
    if (signal.aborted) throw classifyAbort(cause);
    throw new VoiceBridgeError('backend_unavailable', 'backend request failed', { cause });
  }

  if (response.status < 200 || response.status > 299) {
    await response.body?.cancel().catch(() => {});
    throw new VoiceBridgeError(
      'backend_rejected',
      `backend responded with status ${response.status}`,
    );
  }

  let text: string;
  try {
    text = await readCapped(response, options.maxResponseBytes);
  } catch (cause) {
    if (cause instanceof VoiceBridgeError) throw cause;
    if (signal.aborted) throw classifyAbort(cause);
    throw new VoiceBridgeError('backend_unavailable', 'failed to read backend response', { cause });
  }

  if (response.status === 204 || text.length === 0)
    return { status: response.status, body: undefined };
  try {
    return { status: response.status, body: JSON.parse(text) as unknown };
  } catch {
    throw new VoiceBridgeError('invalid_backend_reply', 'backend response is not valid JSON');
  }
}

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new VoiceBridgeError('response_too_large', `response exceeds ${maxBytes} bytes`);
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new VoiceBridgeError('response_too_large', `response exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(chunks));
}
