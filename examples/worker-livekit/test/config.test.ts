import { describe, expect, it } from 'vitest';
import { loadWorkerConfig } from '../src/config.ts';

const ENV = {
  LIVEKIT_URL: 'wss://voice.synthetic.invalid',
  LIVEKIT_API_KEY: 'APIsyntheticKey',
  LIVEKIT_API_SECRET: 'synthetic-livekit-secret-'.padEnd(48, 'x'),
  HELP_DESK_URL: 'http://127.0.0.1:8788',
  HELP_DESK_WORKER_CREDENTIAL: 'wkr_synthetic_'.padEnd(40, 'a'),
};

describe('worker configuration', () => {
  it('builds backend-controlled options: no LLM, recording off, authorizing sessions/start', () => {
    const c = loadWorkerConfig(ENV);
    expect(c.options.mode).toBe('backend-controlled');
    expect(c.options.recording).toBe(false);
    expect(typeof c.options.application.conversation?.start).toBe('function');
    expect(typeof c.options.application.conversation?.end).toBe('function');
    expect(c.options.providers.stt).toEqual({
      model: 'assemblyai/universal-3-6-pro',
      language: 'en',
    });
    expect(c.agentName).toBe('voicebridge-help-desk');
    expect(c.healthHost).toBe('127.0.0.1');
  });

  it('honours provider, text-input, and agent configuration', () => {
    const c = loadWorkerConfig({
      ...ENV,
      VB_STT_MODEL: 'deepgram/nova-3',
      VB_TEXT_INPUT: 'true',
      VB_AGENT_NAME: 'custom-agent',
      VB_TURN_DETECTION: 'stt',
    });
    expect(c.options.providers.stt).toMatchObject({ model: 'deepgram/nova-3' });
    expect(c.options.providers.turnDetection).toBe('stt');
    expect(c.options.textInput).toBe(true);
    expect(c.agentName).toBe('custom-agent');
  });

  it.each([
    'LIVEKIT_URL',
    'LIVEKIT_API_KEY',
    'LIVEKIT_API_SECRET',
    'HELP_DESK_URL',
    'HELP_DESK_WORKER_CREDENTIAL',
  ])('refuses to start without %s', (name) => {
    expect(() => loadWorkerConfig({ ...ENV, [name]: undefined })).toThrow(name);
  });

  it('refuses plain-http non-local backends and weak credentials', () => {
    expect(() =>
      loadWorkerConfig({ ...ENV, HELP_DESK_URL: 'http://backend.example.com' }),
    ).toThrow();
    expect(() => loadWorkerConfig({ ...ENV, HELP_DESK_WORKER_CREDENTIAL: 'short' })).toThrow();
  });

  it('startup diagnostics contain no credentials, secrets, or URLs', () => {
    const summary = JSON.stringify(loadWorkerConfig(ENV).summary);
    for (const v of [
      ENV.LIVEKIT_API_SECRET,
      ENV.LIVEKIT_API_KEY,
      ENV.HELP_DESK_WORKER_CREDENTIAL,
      ENV.HELP_DESK_URL,
      ENV.LIVEKIT_URL,
    ]) {
      expect(summary).not.toContain(v);
    }
    expect(JSON.parse(summary)).toMatchObject({
      recording: false,
      llm: false,
      mode: 'backend-controlled',
    });
  });
});
