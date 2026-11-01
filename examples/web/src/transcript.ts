import type { ReceivedMessage } from '@livekit/components-react';

/**
 * Delivery state of a typed question.
 * - `sent`: LiveKit accepted the text stream (not proof that the agent processed it)
 * - `answered`: the agent has spoken since this message (observed, not inferred from content)
 * - `failed`: the send was rejected; nothing reached the agent
 */
export type Delivery = 'sent' | 'answered' | 'failed';

export interface TranscriptEntry {
  id: string;
  role: 'user' | 'agent';
  text: string;
  source: 'voice' | 'typed';
  /** False while speech-to-text is still revising the user's words. */
  final: boolean;
  delivery?: Delivery;
}

/** A typed question that LiveKit refused to send. It never reached the agent. */
export interface FailedSend {
  localId: string;
  text: string;
}

const FINAL_ATTRIBUTE = 'lk.transcription_final';

/**
 * Builds the transcript from the SDK's session messages (already in arrival order, with partial
 * transcription updates merged into one message per segment) plus local failed sends.
 *
 * Only text that was actually received is displayed. Each message id appears once; a later update
 * to the same id replaces the earlier text in place, so partial transcripts never duplicate.
 */
export function buildTranscript(
  messages: readonly ReceivedMessage[],
  localIdentity: string | undefined,
  failed: readonly FailedSend[] = [],
): TranscriptEntry[] {
  const order: string[] = [];
  const byId = new Map<string, TranscriptEntry>();

  for (const m of messages) {
    const text = m.message.trim();
    if (!text) continue;
    let entry: TranscriptEntry;
    if (m.type === 'userTranscript') {
      entry = {
        id: m.id,
        role: 'user',
        text,
        source: 'voice',
        final: m.attributes?.[FINAL_ATTRIBUTE] !== 'false',
      };
    } else if (m.type === 'agentTranscript') {
      entry = { id: m.id, role: 'agent', text, source: 'voice', final: true };
    } else {
      const local = !!localIdentity && m.from?.identity === localIdentity;
      entry = {
        id: m.id,
        role: local ? 'user' : 'agent',
        text,
        source: 'typed',
        final: true,
        ...(local ? { delivery: 'sent' as const } : {}),
      };
    }
    if (!byId.has(m.id)) order.push(m.id);
    byId.set(m.id, entry);
  }

  const entries = order.map((id) => byId.get(id)!);
  // A typed question counts as answered once any agent speech arrives after it.
  let agentSpokeLater = false;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.role === 'agent') agentSpokeLater = true;
    else if (e.delivery === 'sent' && agentSpokeLater) entries[i] = { ...e, delivery: 'answered' };
  }

  for (const f of failed) {
    entries.push({
      id: f.localId,
      role: 'user',
      text: f.text,
      source: 'typed',
      final: true,
      delivery: 'failed',
    });
  }
  return entries;
}

/**
 * True when the user has finished a turn (final voice transcript or a sent typed question) and no
 * agent speech has arrived since.
 */
export function isAwaitingReply(entries: readonly TranscriptEntry[]): boolean {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.role === 'agent') return false;
    if (e.delivery === 'failed') continue;
    if (e.final) return true;
  }
  return false;
}
