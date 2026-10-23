import {
  defineContentProvider,
  PluginError,
  readBundledResource,
  type ContentHost,
  type Work,
  type ResourceRef,
  type ChapterContent,
  type Json,
  type SourceDescription,
} from '@readest/plugin-sdk';
import type {
  EngineHost,
  EngineWork,
  EngineResource,
  EngineContent,
  EnginePage,
  EngineChapter,
} from './types';
import { encodeRequestBody, decodeResponse, COMPATIBILITY_USER_AGENT } from './http';
import CryptoJS from 'crypto-js';
import { CompatibilityError } from './types';

export function createEngineHost(host: ContentHost): EngineHost {
  const pending: Array<{ url: string; cookie: string }> = [];
  const cookies = new Map<string, string>();
  const flush = async () => {
    while (pending.length) {
      const item = pending[0];
      await host.cookies.set(item.url, item.cookie);
      pending.shift();
    }
  };
  return {
    signal: host.signal,
    settings: host.source.config,
    wasmBinary: readBundledResource('resources/quickjs.wasm').slice().buffer as ArrayBuffer,
    readState: async () => {
      const origins =
        (host.source as typeof host.source & { networkOrigins?: string[] }).networkOrigins ?? [];
      for (const origin of origins) {
        host.signal.throwIfAborted();
        cookies.set(new URL(origin).origin, (await host.cookies.get(origin)).cookie);
      }
      const value = await host.storage.get('compatibility.state');
      return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    },
    writeState: async (state) => {
      await flush();
      await host.storage.set('compatibility.state', JSON.parse(JSON.stringify(state)) as Json);
    },
    request: async (request, signal) => {
      signal.throwIfAborted();
      await flush();
      const method = (request.method ?? 'GET').toUpperCase();
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(method))
        throw new PluginError('Unsupported HTTP method', 'UNSUPPORTED_CAPABILITY');
      const body = encodeRequestBody(request);
      const response = await host.http({
        url: request.url,
        method: method as 'GET',
        headers: { 'User-Agent': COMPATIBILITY_USER_AGENT, ...request.headers },
        body,
      });
      signal.throwIfAborted();
      const cookie = await host.cookies.get(response.url);
      cookies.set(new URL(response.url).origin, cookie.cookie);
      return {
        status: response.status,
        url: response.url,
        headers: response.headers,
        body: decodeResponse(response.bytes, response.headers, request.encoding),
        bytes: Array.from(response.bytes),
      };
    },
    service: (name, args) => {
      const raw = String(args[0]);
      const url = new URL(raw.includes('://') ? raw : 'https://' + raw);
      const origin = url.origin;
      if (name === 'cookies.get' || name === 'cookies.getCookie') {
        const value = cookies.get(origin) ?? '';
        if (name === 'cookies.getCookie') return value;
        return value
          .split(/;\s*/)
          .filter(Boolean)
          .map((pair) => {
            const index = pair.indexOf('=');
            return {
              name: pair.slice(0, index),
              value: pair.slice(index + 1),
              domain: url.hostname,
            };
          });
      }
      if (name === 'cookies.set' || name === 'cookies.setCookie') {
        const values = Array.isArray(args[1])
          ? args[1]
          : name === 'cookies.setCookie'
            ? String(args[1]).split(/;\s*/).filter(Boolean)
            : [args[1]];
        for (const value of values) {
          const cookie =
            typeof value === 'string'
              ? value
              : (() => {
                  const item = value as {
                    name: string;
                    value: string;
                    domain?: string;
                  };
                  if (/[\r\n;]/.test(item.name + item.value)) throw new Error('Invalid cookie');
                  return (
                    `${item.name}=${item.value}; Path=/` +
                    (item.domain ? `; Domain=${item.domain}` : '')
                  );
                })();
          pending.push({ url: url.href, cookie });
          const pair = cookie.split(';')[0];
          const key = pair.slice(0, pair.indexOf('='));
          const previous = (cookies.get(origin) ?? '')
            .split(/;\s*/)
            .filter((item) => item && item.slice(0, item.indexOf('=')) !== key);
          cookies.set(origin, [...previous, pair].join('; '));
        }
        return null;
      }
      if (name === 'cookies.delete' || name === 'cookies.removeCookie') {
        for (const pair of (cookies.get(origin) ?? '').split(/;\s*/).filter(Boolean))
          pending.push({
            url: url.href,
            cookie: pair.split('=')[0] + '=; Max-Age=0; Path=/',
          });
        cookies.delete(origin);
        return null;
      }
      throw new PluginError('Unsupported cookie API: ' + name, 'UNSUPPORTED_CAPABILITY');
    },
  };
}
function mapResource(resource: EngineResource): ResourceRef {
  if ((resource.method && resource.method !== 'GET') || resource.body)
    throw new PluginError(
      'Image requests with a body are not supported by the host resource contract',
      'UNSUPPORTED_CAPABILITY',
    );
  return { id: resource.id, url: resource.url, headers: resource.headers };
}
function mapWork(work: EngineWork): Work {
  return {
    ...work,
    author: work.author ?? '',
    kind: work.kind === 'novel' ? 'text' : 'comic',
    cover: work.cover ? mapResource(work.cover) : undefined,
  };
}
interface Engine {
  search(query: string, cursor?: string): Promise<EnginePage<EngineWork>>;
  explore(cursor?: string): Promise<EnginePage<EngineWork>>;
  getWork(id: string): Promise<EngineWork>;
  getChapters(id: string): Promise<EnginePage<EngineChapter>>;
  resolveChapter(workId: string, chapterId: string): Promise<EngineContent>;
  describe?(): Promise<SourceDescription>;
  validateSettings?(
    values: Record<string, unknown>,
  ): Promise<{ fieldErrors: Record<string, string> }>;
  runSettingAction?(actionId: string): Promise<void>;
  authenticate?(input: Record<string, unknown>): Promise<boolean>;
  dispose?(): void;
}
export function compatibilityProvider(
  id: string,
  create: (content: string, host: EngineHost) => Engine,
  inspect: (
    content: string,
  ) => Array<{ id: string; name: string; content: string; version?: string }>,
) {
  const run = async <T>(
    host: ContentHost,
    fn: (engine: Engine) => Promise<T>,
    metadata = false,
  ) => {
    if (!host.source.definition)
      throw new PluginError('Import a source definition first', 'INVALID_PAYLOAD');
    const engineHost = createEngineHost(host);
    if (!metadata && Object.keys(host.source.secrets ?? {}).length) {
      const { values } = await host.settings.readPrivate(Object.keys(host.source.secrets ?? {}));
      engineHost.settings = { ...host.source.config, ...values };
    }
    const engine = create(host.source.definition.content, engineHost);
    try {
      return await fn(engine);
    } catch (error) {
      if (error instanceof CompatibilityError)
        throw new PluginError(error.message, error.code, error.diagnostic);
      throw error;
    } finally {
      engine.dispose?.();
    }
  };
  return defineContentProvider({
    id,
    validateSettings: ({ values }, host) =>
      run(host, async (engine) => engine.validateSettings?.(values) ?? { fieldErrors: {} }, true),
    describe: (_input, host) =>
      run(
        host,
        async (engine) =>
          engine.describe
            ? engine.describe()
            : { settings: [], actions: [], authentication: { kind: 'none' } },
        true,
      ),
    runSettingAction: ({ actionId }, host) =>
      run(host, async (engine) => {
        if (!engine.runSettingAction)
          throw new PluginError('Setting actions are unavailable', 'UNSUPPORTED_CAPABILITY');
        await engine.runSettingAction(actionId);
        return { completed: true as const };
      }),
    inspect: async ({ content }) => ({
      definitions: inspect(content).map((def) => ({
        id: def.id,
        name: def.name,
        format: id,
        ...(def.version ? { version: def.version } : {}),
        content: def.content,
        revision: CryptoJS.SHA256(def.content).toString(CryptoJS.enc.Hex),
        origins: [
          ...new Set(
            (def.content.match(/https?:\/\/[^\s"'`<>\\]+/g) ?? []).flatMap((value) => {
              try {
                return [new URL(value).origin];
              } catch {
                return [];
              }
            }),
          ),
        ].slice(0, 128),
      })),
    }),
    search: ({ query, cursor }, host) =>
      run(host, async (engine) => {
        const page = await engine.search(query, cursor);
        return { ...page, items: page.items.map(mapWork) };
      }),
    explore: ({ cursor }, host) =>
      run(host, async (engine) => {
        const page = await engine.explore(cursor);
        return { ...page, items: page.items.map(mapWork) };
      }),
    getWork: ({ work }, host) =>
      run(host, async (engine) => mapWork(await engine.getWork(work.id))),
    getChapters: ({ work }, host) => run(host, (engine) => engine.getChapters(work.id)),
    resolveChapter: ({ work, chapter }, host) =>
      run(host, async (engine) => {
        const result = await engine.resolveChapter(work.id, chapter.id);
        if (result.kind === 'pages')
          return {
            kind: 'pages',
            pages: (result.pages ?? []).map((resource, index) => ({
              ...mapResource(resource),
              data: { workId: work.id, chapterId: chapter.id, index },
            })),
          };
        return { kind: 'html', html: result.html ?? '' } as ChapterContent;
      }),
    resolveResource: async ({ resource }, host) => {
      if (
        resource.data?.workId &&
        resource.data.chapterId &&
        typeof resource.data.index === 'number'
      )
        return run(host, async (engine) => {
          const chapter = await engine.resolveChapter(
            String(resource.data!.workId),
            String(resource.data!.chapterId),
          );
          const refreshed = chapter.pages?.[Number(resource.data!.index)];
          if (!refreshed)
            throw new PluginError(
              'Resource is no longer present in this chapter',
              'RESOURCE_UNAVAILABLE',
            );
          return { url: refreshed.url, headers: refreshed.headers };
        });
      if (!resource.url) throw new PluginError('Resource has no URL', 'INVALID_PAYLOAD');
      return {
        url: resource.url,
        headers: resource.headers,
        mimeType: resource.mimeType,
      };
    },
    authenticate: async ({ input }, host) => {
      const description = await run(
        host,
        async (engine) =>
          engine.describe?.() ?? {
            settings: [],
            actions: [],
            authentication: { kind: 'none' as const },
          },
        true,
      );
      if (description.authentication.kind !== 'form')
        throw new PluginError(
          description.authentication.kind === 'unsupported'
            ? description.authentication.reason
            : 'This source has no login',
          'UNSUPPORTED_CAPABILITY',
        );
      const values =
        input ??
        (await host.interaction({
          kind: 'form',
          title: 'Source login',
          fields: description.authentication.fields,
        }));
      if (!values) return { authenticated: false, message: 'Login canceled' };
      return run(host, async (engine) => {
        if (!engine.authenticate)
          throw new PluginError(
            'This source does not implement form login',
            'UNSUPPORTED_CAPABILITY',
          );
        return { authenticated: await engine.authenticate(values) };
      });
    },
  });
}
