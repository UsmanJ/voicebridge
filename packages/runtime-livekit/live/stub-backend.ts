// LIVE HARNESS (opt-in, synthetic data only). Not part of the package or CI.
//
// Plays two roles on 127.0.0.1:8788:
// - "host app" routes (/host/*), local only: create a voice session, attach the issued room, revoke.
// - application backend (/v0/*), requires the service credential: sessions/start with real
//   binding checks (active, unexpired, application, room, idempotent), and keyword-driven turns.
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

const PORT = Number(process.env.VB_LIVE_BACKEND_PORT ?? 8788);
const CREDENTIAL =
  process.env.VB_LIVE_SERVICE_CREDENTIAL ?? 'svc_live_harness_synthetic_credential';
const APP_ID = 'help-desk';

interface Binding {
  applicationId: string;
  roomName?: string;
  status: 'active' | 'revoked';
  expiresAt: number;
  starts: number;
}
const sessions = new Map<string, Binding>();
let turnCounter = 0;

const log = (ev: string, data: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ src: 'backend', t: new Date().toISOString(), ev, ...data }));

createServer((req, res) => {
  let raw = '';
  req.on('data', (c: Buffer) => (raw += c.toString()));
  req.on('end', () => {
    const send = (status: number, body?: unknown) => {
      if (res.writableEnded) return;
      res.writeHead(status, body === undefined ? {} : { 'content-type': 'application/json' });
      res.end(body === undefined ? undefined : JSON.stringify(body));
    };
    let body: Record<string, unknown> = {};
    try {
      body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    } catch {
      return send(400);
    }
    const url = req.url ?? '';

    // ---- host app (local harness control) ----
    if (url === '/host/sessions') {
      const sessionRef = `sr_${randomBytes(16).toString('base64url')}`;
      const expiresInMs = typeof body.expiresInMs === 'number' ? body.expiresInMs : 10 * 60_000;
      sessions.set(sessionRef, {
        applicationId: APP_ID,
        status: 'active',
        expiresAt: Date.now() + expiresInMs,
        starts: 0,
      });
      log('host_session_created', { expiresInMs });
      return send(200, { sessionRef, applicationId: APP_ID });
    }
    if (url === '/host/verify') {
      const b = sessions.get(String(body.sessionRef));
      return send(200, {
        bound:
          !!b &&
          b.status === 'active' &&
          b.applicationId === body.applicationId &&
          b.expiresAt > Date.now(),
      });
    }
    if (url === '/host/attach-room') {
      const b = sessions.get(String(body.sessionRef));
      if (b) b.roomName = String(body.roomName);
      return send(b ? 204 : 404);
    }
    if (url === '/host/revoke') {
      const b = sessions.get(String(body.sessionRef));
      if (b) b.status = 'revoked';
      return send(b ? 204 : 404);
    }

    // ---- application backend (service credential required) ----
    if (req.headers.authorization !== `Bearer ${CREDENTIAL}`) {
      log('unauthenticated_request', { url });
      return send(401);
    }
    if (url === '/v0/sessions/start') {
      const ref = String(body.sessionRef);
      const b = sessions.get(ref);
      const room = (body.runtimeBinding as { roomName?: string } | undefined)?.roomName;
      const why = !b
        ? 'unknown'
        : b.status !== 'active'
          ? 'revoked'
          : b.expiresAt <= Date.now()
            ? 'expired'
            : b.applicationId !== APP_ID
              ? 'application'
              : !b.roomName || b.roomName !== room
                ? 'room_mismatch'
                : null;
      if (why) {
        log('session_start_rejected', { why, idempotencyKey: req.headers['idempotency-key'] });
        return send(403, { error: 'forbidden' });
      }
      b!.starts++;
      log('session_start_authorized', {
        starts: b!.starts,
        idempotencyKey: req.headers['idempotency-key'],
      });
      return send(200, {
        authorized: true,
        greeting: { kind: 'speak', text: 'Welcome to the help desk, marker lagoon.' },
      });
    }
    if (url === '/v0/turns') {
      const n = ++turnCounter;
      const text = String(body.text ?? '');
      const lower = text.toLowerCase();
      log('turn_received', { n, turnId: body.turnId, source: body.source, text });
      let aborted = false;
      res.on('close', () => {
        if (!res.writableEnded) {
          aborted = true;
          log('turn_aborted_by_client', { n });
        }
      });
      if (lower.includes('error')) return send(500, { internal: 'stack trace at db.ts:42' });
      const delay = lower.includes('timeout')
        ? 12_000
        : lower.includes('slow') || lower.includes('stubborn')
          ? 6_000
          : 0;
      setTimeout(() => {
        if (aborted) return log('reply_dropped_client_gone', { n });
        const reply = { kind: 'speak', text: `Approved reply number ${n}, marker tangerine.` };
        log('turn_replied', { n, reply });
        send(200, reply);
      }, delay);
      return;
    }
    send(404);
  });
}).listen(PORT, '127.0.0.1', () => log('listening', { port: PORT }));
