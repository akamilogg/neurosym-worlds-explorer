/* OPERATOR TOOL. Which generated laws leave room to DISCOVER? A seed is usable at a level when:
     - the law can be told apart from Newton: in the observable region, the best Newtonian law (one strength per source,
       fitted on the samples) misses by clearly more than the noise of the perception alone blurs an acceleration,
     - and extrapolation discriminates: fitted in view, that Newtonian law misses beyond the observable region too
       (a law that only fits where it was seen fails where the trial will test it).
   A flat prediction (nothing) has relative error 1 by construction, so it is not reported.
   No network. Nothing here reaches System 2.

     node --experimental-strip-types scripts/calibrate-orbit.ts [fromSeed] [toSeed] [level] [resolution] [noise]
     e.g. scripts/calibrate-orbit.ts 1 20 1          (continuous perception, the world's own noise)
          scripts/calibrate-orbit.ts 1 20 1 0.1      (the table rounded to 0.1 in the learner's units: --resolution)
          scripts/calibrate-orbit.ts 1 20 1 0 0.01   (twenty times the default noise, in true units) */
import { generateOrbit } from '../src/worlds/orbit/index.ts';
import { accelSamples, fitNewton, lawSummary, noiseFloor, relError, sampleLaunches } from '../src/worlds/orbit/operator.ts';

const [from, to, level] = [Number(process.argv[2] || 1), Number(process.argv[3] || 10), Number(process.argv[4] || 1)];
const resolution = Number(process.argv[5] || 0);
const noiseArg = process.argv[6] ? Number(process.argv[6]) : null;
/* "Clearly more": the Newtonian miss must be this many times the noise floor. */
const MARGIN = 3;

const usable: string[] = [];
for (let seed = from; seed <= to; seed++) {
  let generated;
  try { generated = generateOrbit(seed, level); } catch { console.log('seed ' + seed + ': no usable law'); continue; }
  const spec = noiseArg === null ? generated.spec : { ...generated.spec, noise: noiseArg };
  const { report } = generated;
  const view = accelSamples(spec, sampleLaunches(spec, 40, seed * 17 + 1, 'view'), 0, spec.window);
  const outer = accelSamples(spec, sampleLaunches(spec, 20, seed * 17 + 2, 'outer'), spec.window, Infinity);
  const newton = fitNewton(spec, view);
  const inView = relError(view, newton);
  const beyond = relError(outer, newton);
  const noise = noiseFloor(spec, view, resolution);
  const ok = inView >= MARGIN * noise && beyond >= MARGIN * noise;
  if (ok) usable.push(String(seed));
  const pct = (n: number) => (n * 100).toFixed(1) + '%';
  console.log('seed ' + seed + ' L' + level + ' (' + lawSummary(spec) + ')\n  Newton miss in view ' + pct(inView) + ', beyond ' + pct(beyond) +
    ' | noise floor ' + pct(noise) + ' | scale ' + spec.frame.scale.toFixed(2) + ' | stays in view ' + pct(report.staysInView) + ' | samples ' + view.length + '/' + outer.length +
    (ok ? '   <== room to discover' : ''));
}
console.log('\nusable at L' + level + ': ' + (usable.join(', ') || 'none'));
