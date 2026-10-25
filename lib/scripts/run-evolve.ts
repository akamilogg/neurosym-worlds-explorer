/* An evolutionary branch's supervisor (SPEC-DELEGACION-EVOLUTIVA §14), in a process of its own:

     node --experimental-strip-types scripts/run-evolve.ts --spec <branch>.evolve.json --out <branch>.json

   Its mutator and its consolidation ask System 2 as a run does, and the consolidation its Judge: endpoints and keys from
   the environment (LLM_URL, LLM_KEY, LLM_MODEL; JEV_URL, JEV_KEY, JEV_MODEL), never from the command line, never written
   to its record. */
import fs from 'node:fs';
import { runEvolutionBranch, type EvolveBranchSpec } from '../src/runtime/evolve-branch.ts';
import { llmTuning, runLaboratory } from '../src/runtime/lab-runner.ts';
import { chatMutator } from '../src/learn/evolve/mutator.ts';
import { openAiChatClient } from '../src/learn/system2.ts';
import { artifactsLab } from '../src/worlds/artifacts/lab.ts';
import { JEV_DEFAULT_URL } from '../src/core/jev.ts';
import { ROOT } from '../test/support.ts';

const argv = process.argv.slice(2);
const at = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const specFile = at('--spec'), journal = at('--out');
if (!specFile || !journal) { console.error('--spec <file> --out <journal>'); process.exit(2); }
const spec = JSON.parse(fs.readFileSync(specFile, 'utf8')) as EvolveBranchSpec;
const env = process.env;
const tuning = llmTuning(env);
const client = openAiChatClient({ url: env.LLM_URL ?? '', apiKey: env.LLM_KEY, model: env.LLM_MODEL ?? '', ...(tuning.temperature !== undefined ? { temperature: tuning.temperature } : {}),
  ...(tuning.maxTokens ? { maxTokens: tuning.maxTokens } : {}), ...(tuning.timeoutMs ? { timeoutMs: tuning.timeoutMs } : {}), ...(tuning.reasoningEffort ? { reasoningEffort: tuning.reasoningEffort } : {}),
  ...(tuning.extraBody ? { extraBody: tuning.extraBody } : {}), jsonMode: true });
const end = await runEvolutionBranch({ journal, spec, mutator: chatMutator(client),
  consolidate: async (args) => { await runLaboratory(artifactsLab, { args, root: ROOT, llm: { url: env.LLM_URL, key: env.LLM_KEY, model: env.LLM_MODEL, ...tuning },
    /* The Judge, as its requester's run has it (a branch of a run that is not --flat needs it). */
    judge: { url: env.JEV_URL || JEV_DEFAULT_URL, key: env.JEV_KEY, model: env.JEV_MODEL } }); } });
console.log('evolutionary branch ' + spec.id + ': ' + String([...end.events].reverse().find((e: { type: string }) => e.type === 'end')?.stoppedBy));
