import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const test = process.argv.includes('--test');
const testAll=process.argv.includes('--test-all');
if(testAll&&!test)throw new Error('--test-all requires --test and cannot use a production signer');
const experimental=process.argv.includes('--experimental')||/-x\d+$/.test(JSON.parse(readFileSync(resolve(import.meta.dirname,'..','package.json'),'utf8')).version);
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
const releaseIndex=process.argv.indexOf('--release-base');
const releaseBase=releaseIndex>=0?process.argv[releaseIndex+1]:!test&&experimental?`https://github.com/WenHe233/readest-remote-plugins/releases/download/v${JSON.parse(readFileSync(resolve(import.meta.dirname,'..','package.json'),'utf8')).version}/`:undefined;
try {
  writeFileSync(path, pem, { mode: 0o600, flag: 'wx' });
  execFileSync(process.execPath, [resolve(import.meta.dirname, 'build-plugins.mjs'), '--key', path, '--out', resolve(index >= 0 ? process.argv[index + 1] : 'dist'), '--channel', channelIndex >= 0 ? process.argv[channelIndex + 1] : experimental?'beta':'stable', ...(experimental?['--experimental']:[]),...(testAll?['--test-all']:[]),...(releaseBase?['--release-base',releaseBase]:[])], { stdio: 'inherit' });
} finally {
  rmSync(path, { force: true });
  rmdirSync(directory);
}
