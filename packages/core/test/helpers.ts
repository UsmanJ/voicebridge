import { type IncomingHttpHeaders, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { SessionContext } from '../src/contracts/session.ts';
import type { VoiceBridgeEvent } from '../src/observability.ts';

export const APP_ID = 'help-desk';
export const SESSION_REF = 'sr_test_0123456789abcdef';
export const SERVICE_CREDENTIAL = 'svc_test_credential_DO_NOT_LEAK_42';

export function ctx(overrides: Partial<SessionContext> = {}): SessionContext {
  return { applicationId: APP_ID, sessionId: 'sess-1', sessionRef: SESSION_REF, ...overrides };
}

export function collector() {
  const events: VoiceBridgeEvent[] = [];
  return {
    events,
    observer: (e: VoiceBridgeEvent) => events.push(e),
    types: () => events.map((e) => e.type),
    ofType: <T extends VoiceBridgeEvent['type']>(type: T) =>
      events.filter((e): e is Extract<VoiceBridgeEvent, { type: T }> => e.type === type),
  };
}

export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

export interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: unknown;
  aborted: boolean;
}

export type StubHandler = (req: RecordedRequest, res: ServerResponse) => void | Promise<void>;

/** A local HTTP server on 127.0.0.1 with a per-test handler. Records every request. */
export async function startStubServer(handler: StubHandler) {
  const requests: RecordedRequest[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString('utf8')));
    req.on('end', () => {
      const rec: RecordedRequest = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: raw ? (JSON.parse(raw) as unknown) : undefined,
        aborted: false,
      };
      requests.push(rec);
      res.on('close', () => {
        if (!res.writableEnded) rec.aborted = true;
      });
      void handler(rec, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
