/* A shared living world's session (SPEC-ACONTECIMIENTOS-DEL-MUNDO §4), in a process of its own:

     node --experimental-strip-types scripts/run-session.ts --manifest <living-world@1.json> --dir <folder> --name <name>
     node --experimental-strip-types scripts/run-session.ts --resume <x.session.json> --dir <folder> --name <name> [--more-rounds N]

   Every researcher of the manifest is the assisted one in a run of its own, all in this process and in one world; resumed,
   the session goes on from its record (each researcher's run resumed, given more rounds where they ran out). System 2 and
   the Judge from the environment (LLM_URL, LLM_KEY, LLM_MODEL; JEV_URL, JEV_KEY, JEV_MODEL), never from the command line,
   never written to a record. */
import fs from 'node:fs';
import { llmTuning } from '../src/runtime/lab-runner.ts';
import { JEV_DEFAULT_URL } from '../src/core/jev.ts';
import { LABS } from '../src/worlds/labs.ts';
import { readManifest } from '../src/living/manifest.ts';
import { rebuildLivingSession, runLivingSession } from '../src/living/run-session.ts';
import { chatFromEnv } from '../src/orchestra/launch.ts';
import type { LawLab } from '../src/learn/lab.ts';
import { ROOT } from '../test/support.ts';

const argv = process.argv.slice(2);
const at = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const file = at('--manifest'), resume = at('--resume'), dir = at('--dir'), name = at('--name'), more = Number(at('--more-rounds') ?? 0);
if ((!file && !resume) || !dir || !name) { console.error('--manifest <file> | --resume <x.session.json>, --dir <folder> --name <name> [--more-rounds N]'); process.exit(2); }
const env = process.env;
const llm = { url: env.LLM_URL, key: env.LLM_KEY, model: env.LLM_MODEL, ...llmTuning(env) };
const judge = { url: env.JEV_URL || JEV_DEFAULT_URL, key: env.JEV_KEY, model: env.JEV_MODEL };
let r;
if (resume) {
  const recorded = JSON.parse(fs.readFileSync(resume, 'utf8'));
  const lab = Object.values(LABS).find((l) => l.id === recorded.adapter) as LawLab | undefined;
  if (!lab) { console.error('no laboratory ' + recorded.adapter); process.exit(2); }
  r = await rebuildLivingSession(lab, { sessionFile: resume, dir, name, root: ROOT, mode: 'continue', ...(more > 0 ? { moreRounds: more } : {}),
    connection: () => ({ llm, judge }) });
} else {
  const m = readManifest(JSON.parse(fs.readFileSync(file!, 'utf8')), LABS);
  if ('errors' in m) { console.error('the manifest is refused:\n  ' + m.errors.join('\n  ')); process.exit(2); }
  /* A senior's model, as `lab agent` takes it (SENIOR_LLM_URL, SENIOR_LLM_KEY, SENIOR_LLM_MODEL). */
  r = await runLivingSession(LABS[m.lab] as LawLab, { plan: m.plan, dir, name, root: ROOT, args: m.flat ? ['--flat'] : [],
    connection: () => ({ llm, ...(m.flat ? {} : { judge }) }), seniorLlm: () => chatFromEnv(env, 'SENIOR_LLM') });
}
console.log('session ' + name + ': ' + Object.entries(r.runs).map(([id, x]) => id + ' ' + (x.stoppedBy ?? 'failed: ' + x.error)).join(', '));
