/* Any laboratory, by name (SPEC-OBJETIVO O9): the same runner for every world declared as a `Lab` (learn/lab.ts).

     node --experimental-strip-types scripts/run-lab.ts --lab cells --seed 1 --level 1 [options]
     node --experimental-strip-types scripts/run-lab.ts --lab messages --help

   Endpoints and keys come from the environment (never from the command line, never written to the journal):
     JEV_URL (default https://api.typesafe.ai/v1/systemone), JEV_KEY
     LLM_URL (an OpenAI-compatible /chat/completions URL), LLM_KEY, LLM_MODEL */
import { runLab } from '../src/runtime/lab-runner.ts';
import { LABS } from '../src/worlds/labs.ts';
import { ROOT } from '../test/support.ts';

const argv = process.argv.slice(2);
const i = argv.indexOf('--lab');
const name = i >= 0 ? argv[i + 1] : undefined;
const lab = name ? LABS[name] : undefined;
if (!lab) {
  console.error('--lab: one of ' + Object.keys(LABS).join(', ') + (name ? ' (not "' + name + '")' : ''));
  process.exit(2);
}
await runLab(lab, argv, { root: ROOT, command: 'scripts/run-lab.ts --lab ' + name });
