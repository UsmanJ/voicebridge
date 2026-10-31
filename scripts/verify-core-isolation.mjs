// Physical proof that @voicebridge/core runs without LiveKit (or any vendor package) installed.
//
// 1. Builds and `pnpm pack`s @voicebridge/core into a tarball (the published shape).
// 2. In a fresh temp directory OUTSIDE the workspace, `npm install`s only that tarball plus the
//    test runner. Nothing from the monorepo (no @livekit/*) can be resolved there.
// 3. Fails if any vendor package is present in that install.
// 4. Imports the installed package, then runs the full core test suite in that directory.
//
// Usage: node scripts/verify-core-isolation.mjs [--keep]
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const coreDir = join(repo, 'packages', 'core');
const keep = process.argv.includes('--keep');
const isWindows = process.platform === 'win32';
const VENDOR =
  /^(@livekit|livekit-|@pipecat|pipecat|@daily-co|twilio|openai|@deepgram|@cartesia|assemblyai)/i;

// On Windows, pnpm/npm/vitest are .cmd shims that need a shell. Arguments here are fixed or
// generated paths; quote them so paths containing spaces survive.
const quote = (arg) => (isWindows && /\s/.test(arg) ? `"${arg}"` : arg);
function run(cmd, args, cwd) {
  console.log(`$ ${cmd} ${args.join(' ')}`);
  execFileSync(quote(cmd), args.map(quote), { cwd, stdio: 'inherit', shell: isWindows });
}

function installedPackages(nodeModules) {
  const names = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      if (entry === '.bin' || entry === '.modules.yaml') continue;
      if (entry.startsWith('@')) {
        for (const scoped of readdirSync(join(dir, entry))) names.push(`${entry}/${scoped}`);
      } else {
        names.push(entry);
      }
    }
  };
  walk(nodeModules);
  return [...new Set(names)].sort();
}

const target = mkdtempSync(join(tmpdir(), 'voicebridge-core-isolated-'));
try {
  run('pnpm', ['--filter', '@voicebridge/core', 'run', 'build'], repo);
  run('pnpm', ['pack', '--pack-destination', target], coreDir);
  const tarball = readdirSync(target).find((f) => f.endsWith('.tgz'));
  if (!tarball) throw new Error('pnpm pack produced no tarball');

  const corePkg = JSON.parse(readFileSync(join(coreDir, 'package.json'), 'utf8'));
  writeFileSync(
    join(target, 'package.json'),
    JSON.stringify(
      {
        name: 'voicebridge-core-isolation-check',
        private: true,
        type: 'module',
        dependencies: { '@voicebridge/core': `file:./${tarball}` },
        devDependencies: { vitest: corePkg.devDependencies.vitest },
      },
      null,
      2,
    ),
  );
  run(
    'npm',
    ['install', '--no-audit', '--no-fund', '--ignore-scripts', '--loglevel=error'],
    target,
  );

  const packages = installedPackages(join(target, 'node_modules'));
  const vendor = packages.filter((p) => VENDOR.test(p));
  console.log(`isolated install contains ${packages.length} packages`);
  if (vendor.length > 0 || existsSync(join(target, 'node_modules', '@livekit'))) {
    throw new Error(
      `vendor packages present in isolated core install: ${vendor.join(', ') || '@livekit'}`,
    );
  }
  console.log('OK: no vendor packages (no @livekit/*) in the isolated install');

  // Smoke-import the installed, published package (dist via the exports map).
  writeFileSync(
    join(target, 'smoke.mjs'),
    [
      "import * as core from '@voicebridge/core';",
      "import * as testing from '@voicebridge/core/testing';",
      "if (core.WIRE_PROTOCOL_VERSION !== '0') throw new Error('unexpected wire version');",
      "if (testing.loadConformanceVectorsV0().vectors.length === 0) throw new Error('no vectors');",
      "console.log('OK: installed package imports (core + testing + conformance vectors)');",
    ].join(String.fromCharCode(10)),
  );
  run('node', ['smoke.mjs'], target);

  // Run the full suite against the sources, resolving zod from the isolated install only.
  const suite = join(target, 'suite');
  for (const item of ['src', 'test', 'schema', 'conformance', 'package.json', 'vitest.config.ts']) {
    cpSync(join(coreDir, item), join(suite, item), { recursive: true });
  }
  cpSync(join(target, 'node_modules'), join(suite, 'node_modules'), { recursive: true });
  run(join('node_modules', '.bin', isWindows ? 'vitest.cmd' : 'vitest'), ['run'], suite);
  console.log(
    'OK: @voicebridge/core installs, imports, and passes its tests with no vendor packages present.',
  );
} finally {
  if (keep) console.log(`kept: ${target}`);
  else rmSync(target, { recursive: true, force: true });
}
