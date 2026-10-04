import fs from 'node:fs';
import path from 'node:path';
import { formulaHash } from '../core/formula.ts';
import type { Formula } from '../core/types.ts';
import { TeamBoard, type BoardEntry } from '../learn/assisted/board.ts';
import { LabError, runLaboratory } from '../runtime/lab-runner.ts';
import { finding as findingOfRun, runStatus, send } from '../runtime/control.ts';
import { LABS } from '../worlds/labs.ts';
import { runAgentOperator } from './agent-operator.ts';
import { rowOf, type BatchOptions, type BatchRun, type BatchRunRow } from './batch.ts';

/* ============================================================================
 * A TEAM (SPEC-INVESTIGACION-PARALELA §5, PB2): several researchers on worlds of one family at
 * once, each a run of its own with its journal, and - when the team exchanges - a board between
 * them. It is a separate, declared condition: it measures the collective system, never one
 * researcher (§1).
 *
 *   members      each with its researcher, its arguments, its boards to explore (each member its
 *                own stretch of the family: E1) and its ROLE, decided above (E5): a first
 *                message to the assisted researcher, from `agent:team`;
 *   window       rounds per window of the board (E4);
 *   exchange     true: the condition "communicated"; false: "independent" (no board; the exam's
 *                ledger is still the team's);
 *   confirmations  blind confirmations the whole team may spend (§5.4);
 *   budget       B in System 2's tokens, in one of two modes that answer different questions (§7.1):
 *                  fixed     exchange and coordination come out of B: (B - coordination) / N each;
 *                  extended  each member has B / N to investigate, and exchange is paid on top.
 *
 * Every member runs at once: a window waits for every member to pass it. A team is resumable:
 * an ended member is not run again, one that was cut is resumed (its reads of the board replayed,
 * its publications found where they were).
 *
 * The report (team@1) is made of the members' findings - success, time, cost - and, apart, the
 * operator's measures of the team (§6), code-observed: duplicated interventions, what followed the
 * reading of a dead end, and how many different models the members held. None goes to any member.
 * ========================================================================== */

export interface TeamMemberDef {
  readonly id: string;
  readonly researcher?: 'unknown-world' | 'assisted';
  /** Its own arguments, after the team's. */
  readonly args?: readonly string[];
  /** Its role, in words: the first message it is given (assisted only). */
  readonly role?: string;
  /** Its boards to explore (default: the team's). */
  readonly explore_places?: number;
  readonly agent?: BatchRun['agent'];
}

export interface TeamDefinition {
  readonly format?: 'team@1';
  readonly id: string;
  readonly lab: string;
  /** What the team stands for, compared only as declared (e.g. "independent", "communicated"). */
  readonly condition: string;
  /** Arguments every member runs with (the world: its seed, its rounds...). */
  readonly args?: readonly string[];
  readonly members: readonly TeamMemberDef[];
  readonly window?: number;
  readonly exchange?: boolean;
  readonly confirmations?: number | null;
  readonly explore_places?: number;
  readonly budget?: { readonly mode: 'fixed' | 'extended'; readonly tokens: number; readonly coordination_tokens?: number; readonly exchange_tokens_per_member?: number };
}

/** How far apart the members' stretches of exploration boards start. */
export const MEMBER_STRETCH = 20;

export interface TeamReport {
  readonly format: 'team@1';
  readonly id: string;
  readonly condition: string;
  readonly definition: TeamDefinition;
  readonly dir: string;
  readonly started: string;
  ended?: string;
  /** Each member's token cap, and how it was reached (§7.1). */
  budget: { readonly mode: string; readonly tokens: number | null; readonly per_member: number | null; readonly spent: number | null; readonly within: boolean | null } | null;
  members: (BatchRunRow & { readonly explore_offset: number })[];
  /** From the members' findings: the team solves when any member's model is accepted. */
  team: { readonly solved: boolean; readonly first: { readonly member: string; readonly round: number | null; readonly seconds: number | null } | null;
    readonly tokens: number | null; readonly jev_calls: number | null; readonly confirmations_spent: number;
    readonly board: { readonly entries: Record<string, number>; readonly reads: number; readonly versions: number } };
  /** OPERATOR ONLY (§6): measures of the team, never shown to a member. */
  audit: TeamAudit | null;
}

