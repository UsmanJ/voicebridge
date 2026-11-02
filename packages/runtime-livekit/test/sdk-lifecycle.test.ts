// Tripwires for the LiveKit Agents 1.9.5 lifecycle facts the adapter relies on (see
// docs/ARCHITECTURE.md §6.1 "Session and job lifecycle"). They read the installed SDK source. When
// the SDK is upgraded and one fails, re-check the lifecycle before changing the assertion.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const sdkDist = dirname(require.resolve('@livekit/agents'));
const read = (file: string) => readFileSync(join(sdkDist, file), 'utf8');

describe('@livekit/agents 1.9.5 session and job lifecycle', () => {
  it('closes the AgentSession only for client-initiated, room-deleted, or rejected disconnects', () => {
    // A network drop (any other reason) leaves the session open so the same identity can rejoin.
    const roomIo = read('voice/room_io/room_io.js');
    const list = roomIo.match(/const CLOSE_ON_DISCONNECT_REASONS = \[([^\]]*)\]/)?.[1] ?? '';
    expect(list.replace(/\s+/g, ' ').trim()).toBe(
      'DisconnectReason.CLIENT_INITIATED, DisconnectReason.ROOM_DELETED, DisconnectReason.USER_REJECTED',
    );
    expect(roomIo).toContain('closeOnDisconnect: true');
  });

  it('closing the AgentSession closes speech recognition (STT) and releases TTS', () => {
    const activity = read('voice/agent_activity.js');
    expect(activity).toMatch(
      /await \(\(_e = this\.audioRecognition\) == null \? void 0 : _e\.close\(\)\)/,
    );
    expect(activity).toContain('await releaseTts(this.tts);');
  });

  it('a committed spoken turn interrupts active and queued speech before onUserTurnCompleted runs', () => {
    // Why the core doesn't need to call interrupt() for spoken turns (docs/ARCHITECTURE.md §6.1).
    const activity = read('voice/agent_activity.js');
    const turn = activity.slice(activity.indexOf('async userTurnCompleted('));
    const queued = turn.indexOf('this.interruptQueuedSpeeches(false, "user_turn")');
    const active = turn.indexOf('activeSpeech.interrupt(false, "user_turn")');
    const hook = turn.indexOf('await this.agent.onUserTurnCompleted(');
    expect(queued).toBeGreaterThan(0);
    expect(active).toBeGreaterThan(queued);
    expect(hook).toBeGreaterThan(active);
  });

  it('session.interrupt() (used for typed turns) stops current and queued speech', () => {
    const activity = read('voice/agent_activity.js');
    const interrupt = activity.slice(activity.indexOf('  interrupt(options = {}) {'));
    const body = interrupt.slice(0, interrupt.indexOf('return future;'));
    expect(body).toContain(
      'currentSpeech == null ? void 0 : currentSpeech.interrupt(force, source)',
    );
    expect(body).toContain('this.interruptQueuedSpeeches(force, source)');
  });

  it('closing the AgentSession does not end the job; the job ends when its room disconnects', () => {
    // Job shutdown: JobContext.shutdown(), room disconnected, parent shutdown, or a crash. LiveKit
    // closes the room when the last non-agent participant leaves (LiveKit docs, server lifecycle).
    const session = read('voice/agent_session.js');
    expect(session).not.toMatch(/getJobContext\([^)]*\)\??\.shutdown\(/);
    const jobProc = read('ipc/job_proc_lazy_main.js');
    expect(jobProc).toMatch(
      /room\.on\(RoomEvent\.Disconnected, \(\) => \{\s*if \(!shutdown\) \{\s*closeEvent\.emit\("close", EXIT_REASON\.roomDisconnected\)/,
    );
    const job = read('job.js');
    // The only automatic JobContext.shutdown() on a participant leaving is for simulators.
    expect(job).toContain('this.shutdown("simulation completed")');
  });
});
