import { it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { resolve, join, sep } from 'node:path';
import { verifyRepository } from '../scripts/verify-repository.mjs';

it('publishes usable release-root URLs while verifying local signed archives', async () => {
  mkdirSync('.artifacts', { recursive: true });
  const directory = mkdtempSync(resolve('.artifacts/release-repo-'));
  const base = 'https://github.com/WenHe233/readest-remote-plugins/releases/download/v0.2.0-x1/';
  try {
    execFileSync(process.execPath, ['scripts/sign-plugins.mjs', '--test', '--experimental', '--release-base', base, '--out', directory], { stdio: 'pipe' });
    const index = JSON.parse(readFileSync(join(directory, 'index.json')));
    expect(index.plugins.map((item) => item.downloadUrl)).toEqual([
      base + 'legado-0.2.0-x1.readest-plugin', base + 'venera-0.2.0-x1.readest-plugin',
    ]);
    expect(JSON.parse(readFileSync(join(directory, 'local.readest-repo'))).url).toBe(base + 'repo.json');
    expect((await verifyRepository(directory)).plugins).toHaveLength(2);
  } finally {
    if (!realpathSync(directory).startsWith(realpathSync('.artifacts') + sep)) throw new Error('Invalid test cleanup path');
    rmSync(directory, { recursive: true });
  }
});