export interface TeamAudit {
  /** The same intervention (an act or a replay from the same position of the same board) made by more than one member. */
  readonly duplication: { readonly interventions: number; readonly distinct: number; readonly shared: number; readonly by_shared_key: readonly { readonly key: string; readonly members: readonly string[] }[] };
  /** Each dead end a member opened, and whether it then made an intervention behind it itself. Not repeating it is
      compatible with a saving; it does not show it would have been repeated without reading it. */
  readonly dead_ends: readonly { readonly member: string; readonly entry: string; readonly by: string; readonly round: number; readonly repeated_after: boolean }[];
  /** How many different models the members held after each window (a code-observed proxy: the same model, not the same
      hypothesis - which needs the Judge). */
  readonly models_by_window: readonly { readonly window: number; readonly members: number; readonly distinct: number }[];
  readonly note: string;
}

const readJson = (file: string): any => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const ended = (journal: string): boolean => { if (!fs.existsSync(journal)) return false; const s = runStatus(journal); return s.state === 'ended' && s.stoppedBy !== 'cancelled'; };
const eventsOf = (journal: string | null): Record<string, any>[] => (journal ? readJson(journal)?.events ?? [] : []);

/** The checked definition (a LabError says what is wrong). */
export function checkTeam(def: TeamDefinition): void {
  const ID = /^[a-z0-9][a-z0-9_-]*$/i;
  if (!def.id || !ID.test(def.id)) throw new LabError('a team needs an id (letters, digits, - and _)');
  if (!LABS[def.lab]) throw new LabError('team ' + def.id + ': no laboratory ' + def.lab + ' (' + Object.keys(LABS).join(', ') + ')');
  if (!def.condition) throw new LabError('team ' + def.id + ': which condition does it stand for?');
  const lab = LABS[def.lab];
  if (!lab.teams) throw new LabError('team ' + def.id + ': ' + lab.id + ' cannot be investigated by a team yet (SPEC-INVESTIGACION-PARALELA)');
  /* Boards to explore are a laboratory's own (the grid's): a world without them takes none. */
  const explores = lab.options.some((o) => o.name === 'explore-places');
  if (def.members.length < 1) throw new LabError('team ' + def.id + ': no members');
  const ids = new Set<string>();
  for (const m of def.members) {
    if (!m.id || !/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(m.id) || ids.has(m.id)) throw new LabError('team ' + def.id + ': every member needs an id of its own: ' + JSON.stringify(m.id));
    ids.add(m.id);
    const places = m.explore_places ?? def.explore_places ?? 0;
    if (places && !explores) throw new LabError('team ' + def.id + ', member ' + m.id + ': ' + lab.id + ' has no boards to explore (explore_places)');
    if (places > MEMBER_STRETCH) throw new LabError('team ' + def.id + ', member ' + m.id + ': at most ' + MEMBER_STRETCH + ' boards to explore');
    if (places && m.researcher === 'unknown-world') throw new LabError('team ' + def.id + ', member ' + m.id + ': boards to explore are the assisted researcher\'s');
    if (m.role && m.researcher === 'unknown-world') throw new LabError('team ' + def.id + ', member ' + m.id + ': a role is a message: only the assisted researcher takes it');
    if (def.exchange !== false && m.researcher === 'unknown-world') throw new LabError('team ' + def.id + ', member ' + m.id + ': the board is help; an unknown-world member belongs only to a team without exchange');
  }
  if (def.members.length * MEMBER_STRETCH >= 500) throw new LabError('team ' + def.id + ': at most ' + Math.floor(499 / MEMBER_STRETCH) + ' members');
  const b = def.budget;
  if (b && (!(b.tokens > 0) || !['fixed', 'extended'].includes(b.mode))) throw new LabError('team ' + def.id + ': a budget is { "mode": "fixed" | "extended", "tokens": B }');
  if (b?.mode === 'fixed' && (b.coordination_tokens ?? 0) >= b.tokens) throw new LabError('team ' + def.id + ': coordination cannot take all of a fixed budget');
}

