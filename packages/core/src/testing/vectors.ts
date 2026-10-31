import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { WireV0SchemaName } from '../wire/v0.ts';

export interface ConformanceVector {
  name: string;
  schema: WireV0SchemaName;
  valid: boolean;
  value: unknown;
}

export interface ConformanceVectorFile {
  wireVersion: string;
  vectors: ConformanceVector[];
}

/** Absolute path of the shared v0 conformance vectors (language-neutral JSON). */
export const CONFORMANCE_V0_PATH = fileURLToPath(
  new URL('../../conformance/v0/vectors.json', import.meta.url),
);

/** Loads the shared v0 conformance vectors. Other-language implementations read the same file. */
export function loadConformanceVectorsV0(): ConformanceVectorFile {
  return JSON.parse(readFileSync(CONFORMANCE_V0_PATH, 'utf8')) as ConformanceVectorFile;
}
