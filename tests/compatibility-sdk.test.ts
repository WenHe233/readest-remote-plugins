import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { ContentHost } from '@readest/plugin-sdk';
import { createEngineHost } from '../packages/compatibility/src/sdk';
import { veneraProvider } from '../plugins/venera/src/plugin';
const require = createRequire(import.meta.url);
describe('compatibility host cookie binding', () => {
  it('inspects source lists as references without network, storage or WASM', async () => {
    const host = {
      http: vi.fn(),
      storage: { get: vi.fn() },
    } as unknown as ContentHost;
    const result = await veneraProvider.inspect!(
      {
        format: 'venera-list',
        content: '[{"name":"Source","fileName":"source.js"}]',
        baseUrl: 'https://repo.example/list/index.json',
      },
      host,
    );
    expect(result).toEqual({
      definitions: [],
      references: [
        {
          name: 'Source',
          url: 'https://repo.example/list/source.js',
          format: 'venera',
        },
      ],
    });
    expect(host.http).not.toHaveBeenCalled();
    expect(host.storage.get).not.toHaveBeenCalled();
  });
  it('loads approved origin cookies before init and flushes individual Set-Cookie lines', async () => {
    (globalThis as any).__READEST_PLUGIN_RESOURCES__ = {
      'resources/quickjs.wasm': readFileSync(
        require.resolve('@jitl/quickjs-wasmfile-release-asyncify/wasm'),
      ).toString('base64'),
    };
    const storage = {
      get: vi.fn(async () => null),
      set: vi.fn(async () => ({ saved: true })),
      delete: vi.fn(),
    };
    const cookies = {
      get: vi.fn(async () => ({ cookie: 'session=saved' })),
      set: vi.fn(async () => ({ saved: true })),
    };
    const host = {
      signal: new AbortController().signal,
      source: {
        instance: 'lease',
        providerId: 'venera',
        config: {},
        networkOrigins: ['https://approved.example'],
      },
      storage,
      cookies,
      http: vi.fn(async () => ({
        status: 200,
        url: 'https://approved.example/',
        headers: {},
        bytes: new TextEncoder().encode('ok'),
      })),
    } as unknown as ContentHost;
    const engineHost = createEngineHost(host);
    await engineHost.readState();
    expect(cookies.get).toHaveBeenCalledExactlyOnceWith(
      'https://approved.example',
    );
    expect(
      engineHost.service!('cookies.get', ['https://approved.example']),
    ).toEqual([
      { name: 'session', value: 'saved', domain: 'approved.example' },
    ]);
    engineHost.service!('cookies.setCookie', [
      'https://approved.example',
      'first=1; second=2',
    ]);
    await engineHost.request({ url: 'https://approved.example/' }, host.signal);
    expect(cookies.set.mock.calls).toEqual([
      ['https://approved.example/', 'first=1'],
      ['https://approved.example/', 'second=2'],
    ]);
    await engineHost.writeState({ data: 1 });
    expect(storage.set).toHaveBeenCalledWith('compatibility.state', {
      data: 1,
    });
    delete (globalThis as any).__READEST_PLUGIN_RESOURCES__;
  });
});
