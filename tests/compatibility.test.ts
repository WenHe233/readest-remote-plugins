import { describe, expect, it, vi } from 'vitest';
import { Sandbox } from '../packages/compatibility/src/sandbox';
import { parseRule } from '../packages/compatibility/src/rules';
import { inspectLegado, LegadoEngine } from '../plugins/legado/src/engine';
import { inspectVenera, VeneraEngine } from '../plugins/venera/src/engine';
import type { EngineHost } from '../packages/compatibility/src/types';
import { encodeRequestBody } from '../packages/compatibility/src/http';

function host(pages: Record<string, string> = {}): EngineHost {
  let state: Record<string, unknown> = {};
  return {
    signal: new AbortController().signal,
    request: vi.fn(async (request) => {
      if (!(request.url in pages))
        throw new Error('Unrecorded request: ' + request.url);
      return {
        status: 200,
        url: request.url,
        headers: {},
        body: pages[request.url],
      };
    }),
    readState: async () => structuredClone(state),
    writeState: async (next) => {
      state = structuredClone(next);
    },
  };
}

describe('isolated compatibility VM', () => {
  it('preserves host permission errors across both request bridges', async () => {
    const h = host();
    h.request = async () => {
      throw Object.assign(new Error('Origin needs permission'), {
        code: 'ORIGIN_NOT_GRANTED',
      });
    };
    const vm = await Sandbox.create(h);
    try {
      for (const method of ['__requestSync', '__requestAsync'])
        await expect(
          vm.run(`${method}(JSON.stringify({url:'https://test.example'}))`),
        ).rejects.toMatchObject({ code: 'ORIGIN_NOT_GRANTED' });
    } finally {
      vm.dispose();
    }
  });
  it('has no host process, fetch, or require and supports synchronous suspended calls', async () => {
    const vm = await Sandbox.create(
      host({ 'https://test.example/a': 'value' }),
    );
    try {
      expect(
        await vm.run(
          'typeof process + ":" + typeof require + ":" + typeof fetch',
        ),
      ).toBe('undefined:undefined:undefined');
      expect(
        await vm.run(
          'JSON.parse(__requestSync(JSON.stringify({url:"https://test.example/a"}))).body',
        ),
      ).toBe('value');
    } finally {
      vm.dispose();
    }
  });
  it('runs promise network requests and interrupts runaway scripts', async () => {
    const vm = await Sandbox.create(
      host({ 'https://test.example/a': 'value' }),
      { timeoutMs: 50 },
    );
    try {
      expect(
        await vm.run(
          '__requestAsync(JSON.stringify({url:"https://test.example/a"})).then(JSON.parse).then(r=>r.body)',
        ),
      ).toBe('value');
      await expect(vm.run('while(true) {}')).rejects.toThrow(
        /interrupt|timeout/i,
      );
    } finally {
      vm.dispose();
    }
  });
  it('rejects canceled calls before issuing a request', async () => {
    const h = host();
    const controller = new AbortController();
    h.signal = controller.signal;
    const vm = await Sandbox.create(h);
    controller.abort();
    try {
      await expect(vm.run('1')).rejects.toThrow(/abort|cancel/i);
      expect(h.request).not.toHaveBeenCalled();
    } finally {
      vm.dispose();
    }
  });
  it('can dispose after cancellation of a host request that ignores its signal', async () => {
    const h = host();
    h.request = () => new Promise(() => {});
    const vm = await Sandbox.create(h, { timeoutMs: 30 });
    await expect(
      vm.run('__requestAsync(JSON.stringify({url:"https://test.example/a"}))'),
    ).rejects.toThrow(/cancel|timeout/i);
    expect(() => vm.dispose()).not.toThrow();
  });
  it('does not leak VM globals across instances', async () => {
    const a = await Sandbox.create(host());
    const b = await Sandbox.create(host());
    try {
      await a.run('globalThis.privateValue="secret"');
      expect(await b.run('typeof privateValue')).toBe('undefined');
    } finally {
      a.dispose();
      b.dispose();
    }
  });
  it('bounds VM allocation and disposes after out-of-memory failure', async () => {
    const vm = await Sandbox.create(host(), { memoryBytes: 2 * 1024 * 1024 });
    await expect(vm.run('new Array(5000000).fill("large")')).rejects.toThrow(
      /memory/i,
    );
    expect(() => vm.dispose()).not.toThrow();
  });
});

