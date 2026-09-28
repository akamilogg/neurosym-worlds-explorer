/* orbit@1 as a laboratory: the common runner (runtime/lab-runner.ts) with the world's declaration (worlds/orbit/lab.ts),
   SPEC-OBJETIVO O9. The same as `scripts/run-lab.ts --lab orbit`; kept so the launchers (run-orbit.sh / run-orbit.ps1)
   keep working.

     node --experimental-strip-types scripts/run-orbit.ts --seed 3 --level 1 [options]    (--help lists them)

   Endpoints and keys come from the environment (never from the command line, never written to the journal):
     JEV_URL (default https://api.typesafe.ai/v1/systemone), JEV_KEY
     LLM_URL (an OpenAI-compatible /chat/completions URL), LLM_KEY, LLM_MODEL */
import { runLab } from '../src/runtime/lab-runner.ts';
import { orbitLab } from '../src/worlds/orbit/lab.ts';
import { ROOT } from '../test/support.ts';

await runLab(orbitLab, process.argv.slice(2), { root: ROOT, command: 'scripts/run-orbit.ts' });
