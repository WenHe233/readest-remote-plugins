import { it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packSdk } from '../scripts/pack-sdk.mjs';

it('packs the same SDK bytes regardless of the invoking package manager', () => {
  const root = mkdtempSync(join(tmpdir(), 'readest-sdk-pack-'));
  const previous = process.env.npm_execpath;
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'sdk-pack-fixture', version: '1.0.0', files: ['index.js', 'LICENSE'], license: 'AGPL-3.0' }));
    writeFileSync(join(root, 'index.js'), 'export const fixture = true;\n');
    writeFileSync(join(root, 'LICENSE'), 'SDK license fixture\n');
    const outputs = ['npm', 'pnpm'].map((manager) => {
      process.env.npm_execpath = `/simulated/${manager}/bin/${manager}.cjs`;
      const output = join(root, manager);
      mkdirSync(output);
      packSdk(root, output);
      return readFileSync(join(output, 'sdk-pack-fixture-1.0.0.tgz'));
    });
    expect(outputs[0]).toEqual(outputs[1]);
  } finally {
    if (previous === undefined) delete process.env.npm_execpath;
    else process.env.npm_execpath = previous;
    rmSync(root, { recursive: true });
  }
}, 30_000);
