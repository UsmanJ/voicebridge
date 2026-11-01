import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DisconnectReason, type TokenSourceResponseObject } from 'livekit-client';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VoiceDemo } from '../src/components/VoiceDemo';
import { DEMO_APPLICATION } from '../src/demo-app';
import { type FetchCredentialsOptions, TokenRequestError } from '../src/token';
import { fake, msg } from './fake-livekit';

vi.mock(
  '@livekit/components-react',
  async () => (await import('./fake-livekit')).componentsReactMock,
);

const ENDPOINT = 'http://127.0.0.1:8790/api/voice/token';
const creds = (n: number): TokenSourceResponseObject => ({
  serverUrl: 'wss://synthetic.livekit.invalid',
  // Synthetic and unsigned, built at runtime (not a real credential).
  participantToken: [
    Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url'),
    Buffer.from(JSON.stringify({ synthetic: n })).toString('base64url'),
    `sig-${n}-synthetic`,
  ].join('.'),
});

type FetchCredentials = (options: FetchCredentialsOptions) => Promise<TokenSourceResponseObject>;

function setup(fetchCredentials: FetchCredentials = vi.fn(async () => creds(1))) {
  const user = userEvent.setup();
  render(
    <StrictMode>
      <VoiceDemo
        app={DEMO_APPLICATION}
        tokenEndpoint={ENDPOINT}
        fetchCredentials={fetchCredentials}
      />
    </StrictMode>,
  );
  return { user, fetchCredentials };
}

const startButton = () => screen.getByRole('button', { name: 'Start Conversation' });
const statusText = () => document.querySelector('.status')?.textContent ?? '';

/** Start, deliver credentials, connect, and have the agent listening. */
async function connect(user: ReturnType<typeof userEvent.setup>) {
  const before = fake.started.length;
  await user.click(startButton());
  await waitFor(() => expect(fake.started).toHaveLength(before + 1));
  const session = fake.started.at(-1)!;
  await act(async () => {
    session.starts[0]!.resolve();
    fake.setAgentPresent(session, true);
    fake.set({ agentState: 'listening' });
  });
  await waitFor(() => expect(statusText()).toContain('Listening'));
  return session;
}

beforeEach(() => fake.reset());
afterEach(() => vi.useRealTimers());

describe('initial state', () => {
  it('is disconnected and does not request credentials or create a session on load', () => {
    const { fetchCredentials } = setup();
    expect(statusText()).toContain('Disconnected');
    expect(startButton()).toBeEnabled();
    expect(fetchCredentials).not.toHaveBeenCalled();
    expect(fake.sessions).toHaveLength(0);
    expect(screen.getByRole('textbox', { name: 'Type a question' })).toBeDisabled();
    for (const p of DEMO_APPLICATION.examplePrompts) {
      expect(screen.getByRole('button', { name: p })).toBeDisabled();
    }
    expect(screen.queryByRole('button', { name: /camera|video|screen/i })).toBeNull();
  });
});

