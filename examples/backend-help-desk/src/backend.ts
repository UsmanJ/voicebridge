import {
  WIRE_PROTOCOL_VERSION,
  runtimeBindingSchema,
  sessionEndRequestSchema,
  sessionRefSchema,
  sessionStartRequestSchema,
  turnRequestSchema,
} from '@voicebridge/core';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { GREETING, SESSION_INACTIVE, answer } from './faq.ts';
import { InMemorySessionStore, type Refusal, SUBJECT_PATTERN } from './session-store.ts';

export const MAX_BODY_BYTES = 16 * 1024;

/** One application served by this backend, with one credential per caller role. */
export interface ApplicationCredentials {
  applicationId: string;
  /** Used only by the VoiceBridge worker (wire contract routes). */
  workerCredential: string;
  /** Used only by the host app's token route (internal session routes). */
  hostCredential: string;
}

/** Safe structured events: codes only, never refs, text, rooms, or credentials. */
export type BackendLogger = (
  event: string,
  fields?: Record<string, string | number | boolean>,
) => void;

export interface HelpDeskBackendOptions {
  applications: readonly ApplicationCredentials[];
  store?: InMemorySessionStore;
  logger?: BackendLogger;
}

type Role = 'worker' | 'host';

const digest = (value: string) => createHash('sha256').update(value).digest();

/** Credentials must be long, random, and distinct. Fail fast at startup otherwise. */
function validateCredentials(apps: readonly ApplicationCredentials[]) {
  if (apps.length === 0) throw new Error('at least one application is required');
  const seen = new Set<string>();
  for (const a of apps) {
    for (const [role, c] of [
      ['workerCredential', a.workerCredential],
      ['hostCredential', a.hostCredential],
    ] as const) {
      if (typeof c !== 'string' || c.length < 32 || /\s/.test(c)) {
        throw new Error(
          `${a.applicationId}: ${role} must be at least 32 characters with no whitespace`,
        );
      }
      if (seen.has(c))
        throw new Error('every credential must be unique (per application and role)');
      seen.add(c);
    }
  }
}

