/**
 * Fictional support knowledge base for "Pebblebrook Home Goods" (not a real company).
 * Matching is deterministic keyword lookup, so every answer is predictable and spoken verbatim.
 */
import type { BackendReply } from '@voicebridge/core';

export interface FaqEntry {
  readonly id: string;
  /** Any of these words or phrases (after normalisation) selects the entry. */
  readonly keywords: readonly string[];
  readonly answer: string;
}

export const GREETING =
  'Welcome to Pebblebrook Home Goods support. You can ask about opening hours, returns, delivery, warranty, or resetting your password.';

export const FALLBACK_ANSWER =
  'I can help with opening hours, returns, delivery, warranty, or resetting your password. What would you like to know?';

export const GOODBYE = 'Thanks for contacting Pebblebrook Home Goods. Goodbye.';

export const SESSION_INACTIVE = 'This support session is no longer active. Goodbye.';

const GOODBYE_PHRASES = ['goodbye', 'bye', 'that is all', 'thats all', 'no thanks', 'hang up'];

export const FAQ: readonly FaqEntry[] = Object.freeze([
  {
    id: 'hours',
    keywords: ['opening hours', 'open', 'hours', 'close', 'closing', 'sunday', 'weekend'],
    answer:
      'Pebblebrook Home Goods is open Monday to Saturday, from nine in the morning to six in the evening. We are closed on Sundays.',
  },
  {
    id: 'returns',
    keywords: ['return', 'returns', 'refund', 'send back', 'exchange'],
    answer:
      'You can return unused items within thirty days with your order number. Refunds go back to your original payment method within five working days.',
  },
  {
    id: 'delivery',
    keywords: ['delivery', 'deliver', 'shipping', 'ship', 'dispatch', 'arrive'],
    answer:
      'Standard delivery takes three to five working days, and it is free on orders over fifty pounds.',
  },
  {
    id: 'warranty',
    keywords: ['warranty', 'guarantee', 'broken', 'faulty', 'repair'],
    answer: 'All appliances come with a two year warranty that covers manufacturing faults.',
  },
  {
    id: 'password',
    keywords: ['password', 'sign in', 'log in', 'login', 'account', 'locked out'],
    answer:
      'To reset your password, choose Forgot password on the sign in page and follow the link we email you.',
  },
  {
    id: 'human',
    keywords: ['human', 'person', 'agent', 'representative', 'speak to someone'],
    answer:
      'This demo cannot transfer you to a person, but our support team can be reached through the contact page on our website.',
  },
]);

function normalise(text: string): string {
  return ` ${text
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()} `;
}

/** Deterministic answer for a user turn. Same input, same reply, always. */
export function answer(text: string): BackendReply {
  const t = normalise(text);
  if (t.trim().length === 0) return { kind: 'silent' };
  if (GOODBYE_PHRASES.some((p) => t.includes(` ${p} `))) return { kind: 'end', text: GOODBYE };
  const entry = FAQ.find((e) => e.keywords.some((k) => t.includes(` ${k} `)));
  return { kind: 'speak', text: entry ? entry.answer : FALLBACK_ANSWER };
}
