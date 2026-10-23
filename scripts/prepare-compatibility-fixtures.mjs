import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
const root = resolve(import.meta.dirname, '..', 'tests', 'fixtures');
const records = JSON.parse(
  await readFile(resolve(root, 'sources.lock.json'), 'utf8'),
);
for (const record of records) {
  const path = resolve(root, record.file);
  if (
    record.file.includes('..') ||
    !/^venera\/[a-z_]+\.js$|^legado\/[a-z0-9-]+\.json$/.test(record.file)
  )
    throw new Error('Invalid fixture path');
  let bytes;
  try {
    bytes = await readFile(path);
  } catch {}
  if (
    bytes &&
    createHash('sha256').update(bytes).digest('hex') === record.sha256
  )
    continue;
  const response = await fetch(record.url, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok)
    throw new Error(
      `Fixture download failed: ${record.file}: ${response.status}`,
    );
  bytes = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== record.sha256)
    throw new Error('Fixture digest changed: ' + record.file);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
}
console.log(`Verified ${records.length} pinned upstream source fixtures`);
