// Writes the language-neutral JSON Schema files for the experimental v0 wire contract.
// Usage (from packages/core): node scripts/generate-schemas.ts
// A test fails if the committed files drift from the Zod source of truth.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { wireV0JsonSchemas } from '../src/wire/v0.ts';

const outDir = fileURLToPath(new URL('../schema/v0/', import.meta.url));
mkdirSync(outDir, { recursive: true });
for (const [name, schema] of Object.entries(wireV0JsonSchemas())) {
  writeFileSync(`${outDir}${name}.json`, `${JSON.stringify(schema, null, 2)}\n`);
  console.log(`wrote schema/v0/${name}.json`);
}
