import { isGameLab, type AnyLab } from '../learn/lab.ts';

/* ============================================================================
 * A `living-world@1` MANIFEST (SPEC-ACONTECIMIENTOS-DEL-MUNDO §16): the session as the operator declares it - its
 * adapter, its clock, its limits, its actors - checked whole before any inference is spent. Nothing is unlimited by
 * default: a limit not given is an error, never infinity. What the harness does not build yet (other actors, a clock in
 * real time) is refused, said so, never replaced by something else.
 *
 *   {
 *     "format": "living-world@1",
 *     "adapter": "plates@1",
 *     "seed": 1,
 *     "clock": { "mode": "simulated", "decision_interval": 3, "horizon": 600 },
 *     "limits": { "calls_per_window": 4, "intents_per_window": 4 },
 *     "actors": [ { "id": "researcher", "kind": "researcher", "rounds": 10, "steps": 6, "acts": 4 } ]
 *   }
 * ========================================================================== */

const FIELDS = ['format', 'adapter', 'seed', 'clock', 'limits', 'actors', 'explore', 'check_episodes'];
const CLOCK = ['mode', 'decision_interval', 'horizon'];
const LIMITS = ['calls_per_window', 'intents_per_window'];
const ACTOR = ['id', 'kind', 'rounds', 'steps', 'acts', 'max_tokens', 'max_minutes'];

const whole = (x: unknown, min = 1): x is number => typeof x === 'number' && Number.isInteger(x) && x >= min;
const extra = (o: Record<string, unknown>, fields: readonly string[], what: string): string[] =>
  Object.keys(o).filter((k) => !fields.includes(k)).map((k) => what + ' has no field "' + k + '" (its fields: ' + fields.join(', ') + ')');

/** A manifest read: the laboratory it runs and the run's arguments; or every reason it is refused. */
export function readManifest(raw: unknown, labs: Readonly<Record<string, AnyLab>>): { lab: string; args: string[]; actor: string } | { errors: string[] } {
  const m = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
  if (!m) return { errors: ['a manifest is a JSON object'] };
  const errors = extra(m, FIELDS, 'the manifest');
  if (m.format !== 'living-world@1') errors.push('"format" is "living-world@1"');
  const entry = Object.entries(labs).find(([, l]) => l.id === m.adapter);
  if (!entry) errors.push('"adapter": no world ' + JSON.stringify(m.adapter) + ' (the living ones: ' + Object.values(labs).filter((l) => !isGameLab(l) && l.living).map((l) => l.id).join(', ') + ')');
  else if (isGameLab(entry[1]) || !entry[1].living) errors.push('"adapter": ' + entry[1].id + ' is not a living world');
  if (!whole(m.seed, 0)) errors.push('"seed" is a whole number');
  const clock = m.clock && typeof m.clock === 'object' ? m.clock as Record<string, unknown> : null;
  if (!clock) errors.push('"clock" is { "mode", "decision_interval", "horizon" }');
  else {
    errors.push(...extra(clock, CLOCK, '"clock"'));
    if (clock.mode !== 'simulated') errors.push('"clock.mode": only "simulated" is built (a clock in real time, §5.2, is not)');
    if (!whole(clock.decision_interval)) errors.push('"clock.decision_interval" is a whole number of ticks, at least 1');
    if (!whole(clock.horizon)) errors.push('"clock.horizon" is a whole number of ticks, at least 1: a world never ends only when someone said so');
  }
  const limits = m.limits && typeof m.limits === 'object' ? m.limits as Record<string, unknown> : null;
  if (!limits) errors.push('"limits" is { "calls_per_window", "intents_per_window" }: nothing is unlimited by default');
  else {
    errors.push(...extra(limits, LIMITS, '"limits"'));
    for (const k of LIMITS) if (!whole(limits[k])) errors.push('"limits.' + k + '" is a whole number, at least 1');
  }
  const actors = Array.isArray(m.actors) ? m.actors as Record<string, unknown>[] : null;
  if (!actors || actors.length !== 1) errors.push('"actors": one researcher (other actors, and more researchers, are not built yet: §4)');
  const a = actors?.[0] && typeof actors[0] === 'object' ? actors[0] : null;
  if (actors?.length === 1 && !a) errors.push('"actors[0]" is an object');
  if (a) {
    errors.push(...extra(a, ACTOR, 'the actor'));
    if (a.kind !== 'researcher') errors.push('the actor\'s "kind" is "researcher" (other kinds are not built yet: §4)');
    if (typeof a.id !== 'string' || !a.id.trim()) errors.push('the actor has an "id"');
    for (const k of ['rounds', 'steps', 'acts']) if (!whole(a[k])) errors.push('the actor\'s "' + k + '" is a whole number, at least 1');
    for (const k of ['max_tokens', 'max_minutes']) if (a[k] !== undefined && !(typeof a[k] === 'number' && (a[k] as number) > 0)) errors.push('the actor\'s "' + k + '" is a number above 0');
  }
  for (const k of ['explore', 'check_episodes']) if (m[k] !== undefined && !whole(m[k], k === 'explore' ? 0 : 1)) errors.push('"' + k + '" is a whole number');
  if (errors.length) return { errors };
  const c = clock!, l = limits!, r = a!;
  return {
    lab: entry![0], actor: String(r.id),
    args: ['--researcher', 'assisted', '--seed', String(m.seed), '--interval', String(c.decision_interval), '--horizon', String(c.horizon),
      '--window-calls', String(l.calls_per_window), '--window-intents', String(l.intents_per_window),
      '--attempts', String(r.rounds), '--steps', String(r.steps), '--acts', String(r.acts),
      ...(r.max_tokens !== undefined ? ['--max-tokens', String(r.max_tokens)] : []), ...(r.max_minutes !== undefined ? ['--max-minutes', String(r.max_minutes)] : []),
      ...(m.explore !== undefined ? ['--explore', String(m.explore)] : []), ...(m.check_episodes !== undefined ? ['--check-episodes', String(m.check_episodes)] : [])]
  };
}
