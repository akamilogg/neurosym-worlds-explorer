/* cells@1 as a laboratory: the common runner (runtime/lab-runner.ts) with the world's declaration
   (worlds/cells/lab.ts), SPEC-OBJETIVO O9. The same as `scripts/run-lab.ts --lab cells`; kept so the launchers
   (run-cells.sh / run-cells.ps1) keep working.

     node --experimental-strip-types scripts/run-cells.ts --seed 1 [--level N (1-3), --acts N] [options]    (--help lists them)

   Endpoints and keys come from the environment (never from the command line, never written to the journal):
     JEV_URL (default https://api.typesafe.ai/v1/systemone), JEV_KEY
     LLM_URL (an OpenAI-compatible /chat/completions URL), LLM_KEY, LLM_MODEL */
import { runLab } from '../src/runtime/lab-runner.ts';
import { cellsLab } from '../src/worlds/cells/lab.ts';
import { ROOT } from '../test/support.ts';

await runLab(cellsLab, process.argv.slice(2), { root: ROOT, command: 'scripts/run-cells.ts' });
