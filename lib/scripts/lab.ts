/* `lab`: the command line of the laboratory runs (SPEC-INVESTIGADOR-ASISTIDO §5), the same for both researchers.

     node --experimental-strip-types scripts/lab.ts help
     node --experimental-strip-types scripts/lab.ts start cells --seed 1 --level 3
     node --experimental-strip-types scripts/lab.ts list
     node --experimental-strip-types scripts/lab.ts watch last

   Keys come from the environment only (LLM_URL, LLM_MODEL, LLM_KEY; JEV_URL, JEV_KEY): a run started or resumed from here
   takes them from this process's environment. */
import fs from 'node:fs';
import path from 'node:path';
import { failureText, labCli } from '../src/runtime/cli.ts';
import { ROOT } from '../test/support.ts';

/* A failure nothing caught (in a run, an agent, a batch) ends the process with its trace on the console and in
   runs/lab-crash.log, never silently. */
const crashed = (kind: string) => (e: unknown): void => {
  const text = new Date().toISOString() + ' ' + kind + ' in `lab ' + process.argv.slice(2).join(' ') + '`\n' + failureText(e) + '\n';
  console.error(text);
  try { fs.mkdirSync(path.join(ROOT, 'runs'), { recursive: true }); fs.appendFileSync(path.join(ROOT, 'runs', 'lab-crash.log'), text + '\n'); } catch { /* the console has it */ }
  process.exit(1);
};
process.on('uncaughtException', crashed('uncaught exception'));
process.on('unhandledRejection', crashed('unhandled rejection'));

process.exitCode = await labCli(process.argv.slice(2), { root: ROOT, out: (line) => console.log(line) });
