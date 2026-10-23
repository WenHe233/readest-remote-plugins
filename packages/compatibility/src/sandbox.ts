import variant from '@jitl/quickjs-wasmfile-release-asyncify';
import {
  newQuickJSAsyncWASMModuleFromVariant,
  newVariant,
  type QuickJSAsyncContext,
  type QuickJSHandle,
  type QuickJSDeferredPromise,
} from 'quickjs-emscripten-core';
import {
  CompatibilityError,
  type EngineHost,
  type EngineRequest,
} from './types';

/** Each instance owns its WASM module: Asyncify stacks must never be shared across instances. */
export class Sandbox {
  private deadline = 0;
  private pending = new Set<Promise<void>>();
  private deferred = new Set<QuickJSDeferredPromise>();
  private tail: Promise<unknown> = Promise.resolve();
  private controller = new AbortController();
  private closed = false;
  private constructor(
    private vm: QuickJSAsyncContext,
    private host: EngineHost,
    private timeoutMs: number,
  ) {}
  static async create(
    host: EngineHost,
    options: {
      timeoutMs?: number;
      memoryBytes?: number;
      service?: (name: string, args: unknown[]) => unknown;
    } = {},
  ) {
    const customized = host.wasmBinary
      ? newVariant(variant, {
          wasmBinary: host.wasmBinary,
          // Emscripten resolves its filename even when bytes are supplied. In a
          // bundled IIFE import.meta.url is absent; never resolve/fetch a URL.
          locateFile: (file) => {
            if (file !== 'emscripten-module.wasm')
              throw new Error('Unexpected runtime resource: ' + file);
            return 'resources/quickjs.wasm';
          },
        })
      : variant;
    const module = await newQuickJSAsyncWASMModuleFromVariant(customized);
    const runtime = module.newRuntime();
    runtime.setMemoryLimit(options.memoryBytes ?? 64 * 1024 * 1024);
    runtime.setMaxStackSize(512 * 1024);
    const vm = runtime.newContext();
    const sandbox = new Sandbox(vm, host, options.timeoutMs ?? 15_000);
    runtime.setInterruptHandler(
      () =>
        sandbox.closed ||
        host.signal.aborted ||
        sandbox.controller.signal.aborted ||
        Date.now() > sandbox.deadline,
    );
    const install = (name: string, handle: QuickJSHandle) => {
      vm.setProp(vm.global, name, handle);
      handle.dispose();
    };
    const request = async (input: string) => {
      sandbox.check();
      const parsed = JSON.parse(input) as EngineRequest;
      if (!parsed || typeof parsed.url !== 'string')
        throw new Error('Invalid network request');
      const url = new URL(parsed.url);
      if (!['https:', 'http:'].includes(url.protocol))
        throw new Error('Unsupported URL protocol');
      const signal = AbortSignal.any([host.signal, sandbox.controller.signal]);
      if (sandbox.pending.size >= 8)
        throw new CompatibilityError(
          'LIMIT_EXCEEDED',
          'Network concurrency exceeds 8',
        );
      const response = await new Promise<
        Awaited<ReturnType<EngineHost['request']>>
      >((resolve, reject) => {
        const abort = () =>
          reject(
            new CompatibilityError('CANCELED', 'Network request canceled'),
          );
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) {
          abort();
          return;
        }
        host
          .request(parsed, signal)
          .then(resolve, reject)
          .finally(() => signal.removeEventListener('abort', abort));
      });
      sandbox.check();
      if (
        response.body.length > 16 * 1024 * 1024 ||
        (response.bytes?.length ?? 0) > 16 * 1024 * 1024
      )
        throw new CompatibilityError(
          'LIMIT_EXCEEDED',
          'Response exceeds 16 MiB',
        );
      return JSON.stringify({
        ...response,
        bytes: parsed.responseType === 'bytes' ? response.bytes : undefined,
      });
    };
    install(
      '__requestSync',
      vm.newAsyncifiedFunction('__requestSync', async (input) => {
        try {
          return vm.newString(await request(vm.getString(input)));
        } catch (error) {
          return { error: sandbox.errorHandle(error) };
        }
      }),
    );
    install(
      '__requestAsync',
      vm.newFunction('__requestAsync', (input) => {
        const deferred = vm.newPromise();
        sandbox.deferred.add(deferred);
        const task = request(vm.getString(input))
          .then(
            (value) => {
              if (sandbox.closed) return;
              const result = vm.newString(value);
              deferred.resolve(result);
              result.dispose();
            },
            (error) => {
              if (sandbox.closed) return;
              const result = sandbox.errorHandle(error);
              deferred.reject(result);
              result.dispose();
            },
          )
          .finally(() => {
            if (sandbox.deferred.delete(deferred)) deferred.dispose();
            sandbox.pending.delete(task);
          });
        sandbox.pending.add(task);
        return deferred.handle;
      }),
    );
    install(
      '__service',
      vm.newFunction('__service', (name, input) => {
        try {
          sandbox.check();
          return vm.newString(
            JSON.stringify(
              options.service?.(
                vm.getString(name),
                JSON.parse(vm.getString(input)),
              ) ?? null,
            ),
          );
        } catch (error) {
          return { error: sandbox.errorHandle(error) };
        }
      }),
    );
    return sandbox;
  }
  private errorHandle(error: unknown): QuickJSHandle {
    const result = this.vm.newError(
      error instanceof Error ? error.message : String(error),
    );
    const code = (error as { code?: unknown })?.code;
    if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,127}$/.test(code)) {
      const value = this.vm.newString(code);
      this.vm.setProp(result, 'code', value);
      value.dispose();
    }
    return result;
  }
  private scriptError(error: any): CompatibilityError {
    const message = error?.message ?? String(error);
    const code =
      typeof error?.code === 'string' &&
      /^[A-Z][A-Z0-9_]{0,127}$/.test(error.code)
        ? error.code
        : /^UNSUPPORTED_CAPABILITY:/.test(message)
          ? 'UNSUPPORTED_CAPABILITY'
          : /interrupted|out of memory/i.test(message)
            ? 'LIMIT_EXCEEDED'
            : 'SCRIPT_ERROR';
    return new CompatibilityError(code, message);
  }
  private check() {
    if (
      this.closed ||
      this.host.signal.aborted ||
      this.controller.signal.aborted
    )
      throw new CompatibilityError('CANCELED', 'Script execution canceled');
    if (Date.now() > this.deadline)
      throw new CompatibilityError('LIMIT_EXCEEDED', 'Script timeout');
  }
  run(code: string): Promise<any> {
    const next = this.tail.then(() => this.execute(code));
    this.tail = next.catch(() => {});
    return next;
  }
  private async execute(code: string): Promise<unknown> {
    this.deadline = Date.now() + this.timeoutMs;
    this.check();
    const timer = setTimeout(() => this.controller.abort(), this.timeoutMs);
    let value: QuickJSHandle | undefined;
    try {
      const result = await this.vm.evalCodeAsync(code, 'source.js');
      if (result.error) {
        const error = this.vm.dump(result.error);
        result.error.dispose();
        throw this.scriptError(error);
      }
      value = result.value;
      while (true) {
        this.check();
        const state = this.vm.getPromiseState(value);
        if (state.type === 'fulfilled') {
          try {
            return this.vm.dump(state.value);
          } finally {
            if (state.value !== value) state.value.dispose();
          }
        }
        if (state.type === 'rejected') {
          const error = this.vm.dump(state.error);
          state.error.dispose();
          throw this.scriptError(error);
        }
        if (this.vm.runtime.hasPendingJob()) {
          const jobs = this.vm.runtime.executePendingJobs(100);
          if (jobs.error) {
            const error = this.vm.dump(jobs.error);
            jobs.error.dispose();
            throw new Error(error.message);
          }
        } else if (this.pending.size) {
          await Promise.race([
            ...this.pending,
            new Promise<void>((_, reject) => {
              const signal = AbortSignal.any([
                this.host.signal,
                this.controller.signal,
              ]);
              if (signal.aborted) reject(new Error('Script canceled'));
              else
                signal.addEventListener(
                  'abort',
                  () => reject(new Error('Script canceled')),
                  { once: true },
                );
            }),
          ]);
        } else
          throw new CompatibilityError(
            'SCRIPT_ERROR',
            'Promise cannot settle: no pending host operation',
          );
      }
    } finally {
      clearTimeout(timer);
      value?.dispose();
    }
  }
  dispose() {
    if (this.closed) return;
    this.closed = true;
    this.controller.abort();
    for (const deferred of this.deferred) deferred.dispose();
    this.deferred.clear();
    this.vm.dispose();
    this.vm.runtime.dispose();
  }
}