/** Each member's cap in System 2's tokens (§7.1). */
export function perMemberTokens(def: TeamDefinition): number | null {
  const b = def.budget;
  if (!b) return null;
  const n = def.members.length;
  return b.mode === 'fixed' ? Math.floor((b.tokens - (b.coordination_tokens ?? 0)) / n) : Math.floor(b.tokens / n) + (b.exchange_tokens_per_member ?? 0);
}

/** Runs a team (or resumes it): every member at once; then its report. */
export async function runTeam(def: TeamDefinition, options: BatchOptions): Promise<TeamReport> {
  checkTeam(def);
  const dir = options.dir ?? path.join(options.root, 'runs', 'teams', def.id);
  fs.mkdirSync(dir, { recursive: true });
  const board = new TeamBoard(dir, { id: def.id, members: def.members.map((m) => m.id), window: def.window ?? 3, exchange: def.exchange !== false, confirmations: def.confirmations ?? null });
  const file = path.join(dir, 'team-report.json');
  const before: TeamReport | null = readJson(file);
  const latest = new Map<string, string>((before?.members ?? []).filter((r) => r.journal).map((r) => [r.id, r.journal!]));
  const say = options.print ?? (() => {});
  const cap = perMemberTokens(def);
  const report: TeamReport = { format: 'team@1', id: def.id, condition: def.condition, definition: def, dir, started: before?.started ?? new Date().toISOString(),
    budget: null, members: [], team: { solved: false, first: null, tokens: null, jev_calls: null, confirmations_spent: 0, board: { entries: {}, reads: 0, versions: 0 } }, audit: null };
  const rows = new Map<string, BatchRunRow>();
  const asRun = (m: TeamMemberDef): BatchRun => ({ id: m.id, lab: def.lab, condition: def.condition, ...(m.researcher ? { researcher: m.researcher } : {}) });
  const save = (): void => {
    report.members = def.members.map((m, i) => ({ ...(rows.get(m.id) ?? rowOf(asRun(m), latest.get(m.id) ?? null, null)), explore_offset: i * MEMBER_STRETCH }));
    fs.writeFileSync(file, JSON.stringify(report, null, 2));
  };

  const one = async (m: TeamMemberDef, i: number): Promise<void> => {
    const known = latest.get(m.id);
    if (known && ended(known)) { rows.set(m.id, rowOf(asRun(m), known, findingOfRun(known, 'researcher'))); return; }
    const k = known ? (known.match(/\.r(\d+)\.json$/)?.[1] ? Number(known.match(/\.r(\d+)\.json$/)![1]) + 1 : 1) : 0;
    const out = path.join(dir, m.id + (k ? '.r' + k : '') + '.json');
    const researcher = m.researcher ?? 'assisted';
    const places = m.explore_places ?? def.explore_places ?? 0;
    const agents = [...(m.agent ? [m.agent.id + '=message'] : []), ...(m.role ? ['team=message'] : [])];
    const control = [...(cap ? ['--max-tokens', String(cap)] : []), ...(agents.length ? ['--agents', agents.join(';')] : [])];
    const args = known ? ['--resume', known, ...control, '--out', out]
      : [...(def.args ?? []), ...(m.args ?? []), '--researcher', researcher, '--team', dir, '--member', m.id,
        ...(places ? ['--explore-places', String(places), '--explore-offset', String(i * MEMBER_STRETCH)] : []), ...control, '--out', out];
    /* Its role waits in its inbox for its first question (E5: decided above, never on the board). */
    if (!known && m.role) send(out, { kind: 'message', text: m.role, by: 'agent:team' });
    latest.set(m.id, out);
    save();
    say('team ' + def.id + ': ' + m.id + ' ' + (known ? 'resumed' : 'started'));
    const controller = new AbortController();
    const agent = m.agent && options.agentLlm
      ? runAgentOperator({ id: m.agent.id, journal: out, llm: options.agentLlm(m.agent.id), maxOrders: m.agent.max_orders, ...(m.agent.role ? { role: m.agent.role } : {}), ...(m.agent.patience ? { patience: m.agent.patience } : {}), signal: controller.signal, say }) : null;
    try {
      const result = await runLaboratory(LABS[def.lab], { args, root: options.root, llm: options.llmFor?.(m.id) ?? options.llm, ...(options.judge ? { judge: options.judge } : {}),
        ...(options.fetch ? { fetch: options.fetch } : {}), ...(options.signal ? { signal: options.signal } : {}) });
      rows.set(m.id, rowOf(asRun(m), result.journal, result.researcher));
      say('team ' + def.id + ': ' + m.id + ' ' + result.stoppedBy);
    } catch (e) {
      rows.set(m.id, rowOf(asRun(m), out, null, String((e as Error)?.message ?? e)));
      say('team ' + def.id + ': ' + m.id + ' failed: ' + String((e as Error)?.message ?? e));
      /* A member that failed holds no window open. */
      board.end(m.id);
    } finally {
      controller.abort();
      await agent;
      save();
    }
  };
  /* Every member at once: a window waits for every member. */
  await Promise.all(def.members.map((m, i) => one(m, i)));
  save();
  Object.assign(report, teamMeasures(def, board, report.members));
  if (!options.signal?.aborted && report.members.every((r) => r.error || (r.journal && ended(r.journal)))) report.ended = new Date().toISOString();
  save();
  fs.writeFileSync(path.join(dir, 'team.txt'), teamText(report) + '\n');
  return report;
}

