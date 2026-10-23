import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { packSdk } from './pack-sdk.mjs';

const root = resolve(import.meta.dirname, '..');
const source = JSON.parse(readFileSync(join(root, 'SDK_SOURCE.json'), 'utf8'));
const localIndex = process.argv.indexOf('--local');
if (!/^[\w-]+\/[\w.-]+$/.test(source.repository)) throw new Error('Invalid SDK repository');
if(localIndex<0&&(typeof source.revision!=='string'||!/^[0-9a-f]{40}$/.test(source.revision)))throw new Error('SDK release revision is not pinned. Use --local for development, and pin the actual API 4 SDK commit before CI or publication.');
let directory;
if (localIndex >= 0) directory = resolve(process.argv[localIndex + 1]);
else {
  const checkout = join(root, '.sdk-source');
  mkdirSync(checkout, { recursive: true });
  const git = (...args) => execFileSync('git', args, { cwd: checkout, stdio: 'inherit' });
  if (!existsSync(join(checkout, '.git'))) {
    git('init');
    git('remote', 'add', 'origin', `https://github.com/${source.repository}.git`);
    git('sparse-checkout', 'set', 'packages/plugin-sdk');
  }
  git('fetch', '--depth=1', 'origin', source.revision);
  git('checkout', '--detach', 'FETCH_HEAD');
  directory = join(checkout, 'packages/plugin-sdk');
}
const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
if (manifest.name !== '@readest/plugin-sdk' || manifest.version !== source.version) throw new Error('Unexpected SDK identity');
const output = join(root, '.sdk');
mkdirSync(output, { recursive: true });
packSdk(directory, output);
renameSync(join(output, `readest-plugin-sdk-${manifest.version}.tgz`), join(output, 'readest-plugin-sdk.tgz'));
console.log(`Prepared @readest/plugin-sdk ${manifest.version} from ${localIndex >= 0 ? 'explicit local SDK' : source.revision}`);
