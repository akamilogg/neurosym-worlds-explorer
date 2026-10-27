import { isGameLab, type AnyLab } from '../learn/lab.ts';
import type { ActorDecl, SessionLimits } from './world.ts';
import type { ResearcherDecl, SessionPlan } from './run-session.ts';

/* ============================================================================
 * A `living-world@1` MANIFEST (SPEC-ACONTECIMIENTOS-DEL-MUNDO §16): the session as the operator declares it - its
 * adapter, its clock, its limits, its members - checked whole before any inference is spent. Nothing is unlimited by
 * default: a limit not given is an error, never infinity. What the harness does not build yet (a clock in real time) is
 * refused, said so, never replaced by something else.
 *
 *   {
 *     "format": "living-world@1",
 *     "adapter": "plates@1",
 *     "seed": 1,
 *     "clock": { "mode": "simulated", "decision_interval": 3, "horizon": 600 },
 *     "limits": { "calls_per_window": 4, "intents_per_window": 4,
 *                 "messages_per_window": 2, "message_chars": 600, "delivery_per_decision": 8, "window_ms": 600000 },
 *     "actors": [ { "id": "a", "kind": "researcher", "rounds": 10, "steps": 6, "acts": 4 },
 *                 { "id": "b", "kind": "researcher", "rounds": 10, "steps": 6, "acts": 4 },
 *                 { "id": "rival", "kind": "adversary", "policy": "adversary", "actions": ["drain"] } ]
 *   }
 *
 * One researcher alone, without messages: a run of its own (its session is its run's). Anything more: a shared session.
 * ========================================================================== */

const FIELDS = ['format', 'adapter', 'seed', 'clock', 'limits', 'actors', 'explore', 'check_episodes', 'flat'];
const CLOCK = ['mode', 'decision_interval', 'horizon'];
const LIMITS = ['calls_per_window', 'intents_per_window', 'actors', 'messages_per_window', 'message_chars', 'delivery_per_decision', 'window_ms'];
const RESEARCHER = ['id', 'kind', 'rounds', 'steps', 'acts', 'max_tokens', 'max_minutes', 'actions', 'history'];
const OTHER = ['id', 'kind', 'policy', 'params', 'actions', 'history'];
const KINDS = ['researcher', 'policy', 'adversary', 'population'];

const whole = (x: unknown, min = 1): x is number => typeof x === 'number' && Number.isInteger(x) && x >= min;
const extra = (o: Record<string, unknown>, fields: readonly string[], what: string): string[] =>
  Object.keys(o).filter((k) => !fields.includes(k)).map((k) => what + ' has no field "' + k + '" (its fields: ' + fields.join(', ') + ')');

export type ReadManifest = { lab: string; plan: SessionPlan; flat: boolean; /** One researcher alone, without messages: a run's arguments. */ args: string[] | null; actor: string };

/** A manifest read: the laboratory it runs, its plan, and - for one researcher alone - the run's arguments; or every reason
    it is refused. */