/** The team's figures from its members' journals and its board; the audit apart. */
export function teamMeasures(def: TeamDefinition, board: TeamBoard, members: readonly BatchRunRow[]): Pick<TeamReport, 'budget' | 'team' | 'audit'> {
  const journals = new Map(members.filter((r) => r.journal && fs.existsSync(r.journal)).map((r) => [r.id, r.journal!]));
  const findings = new Map([...journals].map(([id, j]) => [id, findingOfRun(j, 'operator')]));
  const sum = (key: string): number | null => { const v = [...findings.values()].map((f) => Number((f.cost.total as Record<string, unknown> | undefined)?.[key])).filter(Number.isFinite); return v.length ? v.reduce((a, b) => a + b, 0) : null; };
  /* The first acceptance: its member, its round, and how long into the member's run (members start together). */
  const firsts = members.filter((r) => r.accepted).map((r) => {
    const check = eventsOf(r.journal).find((e) => e.type === 'check' && e.accepted);
    return { member: r.id, round: r.round, seconds: typeof check?.t === 'number' ? check.t : null };
  }).sort((a, b) => (a.seconds ?? Infinity) - (b.seconds ?? Infinity));
  const entries = board.entries();
  const reads = [...journals.values()].reduce((n, j) => n + eventsOf(j).filter((e) => e.type === 'peer_read').length, 0);
  const versions = fs.existsSync(path.join(board.dir, 'board', 'versions')) ? fs.readdirSync(path.join(board.dir, 'board', 'versions')).length : 0;
  const cap = perMemberTokens(def);
  const spent = sum('llm_tokens');
  return {
    budget: def.budget ? { mode: def.budget.mode, tokens: def.budget.tokens, per_member: cap, spent,
      /* Fixed: within B; extended: within B plus what exchange was given. */
      within: spent === null ? null : spent <= (def.budget.mode === 'fixed' ? def.budget.tokens : def.budget.tokens + (def.budget.exchange_tokens_per_member ?? 0) * def.members.length) } : null,
    team: { solved: firsts.length > 0, first: firsts[0] ?? null, tokens: spent, jev_calls: sum('jev_calls'),
      confirmations_spent: Object.keys(board.examLedger().confirmations).length,
      board: { entries: Object.fromEntries(['result', 'dead_end', 'method'].map((k) => [k, entries.filter((e) => e.kind === k).length])), reads, versions } },
    audit: teamAudit(board, journals, entries)
  };
}

