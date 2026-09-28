/* The grid (unknown-world@1) as a laboratory: the common runner (runtime/lab-runner.ts) with the world's loop
   (worlds/grid/lab.ts), SPEC-OBJETIVO O9c. The same as `scripts/run-lab.ts --lab grid`; kept so the launchers
   (run-grid.sh / run-grid.ps1) keep working.

     node --experimental-strip-types scripts/run-grid.ts --seed 22 [options]    (--help lists them)

   Endpoints and keys come from the environment (never from the command line, never written to the journal):
     JEV_URL (default https://api.typesafe.ai/v1/systemone), JEV_KEY
     LLM_URL (an OpenAI-compatible /chat/completions URL), LLM_KEY, LLM_MODEL */
import { runLab } from '../src/runtime/lab-runner.ts';
import { gridLab } from '../src/worlds/grid/lab.ts';
import { ROOT } from '../test/support.ts';

await runLab(gridLab, process.argv.slice(2), { root: ROOT, command: 'scripts/run-grid.ts' });
