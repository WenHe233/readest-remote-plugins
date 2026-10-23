import {createRequire} from 'node:module';
import { it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { resolve, join, sep } from 'node:path';
import { verifyRepository } from '../scripts/verify-repository.mjs';

it('publishes usable release-root URLs while verifying local signed archives', async () => {
  mkdirSync('.artifacts', { recursive: true });
  const directory = mkdtempSync(resolve('.artifacts/release-repo-'));
  const base = 'https://github.com/WenHe233/readest-remote-plugins/releases/download/v0.3.0-x1/';
  try {
    execFileSync(process.execPath, ['scripts/sign-plugins.mjs', '--test', '--experimental', '--release-base', base, '--out', directory], { stdio: 'pipe' });
    const index = JSON.parse(readFileSync(join(directory, 'index.json')));
    const {z}=createRequire(createRequire(import.meta.url).resolve('@readest/plugin-sdk'))('zod');
    const legacyIndex=z.object({schemaVersion:z.literal(1),plugins:z.array(z.object({contributions:z.array(z.enum(['dictionaryFormats','librarySources','contentSources','sourceFormats']))}).passthrough())}).passthrough();
    expect(()=>legacyIndex.parse(index)).not.toThrow();
    expect(index.plugins.every(item=>!item.contributions.includes('managementPages'))).toBe(true);
    expect(index.plugins.map((item) => item.downloadUrl)).toEqual([
      base + 'legado-0.3.0-x1.readest-plugin', base + 'venera-0.3.0-x1.readest-plugin',
    ]);
    expect(JSON.parse(readFileSync(join(directory, 'local.readest-repo'))).url).toBe(base + 'repo.json');
    expect((await verifyRepository(directory)).plugins).toHaveLength(2);
  } finally {
    if (!realpathSync(directory).startsWith(realpathSync('.artifacts') + sep)) throw new Error('Invalid test cleanup path');
    rmSync(directory, { recursive: true });
  }
});
