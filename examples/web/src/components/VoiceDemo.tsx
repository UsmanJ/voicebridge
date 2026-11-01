'use client';

import { type TokenSourceResponseObject, setLogLevel } from 'livekit-client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { TOKEN_TIMEOUT_MS } from '../config';
import type { DemoApplication } from '../demo-app';
import { type UserFacingError, toUserFacingError } from '../errors';
import { type FetchCredentialsOptions, TokenRequestError, fetchSessionCredentials } from '../token';
import { Composer } from './Composer';
import { ConversationSession, type SessionOutcome } from './ConversationSession';
import { StatusIndicator } from './StatusIndicator';

// The SDK's info/debug logs are verbose. At 'warn' it still logs connection problems (with the
// random room name and participant identity, never tokens or transcript text).
setLogLevel('warn');

type Phase =
  | { kind: 'idle' }
  | { kind: 'requesting' }
  | { kind: 'active'; conversation: number; credentials: TokenSourceResponseObject };

export interface VoiceDemoProps {
  app: DemoApplication;
  tokenEndpoint: string;
  /** Injectable for tests. */
  fetchCredentials?: (options: FetchCredentialsOptions) => Promise<TokenSourceResponseObject>;
}

export function VoiceDemo({
  app,
  tokenEndpoint,
  fetchCredentials = fetchSessionCredentials,
}: VoiceDemoProps) {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [error, setError] = useState<UserFacingError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const requestingRef = useRef(false);
  const requestRef = useRef<AbortController | null>(null);
  const conversationRef = useRef(0);

  // Cancel an in-flight credential request if the page component goes away.
  useEffect(
    () => () => {
      requestRef.current?.abort();
    },
    [],
  );

  const start = useCallback(async () => {
    // Synchronous guard: two clicks in the same frame both see phase 'idle'.
    if (requestingRef.current) return;
    requestingRef.current = true;
    setError(null);
    setNotice(null);
    setPhase({ kind: 'requesting' });
    const controller = new AbortController();
    requestRef.current = controller;
    try {
      const credentials = await fetchCredentials({
        endpoint: tokenEndpoint,
        timeoutMs: TOKEN_TIMEOUT_MS,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      conversationRef.current += 1;
      setPhase({ kind: 'active', conversation: conversationRef.current, credentials });
    } catch (e) {
      if (e instanceof TokenRequestError && e.kind === 'aborted') return;
      setError(toUserFacingError(e));
      setPhase({ kind: 'idle' });
      requestingRef.current = false;
    } finally {
      requestRef.current = null;
    }
  }, [fetchCredentials, tokenEndpoint]);

  const onEnded = useCallback((outcome: SessionOutcome) => {
    // Dropping the phase discards the credentials and unmounts the conversation (and its
    // transcript). The next Start always requests new credentials.
    setPhase({ kind: 'idle' });
    requestingRef.current = false;
    if (outcome.kind === 'error') setError(outcome.error);
    else if (outcome.kind === 'agent_ended') setNotice('The assistant ended the conversation.');
    else setNotice('Conversation ended.');
  }, []);

  return (
    <main className="page">
      <header className="masthead">
        <p className="brand">
          <span className="brand-mark" aria-hidden="true" />
          VoiceBridge
        </p>
        <p className="tagline">Voice middleware for existing application backends · demo</p>
      </header>

      <section className="app-card" aria-labelledby="app-name">
        <p className="eyebrow">Connected example application</p>
        <h1 id="app-name">{app.name}</h1>
        <p>{app.description}</p>
      </section>

      {error ? (
        <p className="notice notice-error" role="alert">
          {error.message}
        </p>
      ) : null}
      {notice ? (
        <p className="notice" role="status">
          {notice}
        </p>
      ) : null}

      {phase.kind === 'active' ? (
        <ConversationSession
          key={phase.conversation}
          credentials={phase.credentials}
          app={app}
          onEnded={onEnded}
        />
      ) : (
        <div className="panel">
          <div className="panel-top">
            <StatusIndicator
              status={phase.kind === 'requesting' ? 'connecting' : error ? 'error' : 'disconnected'}
            />
          </div>
          <div className="controls">
            <button
              type="button"
              className="primary"
              onClick={() => void start()}
              disabled={phase.kind === 'requesting'}
              aria-busy={phase.kind === 'requesting'}
            >
              {phase.kind === 'requesting' ? 'Starting…' : 'Start Conversation'}
            </button>
          </div>
          <p className="hint">
            Your browser will ask for microphone access. Speech is sent to LiveKit Cloud for
            recognition and synthesis. This demo does not record audio or store transcripts.
          </p>
          <Composer onSend={async () => {}} prompts={app.examplePrompts} disabled sending={false} />
        </div>
      )}
    </main>
  );
}
