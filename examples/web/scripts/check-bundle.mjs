// Fails the build if server-only code or secrets reached the browser bundle.
// Runs after `next build`. Scans every file under .next/static (what browsers download).
// Prints only which marker matched, never secret values.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const staticDir = join(root, '.next', 'static');
if (!existsSync(staticDir)) {
  console.error('check-bundle: .next/static not found. Run `next build` first.');
  process.exit(1);
}

// Server-only packages and entry points, and the names of server-side secrets.
const markers = [
  '@livekit/agents',
  '@voicebridge/runtime-livekit',
  '@voicebridge/livekit-tokens',
  'livekit-server-sdk',
  'createVoiceBridgeAgent',
  'createLiveKitTokenIssuer',
  'createHttpBackend',
  'LIVEKIT_API_SECRET',
  'LIVEKIT_API_KEY',
  'HELP_DESK_HOST_CREDENTIAL',
  'HELP_DESK_WORKER_CREDENTIAL',
  'BEGIN PRIVATE KEY',
].map((m) => ({ label: m, value: m }));

// Real secret values from local env files, if present (never printed).
const SECRET_KEYS = [
  'LIVEKIT_API_SECRET',
  'LIVEKIT_API_KEY',
  'HELP_DESK_HOST_CREDENTIAL',
  'HELP_DESK_WORKER_CREDENTIAL',
];
for (const file of [join(root, '..', '..', '.env.local'), join(root, '..', '.env.local')]) {
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || !SECRET_KEYS.includes(m[1])) continue;
    const value = m[2].replace(/^['"]|['"]$/g, '');
    if (value.length >= 8) markers.push({ label: `value of ${m[1]}`, value });
  }
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}

const findings = [];
let files = 0;
for (const file of walk(staticDir)) {
  if (!/\.(js|mjs|css|json|html|txt|map)$/.test(file)) continue;
  files += 1;
  const text = readFileSync(file, 'utf8');
  for (const { label, value } of markers) {
    if (text.includes(value)) findings.push(`${relative(root, file)}: ${label}`);
  }
}

if (findings.length > 0) {
  console.error('check-bundle: server-only code or secrets found in the browser bundle:');
  for (const f of findings) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`check-bundle: ok (${files} files, ${markers.length} markers, no matches)`);
