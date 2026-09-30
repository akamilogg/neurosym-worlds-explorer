/* particles3d@1's viewer (SPEC-MUNDO-3D §4): an episode of a run, as Blender did it and as the learner's final law answers
   it from a row on (its own answers taken as what happened), saved as a .blend file to look at in Blender.

     node --experimental-strip-types scripts/particles3d-view.ts <journal> [--episode ep1] [--from 4] [--out view.blend]

   The law runs here on the table as the learner perceived it; the paths are drawn in Blender's coordinates. Only the
   law's output code is run (a law that asks the Judge is drawn with every rule at 0.5). */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { fromPercept, type SceneSpec } from '../src/worlds/particles3d/scene.ts';
import { appendRow, readAnswer } from '../src/worlds/particles3d/objective.ts';
import { perceiveP3, type P3Point } from '../src/worlds/particles3d/world.ts';
import { VIEW_SCRIPT, findBlender } from '../src/worlds/particles3d/blender.ts';

const argv = process.argv.slice(2);
const arg = (name: string, fallback: string) => { const i = argv.indexOf('--' + name); return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback; };
const file = argv.find((a) => !a.startsWith('--') && !argv[argv.indexOf(a) - 1]?.startsWith('--'));
if (!file) { console.log('usage: scripts/particles3d-view.ts <journal> [--episode ep1] [--from 4] [--out view.blend]'); process.exit(2); }
const journal = JSON.parse(fs.readFileSync(file, 'utf8'));
if (journal.experiment !== 'particles3d@1') { console.log('not a particles3d@1 journal: ' + journal.experiment); process.exit(2); }
const scene: SceneSpec = journal.hidden_from_the_learner.scene;
const events: Record<string, any>[] = journal.events;
const episodeId = arg('episode', 'ep1');
const explored = events.find((e) => e.type === 'exploration_episode' && e.episode === episodeId);
if (!explored) { console.log('no exploration episode ' + episodeId + ' in the journal (exploration episodes: ' + events.filter((e) => e.type === 'exploration_episode').map((e) => e.episode).join(', ') + ')'); process.exit(2); }

/* The table as it was perceived. */
const [head, ...lines] = String(explored.table).split('\n');
const names = [...new Set(head.trim().split(/\s+/).slice(1).map((c) => c.split('.')[0]))];
const cells = lines.map((l) => l.trim().split(/\s+/));
const t = cells.map((c) => Number(c[0]));
const rows = cells.map((c) => names.map((_, j) => (c[1 + 3 * j] === 'null' ? null : [0, 1, 2].map((a) => Number(c[1 + 3 * j + a])))));

/* The final law, run from a row on its own answers. */
const final = [...events].reverse().find((e) => e.type === 'end')?.final;
const source = typeof final?.output === 'string' ? final.output : final?.output?.source;
if (!source) { console.log('the run has no final law with output code'); process.exit(2); }
const law = vm.runInNewContext('(' + source + ')', { Math, JSON, Number, Array, Object }) as (p: unknown, m: unknown) => unknown;
const from = Number(arg('from', '4'));
let state: P3Point = { t: t.slice(0, from + 1), names, rows: rows.slice(0, from + 1) };
const predicted: Record<string, number[][]> = Object.fromEntries(names.map((n, j) => [n, rows[from][j] ? [rows[from][j]!] : []]));
for (let r = from + 1; r < rows.length; r++) {
  const a = readAnswer(law(perceiveP3(state), { rules: new Proxy({}, { get: () => 0.5 }), V: 0.5 }), names);
  if (typeof a === 'string') { console.log('the law stopped at row ' + r + ': ' + a); break; }
  state = appendRow(state, a);
  for (const n of names) if (a[n]) predicted[n].push(a[n]);
}

/* In Blender's coordinates (the place of an exploration episode is the laboratory's: the scene as generated). */
const world = (q: readonly number[]) => fromPercept(scene.frame, q);
const markers = Object.fromEntries(scene.markers.map((m) => [m.name, scene.fields[m.field].location]));
const bodies = names.filter((n) => !(n in markers));
const data = {
  markers,
  real: Object.fromEntries(bodies.map((n) => [n, rows.map((r) => (r[names.indexOf(n)] ? world(r[names.indexOf(n)]!) : null))])),
  predicted: Object.fromEntries(bodies.map((n) => [n, predicted[n].map(world)])),
  from
};
const out = path.resolve(arg('out', file.replace(/\.json$/, '') + '.' + episodeId + '.blend'));
const json = out.replace(/\.blend$/, '.trajectories.json');
fs.writeFileSync(json, JSON.stringify(data));
const blender = findBlender();
if (!blender) { console.log('Blender was not found (set BLENDER); the trajectories are in ' + json); process.exit(1); }
/* Blender exits 0 even when its script fails: whether it saved is read from what it printed. */
const r = spawnSync(blender, ['-b', '--factory-startup', '--python', VIEW_SCRIPT, '--', json, out], { encoding: 'utf8' });
const saved = r.status === 0 && fs.existsSync(out);
console.log(saved ? 'saved ' + out + ' (grey: what happened; orange: the law from row ' + from + ')' : 'Blender failed: ' + (r.stderr + r.stdout).slice(-600));
process.exit(saved ? 0 : 1);
