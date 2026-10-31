import { TrackSource, type VideoGrant } from 'livekit-server-sdk';
import { randomBytes } from 'node:crypto';

/** 128 random bits, base64url-encoded (22 characters). */
function randomId(): string {
  return randomBytes(16).toString('base64url');
}

/**
 * Room name: unpredictable, unique, and free of PII. Never derived from user, application, or
 * session data, and never chosen by a client. Uniqueness matters: LiveKit ignores token dispatch
 * for rooms that already exist.
 */
export function generateRoomName(): string {
  return `vb_${randomId()}`;
}

/** Participant identity: opaque and random per session, so sessions can't be linked through it. */
export function generateParticipantIdentity(): string {
  return `vbu_${randomId()}`;
}

/**
 * Least-privilege grant for a voice participant in exactly one room.
 *
 * - Can join that room only, publish **microphone only**, and subscribe (audio from the agent).
 * - Data publishing only when the application enables typed text input.
 * - Can't update its own metadata, create/list/administer/record rooms, manage ingress, act as an
 *   agent or recorder, hide itself, read metrics, or manage agent sessions.
 *
 * Every privileged flag is set explicitly to `false`, so the decoded token is self-describing.
 */
export function voiceParticipantGrant(room: string, options: { allowData: boolean }): VideoGrant {
  return {
    room,
    roomJoin: true,
    canPublish: true,
    canPublishSources: [TrackSource.MICROPHONE],
    canSubscribe: true,
    canPublishData: options.allowData,
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
  };
}
