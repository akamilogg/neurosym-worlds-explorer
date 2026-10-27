/* A shared living world's session (SPEC-ACONTECIMIENTOS-DEL-MUNDO §4), in a process of its own:

     node --experimental-strip-types scripts/run-session.ts --manifest <living-world@1.json> --dir <folder> --name <name>

   Every researcher of the manifest is the assisted one in a run of its own, all in this process and in one world. System 2
   and the Judge from the environment (LLM_URL, LLM_KEY, LLM_MODEL; JEV_URL, JEV_KEY, JEV_MODEL), never from the command
   line, never written to a record. */
import fs from 'node:fs';
import { llmTuning } from '../src/runtime/lab-runner.ts';
import { JEV_DEFAULT_URL } from '../src/core/jev.ts';
import { LABS } from '../src/worlds/labs.ts';
import { readManifest } from '../src/living/manifest.ts';
import { runLivingSession } from '../src/living/run-session.ts';
import type { LawLab } from '../src/learn/lab.ts';
import { ROOT } from '../test/support.ts';

const argv = process.argv.slice(2);
const at = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const file = at('--manifest'), dir = at('--dir'), name = at('--name');
if (!file || !dir || !name) { console.error('--manifest <file> --dir <folder> --name <name>'); process.exit(2); }
const m = readManifest(JSON.parse(fs.readFileSync(file, 'utf8')), LABS);
if ('errors' in m) { console.error('the manifest is refused:\n  ' + m.errors.join('\n  ')); process.exit(2); }
const env = process.env;
const llm = { url: env.LLM_URL, key: env.LLM_KEY, model: env.LLM_MODEL, ...llmTuning(env) };
const judge = { url: env.JEV_URL || JEV_DEFAULT_URL, key: env.JEV_KEY, model: env.JEV_MODEL };
const r = await runLivingSession(LABS[m.lab] as LawLab, { plan: m.plan, dir, name, root: ROOT, args: m.flat ? ['--flat'] : [],
  connection: () => ({ llm, ...(m.flat ? {} : { judge }) }) });
console.log('session ' + name + ': ' + Object.entries(r.runs).map(([id, x]) => id + ' ' + (x.stoppedBy ?? 'failed: ' + x.error)).join(', '));
