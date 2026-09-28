/* tank@1's service (SPEC-OBJETIVO O12): an environment outside the harness, in a process of its own. Start it, then run
   the laboratory against it:

     node --experimental-strip-types scripts/tank-service.ts [--port 18300] [--seed 1]
     node --experimental-strip-types scripts/run-lab.ts --lab tank --service http://127.0.0.1:18300

   GET /stats says how many steps it has executed: a run interrupted and resumed must not execute one twice. */
import { serveTank } from '../src/worlds/tank/service.ts';

const argv = process.argv.slice(2);
const arg = (name: string, fallback: string) => { const i = argv.indexOf('--' + name); return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback; };
const s = await serveTank({ port: Number(arg('port', '18300')), seed: Number(arg('seed', '1')) });
console.log('tank@1 service on ' + s.url + ' (GET ' + s.url + '/stats)');
