import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { inspectLegado, LegadoEngine } from '../plugins/legado/src/engine';
import { inspectVenera, VeneraEngine } from '../plugins/venera/src/engine';
import type { EngineHost } from '../packages/compatibility/src/types';
import {
  encodeRequestBody,
  decodeResponse,
  COMPATIBILITY_USER_AGENT,
} from '../packages/compatibility/src/http';
const enabled = process.env.READEST_COMPATIBILITY_LIVE === '1';
const results: Array<{
  source: string;
  stage: string;
  ok: boolean;
  error?: string;
}> = [];
const fixtures = new URL('./fixtures/', import.meta.url);
describe.runIf(enabled)(
  'live source compatibility (site failures are recorded separately from replay)',
  () => {
    const additional = inspectLegado(
      readFileSync(new URL('legado/shuhaige.json', fixtures), 'utf8'),
    ).concat(
      (process.env.READEST_EXTRA_LEGADO_FIXTURES ?? '')
        .split(';')
        .filter(Boolean)
        .flatMap((path) => inspectLegado(readFileSync(path, 'utf8'))),
    );
    const candidates = [
      '得奇小说网',
      '天天看小说',
      '手机小说',
      '69书吧',
      '大文学无错小说网',
      '酷我小说',
      '速读谷',
      '快书网',
      '铅笔小说',
      '艾途小说',
      '阅友小说',
      '就爱文学',
      '武林中文网',
      '起点中文',
      '独步小说网',
      '来看文学',
      '和图书',
      '思路客',
      '顶点小说 ddxs',
      '八一中文',
    ];
    const cases = [
      ...['manga_dex', 'baozi', 'komiic', 'comick'].map((name) => ({
        name,
        format: 'venera',
      })),
      ...candidates.map((name) => ({ name, format: 'legado' })),
      ...additional.map((definition) => ({
        name: definition.name,
        format: 'legado',
      })),
    ];
    for (const target of cases)
      it(
        target.name,
        async () => {
          let state: Record<string, unknown> = {};
          let stage = 'search';
          const cookieJar = new Map<string, string>();
          const signal = AbortSignal.timeout(60_000);
          const h: EngineHost = {
            signal,
            readState: async () => state,
            writeState: async (value) => {
              state = value;
            },
            service: (name, args) => {
              const raw = String(args[0]);
              const origin = new URL(
                raw.includes('://') ? raw : 'https://' + raw,
              ).origin;
              if (
                name === 'cookies.removeCookie' ||
                name === 'cookies.delete'
              ) {
                cookieJar.delete(origin);
                return null;
              }
              if (name === 'cookies.getCookie')
                return cookieJar.get(origin) ?? '';
              if (name === 'cookies.get')
                return (cookieJar.get(origin) ?? '')
                  .split(/;\s*/)
                  .filter(Boolean)
                  .map((pair) => ({
                    name: pair.split('=')[0],
                    value: pair.slice(pair.indexOf('=') + 1),
                    domain: new URL(origin).hostname,
                  }));
              if (name === 'cookies.setCookie') {
                cookieJar.set(origin, String(args[1]));
                return null;
              }
              if (name === 'cookies.set') {
                cookieJar.set(
                  origin,
                  (args[1] as Array<{ name: string; value: string }>)
                    .map((c) => c.name + '=' + c.value)
                    .join('; '),
                );
                return null;
              }
              throw new Error('Unsupported live host service: ' + name);
            },
            request: async (request) => {
              const headers = {
                'User-Agent': COMPATIBILITY_USER_AGENT,
                ...(cookieJar.has(new URL(request.url).origin)
                  ? { Cookie: cookieJar.get(new URL(request.url).origin)! }
                  : {}),
                ...request.headers,
              };
              const body = encodeRequestBody(request);
              const response = await fetch(request.url, {
                method: request.method,
                headers,
                body,
                signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
              }).catch((error) => {
                throw new Error(
                  `${request.method ?? 'GET'} ${new URL(request.url).origin + new URL(request.url).pathname}: ${String(error)} (${error.cause?.code ?? 'unknown transport error'})`,
                );
              });
              const bytes = new Uint8Array(await response.arrayBuffer());
              if (bytes.length > 8 * 1024 * 1024)
                throw new Error('Response exceeds 8 MiB');
              const setCookies = response.headers.getSetCookie();
              if (setCookies.length)
                cookieJar.set(
                  new URL(response.url).origin,
                  setCookies.map((value) => value.split(';')[0]).join('; '),
                );
              return {
                status: response.status,
                url: response.url,
                headers: Object.fromEntries(response.headers),
                body: decodeResponse(
                  bytes,
                  Object.fromEntries(response.headers),
                  request.encoding,
                ),
                bytes: Array.from(bytes),
              };
            },
          };
          const engine =
            target.format === 'venera'
              ? new VeneraEngine(
                  inspectVenera(
                    readFileSync(
                      new URL('venera/' + target.name + '.js', fixtures),
                      'utf8',
                    ),
                  ),
                  h,
                )
              : new LegadoEngine(
                  inspectLegado(
                    readFileSync(new URL('legado/xiu2.json', fixtures), 'utf8'),
                  )
                    .concat(additional)
                    .find((s) => s.name === target.name)!,
                  h,
                );
          try {
            const list = await engine.search(
              target.format === 'venera' ? 'one' : '我的',
            );
            expect(
              list.items.length,
              'search returned no works',
            ).toBeGreaterThan(0);
            expect(
              list.items[0].title,
              'search title fell back to URL',
            ).not.toBe(list.items[0].id);
            const work = list.items[0];
            stage = 'details';
            await engine.getWork(work.id);
            stage = 'directory';
            const chapters = await engine.getChapters(work.id);
            expect(
              chapters.items.length,
              'directory returned no chapters',
            ).toBeGreaterThan(0);
            expect(
              chapters.items.every((chapter) => Boolean(chapter.title.trim())),
              'directory contains unnamed chapters',
            ).toBe(true);
            stage = 'content';
            let nonempty = false;
            for (const chapter of chapters.items.slice(0, 5)) {
              const content = await engine.resolveChapter(work.id, chapter.id);
              if (
                (content.kind === 'html'
                  ? content.html
                      ?.replace(/<[^>]*>/g, '')
                      .replace(/&nbsp;/gi, ' ')
                      .trim().length
                  : content.pages?.length) ??
                0
              ) {
                nonempty = true;
                if (content.pages?.[0]) {
                  stage = 'resource';
                  const image = await h.request(content.pages[0], signal);
                  expect(image.status, 'image request failed').toBe(200);
                  expect(
                    image.headers['content-type'],
                    'response is not an image',
                  ).toMatch(/^image\//);
                  expect(image.bytes?.length).toBeGreaterThan(0);
                }
                break;
              }
            }
            expect(nonempty, 'first five chapters were empty').toBe(true);
            results.push({ source: target.name, stage, ok: true });
          } catch (error) {
            results.push({
              source: target.name,
              stage,
              ok: false,
              error: String(error),
            });
            throw error;
          } finally {
            if (engine instanceof VeneraEngine) engine.dispose();
          }
        },
        90_000,
      );
    afterAll(() => {
      mkdirSync('.artifacts', { recursive: true });
      let previous: Array<{ source: string }> = [];
      try {
        previous = JSON.parse(
          readFileSync('.artifacts/compatibility-live.json', 'utf8'),
        ).results;
      } catch {}
      const checkedAt = new Date().toISOString();
      const merged = [
        ...previous.filter(
          (item) => !results.some((next) => next.source === item.source),
        ),
        ...results.map((item) => ({ ...item, checkedAt })),
      ];
      writeFileSync(
        '.artifacts/compatibility-live.json',
        JSON.stringify({ checkedAt, results: merged }, null, 2) + '\n',
      );
    });
  },
);
