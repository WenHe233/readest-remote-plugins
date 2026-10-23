import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
const expected = {
  venera: ['manga_dex', 'komiic', 'comick'],
  legado: ['酷我小说', '阅友小说', '书海阁'],
};
const live = JSON.parse(
  readFileSync('.artifacts/compatibility-live.json', 'utf8'),
);
const checks = Object.entries(expected).flatMap(([engine, names]) =>
  names.map((name) => {
    const result = live.results.find((item) => item.source === name);
    if (
      !result?.ok ||
      (engine === 'venera'
        ? result.stage !== 'resource'
        : result.stage !== 'content')
    )
      throw new Error('Live acceptance is incomplete: ' + name);
    if (
      !result.checkedAt ||
      Date.now() - Date.parse(result.checkedAt) > 24 * 60 * 60 * 1000
    )
      throw new Error('Live acceptance is older than 24 hours: ' + name);
    return { ...result, engine };
  }),
);
const hash = createHash('sha256');
function hashTree(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
    (a, b) => a.name.localeCompare(b.name),
  )) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) hashTree(path);
    else if (entry.isFile()) {
      hash.update(path.replaceAll('\\', '/'));
      hash.update(readFileSync(path));
    }
  }
}
for (const directory of [
  'packages/compatibility',
  'plugins/legado',
  'plugins/venera',
])
  hashTree(directory);
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim(),
  uncommittedChanges: Boolean(
    execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(),
  ),
  engineTreeSha256: hash.digest('hex'),
  runner: {
    node: process.version,
    platform: process.platform,
    tlsVerification: true,
    mode: 'standalone injected host; browser/native host contract verified separately',
  },
  sdk: JSON.parse(readFileSync('SDK_SOURCE.json', 'utf8')),
  fixtures: JSON.parse(
    readFileSync('tests/fixtures/sources.lock.json', 'utf8'),
  ),
  checks,
  substitutions: {
    legado:
      'Original XIU2 candidates retained as replay fixtures. Inaccessible sites were replaced for live acceptance by XIU2 酷我小说/阅友小说 and pinned speauty 书海阁.',
  },
  limitations: [
    'No claim of full ecosystem compatibility',
    'WebView/Java APIs and image transforms return explicit unsupported-capability errors',
    'Live success is environment-specific and does not guarantee future website availability',
  ],
};
mkdirSync('.artifacts', { recursive: true });
writeFileSync(
  '.artifacts/compatibility-report.json',
  JSON.stringify(report, null, 2) + '\n',
);
console.log('Validated 3 Legado and 3 Venera live sources');
