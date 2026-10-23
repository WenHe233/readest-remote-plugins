import { sourceDescriptionSchema, type SourceDescription } from '@readest/plugin-sdk';
import { Sandbox } from '../../../packages/compatibility/src/sandbox';
import { COMMON_BOOTSTRAP, createServices } from '../../../packages/compatibility/src/services';
import {
  CompatibilityError,
  type EngineHost,
  type EngineWork,
  type EngineChapter,
  type EngineContent,
  type EngineResource,
  type EnginePage,
} from '../../../packages/compatibility/src/types';

export interface VeneraDefinition {
  id: string;
  name: string;
  format: 'venera';
  content: string;
  className: string;
  version?: string;
}
export function inspectVenera(content: string): VeneraDefinition {
  if (content.length > 4 * 1024 * 1024)
    throw new CompatibilityError('INVALID_SOURCE', 'Source exceeds 4 MiB');
  const match = /class\s+([A-Za-z_$][\w$]*)\s+extends\s+ComicSource\b/.exec(content);
  if (!match)
    throw new CompatibilityError('INVALID_SOURCE', 'Expected a class extending ComicSource');
  const field = (name: string) =>
    new RegExp(`\\b${name}\\s*=\\s*['"]([^'"\\r\\n]+)['"]`).exec(content)?.[1];
  return {
    id: field('key') ?? match[1],
    name: field('name') ?? match[1],
    format: 'venera',
    content,
    className: match[1],
    version: field('version'),
  };
}
export function inspectVeneraList(
  content: string,
  baseUrl?: string,
): Array<{ name: string; url: string; version?: string; description?: string }> {
  const list = JSON.parse(content);
  if (!Array.isArray(list))
    throw new CompatibilityError('INVALID_SOURCE', 'Expected a Venera source list');
  return list.map((item) => {
    const target = item.url ?? item.filename ?? item.fileName;
    if (typeof target !== 'string' || (!baseUrl && !/^https?:\/\//i.test(target)))
      throw new CompatibilityError(
        'INVALID_SOURCE',
        'Relative source list entries need the original list URL',
      );
    const url = new URL(target, baseUrl);
    if (!['https:', 'http:'].includes(url.protocol))
      throw new CompatibilityError('INVALID_SOURCE', 'Invalid source URL');
    return {
      name: String(item.name ?? ''),
      url: url.href,
      ...(typeof item.version === 'string' ? { version: item.version } : {}),
      ...(typeof item.description === 'string' ? { description: item.description } : {}),
    };
  });
}

const BOOTSTRAP =
  COMMON_BOOTSTRAP +
  String.raw`
globalThis.ComicSource=class {
 static sources={};
 loadData(key){return service('storage.get',key);}
 saveData(key,value){service('storage.set',key,value);}
 deleteData(key){service('storage.delete',key);}
 loadSetting(key){return service('setting',key)??this.settings?.[key]?.default;}
 get isLogged(){return !!this.loadData('__logged');}
 init(){}
};
for(const name of ['Comic','ComicDetails','Comment','Cookie','ImageLoadingConfig'])globalThis[name]=class{constructor(data){Object.assign(this,data);this.subtitle??=this.subTitle;}};
function encodeBody(data){return data instanceof ArrayBuffer?Array.from(new Uint8Array(data)):ArrayBuffer.isView(data)?Array.from(data):data&&typeof data==='object'?JSON.stringify(data):data;}
globalThis.Network={
 sendRequest:async(method,url,headers,data)=>JSON.parse(await __requestAsync(JSON.stringify({method,url,headers,body:encodeBody(data)}))),
 fetchBytes:async(method,url,headers,data)=>{const r=JSON.parse(await __requestAsync(JSON.stringify({method,url,headers,body:encodeBody(data),responseType:'bytes'})));r.body=new Uint8Array(r.bytes??Array.from(new Uint8Array(Convert.encodeUtf8(r.body)))).buffer;return r;},
 setCookies:(...args)=>service('cookies.set',...args),getCookies:(...args)=>service('cookies.get',...args),deleteCookies:(...args)=>service('cookies.delete',...args)
};
for(const method of ['get','post','put','delete','patch'])Network[method]=(url,headers,data)=>Network.sendRequest(method.toUpperCase(),url,headers,data);
globalThis.APP={locale:service('setting','locale')||'zh_CN',version:'1.6.0',platform:'readest'};
globalThis.fetch=async(url,options={})=>{const r=await Network.sendRequest(options.method||'GET',url,options.headers,options.body);return {ok:r.status>=200&&r.status<300,status:r.status,url:r.url,headers:r.headers,text:async()=>r.body,json:async()=>JSON.parse(r.body),arrayBuffer:async()=>r.bytes?new Uint8Array(r.bytes).buffer:Convert.encodeUtf8(r.body)};};
globalThis.UI=new Proxy({}, {get:(_,key)=>(...args)=>unsupported('UI.'+key)});
globalThis.randomInt=(min,max)=>Math.floor(Math.random()*(max-min+1))+min;
globalThis.randomDouble=(min,max)=>Math.random()*(max-min)+min;
globalThis.createUuid=()=> 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,c=>{const r=Math.floor(Math.random()*16);return (c==='x'?r:(r&3|8)).toString(16);});
function portable(value){return JSON.parse(JSON.stringify(value,(_,v)=>v instanceof Map?Object.fromEntries(v):v));}
function searchOptions(){return (__source.search?.optionList||[]).map(option=>option.default??option.options?.[0]?.split('-')[0]??'any');}
`;

export class VeneraEngine {
  private vm?: Sandbox;
  private state: Record<string, unknown> = {};
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    readonly definition: VeneraDefinition,
    private host: EngineHost,
  ) {}
  private call(expression: string): Promise<any> {
    const next = this.tail.then(async () => {
      if (!this.vm) {
        this.state = await this.host.readState();
        this.vm = await Sandbox.create(this.host, {
          service: createServices(this.state, this.host.settings, this.host.service),
        });
        await this.vm.run(
          BOOTSTRAP +
            '\n' +
            this.definition.content +
            `\nglobalThis.__source=new ${this.definition.className}(); ComicSource.sources[__source.key]=__source;`,
        );
        await this.vm.run('Promise.resolve(__source.init?.())');
      }
      const result = await this.vm.run(`Promise.resolve(${expression}).then(portable)`);
      await this.host.writeState(this.state);
      return result;
    });
    this.tail = next.catch(() => {});
    return next;
  }
  async describe(): Promise<SourceDescription> {
    const denied = () => {
      throw new CompatibilityError(
        'PERMISSION_DENIED',
        'Source metadata cannot access private state or network',
      );
    };
    const vm = await Sandbox.create(
      { ...this.host, request: async () => denied() },
      {
        service: (name) => (name === 'setting' ? null : denied()),
      },
    );
    try {
      await vm.run(
        BOOTSTRAP +
          '\n' +
          this.definition.content +
          `\nglobalThis.__source=new ${this.definition.className}();`,
      );
      return sourceDescriptionSchema.parse(
        await vm.run(`portable((()=>{
        const settings=[],actions=[];
        const tr=value=>__source.translation?.[APP.locale]?.[value]??String(value??'');
        for(const [key,item] of Object.entries(__source.settings??{})) {
          if(item.type==='callback') {actions.push({id:key,label:tr(item.buttonText??item.title)});continue;}
          const type={input:'text',switch:'boolean',select:'select'}[item.type];
          if(!type)unsupported('settings.'+item.type);
          const secret=type==='text'&&/api.?key|password|secret|token/i.test(key);
          const field={key,label:tr(item.title??key),type:secret?'secret':type};
          if(type==='text')field.private=true;
          if(item.default!==undefined)field.default=item.default;
          if(type==='select')field.options=(item.options??[]).map(option=>({value:option.value,label:tr(option.text??option.value)}));
          settings.push(field);
        }
        let authentication={kind:'none'};
        if(__source.account?.login)authentication={kind:'form',fields:[{key:'account',label:'Account',type:'text',required:true},{key:'password',label:'Password',type:'secret',required:true}]};
        else if(__source.account?.loginWithCookies?.validate)authentication={kind:'form',fields:__source.account.loginWithCookies.fields.map(key=>({key,label:key,type:'secret',required:true}))};
        else if(__source.account?.loginWithWebview)authentication={kind:'unsupported',reason:'account.loginWithWebview'};
        return {settings,actions,authentication};
      })())`),
      );
    } finally {
      vm.dispose();
    }
  }
  async validateSettings(
    values: Record<string, unknown>,
  ): Promise<{ fieldErrors: Record<string, string> }> {
    const denied = () => {
      throw new CompatibilityError(
        'PERMISSION_DENIED',
        'Settings validation cannot use host services',
      );
    };
    const vm = await Sandbox.create(
      { ...this.host, request: async () => denied() },
      { timeoutMs: 1000, service: (name) => (name === 'setting' ? null : denied()) },
    );
    try {
      await vm.run(
        BOOTSTRAP +
          '\n' +
          this.definition.content +
          `\nglobalThis.__source=new ${this.definition.className}();`,
      );
      return (await vm.run(
        `(()=>{const values=${JSON.stringify(values)},fieldErrors={};for(const [key,setting] of Object.entries(__source.settings??{})){if(setting.type!=='input'||!setting.validator||!Object.prototype.hasOwnProperty.call(values,key))continue;if(typeof setting.validator!=='string')unsupported('settings.validator');try{if(!new RegExp(setting.validator).test(String(values[key]??setting.default??'')))fieldErrors[key]='Invalid setting value';}catch{fieldErrors[key]='Invalid setting validator';}}return {fieldErrors};})()`,
      )) as { fieldErrors: Record<string, string> };
    } finally {
      vm.dispose();
    }
  }
  async runSettingAction(actionId: string): Promise<void> {
    const description = await this.describe();
    if (!description.actions.some((action) => action.id === actionId))
      throw new CompatibilityError('INVALID_PAYLOAD', 'Unknown setting action');
    await this.call(
      `(async()=>{await __source.settings[${JSON.stringify(actionId)}].callback();return true;})()`,
    );
  }
  private async coverWork(value: unknown): Promise<EngineWork> {
    const work = this.work(value);
    if (work.cover) {
      const config = (await this.call(
        `Promise.resolve(__source.comic?.onThumbnailLoad?.(${JSON.stringify(work.cover.url)})??{})`,
      )) as Record<string, unknown>;
      if (config.modifyImage || config.onResponse)
        throw new CompatibilityError(
          'UNSUPPORTED_CAPABILITY',
          'Thumbnail response transformation is unavailable',
        );
      work.cover = {
        ...work.cover,
        url: typeof config.url === 'string' ? config.url : work.cover.url,
        headers: config.headers as Record<string, string> | undefined,
      };
    }
    return work;
  }
  async search(query: string, cursor?: string): Promise<EnginePage<EngineWork>> {
    const page = Number(cursor ?? 1);
    const result = await this.call(
      `(__source.search?.load ? __source.search.load(${JSON.stringify(query)},searchOptions(),${page}) : __source.search?.loadNext ? __source.search.loadNext(${JSON.stringify(query)},searchOptions(),${JSON.stringify(cursor ?? null)}) : unsupported('search'))`,
    );
    return {
      items: await Promise.all((result.comics ?? []).map((v: unknown) => this.coverWork(v))),
      nextCursor: result.next ?? (result.maxPage > page ? String(page + 1) : undefined),
    };
  }
  async explore(cursor?: string): Promise<EnginePage<EngineWork>> {
    const page = Number(cursor ?? 1);
    const result = await this.call(
      `(__source.explore?.[0]?.load ? __source.explore[0].load(${page}) : unsupported('explore'))`,
    );
    const comics =
      result.comics ??
      (Array.isArray(result)
        ? result.flatMap((part: any) => part.comics ?? [])
        : (result.data?.flatMap((part: any) => part.comics ?? (Array.isArray(part) ? part : [])) ??
          []));
    return {
      items: await Promise.all(comics.map((v: unknown) => this.coverWork(v))),
      nextCursor: result.maxPage > page ? String(page + 1) : undefined,
    };
  }
  async getWork(id: string): Promise<EngineWork> {
    return this.coverWork({
      ...(await this.call(`__source.comic.loadInfo(${JSON.stringify(id)})`)),
      id,
    });
  }
  async getChapters(id: string): Promise<EnginePage<EngineChapter>> {
    const result = await this.call(`__source.comic.loadInfo(${JSON.stringify(id)})`);
    const chapters = result.chapters ?? { '0': 'Read' };
    const items: EngineChapter[] = [];
    for (const [key, value] of Object.entries(chapters)) {
      if (typeof value === 'string') items.push({ id: key, title: value });
      else if (value && typeof value === 'object')
        for (const [chapterId, title] of Object.entries(value))
          items.push({ id: chapterId, title: String(title), group: key });
    }
    return { items };
  }
  async resolveChapter(workId: string, chapterId: string): Promise<EngineContent> {
    const pages = await this.call(
      `(async()=>{const result=await __source.comic.loadEp(${JSON.stringify(workId)},${JSON.stringify(chapterId)});const pages=Array.isArray(result)?result:result.images;if(!Array.isArray(pages))throw new Error('loadEp returned no images');return await Promise.all(pages.map(async(url,index)=>{const config=await (__source.comic.onImageLoad?.(url,${JSON.stringify(workId)},${JSON.stringify(chapterId)})??{});if(config.onResponse||config.modifyImage)unsupported('ImageLoadingConfig.onResponse/modifyImage');return {id:${JSON.stringify(chapterId)}+':'+index,url:config.url||url,headers:config.headers,method:config.method,body:encodeBody(config.data)};}));})()`,
    );
    return { kind: 'pages', pages };
  }
  async resolveResource(resource: EngineResource) {
    return resource;
  }
  async login(account: string, password: string) {
    return this.call(
      `(async()=>{if(!__source.account?.login)unsupported('account.login');const value=await __source.account.login(${JSON.stringify(account)},${JSON.stringify(password)});__source.saveData('__logged',true);return value??true;})()`,
    );
  }
  async authenticate(input: Record<string, unknown>): Promise<boolean> {
    return this.call(
      `(async()=>{const input=${JSON.stringify(input)};let result;if(__source.account?.login)result=await __source.account.login(String(input.account??''),String(input.password??''));else if(__source.account?.loginWithCookies?.validate)result=await __source.account.loginWithCookies.validate(__source.account.loginWithCookies.fields.map(key=>String(input[key]??'')));else unsupported('account.login');if(result===false)return false;__source.saveData('__logged',true);return true;})()`,
    );
  }
  private work(input: unknown): EngineWork {
    const value = input as Record<string, unknown>;
    return {
      id: String(value.id),
      title: String(value.title ?? value.id),
      author: String(value.subtitle ?? value.subTitle ?? ''),
      description: typeof value.description === 'string' ? value.description : undefined,
      cover: value.cover
        ? { id: String(value.id) + ':cover', url: String(value.cover) }
        : undefined,
      url: typeof value.url === 'string' ? value.url : undefined,
      kind: 'comic',
    };
  }
  dispose() {
    this.vm?.dispose();
    this.vm = undefined;
  }
}
