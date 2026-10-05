/* The c302 service (SPEC-EUREKA-NAVEGACION §4.1): OpenWorm's model of the nervous system of C. elegans, simulated in a
   process of its own, for the laboratories built on it. It needs a Python with c302 and pyNeuroML, and Java:

     node --experimental-strip-types scripts/c302-service.ts --python <path to python> [--port 18600] [--concurrency 4]

   POST /simulate runs one simulation (an Idempotency-Key makes it run once); GET /stats says how many were run and how
   many answered again. It listens on 127.0.0.1 only. Ctrl+C stops it. */
import { SIMULATE_PY, serveC302 } from '../src/worlds/c302/service.ts';

const argv = process.argv.slice(2);
const arg = (name: string, fallback: string) => { const i = argv.indexOf('--' + name); return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback; };
const python = arg('python', process.env.C302_PYTHON ?? 'python');
const s = await serveC302({ port: Number(arg('port', '18600')), worker: [python, SIMULATE_PY], concurrency: Number(arg('concurrency', '4')) });
console.log('c302 service on ' + s.url + ' (python ' + python + '; GET ' + s.url + '/stats)');
