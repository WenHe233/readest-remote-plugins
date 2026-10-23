import type { SourceDescription } from '@readest/plugin-sdk';
import { Sandbox } from '../../../packages/compatibility/src/sandbox';
import { COMMON_BOOTSTRAP, createServices } from '../../../packages/compatibility/src/services';
import { parseRule, splitOutside } from '../../../packages/compatibility/src/rules';
import {
  CompatibilityError,
  unsupported,
  type EngineHost,
  type EngineWork,
  type EngineChapter,
  type EngineContent,
  type EnginePage,
  type EngineRequest,
  type EngineResource,
} from '../../../packages/compatibility/src/types';

export interface LegadoDefinition {
  id: string;
  name: string;
  format: 'legado';
  content: string;
  rules: Record<string, any>;
}
export function inspectLegado(content: string): LegadoDefinition[] {
  if (content.length > 8 * 1024 * 1024)
    throw new CompatibilityError('INVALID_SOURCE', 'Source exceeds 8 MiB');
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.replace(/^\uFEFF/, ''));
  } catch {
    throw new CompatibilityError('INVALID_SOURCE', 'Legado source must be JSON');
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  return items.map((item) => {
    if (
      !item ||
      typeof item !== 'object' ||
      typeof item.bookSourceUrl !== 'string' ||
      typeof item.bookSourceName !== 'string'
    )
      throw new CompatibilityError('INVALID_SOURCE', 'Missing bookSourceName/bookSourceUrl');
    return {
      id: item.bookSourceUrl,
      name: item.bookSourceName,
      format: 'legado',
      content: JSON.stringify(item),
      rules: item,
    };
  });
}
const BOOTSTRAP =
  COMMON_BOOTSTRAP +
  String.raw`
globalThis.result='';globalThis.__content='';globalThis.baseUrl='';globalThis.book={};globalThis.chapter={};
const store={get:key=>service('storage.get',key),put:(key,value)=>{service('storage.set',key,value);return value;},delete:key=>service('storage.delete',key)};
function elements(rule){const items=service('rule',__content,rule,true).map(html=>({toString:()=>html,attr:name=>service('rule',html,'@'+name,false)[0]||'',text:()=>service('rule',html,'text',false).join('\n')}));items.toArray=()=>items;items.get=index=>items[index];return items;}
function javaRequest(url,method,body,headers){const split=url.search(/,\s*\{/);let options={};if(split>=0){options=eval('('+url.slice(split+1)+')');url=url.slice(0,split);}url=url.replace(/\{\{([\s\S]*?)\}\}/g,(_,code)=>eval(code));const payload=options.body??body;const defaultHeaders=source.header?(typeof source.header==='string'?eval('('+source.header+')'):source.header):{};let r=JSON.parse(__requestSync(JSON.stringify({url:service('url.resolve',url,baseUrl),method:options.method||method,body:payload,headers:{...(payload?{'Content-Type':'application/x-www-form-urlencoded'}:{}),...defaultHeaders,...headers,...options.headers},encoding:options.charset})));return {body:()=>r.body,code:()=>r.status,headers:()=>r.headers,header:name=>Object.entries(r.headers).find(([key])=>key.toLowerCase()===name.toLowerCase())?.[1]??'',cookie:name=>(service('cookies.getCookie',url)||'').split(/;\s*/).find(pair=>pair.startsWith(name+'='))?.slice(name.length+1)??''};}
globalThis.java=new Proxy({
 ajax:url=>javaRequest(url,'GET').body(),post:(url,body,headers)=>javaRequest(url,'POST',body,headers),
 getString:rule=>service('rule',__content,rule,false).join('\n'),getStringList:rule=>service('rule',__content,rule,false),getElements:elements,getElement:elements,setContent:value=>{__content=String(value);result=__content;},
 get:(key,headers)=>headers!==undefined||/^https?:\/\//.test(key)?javaRequest(key,'GET',undefined,headers):store.get(key),put:store.put,log:(...args)=>service('log',...args),longToast:(...args)=>service('log',...args),toast:(...args)=>service('log',...args),
 base64Decode:text=>Convert.decodeUtf8(Convert.decodeBase64(text)),base64Encode:text=>Convert.encodeBase64(Convert.encodeUtf8(text)),
 hexDecodeToString:hex=>Convert.decodeUtf8(new Uint8Array(hex.match(/../g).map(x=>parseInt(x,16))).buffer),
 md5Encode:text=>Convert.hexEncode(Convert.md5(Convert.encodeUtf8(text))),md5Encode16:text=>Convert.hexEncode(Convert.md5(Convert.encodeUtf8(text))).slice(8,24),
 encodeURI:(text,charset)=>{if(charset&&charset.toLowerCase()!=='utf-8')unsupported('java.encodeURI charset '+charset);return encodeURIComponent(text);},
 getAbsoluteURL:(base,path)=>service('url.resolve',path,base),
}, {get:(target,key)=>key in target?target[key]:(...args)=>unsupported('java.'+key)});
globalThis.cache=store;
globalThis.source=new Proxy({getVariable:()=>store.get('__variable'),setVariable:value=>store.put('__variable',value),getKey:()=>source.bookSourceUrl,getLoginInfo:()=>JSON.stringify(store.get('__login')||{}),getLoginInfoMap:()=>store.get('__login')||{},putLoginHeader:header=>store.put('__loginHeader',header),getLoginHeader:()=>store.get('__loginHeader'),removeLoginHeader:()=>store.delete('__loginHeader')},{get:(target,key)=>key in target?target[key]:(...args)=>unsupported('source.'+key)});
globalThis.cookie=new Proxy({}, {get:(_,key)=>(...args)=>service('cookies.'+key,...args)});
globalThis.Packages=new Proxy({}, {get:(_,key)=>unsupported('Packages.'+key)});
`;

