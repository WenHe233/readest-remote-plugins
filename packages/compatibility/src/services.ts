import CryptoJS from 'crypto-js';
import { HtmlBridge, parseRule } from './rules';
import { unsupported } from './types';

export function createServices(
  state: Record<string, unknown>,
  settings: Record<string, unknown> = {},
  extra?: (name: string, args: unknown[]) => unknown,
) {
  const html = new HtmlBridge();
  return (name: string, args: any[]): unknown => {
    if (name.startsWith('html.')) return html.call(name.slice(5), args);
    if (name === 'rule')
      return parseRule(String(args[0]), String(args[1]), Boolean(args[2]));
    if (name === 'storage.get')
      return Object.hasOwn(state, String(args[0]))
        ? (state[String(args[0])] ?? null)
        : null;
    if (name === 'storage.set') {
      if (JSON.stringify(args[1]).length > 1024 * 1024)
        throw new Error('Storage value exceeds 1 MiB');
      Object.defineProperty(state, String(args[0]), {
        value: args[1],
        writable: true,
        configurable: true,
        enumerable: true,
      });
      return null;
    }
    if (name === 'storage.delete') {
      delete state[String(args[0])];
      return null;
    }
    if (name === 'setting') return settings[String(args[0])] ?? null;
    if (name === 'encodeUtf8')
      return Array.from(new TextEncoder().encode(String(args[0])));
    if (name === 'decodeUtf8')
      return new TextDecoder().decode(new Uint8Array(args[0]));
    if (name === 'encodeBase64')
      return CryptoJS.enc.Base64.stringify(toWords(args[0]));
    if (name === 'decodeBase64')
      return toBytes(CryptoJS.enc.Base64.parse(args[0]));
    if (name === 'hexEncode')
      return toWords(args[0]).toString(CryptoJS.enc.Hex);
    const hashes: Record<
      string,
      (word: CryptoJS.lib.WordArray) => CryptoJS.lib.WordArray
    > = {
      md5: CryptoJS.MD5,
      sha1: CryptoJS.SHA1,
      sha256: CryptoJS.SHA256,
      sha512: CryptoJS.SHA512,
    };
    if (hashes[name]) return toBytes(hashes[name](toWords(args[0])));
    if (name === 'hmac' || name === 'hmacString') {
      const functions: Record<string, typeof CryptoJS.HmacSHA256> = {
        md5: CryptoJS.HmacMD5,
        sha1: CryptoJS.HmacSHA1,
        sha256: CryptoJS.HmacSHA256,
        sha512: CryptoJS.HmacSHA512,
      };
      const algorithm = String(args[2]).toLowerCase().replaceAll('-', '');
      if (!functions[algorithm])
        return unsupported(`Convert.hmac.${algorithm}`);
      const result = functions[algorithm](toWords(args[1]), toWords(args[0]));
      return name === 'hmacString'
        ? result.toString(CryptoJS.enc.Hex)
        : toBytes(result);
    }
    if (name.startsWith('decryptAes')) {
      const modes: Record<string, typeof CryptoJS.mode.CBC> = {
        Ecb: CryptoJS.mode.ECB,
        Cbc: CryptoJS.mode.CBC,
        Cfb: CryptoJS.mode.CFB,
        Ofb: CryptoJS.mode.OFB,
      };
      const mode = modes[name.slice(10)];
      if (!mode) return unsupported(`Convert.${name}`);
      return toBytes(
        CryptoJS.AES.decrypt(
          CryptoJS.lib.CipherParams.create({ ciphertext: toWords(args[0]) }),
          toWords(args[1]),
          {
            mode,
            iv: args[2] ? toWords(args[2]) : undefined,
            padding: CryptoJS.pad.Pkcs7,
          },
        ),
      );
    }
    if (name === 'url.resolve')
      return new URL(String(args[0]), String(args[1])).href;
    if (name === 'log') return null;
    if (name.startsWith('cookies.') && extra) return extra(name, args);
    return unsupported(name);
  };
}
function toWords(bytes: number[]) {
  return CryptoJS.lib.WordArray.create(new Uint8Array(bytes) as any);
}
function toBytes(words: CryptoJS.lib.WordArray) {
  return Array.from(
    { length: words.sigBytes },
    (_, i) => (words.words[i >>> 2] >>> (24 - (i % 4) * 8)) & 255,
  );
}

export const COMMON_BOOTSTRAP = String.raw`
function service(name,...args){ return JSON.parse(__service(name,JSON.stringify(args))); }
function unsupported(name){ throw new Error('UNSUPPORTED_CAPABILITY: '+name); }
globalThis.console={log:(...args)=>service('log',...args),warn:(...args)=>service('log',...args),error:(...args)=>service('log',...args)};
globalThis.Convert=new Proxy({}, {get(_,name){return (...args)=>{let result=service(name,...args.map(x=>x instanceof ArrayBuffer?Array.from(new Uint8Array(x)):ArrayBuffer.isView(x)?Array.from(x):x));return Array.isArray(result)?new Uint8Array(result).buffer:result;}}});
globalThis.btoa = str => Convert.encodeBase64(new Uint8Array(Array.from(str,c=>c.charCodeAt(0))).buffer);
globalThis.atob = str => Array.from(new Uint8Array(Convert.decodeBase64(str)),c=>String.fromCharCode(c)).join('');
class HtmlElement {
 constructor(id){this._id=id;}
 querySelectorAll(selector){return service('html.query',this._id,selector).map(id=>new HtmlElement(id));}
 querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
 getElementById(id){return this.querySelector('[id="'+id.replace(/"/g,'\\"')+'"]');}
 get text(){return service('html.text',this._id);}
 get attributes(){return service('html.attributes',this._id);}
 get children(){return service('html.children',this._id).map(id=>new HtmlElement(id));}
 get nodes(){return service('html.nodes',this._id).map(id=>new HtmlElement(id));}
 get parent(){let id=service('html.parent',this._id);return id?new HtmlElement(id):null;}
 get previousSibling(){let id=service('html.previousSibling',this._id);return id?new HtmlElement(id):null;}
 get nextSibling(){let id=service('html.nextSibling',this._id);return id?new HtmlElement(id):null;}
 get innerHtml(){return service('html.innerHtml',this._id);}
 get classNames(){return (this.attributes.class||'').split(/\s+/).filter(Boolean);}
 get id(){return this.attributes.id||null;}
 get localName(){return service('html.localName',this._id);}
 get type(){return service('html.type',this._id);}
 toElement(){return this.type==='element'?this:null;}
 dispose(){service('html.dispose',this._id);}
}
globalThis.HtmlDocument=class extends HtmlElement {constructor(html){super(service('html.parse',html));}};
`;