describe('starting a conversation', () => {
  it('only starts on an explicit click, and a double click issues one credential request', async () => {
    let release!: (c: TokenSourceResponseObject) => void;
    const fetchCredentials = vi.fn<FetchCredentials>(
      () => new Promise<TokenSourceResponseObject>((r) => (release = r)),
    );
    const { user } = setup(fetchCredentials);
    await user.dblClick(startButton());
    await user.click(screen.getByRole('button', { name: 'Starting…' }));
    expect(fetchCredentials).toHaveBeenCalledTimes(1);
    expect(fetchCredentials.mock.calls[0]![0]).toMatchObject({ endpoint: ENDPOINT });
    expect(statusText()).toContain('Connecting');
    await act(async () => release(creds(1)));
    await waitFor(() => expect(fake.started).toHaveLength(1));
    // Strict Mode double-invokes effects: start() must still run exactly once.
    expect(fake.started[0]!.start).toHaveBeenCalledTimes(1);
    expect(fetchCredentials).toHaveBeenCalledTimes(1);
  });

  it('connects with the issued credentials and the microphone only', async () => {
    const { user } = setup();
    const session = await connect(user);
    expect(await session.credentials()).toEqual(creds(1));
    expect(session.starts[0]!.options.tracks).toEqual({
      microphone: { enabled: true, publishOptions: { preConnectBuffer: true } },
    });
    expect(screen.getByRole('button', { name: 'Mute microphone' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'End Conversation' })).toBeEnabled();
    expect(screen.getByRole('textbox', { name: 'Type a question' })).toBeEnabled();
  });

  it('shows a fixed message when microphone permission is denied, and disconnects', async () => {
    const { user } = setup();
    await user.click(startButton());
    await waitFor(() => expect(fake.started).toHaveLength(1));
    const session = fake.started[0]!;
    await act(async () =>
      session.starts[0]!.reject(new DOMException('Permission denied', 'NotAllowedError')),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(/Microphone access was blocked/);
    expect(session.end).toHaveBeenCalled();
    expect(startButton()).toBeEnabled();
    expect(statusText()).toContain('Error');
  });

  it('times out when connecting takes too long', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { user } = setup();
    await user.click(startButton());
    await waitFor(() => expect(fake.started).toHaveLength(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_001);
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(/took too long/);
    expect(fake.started[0]!.end).toHaveBeenCalled();
    expect(fake.started[0]!.starts[0]!.options.signal?.aborted).toBe(true);
  });

  it('reports when the agent never joins', async () => {
    const { user } = setup();
    await user.click(startButton());
    await waitFor(() => expect(fake.started).toHaveLength(1));
    await act(async () => fake.set({ agentState: 'failed' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/did not join/);
    expect(fake.started[0]!.end).toHaveBeenCalled();
  });

  it.each([
    ['unauthorized', /not signed in/],
    ['forbidden', /not allowed to start voice sessions/],
    ['rate_limited', /Too many sessions/],
    ['unavailable', /not available right now/],
    ['network', /Could not reach/],
    ['timeout', /took too long/],
  ] as const)('token endpoint failure %s shows a safe message', async (kind, text) => {
    const { user } = setup(vi.fn(async () => Promise.reject(new TokenRequestError(kind))));
    await user.click(startButton());
    expect(await screen.findByRole('alert')).toHaveTextContent(text);
    expect(fake.sessions).toHaveLength(0);
    expect(startButton()).toBeEnabled();
  });
});

describe('during a conversation', () => {
  it('mutes and unmutes the microphone', async () => {
    const { user } = setup();
    await connect(user);
    await user.click(screen.getByRole('button', { name: 'Mute microphone' }));
    const unmute = screen.getByRole('button', { name: 'Unmute microphone' });
    expect(unmute).toHaveAttribute('aria-pressed', 'true');
    await user.click(unmute);
    expect(screen.getByRole('button', { name: 'Mute microphone' })).toBeInTheDocument();
  });

  it('shows Speaking and Processing states', async () => {
    const { user } = setup();
    const session = await connect(user);
    await act(async () =>
      fake.set({
        messages: [
          msg('userTranscript', 'What are your opening hours?', {
            from: session.room.localParticipant.identity,
            final: true,
          }),
        ],
      }),
    );
    expect(statusText()).toContain('Processing');
    await act(async () => fake.set({ agentState: 'speaking' }));
    expect(statusText()).toContain('Speaking');
  });

  it('renders transcripts in order and merges partial updates into one entry', async () => {
    const { user } = setup();
    await connect(user);
    const welcome = msg('agentTranscript', 'Welcome to Pebblebrook Home Goods support.');
    await act(async () =>
      fake.set({
        messages: [welcome, msg('userTranscript', 'What are', { id: 'seg-1', final: false })],
      }),
    );
    const log = screen.getByRole('log');
    expect(within(log).getByText('What are')).toBeInTheDocument();
    expect(within(log).getByText(/transcribing/)).toBeInTheDocument();
    await act(async () =>
      fake.set({
        messages: [
          welcome,
          msg('userTranscript', 'What are your opening hours?', { id: 'seg-1', final: true }),
          msg('agentTranscript', 'Pebblebrook Home Goods is open Monday to Saturday.'),
        ],
      }),
    );
    const items = within(log)
      .getAllByRole('listitem')
      .filter((li) => li.textContent);
    expect(items.map((li) => li.querySelector('.message-text')?.textContent)).toEqual([
      'Welcome to Pebblebrook Home Goods support.',
      'What are your opening hours?',
      'Pebblebrook Home Goods is open Monday to Saturday.',
    ]);
    expect(within(log).queryByText('What are')).toBeNull();
    expect(within(log).queryByText(/transcribing/)).toBeNull();
  });

  it('sends typed questions over the session and tracks sent then answered', async () => {
    const { user } = setup();
    const session = await connect(user);
    const input = screen.getByRole('textbox', { name: 'Type a question' });
    await user.type(input, 'How long does delivery take?{Enter}');
    expect(fake.send).toHaveBeenCalledTimes(1);
    expect(fake.send).toHaveBeenCalledWith('How long does delivery take?');
    expect(input).toHaveValue('');
    // No new voice session or credentials.
    expect(fake.started).toHaveLength(1);
    expect(session.start).toHaveBeenCalledTimes(1);

    const typed = msg('chatMessage', 'How long does delivery take?', {
      from: session.room.localParticipant.identity,
    });
    await act(async () => fake.set({ messages: [typed] }));
    const log = screen.getByRole('log');
    expect(within(log).getByText('Sent')).toBeInTheDocument();
    expect(within(log).getByText(/\(typed\)/)).toBeInTheDocument();
    expect(statusText()).toContain('Processing');
    await act(async () =>
      fake.set({
        messages: [
          typed,
          msg('agentTranscript', 'Standard delivery takes three to five working days.'),
        ],
      }),
    );
    expect(within(log).getByText('Answered')).toBeInTheDocument();
  });

  it('example prompts are sent to the backend as typed questions', async () => {
    const { user } = setup();
    await connect(user);
    await user.click(screen.getByRole('button', { name: 'What is your returns policy?' }));
    expect(fake.send).toHaveBeenCalledWith('What is your returns policy?');
  });

  it('a failed send is marked "Not sent", keeps the text, and shows a safe error', async () => {
    const { user } = setup();
    await connect(user);
    fake.send.mockRejectedValueOnce(new Error('internal: data channel closed (sid PA_xyz)'));
    const input = screen.getByRole('textbox', { name: 'Type a question' });
    await user.type(input, 'Do you sell lamps?{Enter}');
    expect(await screen.findByText('Not sent')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Your message could not be sent. Try again.',
    );
    expect(document.body.textContent).not.toContain('PA_xyz');
    expect(input).toHaveValue('Do you sell lamps?');
  });

  it('shows the autoplay fallback button when the browser blocks audio', async () => {
    const { user } = setup();
    await connect(user);
    await act(async () => fake.set({ audioBlocked: true }));
    await user.click(screen.getByRole('button', { name: 'Allow audio playback' }));
    expect(screen.queryByRole('button', { name: 'Allow audio playback' })).toBeNull();
  });
});

describe('ending and restarting', () => {
  it('End Conversation disconnects, clears the transcript, and returns to the start state', async () => {
    const { user } = setup();
    const session = await connect(user);
    await act(async () => fake.set({ messages: [msg('agentTranscript', 'Welcome.')] }));
    await user.click(screen.getByRole('button', { name: 'End Conversation' }));
    expect(session.end).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Conversation ended.')).toBeInTheDocument();
    expect(screen.queryByRole('log')).toBeNull();
    expect(screen.queryByText('Welcome.')).toBeNull();
    expect(statusText()).toContain('Disconnected');
    expect(startButton()).toBeEnabled();
  });

  it('an unexpected disconnect is reported and cleaned up', async () => {
    const { user } = setup();
    const session = await connect(user);
    await act(async () => session.room.emit('disconnected', DisconnectReason.SIGNAL_CLOSE));
    expect(await screen.findByRole('alert')).toHaveTextContent(/connection was lost/);
    expect(session.end).toHaveBeenCalled();
    expect(startButton()).toBeEnabled();
  });

  it('the agent leaving after joining ends the conversation (goodbye or revoked session)', async () => {
    const { user } = setup();
    const session = await connect(user);
    await act(async () => {
      fake.setAgentPresent(session, false);
      fake.set({ agentState: 'failed' });
    });
    // During the grace period the status reads Disconnected, not Error.
    expect(statusText()).toContain('Disconnected');
    expect(
      await screen.findByText('The assistant ended the conversation.', {}, { timeout: 3500 }),
    ).toBeInTheDocument();
    expect(session.end).toHaveBeenCalled();
  });

  it('a full reconnect (participants dropped, then restored) does not end the conversation', async () => {
    // Regression: livekit-client drops remote participants before reporting Reconnecting, and
    // useAgent stays 'failed' afterwards. Observed live on LiveKit Cloud.
    const { user } = setup();
    const session = await connect(user);
    await act(async () => {
      fake.setAgentPresent(session, false);
      fake.set({ agentState: 'failed' });
      fake.setRoomState(session, 'reconnecting');
    });
    expect(statusText()).toContain('Connecting');
    await act(async () => new Promise((r) => setTimeout(r, 2500)));
    expect(session.end).not.toHaveBeenCalled();
    await act(async () => {
      fake.setRoomState(session, 'connected');
      fake.setAgentPresent(session, true);
    });
    await act(async () => new Promise((r) => setTimeout(r, 2500)));
    expect(session.end).not.toHaveBeenCalled();
    expect(statusText()).toContain('Listening');
    expect(screen.getByRole('button', { name: 'End Conversation' })).toBeEnabled();
  }, 10_000);

  it('a new conversation obtains fresh credentials and never reuses the ended ones', async () => {
    let n = 0;
    const fetchCredentials = vi.fn(async () => creds(++n));
    const { user } = setup(fetchCredentials);
    const first = await connect(user);
    await user.click(screen.getByRole('button', { name: 'End Conversation' }));
    await screen.findByText('Conversation ended.');
    fake.set({ agentState: 'connecting', messages: [] });
    const second = await connect(user);
    expect(fetchCredentials).toHaveBeenCalledTimes(2);
    expect(second).not.toBe(first);
    expect(await second.credentials()).toEqual(creds(2));
    expect(await first.credentials()).toEqual(creds(1));
    expect(first.start).toHaveBeenCalledTimes(1);
  });

  it('unmounting during a conversation aborts connecting and disconnects', async () => {
    const user = userEvent.setup();
    const view = render(
      <VoiceDemo
        app={DEMO_APPLICATION}
        tokenEndpoint={ENDPOINT}
        fetchCredentials={async () => creds(1)}
      />,
    );
    await user.click(startButton());
    await waitFor(() => expect(fake.started).toHaveLength(1));
    const signal = fake.started[0]!.starts[0]!.options.signal!;
    view.unmount();
    await waitFor(() => expect(signal.aborted).toBe(true));
  });
});

describe('privacy and accessibility', () => {
  it('never writes credentials or transcript text to the console', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    const { user } = setup();
    const session = await connect(user);
    await act(async () =>
      fake.set({ messages: [msg('userTranscript', 'my order number is 12345', { final: true })] }),
    );
    await user.type(
      screen.getByRole('textbox', { name: 'Type a question' }),
      'secret question{Enter}',
    );
    await user.click(screen.getByRole('button', { name: 'End Conversation' }));
    const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls));
    const { participantToken, serverUrl } = await session.credentials();
    for (const forbidden of [participantToken, serverUrl, '12345', 'secret question']) {
      expect(logged).not.toContain(forbidden);
    }
  });

  it('is operable from the keyboard', async () => {
    const { user } = setup();
    await user.tab();
    expect(startButton()).toHaveFocus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(fake.started).toHaveLength(1));
    await act(async () => {
      fake.started[0]!.starts[0]!.resolve();
      fake.setAgentPresent(fake.started[0]!, true);
      fake.set({ agentState: 'listening' });
    });
    await user.click(screen.getByRole('textbox', { name: 'Type a question' }));
    await user.keyboard('What are your opening hours?{Enter}');
    expect(fake.send).toHaveBeenCalledWith('What are your opening hours?');
    screen.getByRole('button', { name: 'End Conversation' }).focus();
    await user.keyboard(' ');
    expect(await screen.findByText('Conversation ended.')).toBeInTheDocument();
  });

  it('every control has an accessible name and status changes are announced', async () => {
    const { user } = setup();
    await connect(user);
    for (const b of screen.getAllByRole('button')) expect(b).toHaveAccessibleName();
    expect(document.querySelector('.status')).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(DEMO_APPLICATION.name);
  });
});
