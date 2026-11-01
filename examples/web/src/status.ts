import type { AgentState } from '@livekit/components-react';

export type DisplayStatus =
  'disconnected' | 'connecting' | 'listening' | 'processing' | 'speaking' | 'error';

export const STATUS_LABEL: Record<DisplayStatus, string> = {
  disconnected: 'Disconnected',
  connecting: 'Connecting',
  listening: 'Listening',
  processing: 'Processing',
  speaking: 'Speaking',
  error: 'Error',
};

/**
 * Maps the SDK agent state to the status shown in the UI.
 *
 * In backend-controlled mode the agent has no LLM, so it never reports `thinking` while the
 * backend is answering. `awaitingReply` (a user turn finished or a typed question was sent, and
 * the agent has not started speaking yet) fills that gap so the user sees "Processing".
 */
export function deriveStatus(agentState: AgentState, awaitingReply: boolean): DisplayStatus {
  switch (agentState) {
    case 'speaking':
      return 'speaking';
    case 'thinking':
      return 'processing';
    case 'listening':
    case 'idle':
      return awaitingReply ? 'processing' : 'listening';
    case 'failed':
      return 'error';
    case 'disconnected':
      return 'disconnected';
    default:
      // connecting, pre-connect-buffering, initializing
      return 'connecting';
  }
}
