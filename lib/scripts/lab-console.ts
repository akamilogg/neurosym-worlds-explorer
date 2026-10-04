/* The console of the laboratory runs (SPEC-INVESTIGADOR-ASISTIDO §8, A3): a local page over the control API, for both
   researchers.

     node --experimental-strip-types scripts/lab-console.ts [--port 18400]

   Open http://127.0.0.1:18400. It listens on 127.0.0.1 only. Runs started or resumed from it take the endpoints and keys
   from this process's environment (LLM_URL, LLM_MODEL, LLM_KEY; JEV_URL, JEV_KEY): they never pass through the page. */
import { serveConsole } from '../src/runtime/console.ts';
import { viewerHtml } from './journal-view.ts';
import { ROOT } from '../test/support.ts';

const argv = process.argv.slice(2);
const i = argv.indexOf('--port');
const c = await serveConsole({ root: ROOT, port: i >= 0 ? Number(argv[i + 1]) : 18400, synthesis: (journal) => viewerHtml(journal) });
console.log('console on ' + c.url + ' (runs in ' + ROOT + '/runs)');
console.log('research observatory on ' + c.url + '/research');
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void c.close().then(() => process.exit(0)); });
