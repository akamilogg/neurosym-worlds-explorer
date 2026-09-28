/* messages@1 as a laboratory: the common runner (runtime/lab-runner.ts) with the world's declaration
   (worlds/messages/lab.ts), SPEC-OBJETIVO O9. The same as `scripts/run-lab.ts --lab messages`; kept so the launchers
   (run-messages.sh / run-messages.ps1) keep working.

     node --experimental-strip-types scripts/run-messages.ts --seed 1 [--tolerance N] [options]    (--help lists them)

   Endpoints and keys come from the environment (never from the command line, never written to the journal):
     JEV_URL (default https://api.typesafe.ai/v1/systemone), JEV_KEY
     LLM_URL (an OpenAI-compatible /chat/completions URL), LLM_KEY, LLM_MODEL */
import { runLab } from '../src/runtime/lab-runner.ts';
import { messagesLab } from '../src/worlds/messages/lab.ts';
import { ROOT } from '../test/support.ts';

await runLab(messagesLab, process.argv.slice(2), { root: ROOT, command: 'scripts/run-messages.ts' });
