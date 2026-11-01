import { type FormEvent, useState } from 'react';
import { MAX_TYPED_MESSAGE_LENGTH } from '../config';

export interface ComposerProps {
  /** Resolves when LiveKit accepted the message; rejects when it was not sent. */
  onSend: (text: string) => Promise<void>;
  prompts: readonly string[];
  disabled: boolean;
  sending: boolean;
}

export function Composer({ onSend, prompts, disabled, sending }: ComposerProps) {
  const [text, setText] = useState('');
  const blocked = disabled || sending;

  const submit = async (value: string, fromInput: boolean) => {
    const trimmed = value.trim();
    if (!trimmed || blocked) return;
    try {
      await onSend(trimmed);
      if (fromInput) setText('');
    } catch {
      // The failure is shown in the transcript. Keep the text so the user can retry.
    }
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void submit(text, true);
  };

  return (
    <div className="composer">
      <form onSubmit={onSubmit} className="composer-form">
        <label htmlFor="typed-question" className="visually-hidden">
          Type a question
        </label>
        <input
          id="typed-question"
          type="text"
          autoComplete="off"
          placeholder={disabled ? 'Start a conversation to type a question' : 'Type a question…'}
          value={text}
          maxLength={MAX_TYPED_MESSAGE_LENGTH}
          onChange={(e) => setText(e.target.value)}
          disabled={disabled}
        />
        <button type="submit" disabled={blocked || text.trim().length === 0}>
          {sending ? 'Sending…' : 'Send'}
        </button>
      </form>
      <div className="prompts" role="group" aria-label="Example questions">
        {prompts.map((p) => (
          <button
            key={p}
            type="button"
            className="prompt"
            disabled={blocked}
            onClick={() => void submit(p, false)}
          >
            {p}
          </button>
        ))}
      </div>
    </div>
  );
}
