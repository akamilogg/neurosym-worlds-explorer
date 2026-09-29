/* `lab`: the command line of the laboratory runs (SPEC-INVESTIGADOR-ASISTIDO §5), the same for both researchers.

     node --experimental-strip-types scripts/lab.ts help
     node --experimental-strip-types scripts/lab.ts start cells --seed 1 --level 3
     node --experimental-strip-types scripts/lab.ts list
     node --experimental-strip-types scripts/lab.ts watch last

   Keys come from the environment only (LLM_URL, LLM_MODEL, LLM_KEY; JEV_URL, JEV_KEY): a run started or resumed from here
   takes them from this process's environment. */
import { labCli } from '../src/runtime/cli.ts';
import { ROOT } from '../test/support.ts';

process.exitCode = await labCli(process.argv.slice(2), { root: ROOT, out: (line) => console.log(line) });
