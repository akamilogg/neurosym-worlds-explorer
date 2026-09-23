/* Deterministic identity. The algorithms are byte-for-byte the harness's (FNV-1a, key-sorted JSON),
   so a hash printed by the harness and one printed by the library can be compared by eye. The one
   deliberate difference: an `undefined` property is skipped (the harness printed "undefined"); values
   that came from JSON never carry one, so their hashes are identical. */

export function hashString(input: string): string {
  let h = 2166136261;
  const text = String(input);
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(36);
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter((k) => record[k] !== undefined).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(record[k])).join(',') + '}';
}

export function specHash(spec: unknown): string {
  return hashString(stableStringify(spec === undefined ? null : spec));
}

/** A copy of plain JSON data. Deliberately not structuredClone: some hosts (sandboxes, older runtimes) lack it. */
export function cloneJson<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as object)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

/** Identical to the harness's round (the EPSILON nudge makes 0.1235 round up the way a reader expects). */
export function round(value: number, digits: number): number {
  const f = Math.pow(10, Number.isFinite(digits) ? digits : 4);
  return Math.round((Number(value) + Number.EPSILON) * f) / f;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
