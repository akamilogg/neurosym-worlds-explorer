import { hashString } from '../../core/hash.ts';
import type { World } from '../../core/types.ts';

/* ============================================================================
 * tank@1 as the learner perceives it: episodes of a value that changes step by step. At
 * each step an input (0 to 9) is given and the value that follows is shown. (The service
 * calls them an inflow and a tank's level; System 2 is never told so.) The rule is the
 * service's (service.ts), outside the harness; nothing here computes it.
 * ========================================================================== */

/** The laboratory's spec: where the service is, and which of its places a spec is. */
export interface TankSpec {
  readonly seed: number;
  /** The service's name for the place (the family's places are other tanks under the same rule). */
  readonly place: string;
  /** Steps per episode. */
  readonly steps: number;
}

/** An episode as it was perceived: the value at the start, then each input and the value after it. */
export interface TankEpisode {
  readonly rows: readonly { readonly input: number | null; readonly value: number }[];
}

/** A point: the rows up to now, and the input that comes next. */
export interface TankPoint {
  readonly rows: readonly { readonly input: number | null; readonly value: number }[];
  readonly next_input: number;
}

export const TANK_PERCEPT_DOC = 'At a point of an episode your code receives p = { rows, next_input }: `p.rows` is what was perceived up to that step, '
  + 'oldest first - each row { input, value } (the first row has input null) - and `p.next_input` is the input of the next step.';

export const perceiveTank = (point: TankPoint): TankPoint => point;

export function tankPointWorld(): World<TankPoint, never> {
  return {
    id: 'tank@1',
    actors: ['nature'],
    initial: () => { throw new Error('tank@1 has no initial state: points come from episodes'); },
    toMove: () => 'nature',
    actions: () => [],
    step: (s) => s,
    outcome: () => ({ over: false, winner: null, reason: null }),
    key: (s) => hashString(JSON.stringify(s)),
    view: () => ({ entities: [], scalars: {} }),
    describeRules: () => '',
    actionKey: () => ''
  };
}
