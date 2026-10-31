// E2E (opt-in, synthetic data, uses YOUR LiveKit project, never run in CI).
// Requires the backend, host, and worker running (see examples/README.md).
// Usage (from examples/worker-livekit):
//   node --env-file-if-exists=../../.env.local --env-file-if-exists=../.env.local e2e/live-e2e.ts <conversation|revoke> <wavDir>
// Never prints tokens, secrets, or session refs.
import {
  AudioFrame,
  AudioSource,
  LocalAudioTrack,
  Room,
  RoomEvent,
  TrackPublishOptions,
  TrackSource,
} from '@livekit/rtc-node';
import { parseDispatchMetadata } from '@voicebridge/livekit-tokens';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const [scenario = 'conversation', wavDir = '.'] = process.argv.slice(2);
const HOST = `http://127.0.0.1:${process.env.HOST_PORT ?? 8790}`;
const BACKEND = process.env.HELP_DESK_URL ?? 'http://127.0.0.1:8788';
const T0 = Date.now();
const log = (ev: string, data: Record<string, unknown> = {}) =>
  console.log(`[E2E +${((Date.now() - T0) / 1000).toFixed(1)}s] ${ev} ${JSON.stringify(data)}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function readWav(name: string): Int16Array {
  const buf = readFileSync(join(wavDir, `${name}.wav`));
  for (let off = 12; off < buf.length;) {
    const size = buf.readUInt32LE(off + 4);
    if (buf.toString('ascii', off, off + 4) === 'data') {
      const pcm = buf.subarray(off + 8, off + 8 + size);
      return new Int16Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.length));
    }
    off += 8 + size;
  }
  throw new Error(`no data chunk in ${name}.wav`);
}

async function main() {
  // 1. The browser's step: ask the host for credentials (development identity, localhost only).
  const tokenRes = await fetch(`${HOST}/api/voice/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ room_name: 'ignored-by-design', agent_name: 'ignored-by-design' }),
  });
  log('token_response', { status: tokenRes.status });
  if (tokenRes.status !== 200) throw new Error('token route refused');
  const { server_url, participant_token } = (await tokenRes.json()) as {
    server_url: string;
    participant_token: string;
  };
  const payload = JSON.parse(
    Buffer.from(participant_token.split('.')[1]!, 'base64url').toString(),
  ) as {
    video: { room: string };
    roomConfig: { agents: Array<{ metadata: string }> };
  };
  const { sessionRef } = parseDispatchMetadata(payload.roomConfig.agents[0]!.metadata);

  const room = new Room();
  const agentTranscripts: string[] = [];
  let agentPresent = false;
  let agentState = 'unknown';
  room.on(RoomEvent.ParticipantConnected, (p) => {
    if (p.identity.startsWith('agent')) {
      agentPresent = true;
      log('agent_joined');
    }
  });
  room.on(RoomEvent.ParticipantDisconnected, (p) => {
    if (p.identity.startsWith('agent')) {
      agentPresent = false;
      log('agent_left');
    }
  });
  room.on(RoomEvent.ParticipantAttributesChanged, (changed) => {
    if (changed['lk.agent.state']) agentState = changed['lk.agent.state'];
  });
  room.registerTextStreamHandler('lk.transcription', (reader, info) => {
    void reader.readAll().then((text) => {
      const final = reader.info.attributes?.['lk.transcription_final'];
      const from = info.identity.startsWith('agent') ? 'agent' : 'user';
      if (from === 'agent') agentTranscripts.push(text);
      if (from === 'agent' || final === 'true') log('transcription', { from, text });
    });
  });
  await room.connect(server_url, participant_token, { autoSubscribe: true, dynacast: false });
  log('connected', { scenario });

  const source = new AudioSource(16000, 1);
  const pub = new TrackPublishOptions();
  pub.source = TrackSource.SOURCE_MICROPHONE;
  await room.localParticipant!.publishTrack(LocalAudioTrack.createAudioTrack('mic', source), pub);
  const queue: Array<{ pcm: Int16Array; done: () => void }> = [];
  let running = true;
  void (async () => {
    let cur: { pcm: Int16Array; done: () => void; pos: number } | undefined;
    while (running) {
      if (!cur && queue.length) cur = { ...queue.shift()!, pos: 0 };
      const chunk = new Int16Array(160);
      if (cur) {
        chunk.set(cur.pcm.subarray(cur.pos, cur.pos + 160));
        cur.pos += 160;
        if (cur.pos >= cur.pcm.length) {
          cur.done();
          cur = undefined;
        }
      }
      await source.captureFrame(new AudioFrame(chunk, 16000, 1, 160));
    }
  })();
  const say = (name: string) => {
    log('user_says', { utterance: name });
    return new Promise<void>((done) => queue.push({ pcm: readWav(name), done }));
  };
  /** Waits for the agent to speak (a reply) and then return to listening. */
  const untilReplied = async (ms = 20000) => {
    const until = Date.now() + ms;
    while (agentState !== 'speaking' && Date.now() < until) await sleep(100);
    while (agentState !== 'listening' && Date.now() < until) await sleep(100);
    await sleep(500);
  };

  for (let i = 0; i < 100 && !agentPresent; i++) await sleep(100);
  await untilReplied(); // greeting finished

  if (scenario === 'conversation') {
    await say('hours');
    await untilReplied();
    await say('returns');
    await untilReplied();
    log('user_types', { text: 'How long does delivery take?' });
    await room.localParticipant!.sendText('How long does delivery take?', { topic: 'lk.chat' });
    await untilReplied();
    await say('goodbye');
    await sleep(8000);
  } else if (scenario === 'revoke') {
    await say('hours');
    await untilReplied();
    // The host revokes the session server-side (for example, the user signed out elsewhere).
    const r = await fetch(`${BACKEND}/internal/v0/sessions/revoke`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${process.env.HELP_DESK_HOST_CREDENTIAL}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ sessionRef }),
    });
    log('session_revoked_by_host', { status: r.status });
    await sleep(3000);
    log('agent_still_present_before_next_turn', { agentPresent });
    await say('warranty');
    await sleep(10000);
  }

  log('summary', { agentUtterances: agentTranscripts.length, agentPresentAtEnd: agentPresent });
  running = false;
  await room.disconnect();
  process.exit(0);
}

main().catch((e: unknown) => {
  console.error('e2e failed:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
