import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* SPEC-CONSOLIDACION §5.3, CC3: the order of the layers, core <- learn <- worlds <- runtime, by every import of the code.
   core reads nothing above it; learn reads no world; runtime reaches the worlds only through their registry
   (worlds/labs.ts) and the capabilities a laboratory declares. No exception is declared. */

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : []));
const importsOf = (file: string): string[] => [...fs.readFileSync(file, 'utf8').matchAll(/(?:from|import\()\s*'(\.[^']+)'/g)]
  .map((m) => path.relative(SRC, path.resolve(path.dirname(file), m[1])).split(path.sep).join('/'));
const layer = (rel: string): string => rel.split('/')[0];

test('CC3: the layers - core reads nothing above it, learn reads no world, runtime reaches a world only through the registry', () => {
  const broken: string[] = [];
  for (const f of files(SRC)) {
    const from = path.relative(SRC, f).split(path.sep).join('/');
    for (const to of importsOf(f)) {
      if (layer(from) === 'core' && layer(to) !== 'core') broken.push(from + ' -> ' + to + ' (core reads nothing above it)');
      if (layer(from) === 'learn' && layer(to) === 'worlds') broken.push(from + ' -> ' + to + ' (learn reads no world)');
      if (layer(from) === 'runtime' && layer(to) === 'worlds' && to !== 'worlds/labs.ts') broken.push(from + ' -> ' + to + ' (runtime reaches a world through the registry)');
    }
  }
  assert.deepEqual(broken, []);
});
