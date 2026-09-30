/* particles3d@1's environment (SPEC-MUNDO-3D): a headless Blender that simulates the scenes the laboratory asks for.
   Start it, then run the laboratory against it:

     node --experimental-strip-types scripts/particles3d-service.ts [--port 18500]      (BLENDER=<path> if it is not found)

   --legacy-global-fields: the world as it was before 30/09/2026 (TEXTURE and TURBULENCE read in Blender's global
   coordinates), only to continue a run made then.
     node --experimental-strip-types scripts/run-particles3d.ts --level 1 --condition A [options]

   It listens on 127.0.0.1 only. Ctrl+C stops it. */
import { startBlenderService } from '../src/worlds/particles3d/blender.ts';

const argv = process.argv.slice(2);
const i = argv.indexOf('--port');
const port = Number(i >= 0 && argv[i + 1] ? argv[i + 1] : 18500);
const legacyGlobalFields = argv.includes('--legacy-global-fields');
const s = await startBlenderService({ port, legacyGlobalFields });
console.log('particles3d@1: Blender ' + s.version + ' on ' + s.url + (legacyGlobalFields ? ' (legacy global fields: only to continue a run made before 30/09/2026)' : ''));
const stop = () => { s.stop(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
s.process.on('exit', (code) => { console.log('Blender exited (' + code + ')'); process.exit(code ?? 1); });
