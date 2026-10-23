import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { mkdir, readFile, writeFile, access, readdir, unlink } from 'node:fs/promises';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(join(root,'package.json'));
const {build}=require('esbuild');
const {ZipWriter,Uint8ArrayWriter,Uint8ArrayReader}=require('@zip.js/zip.js');
const args=process.argv.slice(2);
const option=(name,fallback)=>args.includes(name)?args[args.indexOf(name)+1]:fallback;
const output=resolve(option('--out',join(root,'dist')));
const releaseBase=option('--release-base');
if(releaseBase){const url=new URL(releaseBase);if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||!url.pathname.endsWith('/'))throw new Error('Invalid release base URL');}
const keyPath=option('--key',process.env.READEST_PLUGIN_SIGNING_KEY);
if(!keyPath&&!args.includes('--dev'))throw new Error('Supply --key <private.pem> or --dev for a local test key');
const signingKey=resolve(keyPath||join(root,'.local','test-signing-key.pem'));
await mkdir(dirname(signingKey),{recursive:true});
try{await access(signingKey);}catch{
  if(!args.includes('--dev'))throw new Error('Signing key does not exist');
  const {privateKey}=generateKeyPairSync('ed25519');
  await writeFile(signingKey,privateKey.export({format:'pem',type:'pkcs8'}),{mode:0o600,flag:'wx'});
}
const key=createPrivateKey(await readFile(signingKey));
const publicBytes=createPublicKey(key).export({type:'spki',format:'der'}).subarray(-32);
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
await mkdir(join(output,'plugins'),{recursive:true});
const releases=[];
const directories=option('--plugin')?[resolve(option('--plugin'))]:(args.includes('--test-all')?['kavita','komga','legado','venera']:args.includes('--experimental')?['legado','venera']:['kavita','komga']).map(slug=>join(root,'plugins',slug));
for(const dir of directories){
  const result=await build({entryPoints:[join(dir,'src/worker.ts')],bundle:true,write:false,format:'iife',platform:'browser',target:'es2022',minify:true,metafile:true,legalComments:'inline'});
  for(const input of Object.keys(result.metafile.inputs))if(input.replaceAll('\\','/').includes('apps/readest-app/src/'))throw new Error('A plugin imported host implementation code');
  const manifest=JSON.parse(await readFile(join(dir,'manifest.json'),'utf8'));
  if(option('--version'))manifest.pluginVersion=option('--version');
  const files=new Map([['manifest.json',Buffer.from(JSON.stringify(manifest,null,2)+'\n')],['worker.js',result.outputFiles[0].contents]]);
  let buildResources=[];
  try{buildResources=JSON.parse(await readFile(join(dir,'package.json'),'utf8')).readestBuildResources??[];}catch(error){if(error.code!=='ENOENT')throw error;}
  for(const resource of buildResources){
    const safePath=path=>typeof path==='string'&&/^[a-zA-Z0-9_.\-/]+$/.test(path)&&!path.startsWith('/')&&path.split('/').every(segment=>segment&&segment!=='.'&&segment!=='..');
    if(!/^(@[a-z0-9-]+\/)?[a-z0-9-]+$/.test(resource.package)||!safePath(resource.path)||!safePath(resource.target)||!resource.target.startsWith('resources/'))throw new Error('Invalid declared package resource');
    const packageRoot=dirname(require.resolve(resource.package+'/package.json'));
    files.set(resource.target,await readFile(join(packageRoot,resource.path)));
  }
  const addResources=async(directory,prefix)=>{
    let entries;
    try{entries=await readdir(directory,{withFileTypes:true});}catch(error){if(error.code==='ENOENT')return;throw error;}
    for(const entry of entries){
      if(entry.isSymbolicLink())throw new Error('Plugin resources cannot contain symbolic links');
      const path=prefix+entry.name;
      if(!/^[a-zA-Z0-9_.\-/]+$/.test(path))throw new Error('Use portable ASCII resource paths');
      if(entry.isDirectory())await addResources(join(directory,entry.name),path+'/');
      else if(entry.isFile())files.set(path,await readFile(join(directory,entry.name)));
    }
  };
  await addResources(join(dir,'resources'),'resources/');
  const inventory=[...files].map(([path,bytes])=>({path,size:bytes.length,sha256:digest(bytes)})).sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
  const signed=sign(null,Buffer.from(JSON.stringify({format:1,files:inventory})),key).toString('base64');
  files.set('signature.json',Buffer.from(JSON.stringify({algorithm:'Ed25519',publicKey:publicBytes.toString('base64'),files:inventory,signature:signed})));
  const zip=new ZipWriter(new Uint8ArrayWriter(),{useWebWorkers:false});
  for(const [name,bytes] of files)await zip.add(name,new Uint8ArrayReader(bytes),{lastModDate:new Date('2026-01-01T00:00:00Z')});
  const bytes=await zip.close();
  const slug=dir.split(/[\\/]/).at(-1);
  const filename=`${slug}-${manifest.pluginVersion}.readest-plugin`;
  await writeFile(join(output,'plugins',filename),bytes);
  releases.push({id:manifest.id,name:manifest.name,description:manifest.description,version:manifest.pluginVersion,channel:option('--channel',args.includes('--experimental')?'beta':'stable'),fingerprint:digest(publicBytes),downloadUrl:releaseBase?new URL(filename,releaseBase).href:'plugins/'+filename,size:bytes.length,sha256:digest(bytes),pluginApi:manifest.pluginApi,contributions:Object.keys(manifest.contributions).filter(name=>['dictionaryFormats','librarySources','contentSources','sourceFormats'].includes(name))});
}
await writeFile(join(output,'repo.json'),JSON.stringify({schemaVersion:1,id:'io.github.wenhe233.readest-remote-plugins',name:'Readest Remote plugins',description:'Signed Readest plugins',index:'index.json'},null,2)+'\n');
await writeFile(join(output,'index.json'),JSON.stringify({schemaVersion:1,plugins:releases},null,2)+'\n');
const builtNames=new Set(releases.map(release=>new URL(release.downloadUrl,'https://repository.invalid/').pathname.split('/').at(-1)));
for(const name of await readdir(join(output,'plugins'))){
  if(/^[a-z0-9.-]+\.readest-plugin$/.test(name)&&!builtNames.has(name))await unlink(join(output,'plugins',name));
}
await writeFile(join(output,'local.readest-repo'),JSON.stringify({name:'Readest plugins',url:releaseBase?new URL('repo.json',releaseBase).href:option('--url','https://wenhe233.github.io/readest-remote-plugins/repo.json')},null,2)+'\n');
console.log(JSON.stringify({output,signer:digest(publicBytes),plugins:releases.map(r=>({id:r.id,version:r.version,size:r.size}))},null,2));
