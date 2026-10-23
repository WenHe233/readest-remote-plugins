import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { inspectVenera, VeneraEngine } from '../plugins/venera/src/engine';
import type { EngineHost } from '../packages/compatibility/src/types';

// Settings and Authorization construction reproduce the upstream 1.1.0 API contract.
// No live site or media requests are made.
const source = `class Fixture extends ComicSource {
 name='Fixture'; key='fixture';
 settings={apiKey:{title:'API Key (Optional)',type:'input',default:''}, language:{title:'Language',type:'select',options:[{value:'en',text:'English'}],default:'en'}, enabled:{title:'Enabled',type:'switch',default:true}, clear:{title:'Clear',type:'callback',buttonText:'Clear token',callback:()=>this.deleteData('token')}};
 account={loginWithWebview:{url:'https://fixture.example/login'}};
 init(){return Network.get('https://fixture.example/init');}
 getApiKey(){return (this.loadSetting('apiKey')||'').trim();}
 search={load:async()=>{await Network.get('https://fixture.example/search',{'Authorization':'Key '+this.getApiKey()});return {comics:[{id:'1',title:'Fixture',cover:'https://fixture.example/cover'}]}}};
 comic={onThumbnailLoad:url=>({url,headers:{Referer:'https://fixture.example/'}})};
}`;
const makeHost = (): EngineHost => ({
  signal: new AbortController().signal,
  settings: { apiKey: 'fixture-key' },
  request: vi.fn(async (request) => ({ status: 200, url: request.url, headers: {}, body: '{}' })),
  readState: vi.fn(async () => ({ token: 'saved' })),
  writeState: vi.fn(async () => {}),
});
describe('Venera management', () => {
  it('describes settings without init, network or private state', async () => {
    const host = makeHost();
    const engine = new VeneraEngine(inspectVenera(source), host);
    try {
      const result = await engine.describe();
      expect(result.settings.find((field) => field.key === 'apiKey')).toMatchObject({
        type: 'secret',
        default: '',
      });
      expect(result.authentication).toEqual({
        kind: 'unsupported',
        reason: 'account.loginWithWebview',
      });
      expect(result.actions).toEqual([{ id: 'clear', label: 'Clear token' }]);
      expect(host.request).not.toHaveBeenCalled();
      expect(host.readState).not.toHaveBeenCalled();
    } finally {
      engine.dispose();
    }
  });
  it('uses instance settings for auth and applies thumbnail request configuration', async () => {
    const host = makeHost();
    const engine = new VeneraEngine(inspectVenera(source), host);
    try {
      const result = await engine.search('test');
      expect(host.request).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'https://fixture.example/search',
          headers: { Authorization: 'Key fixture-key' },
        }),
        expect.any(AbortSignal),
      );
      expect(result.items[0].cover?.headers).toEqual({ Referer: 'https://fixture.example/' });
    } finally {
      engine.dispose();
    }
  });
  it('rejects unknown actions and executes declared callbacks', async () => {
    const host = makeHost();
    const engine = new VeneraEngine(inspectVenera(source), host);
    try {
      await expect(engine.runSettingAction('other')).rejects.toThrow();
      await engine.runSettingAction('clear');
      expect(host.writeState).toHaveBeenLastCalledWith({});
    } finally {
      engine.dispose();
    }
  });
});

it('reads the unmodified pinned nhentai settings and authenticates only against replay responses', async () => {
  const content = readFileSync(new URL('./fixtures/venera/nhentai.js', import.meta.url), 'utf8');
  const host = makeHost();
  host.settings = { apiKey: 'fixture-private-key' };
  host.request = vi.fn(async (request) => {
    if (request.url !== 'https://nhentai.net/api/v2/galleries/fixture?include=related,favorite')
      throw new Error('Unrecorded request');
    return {
      status: 200,
      url: request.url,
      headers: {},
      body: JSON.stringify({
        title: { pretty: 'Synthetic fixture' },
        pages: [{ thumbnail: 'https://fixture.example/thumb.png' }],
        cover: { path: 'https://fixture.example/cover.png' },
        tags: [],
      }),
    };
  });
  const engine = new VeneraEngine(inspectVenera(content), host);
  try {
    expect((await engine.describe()).settings).toEqual([
      expect.objectContaining({ key: 'apiKey', type: 'secret' }),
    ]);
    expect((await engine.getWork('fixture')).title).toBe('Synthetic fixture');
    expect(host.request).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Key fixture-private-key' }),
      }),
      expect.any(AbortSignal),
    );
  } finally {
    engine.dispose();
  }
});

it('validates source input rules inside a VM without executing init or writing state', async () => {
  const host = makeHost();
  const engine = new VeneraEngine(
    inspectVenera(
      source.replace("type:'input',default:''", () => "type:'input',default:'',validator:'^[a-z]{3}$'"),
    ),
    host,
  );
  try {
    expect(await engine.validateSettings({ apiKey: '123' })).toEqual({
      fieldErrors: { apiKey: 'Invalid setting value' },
    });
    expect(await engine.validateSettings({ apiKey: 'abc' })).toEqual({ fieldErrors: {} });
    expect(host.request).not.toHaveBeenCalled();
    expect(host.writeState).not.toHaveBeenCalled();
  } finally {
    engine.dispose();
  }
});
