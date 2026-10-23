import { readFileSync, readdirSync, mkdirSync, copyFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ZipWriter, Uint8ArrayWriter, Uint8ArrayReader } from '@zip.js/zip.js';
import { verifyRepository } from './verify-repository.mjs';

const { version } = JSON.parse(readFileSync('package.json'));
const {version:sdkVersion}=JSON.parse(readFileSync('SDK_SOURCE.json'));
await verifyRepository('dist', process.env.READEST_PLUGIN_SIGNER_SHA256);
mkdirSync('release', { recursive: true });
function collect(directory, prefix = '') {
  return readdirSync(directory,{withFileTypes:true}).flatMap(entry=> {
    if(entry.isSymbolicLink()) throw new Error('Archive inputs must not be symlinks');
    const path=join(directory,entry.name);
    return entry.isDirectory()?collect(path,prefix+entry.name+'/'):[[prefix+entry.name,readFileSync(path)]];
  });
}
async function zip(path, entries) {
  const writer=new ZipWriter(new Uint8ArrayWriter(),{useWebWorkers:false});
  for(const [name,bytes] of entries) await writer.add(name,new Uint8ArrayReader(bytes),{lastModDate:new Date('2026-01-01T00:00:00Z')});
  writeFileSync(path,await writer.close());
}
await zip(`release/readest-plugin-source-${version}.zip`,collect('dist'));
copyFileSync('.sdk/readest-plugin-sdk.tgz',`release/readest-plugin-sdk-${sdkVersion}.tgz`);
const examples=[...collect('plugins','plugins/'),...collect('packages','packages/'),...collect('scripts','scripts/'),['.sdk/readest-plugin-sdk.tgz',readFileSync('.sdk/readest-plugin-sdk.tgz')]];
for(const name of ['package.json','pnpm-lock.yaml','pnpm-workspace.yaml','SDK_SOURCE.json','tsconfig.json','README.md','LICENSE']) examples.push([name,readFileSync(name)]);
examples.push(['COMPATIBILITY.md',readFileSync('COMPATIBILITY.md')]);
// Download pinned upstream scripts for testing instead of redistributing sources
// whose repository does not provide a license. Their hashes remain in the lock.
examples.push(...collect('tests','tests/').filter(([name])=>!name.startsWith('tests/fixtures/venera/')&&name!=='tests/fixtures/legado/shuhaige.json'));
await zip(`release/readest-plugin-examples-${version}.zip`,examples);
for(const name of readdirSync('dist/plugins')) copyFileSync(join('dist/plugins',name),join('release',name));
copyFileSync('dist/index.json','release/index.json');
copyFileSync('dist/repo.json','release/repo.json');
if(existsSync('.artifacts/compatibility-report.json'))copyFileSync('.artifacts/compatibility-report.json','release/compatibility-report.json');
const sums=readdirSync('release').filter(name=>name!=='SHA256SUMS.txt').sort().map(name=>`${createHash('sha256').update(readFileSync(join('release',name))).digest('hex')}  ${name}`);
writeFileSync('release/SHA256SUMS.txt',sums.join('\n')+'\n');
