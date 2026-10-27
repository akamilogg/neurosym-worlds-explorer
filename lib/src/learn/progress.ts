/* ============================================================================
 * The metrics of a world's progress (SPEC-VISTA-ESCALADA §3): the mountain its researchers climb.
 *
 * A laboratory declares them, read from its record and never by running anything; the view orients each so that
 * improving is always going up, with its real values on the labels. Only what the protocol measures is a sample (§3.3):
 * its checks, validations, blind confirmations and checks of an artifact - never what the researcher measures while it
 * explores, which is its evidence and not the world's.
 * ========================================================================== */

type J = Record<string, any>;

export interface ProgressMetric {
  /** "exact_share", "growth_exponent", ... */
  readonly id: string;
  /** In the operator's words. */
  readonly label: string;
  readonly unit: string;
  /** What improving is. */
  readonly direction: 'higher' | 'lower';
  /** Its natural limits (0–1 for a share). */
  readonly range?: readonly [number, number];
  readonly scale?: 'linear' | 'log';
  /** Which of the protocol's verdicts give it: a model's check (and its validations and blind confirmations), an
      artifact's check, or the validations alone. */
  readonly source: 'check' | 'artifact_check' | 'validation';
}

export interface LabProgress {
  /** The world's metrics; each is a mountain of its own, never combined with another (§3.4). */
  readonly metrics: readonly ProgressMetric[];
  /** A metric's value in a verdict of the record, or null if that verdict does not give it. The verdict is as the profile
      reading it received it: what it was not given, it cannot be read from. */
  sample(metric: string, event: J): number | null;
}

/** The share of a check's places where the model holds: coarse but honest (§3.1), any world's when it declares nothing. */
export const HOLDING: ProgressMetric = { id: 'places_holding', label: 'lugares donde el modelo se sostiene', unit: 'proporción',
  direction: 'higher', range: [0, 1], source: 'check' };

const places = (event: J): J[] => Array.isArray(event.laboratories) ? event.laboratories.filter((p: unknown) => p && typeof p === 'object') : [];

export function holdingShare(event: J): number | null {
  const ps = places(event);
  return ps.length ? ps.filter((p) => p.holds === true).length / ps.length : null;
}

export const DEFAULT_PROGRESS: LabProgress = {
  metrics: [HOLDING],
  sample: (metric, event) => (metric === HOLDING.id ? holdingShare(event) : null)
};

/** The share of a check's points answered exactly, over its places (`exact/points` of what the operator sees). */
export function exactShare(event: J): number | null {
  let exact = 0, points = 0;
  for (const p of places(event)) if (Number.isFinite(p.points) && Number.isFinite(p.exact)) { exact += p.exact; points += p.points; }
  return points > 0 ? exact / points : null;
}

/** The progress of a world whose check counts exact points (plates, cells). */
export const exactProgress = (label: string): LabProgress => ({
  metrics: [{ id: 'exact_share', label, unit: 'proporción', direction: 'higher', range: [0, 1], source: 'check' }],
  sample: (metric, event) => (metric === 'exact_share' ? exactShare(event) : null)
});

/** Where a metric comes from, by the kind of verdict it is (§3.3). */
export function feeds(metric: ProgressMetric, kind: 'check' | 'validation' | 'blind' | 'artifact'): boolean {
  if (metric.source === 'artifact_check') return kind === 'artifact';
  if (metric.source === 'validation') return kind === 'validation';
  return kind === 'check' || kind === 'validation' || kind === 'blind';
}

/** The axis of a metric over values seen (§3.2): `bottom` is drawn at the foot and `top` at the summit, so that improving is
    always going up - for a metric that improves going down the axis is inverted, its labels its real values. The
    natural range, when declared, always fits inside it. */
export function axisOf(metric: ProgressMetric, values: readonly number[]): { bottom: number; top: number; scale: 'linear' | 'log' } {
  const scale = metric.scale ?? 'linear';
  const xs = values.filter((v) => Number.isFinite(v) && (scale === 'linear' || v > 0));
  let lo = metric.range ? metric.range[0] : Math.min(...xs), hi = metric.range ? metric.range[1] : Math.max(...xs);
  if (metric.range && xs.length) { lo = Math.min(lo, ...xs); hi = Math.max(hi, ...xs); }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) { lo = scale === 'log' ? 1 : 0; hi = scale === 'log' ? 10 : 1; }
  if (lo === hi) {
    const pad = scale === 'log' ? lo : Math.abs(lo) * 0.1 || 1;
    lo = scale === 'log' ? lo / 2 : lo - pad; hi = scale === 'log' ? hi * 2 : hi + pad;
  }
  return metric.direction === 'higher' ? { bottom: lo, top: hi, scale } : { bottom: hi, top: lo, scale };
}

/** How high a value is on its axis, 0 at the foot and 1 at the summit. */
export function elevation(axis: { bottom: number; top: number; scale: 'linear' | 'log' }, value: number): number {
  const f = axis.scale === 'log' ? Math.log : (x: number) => x;
  const span = f(axis.top) - f(axis.bottom);
  return span === 0 ? 0 : (f(value) - f(axis.bottom)) / span;
}

/** Whether `a` is better than `b` on a metric. */
export const better = (metric: ProgressMetric, a: number, b: number): boolean => (metric.direction === 'higher' ? a > b : a < b);
