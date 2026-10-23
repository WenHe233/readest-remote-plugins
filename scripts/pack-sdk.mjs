import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Always use npm: pnpm pack rewrites metadata and inherits a workspace license,
// producing different archive hashes from the same SDK checkout.
export function npmCli() {
  const candidates = execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', ['npm'], { encoding: 'utf8' }).trim().split(/\r?\n/);
  for (const candidate of candidates) {
    const actual = realpathSync(candidate);
    if (actual.endsWith('.js')) return actual;
    for (const base of [join(dirname(actual), 'node_modules/npm'), join(dirname(actual), '../lib/node_modules/npm')]) {
      const cli = join(base, 'bin/npm-cli.js');
      if (existsSync(cli)) return cli;
    }
  }
  throw new Error('Cannot resolve npm CLI for deterministic SDK packing');
}

export function packSdk(directory, output) {
  execFileSync(process.execPath, [npmCli(), 'pack', '--ignore-scripts', '--pack-destination', output], { cwd: directory, stdio: 'pipe' });
}