export function createHelpDeskBackend(options: HelpDeskBackendOptions) {
  validateCredentials(options.applications);
  const store = options.store ?? new InMemorySessionStore();
  const log: BackendLogger = options.logger ?? (() => {});
  const credentials = options.applications.flatMap((a) => [
    { digest: digest(a.workerCredential), applicationId: a.applicationId, role: 'worker' as Role },
    { digest: digest(a.hostCredential), applicationId: a.applicationId, role: 'host' as Role },
  ]);

  /** Constant-time credential lookup. Every entry is compared, whatever matches. */
  function authenticate(req: IncomingMessage): { applicationId: string; role: Role } | undefined {
    const header = req.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return undefined;
    const presented = digest(header.slice(7));
    let match: { applicationId: string; role: Role } | undefined;
    for (const c of credentials) {
      if (timingSafeEqual(presented, c.digest))
        match = { applicationId: c.applicationId, role: c.role };
    }
    return match;
  }

  function send(res: ServerResponse, status: number, body?: unknown) {
    if (res.writableEnded) return;
    const headers: Record<string, string> = {
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    res.writeHead(status, headers);
    res.end(body === undefined ? undefined : JSON.stringify(body));
  }
  const fail = (res: ServerResponse, status: number, error: string) => send(res, status, { error });

  async function readJson(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) throw Object.assign(new Error('too large'), { status: 413 });
      chunks.push(chunk);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } catch {
      throw Object.assign(new Error('bad json'), { status: 400 });
    }
  }

  /** Refusals are deliberately coarse on the wire. Details stay in the event code. */
  const refuse = (res: ServerResponse, route: string, reason: Refusal) => {
    log('refused', { route, reason });
    fail(res, 403, 'session_not_authorized');
  };

  async function handleWorker(
    path: string,
    applicationId: string,
    body: unknown,
    res: ServerResponse,
  ) {
    if (path === '/v0/sessions/start') {
      const parsed = sessionStartRequestSchema.safeParse(body);
      if (!parsed.success) return fail(res, 400, 'invalid_request');
      // LiveKit deployments must report the actual room; without it there's no room check.
      if (!parsed.data.runtimeBinding) return refuse(res, 'start', 'room_not_bound');
      const result = store.authorizeStart(
        applicationId,
        parsed.data.sessionRef,
        parsed.data.runtimeBinding.roomName,
      );
      if (!result.ok) return refuse(res, 'start', result.reason);
      log('session_started', { firstStart: result.firstStart });
      return send(res, 200, { authorized: true, greeting: { kind: 'speak', text: GREETING } });
    }
    if (path === '/v0/turns') {
      const parsed = turnRequestSchema.safeParse(body);
      if (!parsed.success) return fail(res, 400, 'invalid_request');
      const check = store.checkActive(applicationId, parsed.data.sessionRef);
      if (!check.ok) {
        if (check.reason === 'revoked' || check.reason === 'expired' || check.reason === 'ended') {
          // Known but no longer active: end the conversation (takes effect at this turn).
          log('turn_session_inactive', { reason: check.reason });
          return send(res, 200, { kind: 'end', text: SESSION_INACTIVE });
        }
        return refuse(res, 'turn', check.reason);
      }
      const reply = answer(parsed.data.text);
      log('turn_answered', { kind: reply.kind, source: parsed.data.source });
      return send(res, 200, reply);
    }
    if (path === '/v0/sessions/end') {
      const parsed = sessionEndRequestSchema.safeParse(body);
      if (!parsed.success) return fail(res, 400, 'invalid_request');
      if (!store.end(applicationId, parsed.data.sessionRef)) return refuse(res, 'end', 'not_found');
      log('session_ended', { reason: parsed.data.reason });
      return send(res, 204);
    }
    return fail(res, 404, 'not_found');
  }

  async function handleHost(
    path: string,
    applicationId: string,
    body: unknown,
    res: ServerResponse,
  ) {
    const record = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    if (path === '/internal/v0/sessions') {
      if (typeof record.subject !== 'string' || !SUBJECT_PATTERN.test(record.subject)) {
        return fail(res, 400, 'invalid_request');
      }
      const created = store.create(applicationId, record.subject);
      log('session_created');
      return send(res, 201, created);
    }
    if (!sessionRefSchema.safeParse(record.sessionRef).success)
      return fail(res, 400, 'invalid_request');
    const sessionRef = record.sessionRef as string;
    if (path === '/internal/v0/sessions/verify-issuance') {
      return send(res, 200, { issuable: store.canIssue(applicationId, sessionRef) });
    }
    if (path === '/internal/v0/sessions/attach-room') {
      if (!runtimeBindingSchema.shape.roomName.safeParse(record.roomName).success) {
        return fail(res, 400, 'invalid_request');
      }
      const result = store.attachRoom(applicationId, sessionRef, record.roomName as string);
      if (result === 'attached') return send(res, 204);
      log('attach_refused', { reason: result });
      return fail(
        res,
        result === 'conflict' ? 409 : 403,
        result === 'conflict' ? 'room_already_bound' : 'session_not_authorized',
      );
    }
    if (path === '/internal/v0/sessions/revoke') {
      if (!store.revoke(applicationId, sessionRef)) return fail(res, 404, 'not_found');
      log('session_revoked');
      return send(res, 204);
    }
    return fail(res, 404, 'not_found');
  }

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? '/').split('?')[0]!;
    try {
      if (req.method === 'GET' && path === '/healthz') return send(res, 200, { status: 'ok' });
      if (req.method !== 'POST') return fail(res, 405, 'method_not_allowed');
      const caller = authenticate(req);
      if (!caller) {
        log('unauthenticated', { route: path.startsWith('/internal/') ? 'internal' : 'wire' });
        return fail(res, 401, 'unauthenticated');
      }
      const isWire = path.startsWith('/v0/');
      const isInternal = path.startsWith('/internal/v0/');
      // Least privilege: each credential is valid for exactly one route family.
      if ((isWire && caller.role !== 'worker') || (isInternal && caller.role !== 'host')) {
        log('wrong_role', { role: caller.role });
        return fail(res, 403, 'forbidden');
      }
      if (isWire && req.headers['voicebridge-version'] !== WIRE_PROTOCOL_VERSION) {
        return fail(res, 400, 'unsupported_version');
      }
      const body = await readJson(req);
      if (isWire) return await handleWorker(path, caller.applicationId, body, res);
      if (isInternal) return await handleHost(path, caller.applicationId, body, res);
      return fail(res, 404, 'not_found');
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status === 413) return fail(res, 413, 'payload_too_large');
      if (status === 400) return fail(res, 400, 'invalid_json');
      log('internal_error');
      return fail(res, 500, 'internal_error');
    }
  };

  return { handler, store };
}
