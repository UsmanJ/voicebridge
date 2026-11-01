import { useEffect, useRef } from 'react';
import type { Delivery, TranscriptEntry } from '../transcript';

const DELIVERY_LABEL: Record<Delivery, string> = {
  sent: 'Sent',
  answered: 'Answered',
  failed: 'Not sent',
};

export function Transcript({ entries }: { entries: readonly TranscriptEntry[] }) {
  const endRef = useRef<HTMLLIElement>(null);
  const last = entries.at(-1);
  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'end' });
  }, [entries.length, last?.text]);

  return (
    <section className="transcript" aria-labelledby="transcript-heading">
      <h2 id="transcript-heading">Conversation</h2>
      {entries.length === 0 ? (
        <p className="transcript-empty">
          Nothing yet. Speak, type a question, or pick an example below.
        </p>
      ) : (
        <ol role="log" aria-live="polite" aria-relevant="additions" className="transcript-list">
          {entries.map((e) => (
            <li
              key={e.id}
              className="message"
              data-role={e.role}
              data-final={e.final}
              data-delivery={e.delivery}
            >
              <span className="message-meta">
                {e.role === 'user' ? 'You' : 'Assistant'}
                {e.source === 'typed' && e.role === 'user' ? ' (typed)' : ''}
                {!e.final ? ' (transcribing…)' : ''}
              </span>
              <span className="message-text">{e.text}</span>
              {e.delivery ? (
                <span className="message-delivery">{DELIVERY_LABEL[e.delivery]}</span>
              ) : null}
            </li>
          ))}
          <li ref={endRef} aria-hidden="true" className="transcript-end" />
        </ol>
      )}
    </section>
  );
}
