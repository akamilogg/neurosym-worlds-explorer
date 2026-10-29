/* The junior's server (SPEC-METAPOLITICA-APRENDIZAJE §5), on the junior's machine: its sessions, receipts and memory states
   under --root, its blobs under --blobs, its model in one Python worker (Qwenputer's driver, or the fake backend):

     node --experimental-strip-types scripts/junior-server.ts --root <dir> --blobs <dir> --python <path to python>
          [--backend qwenputer|fake] [--port 18700] [--queue-timeout-ms N]

   It listens on 127.0.0.1 only: the harness runs on the same machine. Before an investigation, the machine is checked
   (lab junior check). Ctrl+C stops it; a question it was answering is published as failed by the next server on --root. */
import path from 'node:path';
import { BlobStore } from '../src/junior/package.ts';
import { SessionServer } from '../src/junior/sessions.ts';
import { serveJunior } from '../src/junior/http.ts';
import { ProcessWorker, type Backend } from '../src/junior/worker.ts';

const argv = process.argv.slice(2);
const arg = (name: string, fallback?: string): string | undefined => { const i = argv.indexOf('--' + name); return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback; };
const root = arg('root'), blobs = arg('blobs');
if (!root || !blobs) { console.error('junior-server --root <dir> --blobs <dir> --python <python> [--backend qwenputer|fake] [--port 18700]'); process.exit(2); }
const backend = (arg('backend', 'qwenputer') as Backend);
const worker = new ProcessWorker({ python: [arg('python', process.env.JUNIOR_PYTHON ?? 'python')!, '-u'], backend, work: path.join(root, 'work') });
const queue = arg('queue-timeout-ms');
const server = new SessionServer({ root, store: new BlobStore(blobs), worker, ...(queue ? { queueTimeoutMs: Number(queue) } : {}) });
const s = await serveJunior(server, { port: Number(arg('port', '18700')) });
console.log('junior server on ' + s.url + ' (' + backend + '; sessions in ' + path.join(root, 'sessions') + ')');
const stop = (): void => { server.stop(); void s.close().then(() => process.exit(0)); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
