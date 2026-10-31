// LIVE HARNESS synthetic user (opt-in, synthetic data only). Run from packages/runtime-livekit:
//   node --env-file=../../.env.local live/harness.ts <scenario> <wavDir>
// Scenarios: basic delayed cancel stale errors text | revoked expired wrong-room forged-ref bad-metadata
// Never prints tokens, secrets, or session refs.
import {
  AudioFrame,
  AudioSource,
  LocalAudioTrack,
  type RemoteParticipant,
  Room,
  RoomEvent,
  TrackPublishOptions,
  TrackSource,
} from '@livekit/rtc-node';
import { createLiveKitTokenIssuer, loadServerConfigFromEnv } from '@voicebridge/livekit-tokens';
import {
  AccessToken,
  RoomAgentDispatch,
  RoomConfiguration,
  RoomServiceClient,
} from 'livekit-server-sdk';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const [scenario = 'basic', wavDir = '.'] = process.argv.slice(2);
const HOST = `http://127.0.0.1:${process.env.VB_LIVE_BACKEND_PORT ?? 8788}`;
const AGENT = 'voicebridge-live';
const T0 = Date.now();
const log = (ev: string, data: Record<string, unknown> = {}) =>
  console.log(`[H +${((Date.now() - T0) / 1000).toFixed(1)}s] ${ev} ${JSON.stringify(data)}`);
const host = async (path: string, body: unknown) => {
  const res = await fetch(`${HOST}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.status === 204 ? undefined : ((await res.json()) as Record<string, unknown>);
};

type Step =
  | { say: string }
  | { sleep: number }
  | { waitAgent: 'speaking' | 'listening'; timeout?: number }
  | { text: string };
const CONVERSATIONS: Record<string, Step[]> = {
  basic: [{ waitAgent: 'speaking' }, { waitAgent: 'listening' }, { say: 'hello' }, { sleep: 9000 }],
  delayed: [{ sleep: 4000 }, { say: 'slow' }, { sleep: 13000 }],
  cancel: [{ sleep: 4000 }, { say: 'slow' }, { sleep: 3000 }, { say: 'quick' }, { sleep: 12000 }],
  stale: [
    { sleep: 4000 },
    { say: 'stubborn' },
    { sleep: 3000 },
    { say: 'quick' },
    { sleep: 12000 },
  ],
  errors: [
    { sleep: 4000 },
    { say: 'error' },
    { sleep: 7000 },
    { say: 'timeout' },
    { sleep: 13000 },
  ],
  text: [{ sleep: 4000 }, { text: 'typed hello from the keyboard' }, { sleep: 7000 }],
};
const REJECTIONS = new Set(['revoked', 'expired', 'wrong-room', 'forged-ref', 'bad-metadata']);

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

async function credentials(): Promise<{ serverUrl: string; token: string; roomName: string }> {
  const server = loadServerConfigFromEnv();
  if (scenario === 'forged-ref' || scenario === 'bad-metadata') {
    // An attacker holding nothing but a valid-looking token cannot get past session start.
    const roomName = `vb_${randomBytes(16).toString('base64url')}`;
    const at = new AccessToken(server.apiKey, server.apiSecret, {
      identity: `vbu_${randomBytes(8).toString('hex')}`,
      ttl: 300,
    });
    at.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true });
    const metadata =
      scenario === 'forged-ref'
        ? JSON.stringify({
            vb: 0,
            applicationId: 'help-desk',
            sessionRef: `sr_${randomBytes(16).toString('base64url')}`,
          })
        : JSON.stringify({ role: 'admin' });
    at.roomConfig = new RoomConfiguration({
      agents: [new RoomAgentDispatch({ agentName: AGENT, metadata })],
    });
    return { serverUrl: server.serverUrl, token: await at.toJwt(), roomName };
  }
  const session = (await host('/host/sessions', {
    expiresInMs: scenario === 'expired' ? 1500 : 600_000,
  }))!;
  const issuer = createLiveKitTokenIssuer({
    ...server,
    applications: { 'help-desk': { agentName: AGENT, allowTextInput: true } },
    verifySessionBinding: async (b) => (await host('/host/verify', b))?.bound === true,
    recordIssuance: async (r) => {
      const roomName =
        scenario === 'wrong-room'
          ? `vb_someOtherRoom${randomBytes(4).toString('hex')}`
          : r.roomName;
      await host('/host/attach-room', { sessionRef: r.sessionRef, roomName });
    },
  });
  const creds = await issuer.issue({
    applicationId: 'help-desk',
    sessionRef: String(session.sessionRef),
  });
  if (scenario === 'revoked') await host('/host/revoke', { sessionRef: session.sessionRef });
  if (scenario === 'expired') await new Promise((r) => setTimeout(r, 2000));
  return { serverUrl: creds.serverUrl, token: creds.participantToken, roomName: creds.roomName };
}

async function main() {
  const { serverUrl, token, roomName } = await credentials();
  const room = new Room();
  const agentSeen = new Promise<RemoteParticipant>((resolve) =>
    room.on(RoomEvent.ParticipantConnected, (p) => {
      log('participant_connected', { kind: p.kind, isAgent: p.identity.startsWith('agent') });
      if (p.identity.startsWith('agent')) resolve(p);
    }),
  );
  let agentState = 'unknown';
  room.on(RoomEvent.ParticipantAttributesChanged, (changed) => {
    if (changed['lk.agent.state'])
      log('agent_state', { state: (agentState = changed['lk.agent.state']) });
  });
  room.registerTextStreamHandler('lk.transcription', (reader, info) => {
    void reader.readAll().then((text) =>
      log('transcription', {
        from: info.identity.startsWith('agent') ? 'agent' : 'user',
        final: reader.info.attributes?.['lk.transcription_final'],
        text,
      }),
    );
  });
  await room.connect(serverUrl, token, { autoSubscribe: true, dynacast: false });
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

  const waitMs = REJECTIONS.has(scenario) ? 15_000 : 20_000;
  const agent = await Promise.race([
    agentSeen,
    new Promise<undefined>((r) => setTimeout(() => r(undefined), waitMs)),
  ]);
  log(agent ? 'AGENT_JOINED' : 'NO_AGENT_JOINED', {
    scenario,
    expectAgent: !REJECTIONS.has(scenario),
  });

  for (const step of agent ? (CONVERSATIONS[scenario] ?? []) : []) {
    if ('say' in step) {
      log('user_says', { utterance: step.say });
      await new Promise<void>((done) => queue.push({ pcm: readWav(step.say), done }));
    } else if ('sleep' in step) await new Promise((r) => setTimeout(r, step.sleep));
    else if ('text' in step) {
      log('user_types', { text: step.text });
      await room.localParticipant!.sendText(step.text, { topic: 'lk.chat' });
    } else {
      const until = Date.now() + (step.timeout ?? 15000);
      while (agentState !== step.waitAgent && Date.now() < until)
        await new Promise((r) => setTimeout(r, 50));
    }
  }
  running = false;
  await room.disconnect();
  const server = loadServerConfigFromEnv();
  await new RoomServiceClient(
    server.serverUrl.replace('wss://', 'https://'),
    server.apiKey,
    server.apiSecret,
  )
    .deleteRoom(roomName)
    .catch(() => {});
  log('done', { scenario });
  process.exit(0);
}

main().catch((e: unknown) => {
  console.error('harness failed:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
