import { applicationIdSchema, sessionRefSchema } from '@voicebridge/core';
import { LiveKitTokenError } from './errors.ts';

/**
 * Agent dispatch metadata, version 0 (experimental).
 *
 * Carried in the token's `roomConfig.agents[0].metadata` and delivered to the dispatched worker as
 * job metadata. It contains **only opaque references**: no secrets, credentials, or personal data.
 * The client holding the token can read it (a JWT payload is not encrypted). Integrity comes from
 * the token signature, not confidentiality.
 *
 * The worker must still verify the application/session binding through a trusted server-side
 * mechanism before acting on it (see README: not implemented in this package).
 */
export interface DispatchMetadataV0 {
  readonly vb: 0;
  readonly applicationId: string;
  readonly sessionRef: string;
}

export const DISPATCH_METADATA_MAX_BYTES = 512;

export function buildDispatchMetadata(applicationId: string, sessionRef: string): string {
  const metadata: DispatchMetadataV0 = { vb: 0, applicationId, sessionRef };
  return JSON.stringify(metadata);
}

/**
 * Parses and validates dispatch metadata, for use by the worker when reading `ctx.job.metadata`.
 * Throws `invalid_request` without echoing the input.
 *
 * A successful parse proves only that a holder of the API secret minted it. It does **not** prove
 * the session is still valid or authorized. Resolve `sessionRef` server-side before use.
 */
export function parseDispatchMetadata(raw: string): DispatchMetadataV0 {
  if (
    typeof raw !== 'string' ||
    raw.length === 0 ||
    Buffer.byteLength(raw) > DISPATCH_METADATA_MAX_BYTES
  ) {
    throw new LiveKitTokenError('invalid_request', 'dispatch metadata is missing or too large');
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new LiveKitTokenError('invalid_request', 'dispatch metadata is not valid JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new LiveKitTokenError('invalid_request', 'dispatch metadata must be an object');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort().join(',');
  if (keys !== 'applicationId,sessionRef,vb' || record.vb !== 0) {
    throw new LiveKitTokenError(
      'invalid_request',
      'dispatch metadata has an unexpected shape or version',
    );
  }
  if (
    !applicationIdSchema.safeParse(record.applicationId).success ||
    !sessionRefSchema.safeParse(record.sessionRef).success
  ) {
    throw new LiveKitTokenError('invalid_request', 'dispatch metadata has invalid identifiers');
  }
  return Object.freeze({
    vb: 0,
    applicationId: record.applicationId as string,
    sessionRef: record.sessionRef as string,
  });
}
