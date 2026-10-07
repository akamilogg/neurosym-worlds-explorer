import { mulberry32 } from '../grid/gen.ts';
import type { Circuit, Signals } from './body.ts';

/* ============================================================================
 * SYNTHETIC CIRCUITS (SPEC-C302-LAZO-CERRADO §8.2): stand-ins for c302 that verify the body and
 * the field by themselves - what each does is known, so what the body does with it can be checked
 * before anything is attributed to the real circuit. Never shown to a researcher.
 * ========================================================================== */

/** Fixed signals, whatever comes in. */
export const constantCircuit = (s: Signals): Circuit => ({ initial: s, step: () => s });

/** Steers by how the current is shared between the sides only (the head's swing), never by the concentration: in a uniform
    field it sees nothing but the swing - what drift the swing alone gives (§8.2). */
export const splitCircuit = (gain: number): Circuit => ({
  initial: { reorientation: 0, steering: 0 },
  step: (l, r) => ({ reorientation: 0, steering: gain * (l - r) / (l + r) })
});

/** Signals unrelated to the odor: a schedule of its own, from a seed - turns and bends that never depend on what comes in. */
export function decoupledCircuit(seed: number): Circuit {
  const rnd = mulberry32(seed);
  let steer = 0, reo = 0, t = 0;
  return {
    initial: { reorientation: 0, steering: 0 },
    step: (_l, _r, dtMs) => {
      t += dtMs;
      if (t >= 500) { t -= 500; steer = (rnd() - 0.5) * 1.6; reo = rnd() < 0.15 ? 3 : 0; }
      return { reorientation: reo, steering: steer };
    }
  };
}

/** A toy circuit that navigates, as a worm might: it turns sharply when the concentration falls (klinokinesis), and bends
    towards the side where the head finds more of it (weathervane: the current above its recent mean, times the side the
    swing has the head on). What it does is known: the closed loop reaches the source with it, end to end. */
export function toyCircuit(o: { tauMs?: number; steer?: number; turn?: number } = {}): Circuit {
  const tau = o.tauMs ?? 1500, ks = o.steer ?? 40, kr = o.turn ?? 40;
  let mean: number | null = null;
  return {
    initial: { reorientation: 0, steering: 0 },
    step: (l, r, dtMs) => {
      const total = l + r, side = (l - r) / total;
      const was = mean;
      mean = mean === null ? total : mean + (total - mean) * (1 - Math.exp(-dtMs / tau));
      /* The slow trend (the mean's), not the swing's: a turn when the odor falls as the worm goes, not as its head sways. */
      const slope = was === null ? 0 : (mean - was) / (dtMs / 1000);
      return { reorientation: kr * Math.max(0, -slope), steering: ks * (total - mean) * side };
    }
  };
}