export function readManifest(raw: unknown, labs: Readonly<Record<string, AnyLab>>): ReadManifest | { errors: string[] } {
  const m = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
  if (!m) return { errors: ['a manifest is a JSON object'] };
  const errors = extra(m, FIELDS, 'the manifest');
  if (m.format !== 'living-world@1') errors.push('"format" is "living-world@1"');
  const entry = Object.entries(labs).find(([, l]) => l.id === m.adapter);
  const living = entry && !isGameLab(entry[1]) ? entry[1].living ?? null : null;
  if (!entry) errors.push('"adapter": no world ' + JSON.stringify(m.adapter) + ' (the living ones: ' + Object.values(labs).filter((l) => !isGameLab(l) && l.living).map((l) => l.id).join(', ') + ')');
  else if (!living) errors.push('"adapter": ' + entry[1].id + ' is not a living world');
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
  if (!limits) errors.push('"limits" is { "calls_per_window", "intents_per_window", ... }: nothing is unlimited by default');
  else {
    errors.push(...extra(limits, LIMITS, '"limits"'));
    for (const k of ['calls_per_window', 'intents_per_window']) if (!whole(limits[k])) errors.push('"limits.' + k + '" is a whole number, at least 1');
    for (const k of ['actors', 'messages_per_window', 'message_chars', 'delivery_per_decision', 'window_ms']) if (limits[k] !== undefined && !whole(limits[k])) errors.push('"limits.' + k + '" is a whole number, at least 1');
    if ((limits.messages_per_window === undefined) !== (limits.message_chars === undefined)) errors.push('"limits.messages_per_window" and "limits.message_chars" go together: messages, and how long one may be');
  }
  const actors = Array.isArray(m.actors) ? m.actors.map((a) => (a && typeof a === 'object' && !Array.isArray(a) ? a as Record<string, unknown> : null)) : null;
  if (!actors?.length) errors.push('"actors": the members, at least one researcher');
  const kinds = new Set(Object.keys(living?.adapter.policies ?? {}));
  const actions = living?.adapter.actions.map((a) => a.kind) ?? [];
  for (const [i, a] of (actors ?? []).entries()) {
    const at = 'actor ' + (typeof a?.id === 'string' ? '"' + a.id + '"' : '#' + i);
    if (!a) { errors.push(at + ' is an object'); continue; }
    if (typeof a.id !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(a.id)) errors.push(at + ' has an "id": letters, digits, "_" and "-", starting with a letter');
    if (!KINDS.includes(String(a.kind))) { errors.push(at + ': "kind" is one of ' + KINDS.join(', ')); continue; }
    errors.push(...extra(a, a.kind === 'researcher' ? RESEARCHER : OTHER, at));
    if (a.actions !== undefined && !(Array.isArray(a.actions) && a.actions.every((x) => actions.includes(String(x))))) errors.push(at + ': "actions" are some of the world\'s: ' + actions.join(', '));
    if (a.history !== undefined && typeof a.history !== 'boolean') errors.push(at + ': "history" is true or false');
    if (a.kind === 'researcher') {
      for (const k of ['rounds', 'steps', 'acts']) if (!whole(a[k])) errors.push(at + ': "' + k + '" is a whole number, at least 1');
      for (const k of ['max_tokens', 'max_minutes']) if (a[k] !== undefined && !(typeof a[k] === 'number' && (a[k] as number) > 0)) errors.push(at + ': "' + k + '" is a number above 0');
    } else {
      if (!kinds.has(String(a.policy))) errors.push(at + ': "policy" is one of the world\'s: ' + [...kinds].join(', '));
      if (a.params !== undefined && (typeof a.params !== 'object' || Array.isArray(a.params))) errors.push(at + ': "params" is an object');
      if (!Array.isArray(a.actions)) errors.push(at + ': its "actions" are given explicitly');
    }
  }
  const ids = (actors ?? []).map((a) => a?.id);
  if (new Set(ids).size !== ids.length) errors.push('"actors": two members with the same id');
  const researchers = (actors ?? []).filter((a) => a?.kind === 'researcher');
  if (actors?.length && !researchers.length) errors.push('"actors": at least one researcher');
  if (researchers.length > 1 && limits && limits.window_ms === undefined) errors.push('"limits.window_ms": with more than one researcher, how long a window waits for them');
  if (limits && whole(limits.actors) && actors && (limits.actors as number) < actors.length) errors.push('"limits.actors": less than the members declared');
  for (const k of ['explore', 'check_episodes']) if (m[k] !== undefined && !whole(m[k], k === 'explore' ? 0 : 1)) errors.push('"' + k + '" is a whole number');
  if (m.flat !== undefined && typeof m.flat !== 'boolean') errors.push('"flat" is true or false');
  if (errors.length) return { errors };
  const c = clock!, l = limits!;
  const plan: SessionPlan = {
    seed: m.seed as number, clock: { decision_interval: c.decision_interval as number, horizon: c.horizon as number }, limits: l as unknown as SessionLimits,
    actors: actors!.map((a) => a as unknown as ResearcherDecl | ActorDecl),
    ...(m.explore !== undefined ? { explore: m.explore as number } : {}), ...(m.check_episodes !== undefined ? { check_episodes: m.check_episodes as number } : {})
  };
  const alone = researchers.length === 1 && actors!.length === 1 && l.messages_per_window === undefined ? researchers[0]! : null;
  return {
    lab: entry![0], plan, flat: m.flat === true, actor: String(researchers[0]!.id),
    args: alone ? ['--researcher', 'assisted', '--seed', String(m.seed), '--interval', String(c.decision_interval), '--horizon', String(c.horizon),
      '--window-calls', String(l.calls_per_window), '--window-intents', String(l.intents_per_window),
      '--attempts', String(alone.rounds), '--steps', String(alone.steps), '--acts', String(alone.acts),
      /* Its identity and its permissions, as declared: never the world's defaults in their place. */
      '--actor', String(alone.id), ...(Array.isArray(alone.actions) ? ['--actions', alone.actions.length ? alone.actions.map(String).join(',') : 'none'] : []),
      ...(alone.max_tokens !== undefined ? ['--max-tokens', String(alone.max_tokens)] : []), ...(alone.max_minutes !== undefined ? ['--max-minutes', String(alone.max_minutes)] : []),
      ...(m.explore !== undefined ? ['--explore', String(m.explore)] : []), ...(m.check_episodes !== undefined ? ['--check-episodes', String(m.check_episodes)] : []),
      ...(m.flat === true ? ['--flat'] : [])] : null
  };
}
