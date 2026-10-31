/**
 * Static proof that @voicebridge/core has no vendor dependencies.
 * The physical proof (an isolated install with no @livekit packages present) is
 * `scripts/verify-core-isolation.mjs` at the repo root, run in CI.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Record<string, unknown>;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? sourceFiles(full) : full.endsWith('.ts') ? [full] : [];
  });
}

const IMPORT_RE =
  /(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g;

describe('@voicebridge/core dependency isolation', () => {
  it('declares zod as its only runtime dependency', () => {
    expect(Object.keys((pkg.dependencies as object | undefined) ?? {})).toEqual(['zod']);
    expect(pkg.peerDependencies).toBeUndefined();
    expect(pkg.optionalDependencies).toBeUndefined();
  });

  it('has no vendor packages anywhere in its manifest, including dev dependencies', () => {
    const all = Object.keys({
      ...(pkg.dependencies as object),
      ...(pkg.devDependencies as object),
    });
    expect(
      all.filter((d) =>
        /livekit|pipecat|daily|twilio|openai|deepgram|cartesia|assemblyai/i.test(d),
      ),
    ).toEqual([]);
  });

  it('only imports relative modules, zod, and node: built-ins from src/', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(join(root, 'src'))) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(IMPORT_RE)) {
        const spec = m[1] ?? m[2] ?? m[3] ?? '';
        const allowed =
          spec.startsWith('./') ||
          spec.startsWith('../') ||
          spec === 'zod' ||
          spec.startsWith('node:');
        if (!allowed) offenders.push(`${file.slice(root.length)} -> ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('never mentions a vendor SDK in source code', () => {
    const hits = sourceFiles(join(root, 'src')).filter((f) =>
      /@livekit|livekit-|pipecat/i.test(readFileSync(f, 'utf8')),
    );
    expect(hits).toEqual([]);
  });
});
