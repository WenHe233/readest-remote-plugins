import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { verifyRepository } from '../scripts/verify-repository.mjs';

describe('release signing boundaries', () => {
  const script = resolve('scripts/sign-plugins.mjs');
  const env = { ...process.env, READEST_PLUGIN_SIGNING_KEY_PEM: '', READEST_PLUGIN_SIGNER_SHA256: '0'.repeat(64) };
  const run = () => spawnSync(process.execPath, [script], { env, encoding: 'utf8' });
  it('requires a configured key', () => expect(run().stderr).toMatch(/Configure READEST_PLUGIN_SIGNING_KEY_PEM/));
  it('rejects a different signer', () => {
    env.READEST_PLUGIN_SIGNING_KEY_PEM = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
    expect(run().stderr).toMatch(/does not match/);
  });
  it('rejects a non-Ed25519 key', () => {
    env.READEST_PLUGIN_SIGNING_KEY_PEM = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' });
    expect(run().stderr).toMatch(/requires an Ed25519 key/);
  });
});

describe('repository verification', () => {
  let directory;
  beforeAll(() => {
    mkdirSync('.artifacts', { recursive: true });
    directory = mkdtempSync(resolve('.artifacts/verify-'));
    execFileSync(process.execPath, ['scripts/sign-plugins.mjs', '--test', '--out', directory], { stdio: 'pipe' });
  });
  afterAll(() => {
    if (!realpathSync(directory).startsWith(realpathSync('.artifacts') + sep)) throw new Error('Invalid test cleanup path');
    rmSync(directory, { recursive: true });
  });
  it('verifies the actual workers and rejects signer changes', async () => {
    const index = await verifyRepository(directory);
    expect(index.plugins).toHaveLength(2);
    await expect(verifyRepository(directory, '0'.repeat(64))).rejects.toThrow(/Signer mismatch/);
  });
  it('rejects changed archive bytes even when the repository digest is updated', async () => {
    const path = join(directory, 'index.json');
    const index = JSON.parse(readFileSync(path));
    const item = index.plugins[0];
    const archive = join(directory, item.downloadUrl);
    const original = readFileSync(archive);
    const changed = Buffer.from(original);
    changed[100] ^= 1;
    writeFileSync(archive, changed);
    await expect(verifyRepository(directory)).rejects.toThrow(/digest mismatch/);
    item.sha256 = createHash('sha256').update(changed).digest('hex');
    writeFileSync(path, JSON.stringify(index));
    await expect(verifyRepository(directory)).rejects.toThrow();
    writeFileSync(archive, original);
  });
});
