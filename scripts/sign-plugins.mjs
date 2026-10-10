import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const test = process.argv.includes('--test');
const pem = test ? generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }) : process.env.READEST_PLUGIN_SIGNING_KEY_PEM;
if (!pem) throw new Error('Configure READEST_PLUGIN_SIGNING_KEY_PEM as an Actions secret');
const key = createPrivateKey(pem);
if (key.asymmetricKeyType !== 'ed25519') throw new Error('Plugin signing requires an Ed25519 key');
const fingerprint = createHash('sha256').update(createPublicKey(key).export({ type: 'spki', format: 'der' }).subarray(-32)).digest('hex');
if (!test && fingerprint !== process.env.READEST_PLUGIN_SIGNER_SHA256?.toLowerCase()) throw new Error('Signing key does not match configured signer');
const directory = mkdtempSync(join(tmpdir(), 'readest-plugin-sign-'));
const path = join(directory, 'key.pem');
const index = process.argv.indexOf('--out');
const channelIndex = process.argv.indexOf('--channel');
try {
  writeFileSync(path, pem, { mode: 0o600, flag: 'wx' });
  execFileSync(process.execPath, [resolve(import.meta.dirname, 'build-plugins.mjs'), '--key', path, '--out', resolve(index >= 0 ? process.argv[index + 1] : 'dist'), '--channel', channelIndex >= 0 ? process.argv[channelIndex + 1] : 'stable'], { stdio: 'inherit' });
} finally {
  rmSync(path, { force: true });
  rmdirSync(directory);
}
