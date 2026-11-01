// Static guard (runs in CI without a build): browser code may only import the browser SDKs, React,
// and Next. `pnpm build` additionally scans the real bundle (scripts/check-bundle.mjs).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const ALLOWED = [
  /^react$/,
  /^react-dom$/,
  /^next(\/.*)?$/,
  /^livekit-client$/,
  /^@livekit\/components-react$/,
  /^\.\.?\//,
];

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* sources(p);
    else if (/\.(ts|tsx|css)$/.test(name)) yield p;
  }
}

describe('browser bundle inputs', () => {
  it('src/ and app/ import only browser-safe modules', () => {
    const offenders: string[] = [];
    for (const dir of ['src', 'app']) {
      for (const file of sources(join(root, dir))) {
        const text = readFileSync(file, 'utf8');
        const pattern =
          /^\s*(?:import|export)\b[^;]*?from\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)|\brequire\(\s*['"]([^'"]+)['"]\s*\)/gm;
        for (const m of text.matchAll(pattern)) {
          const spec = (m[1] ?? m[2] ?? m[3] ?? m[4])!;
          if (!ALLOWED.some((r) => r.test(spec)))
            offenders.push(`${relative(root, file)}: ${spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no client code reads non-public environment variables', () => {
    for (const dir of ['src', 'app']) {
      for (const file of sources(join(root, dir))) {
        const text = readFileSync(file, 'utf8');
        for (const m of text.matchAll(/process\.env\.([A-Z0-9_]+)/g)) {
          expect(m[1], relative(root, file)).toMatch(/^NEXT_PUBLIC_VB_/);
        }
      }
    }
  });
});
