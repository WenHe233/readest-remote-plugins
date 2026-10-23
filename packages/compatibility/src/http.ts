import { encode } from '@vscode/iconv-lite-umd';
import type { EngineRequest } from './types';
export const COMPATIBILITY_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36';
export function decodeResponse(
  bytes: Uint8Array,
  headers: Record<string, string>,
  requested?: string,
): string {
  const contentType =
    Object.entries(headers).find(
      ([name]) => name.toLowerCase() === 'content-type',
    )?.[1] ?? '';
  const prefix = new TextDecoder().decode(bytes.subarray(0, 8192));
  const encoding =
    requested ??
    /charset=["']?([\w.-]+)/i.exec(contentType)?.[1] ??
    /<meta[^>]+charset\s*=\s*["']?([\w.-]+)/i.exec(prefix)?.[1] ??
    'utf-8';
  return new TextDecoder(encoding).decode(bytes);
}
/** Preserves author-provided percent escapes while encoding raw form characters in the requested charset. */
export function encodeRequestBody(
  request: EngineRequest,
): string | Uint8Array<ArrayBuffer> | undefined {
  if (Array.isArray(request.body)) return new Uint8Array(request.body);
  if (typeof request.body !== 'string') return undefined;
  const contentType =
    Object.entries(request.headers ?? {}).find(
      ([key]) => key.toLowerCase() === 'content-type',
    )?.[1] ?? '';
  if (contentType.startsWith('application/x-www-form-urlencoded')) {
    const escape = (value: string) =>
      value.replace(/%[\da-f]{2}|[^a-z\d*_.~+%-]/giu, (char) =>
        char.startsWith('%')
          ? char
          : Array.from(
              encode(char, request.encoding ?? 'utf-8'),
              (byte) => '%' + byte.toString(16).padStart(2, '0').toUpperCase(),
            ).join(''),
      );
    return request.body
      .split('&')
      .map((part) => {
        const at = part.indexOf('=');
        return at < 0
          ? escape(part)
          : escape(part.slice(0, at)) + '=' + escape(part.slice(at + 1));
      })
      .join('&');
  }
  return request.encoding
    ? new Uint8Array(encode(request.body, request.encoding))
    : request.body;
}
