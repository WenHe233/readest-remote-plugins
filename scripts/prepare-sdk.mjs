import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { resolve, join } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const source = JSON.parse(readFileSync(join(root, 'SDK_SOURCE.json'), 'utf8'));
if (!/^[\w-]+\/[\w.-]+$/.test(source.repository) || !/^[0-9a-f]{40}$/.test(source.revision)) throw new Error('Invalid SDK source pin');
const localIndex = process.argv.indexOf('--local');
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
// npm_execpath is supplied by both `npm run sdk:prepare` and `pnpm sdk:prepare`.
if (!process.env.npm_execpath) throw new Error('Run this script with npm run sdk:prepare');
execFileSync(process.execPath, [process.env.npm_execpath, 'pack', '--ignore-scripts', '--pack-destination', output], { cwd: directory, stdio: 'inherit' });
renameSync(join(output, `readest-plugin-sdk-${manifest.version}.tgz`), join(output, 'readest-plugin-sdk.tgz'));
console.log(`Prepared @readest/plugin-sdk ${manifest.version} from ${localIndex >= 0 ? 'explicit local SDK' : source.revision}`);