describe('Legado rule semantics', () => {
  it('distinguishes stored java.get values from synchronous HTTP get', async () => {
    const definition = inspectLegado(
      JSON.stringify({
        bookSourceName: 'Java helpers',
        bookSourceUrl: 'https://test.example',
        ruleContent: {
          content:
            '@js:java.put("memo","cached"); java.get("memo")+":"+java.get("https://test.example/extra",{}).body()',
        },
      }),
    )[0];
    const h = host({
      'https://test.example/chapter': 'unused',
      'https://test.example/extra': 'network',
    });
    const engine = new LegadoEngine(definition, h);
    expect(
      (
        await engine.resolveChapter(
          'https://test.example/work',
          'https://test.example/chapter',
        )
      ).html,
    ).toContain('cached:network');
  });
  const html = '<main><a href="/1">One</a><a href="/2">Two</a></main>';
  it('supports CSS/JSoup selectors and terminal attributes', () => {
    expect(parseRule(html, 'a@text')).toEqual(['One', 'Two']);
    expect(parseRule(html, 'tag.a.1@href')).toEqual(['/2']);
    expect(parseRule('<a onclick="open()">One</a>', '@onclick')).toEqual([
      'open()',
    ]);
    expect(parseRule(html, 'a@text##o##0')).toEqual(['One', 'Tw0']);
  });
  it('supports XPath, JSONPath and combinations without host eval', () => {
    expect(parseRule(html, '//a/@href')).toEqual(['/1', '/2']);
    expect(
      parseRule('{"items":[{"name":"A"},{"name":"B"}]}', '$.items[*].name'),
    ).toEqual(['A', 'B']);
    expect(
      parseRule('{"items":[{"name":"A"},{"name":"B"}]}', '$.items', true),
    ).toEqual(['{"name":"A"}', '{"name":"B"}']);
    expect(parseRule(html, '.missing@text||a@text')).toEqual(['One', 'Two']);
    expect(() =>
      parseRule('{}', '$[?(@.constructor.constructor("return process")())]'),
    ).toThrow();
    expect(() => parseRule('a'.repeat(10000), '##(a+)+$##')).toThrow(
      /complexity/,
    );
  });
  it('encodes GBK form values without double encoding source-provided escapes', () => {
    expect(
      encodeRequestBody({
        url: 'https://test.example',
        body: 'key=我的&raw=%B5%C4',
        encoding: 'gbk',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      }),
    ).toBe('key=%CE%D2%B5%C4&raw=%B5%C4');
  });
  it('imports without executing and reads a novel through HTTP replay', async () => {
    const definition = inspectLegado(
      JSON.stringify({
        bookSourceName: 'Replay',
        bookSourceUrl: 'https://test.example',
        searchUrl: '/search?q={{key}}',
        ruleSearch: { bookList: '.book', name: 'a@text', bookUrl: 'a@href' },
        ruleBookInfo: { name: 'h1@text', tocUrl: '#toc@href' },
        ruleToc: {
          chapterList: '.chapter',
          chapterName: 'a@text',
          chapterUrl: 'a@href',
        },
        ruleContent: { content: '#content@html' },
      }),
    )[0];
    const h = host({
      'https://test.example/search?q=Novel':
        '<div class="book"><a href="/book">Novel</a></div>',
      'https://test.example/book':
        '<h1>Novel</h1><a id="toc" href="/toc">TOC</a>',
      'https://test.example/toc':
        '<div class="chapter"><a href="/chapter">Chapter</a></div>',
      'https://test.example/chapter': '<div id="content"><p>Read me</p></div>',
    });
    expect(h.request).not.toHaveBeenCalled();
    const engine = new LegadoEngine(definition, h);
    expect((await engine.search('Novel')).items[0].title).toBe('Novel');
    expect((await engine.getWork('https://test.example/book')).title).toBe(
      'Novel',
    );
    expect(
      (await engine.getChapters('https://test.example/book')).items[0].title,
    ).toBe('Chapter');
    expect(
      (
        await engine.resolveChapter(
          'https://test.example/book',
          'https://test.example/chapter',
        )
      ).html,
    ).toContain('Read me');
  });
});

describe('Venera source lifecycle', () => {
  const script = `class TestSource extends ComicSource {
    name='Replay'; key='replay'; version='1';
    init(){this.saveData('initialized', true)}
    search={load:async(keyword,options,page)=>({comics:[new Comic({id:'work',title:JSON.parse((await Network.get('https://test.example/search')).body).title,cover:'https://test.example/cover'})],maxPage:1})};
    comic={loadInfo:async(id)=>new ComicDetails({title:'Novel',chapters:{chapter:'Chapter'}}),loadEp:async()=>['https://test.example/image'],onImageLoad:(url)=>({url,headers:{Referer:'https://test.example/'}})};
  }`;
  it('imports JS without execution then maps chapters, pages and image headers', async () => {
    const definition = inspectVenera(script);
    const h = host({ 'https://test.example/search': '{"title":"Novel"}' });
    expect(h.request).not.toHaveBeenCalled();
    const engine = new VeneraEngine(definition, h);
    expect((await engine.search('Novel')).items[0].title).toBe('Novel');
    expect((await engine.getChapters('work')).items[0]).toMatchObject({
      id: 'chapter',
      title: 'Chapter',
    });
    expect(
      (await engine.resolveChapter('work', 'chapter')).pages?.[0],
    ).toMatchObject({
      url: 'https://test.example/image',
      headers: { Referer: 'https://test.example/' },
    });
    expect(await h.readState()).toMatchObject({ initialized: true });
    engine.dispose();
  });
  it('performs form login and preserves source session state', async () => {
    const source = inspectVenera(
      `class LoginSource extends ComicSource {name='Login';key='login';account={login:async(account,password)=>{const r=await Network.post('https://test.example/login',{},JSON.stringify({account,password}));if(r.status!==200)throw new Error('login failed');this.saveData('token',JSON.parse(r.body).token);}}}`,
    );
    const h = host({
      'https://test.example/login': '{"token":"fixture-token"}',
    });
    const engine = new VeneraEngine(source, h);
    try {
      expect(
        await engine.authenticate({
          account: 'fixture-user',
          password: 'fixture-password',
        }),
      ).toBe(true);
      expect(await h.readState()).toMatchObject({
        token: 'fixture-token',
        __logged: true,
      });
    } finally {
      engine.dispose();
    }
  });
});