export class LegadoEngine {
  constructor(
    readonly definition: LegadoDefinition,
    private host: EngineHost,
  ) {}
  private async session<T>(fn: (vm: Sandbox) => Promise<T>): Promise<T> {
    const state = await this.host.readState();
    const vm = await Sandbox.create(this.host, {
      service: createServices(state, this.host.settings, this.host.service),
    });
    try {
      const source = this.definition.rules;
      await vm.run(
        BOOTSTRAP +
          `\nbaseUrl=${JSON.stringify(source.bookSourceUrl)};book.origin=baseUrl;Object.assign(source,${JSON.stringify(source)});`,
      );
      if (source.jsLib) {
        if (String(source.jsLib).trim().startsWith('{')) unsupported('remote jsLib dependency');
        await vm.run(source.jsLib);
      }
      return await fn(vm);
    } finally {
      vm.dispose();
      await this.host.writeState(state);
    }
  }
  private async js(
    vm: Sandbox,
    script: string,
    input: unknown,
    base: string,
    variables: Record<string, unknown> = {},
  ): Promise<any> {
    await vm.run(
      `globalThis.result=${JSON.stringify(input)};globalThis.__content=${JSON.stringify(input)};globalThis.baseUrl=${JSON.stringify(base)};Object.assign(globalThis,${JSON.stringify(variables)});`,
    );
    return vm.run(script);
  }
  private async rule(
    vm: Sandbox,
    input: string,
    rule: unknown,
    base: string,
    elements = false,
  ): Promise<string[]> {
    if (!rule) return [input];
    let text = String(rule);
    const put = /^@put:(\{[^}]+\})/.exec(text);
    if (put) {
      const assignments = JSON.parse(put[1]);
      for (const [key, value] of Object.entries(assignments)) {
        const parsed = await this.rule(vm, input, value, base);
        await vm.run(`java.put(${JSON.stringify(key)},${JSON.stringify(parsed.join('\n'))})`);
      }
      text = text.slice(put[0].length);
    }
    for (const match of [...text.matchAll(/@get:\{([^}]+)\}/g)])
      text = text.replace(
        match[0],
        String((await vm.run(`java.get(${JSON.stringify(match[1])})`)) ?? ''),
      );
    const jsIndex = text.indexOf('@js:');
    const tagIndex = text.indexOf('<js>');
    const index = jsIndex >= 0 ? jsIndex : tagIndex;
    if (index >= 0) {
      const head = text.slice(0, index);
      const value = head ? (await this.rule(vm, input, head, base, elements)).join('\n') : input;
      const end = tagIndex >= 0 ? text.indexOf('</js>', tagIndex) : -1;
      const code =
        jsIndex >= 0 ? text.slice(index + 4) : text.slice(index + 4, end < 0 ? undefined : end);
      const result = await this.js(vm, code, value, base, { __content: input });
      if (end >= 0 && text.slice(end + 5).trim())
        return this.rule(vm, String(result ?? ''), text.slice(end + 5), base, elements);
      return (Array.isArray(result) ? result : [result])
        .filter((x) => x != null)
        .map((x) => (typeof x === 'string' ? x : JSON.stringify(x)));
    }
    const interpolated = text.includes('{{');
    for (const match of [...text.matchAll(/\{\{([\s\S]*?)\}\}/g)]) {
      const expr = match[1];
      const result = /^(?:@@|@XPath:|@Json:|\/\/|\$\.)/.test(expr)
        ? (await this.rule(vm, input, expr, base)).join('\n')
        : await this.js(vm, expr, input, base);
      text = text.replace(match[0], String(result ?? ''));
    }
    if (interpolated && !text.startsWith('##')) return [text];
    return parseRule(input, text, elements);
  }
  private async url(
    vm: Sandbox,
    template: string,
    base: string,
    variables: Record<string, unknown> = {},
  ): Promise<EngineRequest> {
    let value = template;
    if (value.startsWith('<js>')) {
      const end = value.indexOf('</js>');
      if (end < 0) throw new CompatibilityError('INVALID_SOURCE', 'Unclosed URL JavaScript block');
      const result = await this.js(vm, value.slice(4, end), '', base, variables);
      value = value.slice(end + 5) || String(result ?? '');
    } else if (value.startsWith('@js:'))
      value = String(await this.js(vm, value.slice(4), '', base, variables));
    if (!value || value === 'null' || value === 'undefined')
      throw new CompatibilityError('SCRIPT_ERROR', 'URL rule returned no URL');
    await vm.run(`Object.assign(globalThis,${JSON.stringify(variables)})`);
    for (const match of [...value.matchAll(/\{\{([\s\S]*?)\}\}/g)])
      value = value.replace(match[0], String(await this.js(vm, match[1], '', base, variables)));
    const split = value.search(/,\s*\{/);
    const path = split < 0 ? value : value.slice(0, split);
    const options = split < 0 ? {} : await vm.run('(' + value.slice(split + 1) + ')');
    if (options.webView || options.webJs) unsupported('URL webView/webJs');
    const sourceHeader = this.definition.rules.header;
    let headers = sourceHeader
      ? typeof sourceHeader === 'object'
        ? sourceHeader
        : await vm.run('(' + sourceHeader + ')')
      : {};
    const loginHeader = await vm.run('source.getLoginHeader()');
    if (loginHeader) headers = { ...headers, ...JSON.parse(loginHeader) };
    const requestHeaders = {
      ...(options.body
        ? {
            'Content-Type':
              typeof options.body === 'object'
                ? 'application/json'
                : 'application/x-www-form-urlencoded',
          }
        : {}),
      ...headers,
      ...options.headers,
    };
    return {
      url: new URL(path, base).href,
      method: String(options.method ?? 'GET').toUpperCase(),
      body: typeof options.body === 'object' ? JSON.stringify(options.body) : options.body,
      headers: requestHeaders,
      encoding: options.charset,
    };
  }
  private async request(
    vm: Sandbox,
    template: string,
    base: string,
    variables: Record<string, unknown> = {},
  ) {
    const request = await this.url(vm, template, base, variables);
    this.host.signal.throwIfAborted();
    const response = await this.host.request(request, this.host.signal);
    if (response.status < 200 || response.status >= 400)
      throw new Error(`HTTP ${response.status}: ${request.url}`);
    return { text: response.body, url: response.url ?? request.url };
  }
  private async field(vm: Sandbox, input: string, rule: unknown, base: string) {
    return rule ? (await this.rule(vm, input, rule, base)).join('\n') : '';
  }
  private async work(
    vm: Sandbox,
    input: string,
    rules: Record<string, any>,
    base: string,
    id?: string,
  ): Promise<EngineWork> {
    const title = await this.field(vm, input, rules.name, base);
    const path = id ?? (await this.field(vm, input, rules.bookUrl, base));
    if (!path) throw new CompatibilityError('INVALID_SOURCE', 'Book rule returned no stable URL');
    const url = new URL(path, base).href;
    const cover = await this.field(vm, input, rules.coverUrl, base);
    return {
      id: url,
      url,
      title: title || url,
      author: await this.field(vm, input, rules.author, base),
      description: await this.field(vm, input, rules.intro, base),
      cover: cover ? { id: url + ':cover', url: new URL(cover, base).href } : undefined,
      kind: 'novel',
    };
  }
  async search(query: string, cursor?: string): Promise<EnginePage<EngineWork>> {
    return this.session(async (vm) => {
      const source = this.definition.rules;
      if (!source.searchUrl) unsupported('search');
      const page = Number(cursor ?? 1);
      const response = await this.request(vm, source.searchUrl, source.bookSourceUrl, {
        key: query,
        page,
      });
      const rules = source.ruleSearch ?? {};
      const elements = await this.rule(vm, response.text, rules.bookList, response.url, true);
      const items = [];
      for (const element of elements) items.push(await this.work(vm, element, rules, response.url));
      return { items, nextCursor: items.length ? String(page + 1) : undefined };
    });
  }
  async explore(cursor?: string): Promise<EnginePage<EngineWork>> {
    return this.session(async (vm) => {
      const source = this.definition.rules;
      if (!source.exploreUrl) unsupported('explore');
      let target = String(source.exploreUrl);
      if (target.startsWith('[')) target = JSON.parse(target)[0].url;
      else if (target.includes('::')) target = target.split(/&&|\n/)[0].split('::')[1];
      const page = Number(cursor ?? 1);
      const response = await this.request(vm, target, source.bookSourceUrl, {
        page,
      });
      const rules = source.ruleExplore ?? source.ruleSearch ?? {};
      const elements = await this.rule(vm, response.text, rules.bookList, response.url, true);
      const items = [];
      for (const element of elements) items.push(await this.work(vm, element, rules, response.url));
      return { items, nextCursor: items.length ? String(page + 1) : undefined };
    });
  }
  async getWork(id: string): Promise<EngineWork> {
    return this.session(async (vm) => {
      const response = await this.request(vm, id, this.definition.rules.bookSourceUrl);
      const rules = this.definition.rules.ruleBookInfo ?? {};
      const input = rules.init
        ? await this.field(vm, response.text, rules.init, response.url)
        : response.text;
      return this.work(vm, input, rules, response.url, id);
    });
  }
  async getChapters(id: string): Promise<EnginePage<EngineChapter>> {
    return this.session(async (vm) => {
      const source = this.definition.rules;
      const info = await this.request(vm, id, source.bookSourceUrl);
      const init = source.ruleBookInfo?.init
        ? await this.field(vm, info.text, source.ruleBookInfo.init, info.url)
        : info.text;
      const toc = await this.field(vm, init, source.ruleBookInfo?.tocUrl, info.url);
      let response = toc ? await this.request(vm, toc, info.url) : info;
      const seen = new Set<string>();
      const chapters = new Map<string, EngineChapter>();
      const rules = source.ruleToc ?? {};
      while (!seen.has(response.url)) {
        if (seen.size >= 1000)
          throw new CompatibilityError('LIMIT_EXCEEDED', 'Directory exceeds 1000 pages');
        seen.add(response.url);
        const elements = await this.rule(vm, response.text, rules.chapterList, response.url, true);
        for (const element of elements) {
          const path = await this.field(vm, element, rules.chapterUrl, response.url);
          if (!path) throw new Error('Chapter rule returned no URL');
          const url = new URL(path, response.url).href;
          chapters.set(url, {
            id: url,
            url,
            title: await this.field(vm, element, rules.chapterName, response.url),
          });
        }
        const next = await this.field(vm, response.text, rules.nextTocUrl, response.url);
        if (!next) break;
        const url = new URL(next, response.url).href;
        if (seen.has(url)) break;
        response = await this.request(vm, url, response.url);
      }
      return { items: [...chapters.values()] };
    });
  }
  async resolveChapter(workId: string, chapterId: string): Promise<EngineContent> {
    return this.session(async (vm) => {
      await vm.run(
        `book={bookUrl:${JSON.stringify(workId)}};chapter={url:${JSON.stringify(chapterId)}};`,
      );
      let response = await this.request(vm, chapterId, workId);
      const seen = new Set<string>();
      const content: string[] = [];
      const rules = this.definition.rules.ruleContent ?? {};
      while (!seen.has(response.url)) {
        if (seen.size >= 100)
          throw new CompatibilityError('LIMIT_EXCEEDED', 'Chapter exceeds 100 pages');
        seen.add(response.url);
        let text = await this.field(vm, response.text, rules.content, response.url);
        if (rules.replaceRegex)
          text = (
            await this.rule(
              vm,
              text,
              String(rules.replaceRegex).startsWith('##')
                ? rules.replaceRegex
                : '##' + rules.replaceRegex,
              response.url,
            )
          ).join('\n');
        content.push(text);
        const next = await this.field(vm, response.text, rules.nextContentUrl, response.url);
        if (!next) break;
        const url = new URL(next, response.url).href;
        if (seen.has(url)) break;
        response = await this.request(vm, url, response.url);
      }
      const raw = content.join('\n');
      const html = /<\/?[a-z][\s>]/i.test(raw)
        ? raw
        : raw
            .split(/\n+/)
            .map(
              (line) =>
                '<p>' +
                line.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;') +
                '</p>',
            )
            .join('\n');
      return { kind: 'html', html, baseUrl: chapterId };
    });
  }
  async resolveResource(resource: EngineResource) {
    return resource;
  }
  async describe(): Promise<SourceDescription> {
    const login = String(this.definition.rules.loginUrl ?? '');
    return {
      settings: [],
      actions: [],
      authentication: !login
        ? { kind: 'none' }
        : /^https?:\/\//.test(login)
          ? { kind: 'unsupported', reason: 'Legado WebView login' }
          : {
              kind: 'form',
              fields: [
                { key: 'account', label: 'Account', type: 'text', required: true },
                { key: 'password', label: 'Password', type: 'secret', required: true },
              ],
            },
    };
  }
  async login(values: Record<string, string>) {
    return this.session(async (vm) => {
      const source = this.definition.rules;
      if (!source.loginUrl) unsupported('login');
      await vm.run(`java.put('__login',${JSON.stringify(values)});`);
      return this.js(vm, source.loginUrl, values, source.bookSourceUrl);
    });
  }
  async authenticate(values: Record<string, unknown>): Promise<boolean> {
    return this.session(async (vm) => {
      const source = this.definition.rules;
      const script = String(source.loginUrl ?? '');
      if (!script || /^https?:\/\//.test(script)) unsupported('Legado WebView login');
      await vm.run(
        `java.put('__login',${JSON.stringify(values)});source.getLoginInfoMap=()=>Object.assign({},java.get('__login'),{get(key){return this[key]}});`,
      );
      await this.js(vm, script.replace(/^@js:|^<js>|<\/js>$/g, ''), values, source.bookSourceUrl);
      const result = await vm.run(`typeof login==='function'?login():true`);
      return result !== false;
    });
  }
}
