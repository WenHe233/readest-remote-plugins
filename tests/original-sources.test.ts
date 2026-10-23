import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { inspectVenera, VeneraEngine } from '../plugins/venera/src/engine';
import { inspectLegado, LegadoEngine } from '../plugins/legado/src/engine';
import type {
  EngineHost,
  EngineRequest,
} from '../packages/compatibility/src/types';

const fixtures = new URL('./fixtures/', import.meta.url);
function fixture(file: string) {
  return readFileSync(new URL(file, fixtures), 'utf8');
}
function replay(respond: (request: EngineRequest) => unknown): EngineHost {
  let state: Record<string, unknown> = {};
  return {
    signal: new AbortController().signal,
    readState: async () => state,
    writeState: async (value) => {
      state = value;
    },
    request: async (request) => {
      const body = respond(request);
      return {
        status: 200,
        url: request.url,
        headers: {},
        body: typeof body === 'string' ? body : JSON.stringify(body),
      };
    },
  };
}
describe('unmodified pinned upstream definitions', () => {
  it('matches source SHA256 inventory and imports all requested Venera files without execution', () => {
    const inventory = JSON.parse(fixture('sources.lock.json')) as Array<{
      file: string;
      sha256: string;
    }>;
    for (const item of inventory) {
      const bytes = readFileSync(new URL(item.file, fixtures));
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(
        item.sha256,
      );
      if (item.file.endsWith('.js'))
        expect(inspectVenera(bytes.toString()).name).toBeTruthy();
    }
  });
  it('MangaDex maps multilingual grouped chapters and image headers', async () => {
    const comic = {
      id: 'work',
      attributes: {
        title: { en: 'Fixture comic' },
        altTitles: [],
        tags: [],
        description: { en: 'Description' },
        status: 'ongoing',
      },
      relationships: [],
    };
    const h = replay((req) => {
      const url = new URL(req.url);
      if (url.pathname === '/manga') return { data: [comic], total: 1 };
      if (url.pathname === '/manga/work') return { data: comic };
      if (url.pathname === '/manga/work/feed')
        return {
          data: [
            {
              id: 'chapter',
              attributes: {
                chapter: '1',
                title: 'Start',
                translatedLanguage: 'en',
                volume: '1',
              },
            },
          ],
          total: 1,
        };
      if (url.pathname === '/statistics/manga/work') return { statistics: {} };
      if (url.pathname === '/at-home/server/chapter')
        return {
          baseUrl: 'https://images.example',
          chapter: {
            hash: 'hash',
            data: ['one.jpg'],
            dataSaver: ['small.jpg'],
          },
        };
      throw new Error('Unrecorded ' + req.url);
    });
    const engine = new VeneraEngine(
      inspectVenera(fixture('venera/manga_dex.js')),
      h,
    );
    try {
      expect((await engine.search('Fixture')).items[0].title).toBe(
        'Fixture comic',
      );
      expect((await engine.getWork('work')).title).toBe('Fixture comic');
      expect((await engine.getChapters('work')).items[0]).toMatchObject({
        id: 'chapter',
        group: 'Volume 1 - EN',
      });
      expect(
        (await engine.resolveChapter('work', 'chapter')).pages?.[0],
      ).toMatchObject({ headers: { Referer: 'https://mangadex.org/' } });
    } finally {
      engine.dispose();
    }
  });
  it('Baozi parses real selectors and uses chapter image configuration', async () => {
    const h = replay((req) => {
      if (req.url.includes('/search?'))
        return '<div class="comics-card"><a href="/comic/work"><amp-img src="https://images.example/cover.jpg"></amp-img></a><h3>Fixture comic</h3><small>Description</small></div>';
      if (req.url.includes('/comic/work'))
        return '<h1 class="comics-detail__title">Fixture comic</h1><div class="l-content"><div><div><amp-img src="https://images.example/cover.jpg"></amp-img></div></div></div><h2 class="comics-detail__author">Author</h2><p class="comics-detail__desc">Description</p><div id="chapter-items"><div class="comics-chapters"><a><div><span>Chapter One</span></div></a></div></div>';
      if (req.url.includes('/chapter/work/'))
        return '<div class="comic-contain"><div class="chapter-img"><img class="comic-contain__item" data-src="https://images.example/one.jpg"></div></div>';
      throw new Error('Unrecorded ' + req.url);
    });
    const engine = new VeneraEngine(
      inspectVenera(fixture('venera/baozi.js')),
      h,
    );
    try {
      expect((await engine.search('Fixture')).items[0].title).toBe(
        'Fixture comic',
      );
      expect((await engine.getWork('work')).title).toBe('Fixture comic');
      expect((await engine.getChapters('work')).items[0]).toMatchObject({
        id: '0',
        title: 'Chapter One',
      });
      expect((await engine.resolveChapter('work', '0')).pages?.[0].url).toBe(
        'https://images.example/one.jpg',
      );
    } finally {
      engine.dispose();
    }
  });
  it('Komiic preserves GraphQL POST bodies and parallel detail requests', async () => {
    const comic = {
      id: 'work',
      title: 'Fixture comic',
      authors: [{ name: 'Author' }],
      categories: [],
      dateUpdated: '2026-01-01',
      imageUrl: 'https://images.example/cover.jpg',
    };
    const h = replay((req) => {
      expect(req.method).toBe('POST');
      const { operationName } = JSON.parse(req.body as string);
      const data: Record<string, unknown> = {
        searchComicAndAuthorQuery: {
          searchComicsAndAuthors: { comics: [comic] },
        },
        recommendComicById: { recommendComicById: [] },
        comicByIds: { comicByIds: [comic] },
        chapterByComicId: {
          chaptersByComicId: [{ id: 'chapter', serial: '1', type: 'chapter' }],
        },
        imagesByChapterId: { imagesByChapterId: [{ kid: 'one' }] },
      };
      if (!(operationName in data))
        throw new Error('Unrecorded ' + operationName);
      return { data: data[operationName] };
    });
    const engine = new VeneraEngine(
      inspectVenera(fixture('venera/komiic.js')),
      h,
    );
    try {
      expect((await engine.search('Fixture')).items[0].title).toBe(
        'Fixture comic',
      );
      expect((await engine.getWork('work')).title).toBe('Fixture comic');
      expect((await engine.getChapters('work')).items[0].id).toBe('chapter');
      expect(
        (await engine.resolveChapter('work', 'chapter')).pages?.[0],
      ).toMatchObject({
        url: 'https://komiic.com/api/image/one',
        headers: {
          referer: 'https://komiic.com/comic/work/chapter/chapter/images/all',
        },
      });
    } finally {
      engine.dispose();
    }
  });
  const sources = inspectLegado(fixture('legado/xiu2.json'));
  it('Shuhaige implicit JSON fields and paginated directory retain complete chapters', async () => {
    const definition = inspectLegado(fixture('legado/shuhaige.json'))[0];
    const book = {
      id: 'work',
      bookName: 'Fixture novel',
      authorName: 'Author',
      bookDesc: 'Description',
      picUrl: '/cover.jpg',
    };
    const h = replay((request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith('/searchByPage'))
        return { data: { list: [book] } };
      if (url.pathname.includes('/queryBookDetail/')) return { data: book };
      if (url.pathname.endsWith('/queryIndexList')) {
        const page = url.searchParams.get('curr')!;
        return {
          data: {
            list: [
              {
                id: 'chapter' + page,
                bookId: 'work',
                indexName: 'Chapter ' + page,
              },
            ],
            pageSize: 1,
            total: 2,
          },
        };
      }
      if (url.pathname.endsWith('/queryReadPage'))
        return { data: { content: 'Fixture chapter prose' } };
      throw new Error('Unrecorded ' + request.url);
    });
    const engine = new LegadoEngine(definition, h);
    const work = (await engine.search('Fixture')).items[0];
    expect(work.title).toBe('Fixture novel');
    expect((await engine.getWork(work.id)).title).toBe('Fixture novel');
    const chapters = (await engine.getChapters(work.id)).items;
    expect(chapters.map((c) => c.title)).toEqual(['Chapter 1', 'Chapter 2']);
    expect(
      (await engine.resolveChapter(work.id, chapters[0].id)).html,
    ).toContain('Fixture chapter prose');
  });
  for (const name of ['得奇小说网', '天天看小说', '手机小说'])
    it(
      'Legado ' + name + ' search → details → directory → chapter replay',
      async () => {
        const definition = sources.find((s) => s.name === name)!;
        const origin = definition.id;
        const metadata =
          '<meta property="og:novel:book_name" name="og:novel:book_name" content="Fixture novel"><meta property="og:novel:author" name="og:novel:author" content="Author">';
        const h = replay((req) => {
          if (
            req.url.includes('/tag/') ||
            req.url.includes('/novel/search') ||
            req.url.includes('/modules/article/search.php')
          ) {
            return '<div class="item novel_cell novel-item"><a href="/book"><img alt="Fixture novel" src="https://images.example/cover.jpg"></a><h3><a href="/book">Fixture novel</a></h3><amp-img src="https://images.example/cover.jpg"></amp-img><p><span>Novel</span></p><p><a>Author</a></p><li></li><li>Author</li><li>Description</li><span class="novel-author">Author</span></div>';
          }
          if (req.url === origin + '/book')
            return (
              metadata +
              '<div class="itemtxt"><h1><a>Fixture novel</a></h1><p></p><p><a>Author</a></p></div><div id="list"><a href="/chapter">Chapter One</a></div><div class="full_chapters"><ul><a href="/chapter">Chapter One</a></ul></div><div id="lbks"><dl><dt>Volume</dt><dd><a href="/chapter">Chapter One</a></dd></dl></div>'
            );
          if (req.url === origin + '/chapter')
            return '<div class="con content" id="zjny"><p>Fixture prose</p></div>';
          throw new Error('Unrecorded ' + req.url);
        });
        const engine = new LegadoEngine(definition, h);
        expect((await engine.search('Fixture')).items[0].title).toBe(
          'Fixture novel',
        );
        expect((await engine.getWork(origin + '/book')).title).toBe(
          'Fixture novel',
        );
        expect(
          (await engine.getChapters(origin + '/book')).items[0],
        ).toMatchObject({ id: origin + '/chapter', title: 'Chapter One' });
        expect(
          (await engine.resolveChapter(origin + '/book', origin + '/chapter'))
            .html,
        ).toContain('Fixture prose');
      },
    );
});
