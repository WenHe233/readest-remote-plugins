import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { verifyRepository } from './verify-repository.mjs';

const repository='WenHe233/readest-remote-plugins';
const tags=execFileSync('gh',['api',`repos/${repository}/releases`,'--paginate','--jq','.[] | select(.draft == false) | .tag_name'],{encoding:'utf8'}).trim().split('\n').filter(Boolean);
if(!tags.length) throw new Error('No published plugin releases');
mkdirSync('.pages/plugins',{recursive:true});
const plugins=new Map();
for(const tag of tags) {
  if(!/^v[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$/.test(tag)) continue;
  const directory=join('.artifacts/pages',tag);
  mkdirSync(join(directory,'plugins'),{recursive:true});
  execFileSync('gh',['release','download',tag,'--repo',repository,'--pattern','index.json','--dir',directory,'--clobber'],{stdio:'inherit'});
  execFileSync('gh',['release','download',tag,'--repo',repository,'--pattern','*.readest-plugin','--dir',join(directory,'plugins'),'--clobber'],{stdio:'inherit'});
  const index=await verifyRepository(directory,process.env.READEST_PLUGIN_SIGNER_SHA256);
  for(const plugin of index.plugins) {
    const key=`${plugin.id}/${plugin.fingerprint}/${plugin.version}/${plugin.channel}`;
    const prior=plugins.get(key);
    if(prior && prior.sha256!==plugin.sha256) throw new Error('Published plugin version was changed');
    const path=join('.pages',plugin.downloadUrl);
    if(existsSync(path) && !readFileSync(path).equals(readFileSync(join(directory,plugin.downloadUrl)))) throw new Error('Conflicting package filename');
    copyFileSync(join(directory,plugin.downloadUrl),path);
    plugins.set(key,plugin);
  }
}
writeFileSync('.pages/index.json',JSON.stringify({schemaVersion:1,plugins:[...plugins.values()]},null,2)+'\n');
writeFileSync('.pages/repo.json',JSON.stringify({schemaVersion:1,id:'io.github.wenhe233.readest-remote-plugins',name:'Readest Remote plugins',description:'Signed Kavita and Komga plugins',index:'index.json'},null,2)+'\n');
writeFileSync('.pages/readest-remote.readest-repo',JSON.stringify({name:'Readest Remote plugins',url:'https://wenhe233.github.io/readest-remote-plugins/repo.json'})+'\n');
writeFileSync('.pages/index.html','<!doctype html><meta charset="utf-8"><title>Readest Remote plugins</title><h1>Readest Remote plugins</h1><p>Add <a href="repo.json">repo.json</a> in Readest Remote Settings → Plugins → Repositories.</p><p><a href="readest-remote.readest-repo">Download repository import file</a></p><p>Signer: <code>53bd64d1d5c13cd5010e0e46dd1e521d3a296fa41c6e7ce1767266890ba2092e</code></p>');
await verifyRepository('.pages',process.env.READEST_PLUGIN_SIGNER_SHA256);
