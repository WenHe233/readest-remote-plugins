import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { ZipReader, Uint8ArrayReader, Uint8ArrayWriter } from '@zip.js/zip.js';
import { pathToFileURL } from 'node:url';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export async function verifyRepository(directory, expectedSigner) {
  const index = JSON.parse(readFileSync(join(directory, 'index.json'), 'utf8'));
  if (index.schemaVersion !== 1 || !index.plugins.length) throw new Error('Empty or invalid repository');
  for (const item of index.plugins) {
    let archivePath=item.downloadUrl;
    if(!/^plugins\/[a-z0-9.-]+\.readest-plugin$/.test(archivePath)){
      const url=new URL(item.downloadUrl);
      const name=url.pathname.split('/').at(-1);
      if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||!/^[a-z0-9.-]+\.readest-plugin$/.test(name))throw new Error('Invalid package path');
      archivePath='plugins/'+name;
    }
    const bytes = readFileSync(join(directory, archivePath));
    if (digest(bytes) !== item.sha256 || bytes.length !== item.size) throw new Error('Package digest mismatch');
    const reader = new ZipReader(new Uint8ArrayReader(bytes));
    try {
      const entries = await reader.getEntries();
      const files = new Map();
      for (const entry of entries) {
        if (entry.directory || !/^[a-zA-Z0-9_.\-/]+$/.test(entry.filename) || entry.filename.split('/').some(p=>!p||p==='.'||p==='..') || files.has(entry.filename)) throw new Error('Invalid archive path');
        files.set(entry.filename, Buffer.from(await entry.getData(new Uint8ArrayWriter())));
      }
      const signature = JSON.parse(files.get('signature.json'));
      const publicKey = Buffer.from(signature.publicKey, 'base64');
      if (signature.algorithm !== 'Ed25519' || publicKey.length !== 32 || digest(publicKey) !== item.fingerprint || (expectedSigner && item.fingerprint !== expectedSigner)) throw new Error('Signer mismatch');
      const inventory = [...signature.files].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
      if (inventory.length !== files.size - 1 || new Set(inventory.map(f=>f.path)).size !== inventory.length) throw new Error('Incomplete signed inventory');
      for (const file of inventory) {
        const content = files.get(file.path);
        if (!content || file.path === 'signature.json' || content.length !== file.size || digest(content) !== file.sha256) throw new Error('Signed file digest mismatch');
      }
      const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),publicKey]), type:'spki',format:'der' });
      if (!verify(null,Buffer.from(JSON.stringify({format:1,files:inventory})),key,Buffer.from(signature.signature,'base64'))) throw new Error('Invalid signature');
      const manifest = JSON.parse(files.get('manifest.json'));
      const api=manifest.pluginApi;
      if (manifest.id !== item.id || manifest.pluginVersion !== item.version || manifest.protocolVersion !== 2 || !api || !Number.isInteger(api.min) || !Number.isInteger(api.max) || api.min>api.max || api.min>3 || api.max<2 || JSON.stringify(api)!==JSON.stringify(item.pluginApi) || !files.has(manifest.entry)) throw new Error('Manifest identity mismatch');
    } finally { await reader.close(); }
  }
  return index;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const index = await verifyRepository(resolve(process.argv[2] || 'dist'), process.env.READEST_PLUGIN_SIGNER_SHA256);
  console.log(`Verified ${index.plugins.length} signed plugin packages`);
}
