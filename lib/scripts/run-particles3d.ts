/* particles3d@1 as a laboratory (SPEC-MUNDO-3D): the common runner with the world's declaration
   (worlds/particles3d/lab.ts). The same as `scripts/run-lab.ts --lab particles3d`. Its environment is Blender, as a service:
   start it first (scripts/particles3d-service.ts).

     node --experimental-strip-types scripts/run-particles3d.ts --seed 1 --level 1 --condition A [options]    (--help lists them)

   Endpoints and keys come from the environment (never from the command line, never written to the journal):
     JEV_URL (default https://api.typesafe.ai/v1/systemone), JEV_KEY
     LLM_URL (an OpenAI-compatible /chat/completions URL), LLM_KEY, LLM_MODEL */
import { runLab } from '../src/runtime/lab-runner.ts';
import { particles3dLab } from '../src/worlds/particles3d/lab.ts';
import { ROOT } from '../test/support.ts';

await runLab(particles3dLab, process.argv.slice(2), { root: ROOT, command: 'scripts/run-particles3d.ts' });
