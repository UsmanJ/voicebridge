import { MediaDeviceFailure } from 'livekit-client';
import { TokenRequestError } from './token';

/** A failure the user can act on. Messages are fixed strings: no server text, URLs, or tokens. */
export interface UserFacingError {
  code:
    | 'microphone_denied'
    | 'microphone_missing'
    | 'microphone_busy'
    | 'not_signed_in'
    | 'origin_refused'
    | 'rate_limited'
    | 'service_unavailable'
    | 'timeout'
    | 'network'
    | 'agent_unavailable'
    | 'connection_lost'
    | 'message_failed'
    | 'unknown';
  message: string;
}

const MESSAGES: Record<UserFacingError['code'], string> = {
  microphone_denied:
    'Microphone access was blocked. Allow microphone access for this page in your browser, then start again.',
  microphone_missing: 'No microphone was found. Connect one, then start again.',
  microphone_busy: 'Your microphone is in use by another application. Close it, then start again.',
  not_signed_in: 'You are not signed in to the host application.',
  origin_refused: 'This page is not allowed to start voice sessions. Check HOST_ALLOWED_ORIGINS.',
  rate_limited: 'Too many sessions were started. Wait a minute, then try again.',
  service_unavailable: 'Voice sessions are not available right now. Try again shortly.',
  timeout: 'The connection took too long. Check that all services are running, then try again.',
  network: 'Could not reach the voice service. Check that the token host is running.',
  agent_unavailable: 'The voice assistant did not join. Check that the worker is running.',
  connection_lost: 'The connection was lost. Start a new conversation to continue.',
  message_failed: 'Your message could not be sent. Try again.',
  unknown: 'Something went wrong. Start a new conversation to try again.',
};

export function userError(code: UserFacingError['code']): UserFacingError {
  return { code, message: MESSAGES[code] };
}

/** Maps anything thrown while starting a conversation to a fixed, safe message. */
export function toUserFacingError(error: unknown): UserFacingError {
  if (error instanceof TokenRequestError) {
    switch (error.kind) {
      case 'unauthorized':
        return userError('not_signed_in');
      case 'forbidden':
        return userError('origin_refused');
      case 'rate_limited':
        return userError('rate_limited');
      case 'timeout':
        return userError('timeout');
      case 'network':
        return userError('network');
      default:
        return userError('service_unavailable');
    }
  }
  const media = MediaDeviceFailure.getFailure(error);
  if (media === MediaDeviceFailure.PermissionDenied) return userError('microphone_denied');
  if (media === MediaDeviceFailure.NotFound) return userError('microphone_missing');
  if (media === MediaDeviceFailure.DeviceInUse) return userError('microphone_busy');
  if (error instanceof DOMException && error.name === 'TimeoutError') return userError('timeout');
  return userError('unknown');
}
