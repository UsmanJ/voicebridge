import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadConformanceVectorsV0 } from '../src/testing/vectors.ts';
import { WIRE_PROTOCOL_VERSION } from '../src/version.ts';
import { WIRE_V0_SCHEMAS, wireV0JsonSchemas } from '../src/wire/v0.ts';

const schemaDir = fileURLToPath(new URL('../schema/v0/', import.meta.url));
const file = loadConformanceVectorsV0();

describe('wire contract v0 conformance vectors', () => {
  it('targets the current experimental wire version', () => {
    expect(WIRE_PROTOCOL_VERSION).toBe('0');
    expect(file.wireVersion).toBe(WIRE_PROTOCOL_VERSION);
  });

  it('covers every message schema with both valid and invalid vectors', () => {
    for (const name of Object.keys(WIRE_V0_SCHEMAS)) {
      const forSchema = file.vectors.filter((v) => v.schema === name);
      expect(
        forSchema.some((v) => v.valid),
        `${name} has a valid vector`,
      ).toBe(true);
      if (name !== 'sessionStartRequest') {
        expect(
          forSchema.some((v) => !v.valid),
          `${name} has an invalid vector`,
        ).toBe(true);
      }
    }
  });

  it.each(file.vectors.map((v) => [v.name, v] as const))('%s', (_name, vector) => {
    const schema = WIRE_V0_SCHEMAS[vector.schema];
    expect(schema, `unknown schema ${vector.schema}`).toBeDefined();
    expect(schema.safeParse(vector.value).success).toBe(vector.valid);
  });
});

describe('wire contract v0 JSON Schema export', () => {
  it('committed schema files match the Zod source of truth (run `pnpm generate:schemas` after changes)', () => {
    const generated = wireV0JsonSchemas();
    const committed = readdirSync(schemaDir)
      .filter((f) => f.endsWith('.json'))
      .sort();
    expect(committed).toEqual(
      Object.keys(generated)
        .map((n) => `${n}.json`)
        .sort(),
    );
    for (const [name, schema] of Object.entries(generated)) {
      const onDisk = JSON.parse(readFileSync(`${schemaDir}${name}.json`, 'utf8')) as unknown;
      expect(onDisk, `${name}.json is stale`).toEqual(schema);
    }
  });

  it('produces draft 2020-12 schemas that forbid unknown properties on requests', () => {
    const schemas = wireV0JsonSchemas();
    expect(schemas.turnRequest.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(schemas.turnRequest.additionalProperties).toBe(false);
    expect(schemas.toolInvocationRequest.additionalProperties).toBe(false);
  });
});
