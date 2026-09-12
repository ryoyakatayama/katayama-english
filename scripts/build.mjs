import { readFile, writeFile, mkdir, readdir, cp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
const root = process.cwd();
const entries = async (dir) => {
  const result = [];
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, item.name);
    if (item.isDirectory()) result.push(...(await entries(file)));
    else result.push(file);
  }
  return result.sort();
};
const words = [];
for (const name of ['vocabulary.txt', 'vocabulary_upper.txt']) {
  let level, pos;
  for (let line of (await readFile(`legacy-python/${name}`, 'utf8')).split(
    /\r?\n/,
  )) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[')) {
      [level, pos] = line.slice(1, -1).split(',');
      continue;
    }
    const i = line.indexOf('='),
      english = line.slice(0, i),
      japanese = line.slice(i + 1);
    if (
      i < 1 ||
      !japanese ||
      !['basic', 'advanced', 'upper1', 'upper2'].includes(level) ||
      !['noun', 'verb', 'adjective', 'adverb'].includes(pos)
    )
      throw Error('Invalid vocabulary');
    words.push({ key: `${english}:${pos}`, english, japanese, level, pos });
  }
}
if (new Set(words.map((w) => w.english)).size !== 2000)
  throw Error('Expected 2000 unique words');
for (const level of ['basic', 'advanced', 'upper1', 'upper2'])
  if (words.filter((w) => w.level === level).length !== 500)
    throw Error('Expected 500 words per level');
const families = (await readFile('legacy-python/synonyms.txt', 'utf8'))
  .split(/\r?\n/)
  .map((s) => s.trim().split(/\s+/).filter(Boolean));
const vocabulary = JSON.stringify({ version: 1, words, families });
const compiled = await entries('.build'),
  publicFiles = await entries('public');
for (const required of [
  'icon-192.png',
  'icon-512.png',
  'apple-touch-icon.png',
  'maskable-512.png',
])
  if (!publicFiles.includes(path.join('public', 'icons', required)))
    throw Error(`Missing icon ${required}`);
const template = await readFile('scripts/sw-template.js', 'utf8');
const hash = createHash('sha256');
for (const f of [...compiled, ...publicFiles]) {
  hash.update(f);
  hash.update(await readFile(f));
}
hash.update(vocabulary);
hash.update(template);
const version = hash.digest('hex').slice(0, 16);
// The only removed directory is the known generated dist below this project.
const output = path.resolve(root, 'dist');
if (path.dirname(output) !== root) throw Error('Unsafe output path');
await rm(output, { recursive: true, force: true });
await cp('public', output, { recursive: true });
await mkdir(`dist/assets/${version}`, { recursive: true });
for (const file of compiled)
  await cp(file, `dist/assets/${version}/${path.basename(file)}`);
await mkdir('dist/data', { recursive: true });
await writeFile('dist/data/vocabulary.json', vocabulary);
await writeFile(
  'dist/index.html',
  (await readFile('public/index.html', 'utf8')).replace('BUILD_ID', version),
);
await writeFile('dist/.nojekyll', '');
const assets = (await entries('dist')).map((f) =>
  path.relative('dist', f).replaceAll('\\', '/'),
);
await writeFile(
  'dist/sw.js',
  template
    .replace('__VERSION__', version)
    .replace('__ASSETS__', JSON.stringify(assets)),
);
console.log(
  `Built ${words.length} words · ${version} · ${assets.length} offline assets -> dist/`,
);
