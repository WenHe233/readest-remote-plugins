export interface EngineRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | number[];
  encoding?: string;
  responseType?: 'text' | 'bytes';
}
export interface EngineResponse {
  status: number;
  url?: string;
  headers: Record<string, string>;
  body: string;
  bytes?: number[];
}
export interface EngineHost {
  signal: AbortSignal;
  request(request: EngineRequest, signal: AbortSignal): Promise<EngineResponse>;
  readState(): Promise<Record<string, unknown>>;
  writeState(state: Record<string, unknown>): Promise<void>;
  settings?: Record<string, unknown>;
  wasmBinary?: ArrayBuffer;
  service?(name: string, args: unknown[]): unknown;
}
export interface EngineWork {
  id: string;
  title: string;
  author?: string;
  description?: string;
  cover?: EngineResource;
  url?: string;
  kind: 'novel' | 'comic';
}
export interface EngineResource {
  id: string;
  url: string;
  headers?: Record<string, string>;
  method?: string;
  body?: string | number[];
}
export interface EngineChapter {
  id: string;
  title: string;
  url?: string;
  group?: string;
}
export interface EnginePage<T> {
  items: T[];
  nextCursor?: string;
}
export interface EngineContent {
  kind: 'html' | 'pages';
  html?: string;
  pages?: EngineResource[];
  baseUrl?: string;
}
export class CompatibilityError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CompatibilityError';
  }
}
export const unsupported = (api: string): never => {
  throw new CompatibilityError(
    'UNSUPPORTED_CAPABILITY',
    `Unsupported compatibility API: ${api}`,
  );
};
