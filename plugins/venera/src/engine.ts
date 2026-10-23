import { Sandbox } from '../../../packages/compatibility/src/sandbox';
import {
  COMMON_BOOTSTRAP,
  createServices,
} from '../../../packages/compatibility/src/services';
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
  const match = /class\s+([A-Za-z_$][\w$]*)\s+extends\s+ComicSource\b/.exec(
    content,
  );
  if (!match)
    throw new CompatibilityError(
      'INVALID_SOURCE',
      'Expected a class extending ComicSource',
    );
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
): Array<{ name: string; url: string }> {
  const list = JSON.parse(content);
  if (!Array.isArray(list))
    throw new CompatibilityError(
      'INVALID_SOURCE',
      'Expected a Venera source list',
    );
  return list.map((item) => {
    const target = item.url ?? item.filename ?? item.fileName;
    if (
      typeof target !== 'string' ||
      (!baseUrl && !/^https?:\/\//i.test(target))
    )
      throw new CompatibilityError(
        'INVALID_SOURCE',
        'Relative source list entries need the original list URL',
      );
    const url = new URL(target, baseUrl);
    if (!['https:', 'http:'].includes(url.protocol))
      throw new CompatibilityError('INVALID_SOURCE', 'Invalid source URL');
    return { name: String(item.name ?? ''), url: url.href };
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
          service: createServices(
            this.state,
            this.host.settings,
            this.host.service,
          ),
        });
        await this.vm.run(
          BOOTSTRAP +
            '\n' +
            this.definition.content +
            `\nglobalThis.__source=new ${this.definition.className}(); ComicSource.sources[__source.key]=__source;`,
        );
        await this.vm.run('Promise.resolve(__source.init?.())');
      }
      const result = await this.vm.run(
        `Promise.resolve(${expression}).then(portable)`,
      );
      await this.host.writeState(this.state);
      return result;
    });
    this.tail = next.catch(() => {});
    return next;
  }
  async search(
    query: string,
    cursor?: string,
  ): Promise<EnginePage<EngineWork>> {
    const page = Number(cursor ?? 1);
    const result = await this.call(
      `(__source.search?.load ? __source.search.load(${JSON.stringify(query)},searchOptions(),${page}) : __source.search?.loadNext ? __source.search.loadNext(${JSON.stringify(query)},searchOptions(),${JSON.stringify(cursor ?? null)}) : unsupported('search'))`,
    );
    return {
      items: (result.comics ?? []).map((v: any) => this.work(v)),
      nextCursor:
        result.next ?? (result.maxPage > page ? String(page + 1) : undefined),
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
        : (result.data?.flatMap(
            (part: any) => part.comics ?? (Array.isArray(part) ? part : []),
          ) ?? []));
    return {
      items: comics.map((v: any) => this.work(v)),
      nextCursor: result.maxPage > page ? String(page + 1) : undefined,
    };
  }
  async getWork(id: string): Promise<EngineWork> {
    return this.work({
      ...(await this.call(`__source.comic.loadInfo(${JSON.stringify(id)})`)),
      id,
    });
  }
  async getChapters(id: string): Promise<EnginePage<EngineChapter>> {
    const result = await this.call(
      `__source.comic.loadInfo(${JSON.stringify(id)})`,
    );
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
  async resolveChapter(
    workId: string,
    chapterId: string,
  ): Promise<EngineContent> {
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
  private work(value: any): EngineWork {
    return {
      id: String(value.id),
      title: String(value.title ?? value.id),
      author: value.subtitle ?? value.subTitle,
      description: value.description,
      cover: value.cover
        ? { id: String(value.id) + ':cover', url: value.cover }
        : undefined,
      url: value.url,
      kind: 'comic',
    };
  }
  dispose() {
    this.vm?.dispose();
    this.vm = undefined;
  }
}