/** OPERATOR ONLY (§6, PB4): what code observes of the team in its members' journals and its board. */
export function teamAudit(board: TeamBoard, journals: ReadonlyMap<string, string>, entries: readonly BoardEntry[]): TeamAudit {
  const interventions = [...journals].flatMap(([member, j]) => eventsOf(j).filter((e) => e.type === 'operator_interventions')
    .flatMap((e) => (e.interventions as { key: string }[]).map((x) => ({ member, round: e.round as number, key: x.key }))));
  const byKey = new Map<string, Set<string>>();
  for (const x of interventions) byKey.set(x.key, (byKey.get(x.key) ?? new Set()).add(x.member));
  const shared = [...byKey].filter(([, ms]) => ms.size > 1);
  /* Each dead end a member opened: did it then make an intervention behind it itself? */
  const kinds = new Map(entries.map((e) => [e.id, e]));
  const deadEnds: TeamAudit['dead_ends'][number][] = [];
  for (const [member, j] of journals) {
    for (const e of eventsOf(j).filter((x) => x.type === 'peer_read' && x.peers === 'open' && Array.isArray(x.items))) {
      for (const id of e.items as string[]) {
        const entry = kinds.get(id);
        if (!entry || entry.kind !== 'dead_end' || entry.member === member || deadEnds.some((d) => d.member === member && d.entry === id)) continue;
        const keys = new Set(((board.operatorOf(id)?.keys ?? []) as string[]));
        const repeated = interventions.some((x) => x.member === member && x.round >= e.round && keys.has(x.key));
        deadEnds.push({ member, entry: id, by: entry.member, round: e.round, repeated_after: repeated });
      }
    }
  }
  /* The model each member held at the end of each window. */
  const window = board.spec.window;
  /* A proposal's model: a formula (the grid) or a law with its print (a world of laws). */
  const models = new Map([...journals].map(([member, j]) => [member, eventsOf(j).filter((e) => e.type === 'proposal' && (e.formula || e.fingerprint))
    .map((e) => ({ round: e.round as number, fp: e.formula ? formulaHash(e.formula as Formula) : String(e.fingerprint) }))]));
  const lastWindow = Math.max(0, ...[...models.values()].flatMap((ps) => ps.map((p) => Math.ceil(p.round / window))));
  const modelsByWindow = Array.from({ length: lastWindow }, (_, k) => {
    const held = [...models.values()].map((ps) => ps.filter((p) => p.round <= (k + 1) * window).at(-1)?.fp).filter((x): x is string => !!x);
    return { window: k + 1, members: held.length, distinct: new Set(held).size };
  });
  return {
    duplication: { interventions: interventions.length, distinct: byKey.size, shared: shared.length, by_shared_key: shared.map(([key, ms]) => ({ key, members: [...ms] })) },
    dead_ends: deadEnds, models_by_window: modelsByWindow,
    note: 'Code-observed. A dead end read and not repeated is compatible with a saving; it does not show the member would have repeated it. The same model is not the same hypothesis: convergence of hypotheses needs the Judge (pending).'
  };
}

/** A team in a few lines, for a person. */
export function teamText(r: TeamReport): string {
  const t = r.team;
  return ['team ' + r.id + ' [' + r.condition + ']' + (r.ended ? ' (ended ' + r.ended + ')' : ' (running)'),
    '  ' + (t.solved ? 'SOLVED by ' + t.first!.member + ' in round ' + t.first!.round + (t.first!.seconds !== null ? ' (' + t.first!.seconds + ' s)' : '') : 'not solved')
      + '; tokens ' + (t.tokens ?? '-') + '; Jev calls ' + (t.jev_calls ?? '-') + '; blind confirmations spent ' + t.confirmations_spent,
    ...(r.budget ? ['  budget ' + r.budget.mode + ' ' + r.budget.tokens + ' (' + r.budget.per_member + ' per member): spent ' + (r.budget.spent ?? '-') + (r.budget.within === false ? ' - OVER' : '')] : []),
    '  board: ' + Object.entries(t.board.entries).map(([k, n]) => n + ' ' + k).join(', ') + '; ' + t.board.reads + ' read(s); ' + t.board.versions + ' version(s)',
    ...r.members.map((m) => '    ' + m.id + ': ' + m.status + (m.round !== null ? ' in round ' + m.round : '') + (m.error ? ' - ' + m.error : '')),
    ...(r.audit ? ['  AUDIT (operator only): ' + r.audit.duplication.shared + ' intervention(s) made by more than one member of ' + r.audit.duplication.distinct
      + '; dead ends read ' + r.audit.dead_ends.length + ' (repeated after ' + r.audit.dead_ends.filter((d) => d.repeated_after).length + ')'
      + '; distinct models by window ' + (r.audit.models_by_window.map((w) => w.distinct + '/' + w.members).join(' ') || '-')] : [])].join('\n');
}
