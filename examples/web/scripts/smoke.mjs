// Lightweight smoke test of the production build: starts `next start` on a spare port, fetches the
// page, and checks the security headers and the initial (disconnected) UI. No LiveKit, no token
// host, no browser. Run after `pnpm build`:  pnpm --filter @voicebridge/web-example smoke
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const port = Number(process.env.SMOKE_PORT ?? 3199);
const base = `http://localhost:${port}`;

const server = spawn(
  process.execPath,
  ['node_modules/next/dist/bin/next', 'start', '--hostname', 'localhost', '--port', String(port)],
  { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_ENV: 'production' } },
);
let output = '';
server.stdout.on('data', (d) => (output += d));
server.stderr.on('data', (d) => (output += d));

const failures = [];
const check = (ok, label) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) failures.push(label);
};

try {
  let res;
  for (let i = 0; i < 60; i++) {
    try {
      res = await fetch(base, { signal: AbortSignal.timeout(2000) });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  if (!res) throw new Error(`server did not start:\n${output}`);
  const html = await res.text();
  const csp = res.headers.get('content-security-policy') ?? '';
  const permissions = res.headers.get('permissions-policy') ?? '';

  check(res.status === 200, 'GET / returns 200');
  check(html.includes('VoiceBridge'), 'page shows VoiceBridge branding');
  check(html.includes('Pebblebrook Home Goods'), 'page shows the example application');
  check(html.includes('Start Conversation'), 'page renders the Start Conversation button');
  check(html.includes('Disconnected'), 'initial status is Disconnected');
  check(!/participant_token|eyJhbGci/.test(html), 'no credentials in the server-rendered page');
  check(!/unsafe-eval/.test(csp), 'production CSP has no unsafe-eval');
  check(/connect-src [^;]*wss:\/\/\*\.livekit\.cloud/.test(csp), 'CSP allows LiveKit Cloud only');
  check(/frame-ancestors 'none'/.test(csp), 'CSP forbids framing');
  check(/camera=\(\)/.test(permissions), 'Permissions-Policy disables the camera');
  check(/display-capture=\(\)/.test(permissions), 'Permissions-Policy disables screen capture');
  check(!res.headers.has('x-powered-by'), 'no X-Powered-By header');
} catch (error) {
  failures.push(String(error));
  console.error(error);
} finally {
  server.kill();
}

if (failures.length > 0) {
  console.error(`smoke: ${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('smoke: ok');
