// Preflight diagnostics: validates configuration and checks the backend is reachable.
// Prints only sanitized results (no credentials, secrets, or URLs). Exit code 1 on any failure.
// Usage (from examples/worker-livekit): pnpm diagnose
import { loadWorkerConfig } from './config.ts';

const checks: Array<{ check: string; ok: boolean; detail?: string }> = [];

let summary: Record<string, string | number | boolean> = {};
try {
  summary = loadWorkerConfig(process.env).summary;
  checks.push({ check: 'configuration valid', ok: true });
} catch (error) {
  checks.push({
    check: 'configuration valid',
    ok: false,
    detail: error instanceof Error ? error.message : 'invalid',
  });
}

if (process.env.HELP_DESK_URL) {
  try {
    const res = await fetch(new URL('/healthz', process.env.HELP_DESK_URL), {
      redirect: 'error',
      signal: AbortSignal.timeout(3000),
    });
    checks.push({
      check: 'help-desk backend reachable',
      ok: res.ok,
      detail: `status ${res.status}`,
    });
  } catch {
    checks.push({ check: 'help-desk backend reachable', ok: false, detail: 'unreachable' });
  }
}

console.log(JSON.stringify({ src: 'worker-diagnose', summary, checks }, null, 2));
process.exit(checks.every((c) => c.ok) ? 0 : 1);
