import { READOUT_TAU_MS, UNIT } from '../c302nav/world.ts';
import type { Signals } from './body.ts';

/* ============================================================================
 * The INCREMENTAL readout (SPEC-C302-LAZO-CERRADO §3, §4): in closed loop the signals are read
 * step by step, as the calcium comes, keeping the state of the two filters between steps - and
 * they must be exactly c302nav's, read over the whole trace (`signalsOf`): the reorientation from
 * AVA − AVB, the steering from RIAL − RIAR, each filtered twice with one pole of 200 ms, in units
 * of 1e-8 mM. The reference the service's own readout is checked against (L2).
 * ========================================================================== */

const round = (x: number): number => Number(x.toPrecision(6));

export class Readout {
  private readonly a: number;
  /** The two filters' state, per signal. */
  private reo = [0, 0];
  private steer = [0, 0];

  constructor(dtMs: number, tauMs = READOUT_TAU_MS) { this.a = Math.exp(-dtMs / Math.max(tauMs, dtMs)); }

  /** The calcium of the readout cells now: the signals now. */
  step(calcium: Readonly<Record<'AVAL' | 'AVAR' | 'AVBL' | 'AVBR' | 'RIAL' | 'RIAR', number>>): Signals {
    const ava = (calcium.AVAL + calcium.AVAR) / 2, avb = (calcium.AVBL + calcium.AVBR) / 2;
    const twice = (s: number[], x: number) => { s[0] = this.a * s[0] + (1 - this.a) * x; s[1] = this.a * s[1] + (1 - this.a) * s[0]; return round(s[1] * UNIT); };
    return { reorientation: twice(this.reo, ava - avb), steering: twice(this.steer, calcium.RIAL - calcium.RIAR) };
  }
}
