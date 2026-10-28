import { Observer } from '../../core/observer.ts';
import { Evaluator } from '../../core/evaluate.ts';
import { Predictor, checkLaw, type Law } from '../../core/predict.ts';
import { hashString, stableStringify } from '../../core/hash.ts';
import type { CodeRunner, CodeSpec, Judge, MeasureDecl, Rule, World } from '../../core/types.ts';
import { researcherEvents } from '../../orchestra/view.ts';
import { stuckSignals } from '../../orchestra/reader.ts';
import type { OperatorMessage } from './session.ts';

/* ============================================================================
 * A RESEARCH POLICY (SPEC-METAPOLITICA-INVESTIGACION, M1): a legible, executable procedure that orients a researcher
 * from its own course - before its next question, it advises one of three kinds of work (develop, contrast, reframe) or
 * keeps silent. It is a model like any other of the harness: observations in code over an authorized view of the
 * course, rules the Judge answers (typed decisions, never free text), and a composition in code that decides. The advice
 * is assembled from its versioned templates and values it computed: nothing is generated freely when it is used.
 *
 * What it reads is a capture of the researcher's view up to a cut of its journal - never the operator's raw journal,
 * never what came after. What it gives is advice from `agent:research-policy`, a notice in the researcher's channel:
 * never a directive, never an act in the world, a check, a closed round, a branch. Each piece of advice is help, paid once
 * when it is published; keeping silent costs nothing. Every decision is recorded with its capture and the Judge's answers,
 * so that it is rebuilt without the Judge, and a run resumed neither asks again nor pays twice.
 * ========================================================================== */

type J = Record<string, any>;

export const POLICY_FORMAT = 'research-policy@1';
export const VIEW_CONTRACT = 'research-view@1';
export const FOCI = ['develop', 'contrast', 'reframe'] as const;
export type Focus = typeof FOCI[number];

export interface PolicyTemplate {
  /** The advice's words, with {{name}} where an argument goes. */
  readonly text: string;
  /** The arguments it takes: nothing else is put into its words. */
  readonly arguments?: readonly string[];
}

/** The artifact (§3): what runs, and where it came from. */
export interface ResearchPolicy {
  readonly format: typeof POLICY_FORMAT;
  /** What the Judge is told the "world" is: the course of an investigation, as the policy reads it. */
  readonly about?: string;
  readonly contract: typeof VIEW_CONTRACT;
  readonly observations: Readonly<Record<string, MeasureDecl>>;
  readonly rules?: Readonly<Record<string, Rule>>;
  /** Weights over the rules, as a model's (default: equal). */
  readonly weights?: Readonly<Record<string, number>>;
  /** `(p, m) => ({ guidance, state })`: p is the capture, with `p.state` the policy's own state; m its observations and
      the Judge's answers. */
  readonly composition: CodeSpec;
  /** Its private state at the start of each run. */
  readonly state?: unknown;
  readonly templates: Readonly<Record<string, PolicyTemplate>>;
  /** Where it came from - parents, the reason of each change, the experience it used, domain knowledge declared. Not part
      of what runs: its hash leaves it out. */
  readonly provenance?: Readonly<Record<string, unknown>>;
}

export type Guidance =
  | { readonly kind: 'abstain'; readonly reason: string }
  | { readonly kind: 'advise'; readonly focus: Focus; readonly template: string; readonly arguments: Readonly<Record<string, string | number | boolean>>;
      /** Ids present in the capture. */
      readonly evidence: readonly string[];
      /** Rules it used: judgments, not evidence of the world. */
      readonly judgments: readonly string[] };

/** The configuration of a run (§5): the policy, how its capture is made, and its limits. */
export interface PolicyConfig {
  readonly policy: ResearchPolicy;
  readonly context?: { readonly events?: number; readonly text?: number };
  readonly limits?: { readonly evaluations?: number; readonly advice?: number; readonly judge_calls?: number; readonly state_bytes?: number };
}

const DEFAULT_CONTEXT = { events: 60, text: 600 };
const DEFAULT_LIMITS = { evaluations: 200, advice: 20, judge_calls: 200, state_bytes: 4000 };

/** What runs - everything but its provenance: its identity. */
export function policyHash(p: ResearchPolicy): string {
  const { provenance: _p, ...runs } = p;
  return hashString(stableStringify(runs));
}

export const asksJudge = (p: ResearchPolicy): boolean => Object.keys(p.rules ?? {}).length > 0;

/** A policy as a model of the harness: its observations, rules and weights, and its composition as the output. */
function lawOf(p: ResearchPolicy): Law {
  const rules = p.rules ?? {};
  const ids = Object.keys(rules);
  const weights = p.weights ?? Object.fromEntries(ids.map((id) => [id, 1 / ids.length]));
  return { world: 'research@1', observations: p.observations, rules, weights, output: p.composition };
}

/** Whether a policy holds to its contract before anything runs (§3): its format, its parts, its templates. */
export function checkPolicy(p: unknown): string[] {
  const errors: string[] = [];
  const o = p && typeof p === 'object' ? p as J : null;
  if (!o) return ['a research policy is a JSON object'];
  if (o.format !== POLICY_FORMAT) errors.push('"format" is "' + POLICY_FORMAT + '"');
  if (o.contract !== VIEW_CONTRACT) errors.push('"contract" is "' + VIEW_CONTRACT + '": the view it reads');
  if (!o.observations || typeof o.observations !== 'object') errors.push('"observations": an object (it may be empty)');
  if (!o.composition || o.composition.kind !== 'code' || typeof o.composition.source !== 'string') errors.push('"composition": {"kind": "code", "lang": "js", "source": "(p, m) => ({ guidance, state })"}');
  if (!o.templates || typeof o.templates !== 'object' || !Object.keys(o.templates).length) errors.push('"templates": at least one, {"<id>": {"text": "...{{arg}}...", "arguments": ["arg"]}}');
  for (const [id, t] of Object.entries((o.templates ?? {}) as J)) {
    if (!t || typeof t.text !== 'string' || !t.text.trim()) { errors.push('template "' + id + '" has a "text"'); continue; }
    const args = new Set<string>(Array.isArray(t.arguments) ? t.arguments : []);
    for (const m of t.text.matchAll(/\{\{(\w+)\}\}/g)) if (!args.has(m[1])) errors.push('template "' + id + '" uses {{' + m[1] + '}} but does not declare it in "arguments"');
  }
  try { JSON.stringify(o.state ?? null); } catch { errors.push('"state" is JSON'); }
  if (!errors.length) {
    const law = lawOf(o as ResearchPolicy);
    const c = checkLaw(law);
    errors.push(...c.errors);
  }
  return errors;
}

/* --- What it observes (§4) ------------------------------------------------------------------------------------------- */

export interface Capture {
  readonly contract: typeof VIEW_CONTRACT;
  /** How many events of the journal it was taken after. */
  readonly cut: number;
  readonly question: number;
  /** The researcher's view of its events, the latest within the context's window, each with its id ("e<index>"). */
  readonly events: readonly J[];
  /** What the window left out, and what was clipped: an absence here is not an absence in the course. */
  readonly omitted: { readonly events: number; readonly first_kept: string | null };
  readonly truncated: readonly string[];
  /** Facts of its course computed on this view (stuckSignals), never their interpretation. */
  readonly facts: J | null;
  /** The advice it gave before, as delivered, and what the researcher wrote of it is in its events. */
  readonly guidance: readonly J[];
  /** What it may still spend: its own limits, and the run's help. */
  readonly resources: J;
  /** The policy's own state. */
  readonly state: unknown;
}

const clip = (v: unknown, n: number, where: string, truncated: string[]): unknown => {
  const text = typeof v === 'string' ? v : JSON.stringify(v ?? null);
  if (text.length <= n) return v;
  truncated.push(where);
  return text.slice(0, n) + '…';
};

/** The capture of the researcher's view up to a cut (§4): its events as it lived them - what it wrote, asked and was answered
    (whether each request ran, was refused or failed), the verdicts it was told, the help delivered to it - within a window
    of the latest, clipped, with what was left out said. Never an event after the cut, never what it was not given. */
export function captureView(journalEvents: readonly J[], cut: number, o: { question: number; context?: PolicyConfig['context']; guidance: readonly J[]; resources: J; state: unknown }): Capture {
  const context = { ...DEFAULT_CONTEXT, ...(o.context ?? {}) };
  const truncated: string[] = [];
  const seen: J[] = [];
  journalEvents.slice(0, cut).forEach((e, i) => {
    const [v] = researcherEvents({ events: [e] });
    if (!v) return;
    const id = 'e' + i;
    const out: J = { id, ...v };
    /* What its requests were answered: whether each ran, was refused or failed, and what came, clipped. */
    if (e.type === 'investigation' && Array.isArray(e.results)) out.results = e.results.map((r: J, k: number) => {
      const status = r && typeof r === 'object' ? (r.error ? 'error' : r.refused ? 'refused' : 'ok') : 'ok';
      return { status, answer: clip(r, context.text, id + '.results[' + k + ']', truncated) };
    });
    for (const k of ['rationale', 'notes', 'text']) if (typeof out[k] === 'string') out[k] = clip(out[k], context.text, id + '.' + k, truncated);
    seen.push(out);
  });
  const events = seen.slice(-context.events);
  let facts: J | null = null;
  try { facts = stuckSignals({ events: seen }) as unknown as J; } catch { facts = null; }
  return { contract: VIEW_CONTRACT, cut, question: o.question, events, omitted: { events: seen.length - events.length, first_kept: events[0]?.id ?? null },
    truncated, facts, guidance: o.guidance, resources: o.resources, state: o.state };
}

/* --- How it decides (§3) ---------------------------------------------------------------------------------------------- */

const WORLD: World<Capture> = {
  id: 'research@1', actors: ['policy'], initial: () => { throw new Error('no initial capture'); }, toMove: () => 'policy', actions: () => [], step: (s) => s,
  outcome: () => ({ over: false, winner: null, reason: null }), key: (s) => hashString(stableStringify(s)), view: () => ({ entities: [], scalars: {} }),
  describeRules: () => '', actionKey: () => ''
};

export type DecisionFailure = 'no_context' | 'judge_failed' | 'invalid_output' | 'limit';
export interface Decision {
  readonly guidance: Guidance | null;
  readonly state: unknown;
  readonly observations: Readonly<Record<string, number | string>>;
  /** The Judge's answers, by rule. */
  readonly rules: Readonly<Record<string, number>>;
  readonly judge_calls: number;
  readonly failure?: DecisionFailure;
  readonly why?: string;
}

/** Whether a composition's result holds to the contract (§3): a guidance of its kinds, a template it has with the arguments
    it declares, evidence that is in the capture, judgments that are its rules, and a state within its limit. */
export function validateResult(p: ResearchPolicy, capture: Capture, out: unknown, stateBytes: number): { guidance: Guidance; state: unknown } | string {
  /* What came out of its sandbox, as plain JSON of this side: nothing of the sandbox's own objects travels on. */
  let plain: unknown;
  try { plain = JSON.parse(JSON.stringify(out ?? null)); } catch { return 'the composition answers JSON'; }
  const o = plain && typeof plain === 'object' ? plain as J : null;
  if (!o || !o.guidance || typeof o.guidance !== 'object') return 'the composition answers { guidance, state }';
  const g = o.guidance as J;
  let state: unknown;
  try { state = o.state === undefined ? capture.state : JSON.parse(JSON.stringify(o.state)); } catch { return 'its state is JSON'; }
  if (JSON.stringify(state ?? null).length > stateBytes) return 'its state is over ' + stateBytes + ' bytes';
  if (g.kind === 'abstain') return typeof g.reason === 'string' && g.reason.trim() ? { guidance: { kind: 'abstain', reason: g.reason }, state } : 'an abstention says its "reason"';
  if (g.kind !== 'advise') return 'a guidance is "abstain" or "advise"';
  if (!FOCI.includes(g.focus)) return 'its "focus" is one of ' + FOCI.join(', ');
  const t = p.templates[g.template];
  if (!t) return 'no template "' + g.template + '"';
  const args = g.arguments && typeof g.arguments === 'object' ? g.arguments as J : {};
  const declared = new Set(t.arguments ?? []);
  for (const [k, v] of Object.entries(args)) {
    if (!declared.has(k)) return 'template "' + g.template + '" takes no argument "' + k + '"';
    if (!['string', 'number', 'boolean'].includes(typeof v)) return 'argument "' + k + '" is a string, a number or a boolean';
  }
  for (const k of declared) if (!(k in args)) return 'template "' + g.template + '" needs its argument "' + k + '"';
  const ids = new Set([...capture.events.map((e) => e.id), ...capture.guidance.map((x) => x.id)]);
  const evidence = Array.isArray(g.evidence) ? g.evidence.map(String) : [];
  const bad = evidence.filter((id) => !ids.has(id));
  if (bad.length) return 'evidence not in its capture: ' + bad.join(', ');
  const judgments = Array.isArray(g.judgments) ? g.judgments.map(String) : [];
  const rules = new Set(Object.keys(p.rules ?? {}));
  const noRule = judgments.filter((id) => !rules.has(id));
  if (noRule.length) return 'judgments that are not its rules: ' + noRule.join(', ');
  return { guidance: { kind: 'advise', focus: g.focus, template: g.template, arguments: args as Record<string, string | number | boolean>, evidence, judgments }, state };
}

/** The advice in words: its template with its arguments, nothing else. */
export function renderGuidance(p: ResearchPolicy, g: Extract<Guidance, { kind: 'advise' }>): string {
  return p.templates[g.template].text.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => String(g.arguments[k]));
}

/** Decides at a capture: its observations, the Judge's answers to its rules, its composition - validated. A Judge that
    fails, or leaves a rule unanswered, is a failure of the evaluation, never a neutral answer. */
export async function decide(p: ResearchPolicy, capture: Capture, judge: Judge, o: { runner: CodeRunner; stateBytes?: number; judgeCalls?: number; cache?: Map<string, unknown> }): Promise<Decision> {
  if (!capture.events.length) return { guidance: null, state: capture.state, observations: {}, rules: {}, judge_calls: 0, failure: 'no_context', why: 'nothing of its course in the capture yet' };
  let calls = 0, judgeError: string | null = null;
  const counted: Judge = { id: judge.id, async judge(request, signal) {
    if (calls >= (o.judgeCalls ?? Infinity)) throw new Error('its Judge calls are spent');
    calls++;
    try { return await judge.judge(request, signal); } catch (e) { judgeError = String((e as Error).message ?? e); throw e; }
  } };
  const world = { ...WORLD, describeRules: () => p.about ?? 'The course of an investigation, as its researcher lived it, up to now; the measurements are facts of that course.' };
  const observer = new Observer<Capture>(world, { kinds: ['code'], core: false, runners: [o.runner], perceive: (s) => s });
  const evaluator = new Evaluator<Capture>(observer, counted, { runners: [o.runner], ...(o.cache ? { cache: o.cache as never } : {}) });
  const predictor = new Predictor<Capture>(evaluator, (s) => s, { runners: [o.runner] });
  let prediction;
  try { prediction = await predictor.predict(lawOf(p), capture, { askRules: true }); }
  catch (e) {
    const why = String((e as Error).message ?? e);
    return { guidance: null, state: capture.state, observations: {}, rules: {}, judge_calls: calls, failure: judgeError || /Judge calls are spent/.test(why) ? (/spent/.test(why) ? 'limit' : 'judge_failed') : 'invalid_output', why };
  }
  const rules = Object.fromEntries(Object.entries(prediction.rules).filter(([, v]) => typeof v === 'number')) as Record<string, number>;
  if (prediction.evaluation?.fallbacks.length) return { guidance: null, state: capture.state, observations: prediction.observations, rules, judge_calls: calls, failure: 'judge_failed', why: 'the Judge left unanswered: ' + prediction.evaluation.fallbacks.join(', ') };
  const valid = validateResult(p, capture, prediction.answer, o.stateBytes ?? DEFAULT_LIMITS.state_bytes);
  if (typeof valid === 'string') return { guidance: null, state: capture.state, observations: prediction.observations, rules, judge_calls: calls, failure: 'invalid_output', why: valid };
  return { guidance: valid.guidance, state: valid.state, observations: prediction.observations, rules, judge_calls: calls };
}

/** A decision rebuilt from its record (§11): its capture and the Judge's recorded answers, through its composition again -
    no Judge, no inference. */
export function rebuildDecision(p: ResearchPolicy, capture: Capture, rules: Readonly<Record<string, number>>, runner: CodeRunner, stateBytes = DEFAULT_LIMITS.state_bytes): { guidance: Guidance; state: unknown } | string {
  const world = { ...WORLD };
  const observer = new Observer<Capture>(world, { kinds: ['code'], core: false, runners: [runner], perceive: (s) => s });
  const never: Judge = { id: 'none', judge: async () => { throw new Error('a rebuilt decision asks no Judge'); } };
  const predictor = new Predictor<Capture>(new Evaluator<Capture>(observer, never, { runners: [runner] }), (s) => s, { runners: [runner] });
  try {
    const law = lawOf(p);
    const m = predictor.measured(law, capture);
    return validateResult(p, capture, predictor.rawAnswerWith(law, m, rules), stateBytes);
  } catch (e) { return String((e as Error).message ?? e); }
}

/* --- Before each question (§5, §11) ------------------------------------------------------------------------------------ */

export interface PolicyHost {
  /** The run's journal events as they are now (the cut is taken from them). */
  events(): readonly J[];
  log(type: string, data: J): void;
  judge: Judge;
  runner: CodeRunner;
  /** Help left in the run (null: no budget), and paying one delivery. */
  helpLeft(): number | null;
  spendHelp(): void;
  /** The journal it resumes, if any: its decisions are used again, never asked again. */
  previous?: readonly J[];
}

/** The policy of a run: before each question, a decision at a cut, recorded, then its advice delivered once. */
export class PolicyRunner {
  readonly hash: string;
  private state: unknown;
  private evaluations = 0;
  private advised = 0;
  private judgeCalls = 0;
  private readonly guidance: J[] = [];
  private readonly cache = new Map<string, unknown>();
  private readonly limits: Required<NonNullable<PolicyConfig['limits']>>;
  /** What the run it resumes decided, by question. */
  private readonly before = new Map<number, { requested?: J; decided?: J; delivered?: J }>();

  readonly config: PolicyConfig;
  private readonly host: PolicyHost;

  constructor(config: PolicyConfig, host: PolicyHost) {
    this.config = config;
    this.host = host;
    this.hash = policyHash(config.policy);
    this.state = config.policy.state ?? null;
    this.limits = { ...DEFAULT_LIMITS, ...(config.limits ?? {}) } as Required<NonNullable<PolicyConfig['limits']>>;
    for (const e of host.previous ?? []) {
      if (!String(e.type).startsWith('research_policy_') || typeof e.question !== 'number') continue;
      const b = this.before.get(e.question) ?? {};
      if (e.type === 'research_policy_requested') b.requested = e;
      if (e.type === 'research_policy_decided') b.decided = e;
      if (e.type === 'research_policy_delivered') b.delivered = e;
      this.before.set(e.question, b);
    }
  }

  /** The help it already delivered in the run it resumes: counted against the run's help. */
  static delivered(events: readonly J[]): number { return events.filter((e) => e.type === 'research_policy_delivered' && e.message).length; }

  /** Before question `question`: its advice to deliver now, or null. `live`: whether the run asks live (not replaying its
      history - a decision then would change what the replayed conversation asked). `recorded`: its advice as the run it
      resumes delivered it at this question. */
  async advise(question: number, live: boolean, recorded?: OperatorMessage): Promise<OperatorMessage | null> {
    const id = 'rp-q' + question;
    const prior = this.before.get(question);
    if (prior?.decided) return this.restore(question, id, prior, recorded);
    if (!live) return null;
    const events = this.host.events();
    const cut = events.length;
    const left = this.host.helpLeft();
    const resources = { evaluations_left: this.limits.evaluations - this.evaluations, advice_left: this.limits.advice - this.advised,
      judge_calls_left: this.limits.judge_calls - this.judgeCalls, help_left: left };
    const capture = captureView(events, cut, { question, context: this.config.context, guidance: [...this.guidance], resources, state: this.state });
    this.host.log('research_policy_requested', { id, question, policy: this.hash, cut, capture, state_before: this.state,
      reserve: { judge_calls: Math.min(this.limits.judge_calls - this.judgeCalls, Object.keys(this.config.policy.rules ?? {}).length) } });
    /* Nothing left to give: no inference that could not be delivered. */
    const spent = this.evaluations >= this.limits.evaluations ? 'its evaluations' : this.advised >= this.limits.advice ? 'its advice' : left !== null && left <= 0 ? 'the run\'s help'
      : this.judgeCalls >= this.limits.judge_calls && Object.keys(this.config.policy.rules ?? {}).length ? 'its Judge calls' : null;
    let d: Decision;
    if (spent) d = { guidance: null, state: this.state, observations: {}, rules: {}, judge_calls: 0, failure: 'limit', why: spent + ' are spent' };
    else {
      this.evaluations++;
      d = await decide(this.config.policy, capture, this.host.judge, { runner: this.host.runner, stateBytes: this.limits.state_bytes, judgeCalls: this.limits.judge_calls - this.judgeCalls, cache: this.cache });
      this.judgeCalls += d.judge_calls;
    }
    this.host.log('research_policy_decided', { id, question, observations: d.observations, rules: d.rules, judge_calls: d.judge_calls,
      ...(d.failure ? { failure: d.failure, why: d.why } : { guidance: d.guidance, state: d.state }) });
    if (d.failure || !d.guidance) { this.host.log('research_policy_delivered', { id, question, reason: d.failure ?? 'no guidance' }); return null; }
    this.state = d.state;
    /* What came meanwhile (other than its own record) makes its capture old: not given as current advice. */
    const now = this.host.events().slice(cut).filter((e) => !String(e.type).startsWith('research_policy_'));
    if (now.length) { this.host.log('research_policy_delivered', { id, question, reason: 'stale', newer: now.map((e) => e.type) }); return null; }
    return this.deliver(question, id, d.guidance);
  }

  private deliver(question: number, id: string, g: Guidance): OperatorMessage | null {
    if (g.kind === 'abstain') { this.host.log('research_policy_delivered', { id, question, reason: 'abstained' }); return null; }
    const text = renderGuidance(this.config.policy, g);
    const message: OperatorMessage & J = { id: 'research-policy:' + id, text, by: 'agent:research-policy', at: new Date().toISOString(),
      advice: { policy: this.hash, decision: id, focus: g.focus, template: g.template, evidence: g.evidence, judgments: g.judgments } };
    this.host.spendHelp();
    this.advised++;
    this.guidance.push({ id: message.id, question, focus: g.focus, template: g.template, text, evidence: g.evidence });
    this.host.log('research_policy_delivered', { id, question, message: message.id });
    return message;
  }

  /** A question the run it resumes decided at: its record again, as it was (a resumed run writes its history again word for
      word), its state again, its advice delivered only if it was not - no Judge, no second payment. */
  private restore(question: number, id: string, prior: { requested?: J; decided?: J; delivered?: J }, recorded?: OperatorMessage): OperatorMessage | null {
    const d = prior.decided!;
    if (prior.requested) this.host.log('research_policy_requested', strip(prior.requested));
    this.host.log('research_policy_decided', strip(d));
    this.evaluations += d.failure === 'limit' ? 0 : 1;
    this.judgeCalls += Number(d.judge_calls) || 0;
    if (d.failure || !d.guidance) { if (prior.delivered) this.host.log('research_policy_delivered', strip(prior.delivered)); return null; }
    this.state = d.state;
    if (prior.delivered) {
      this.host.log('research_policy_delivered', strip(prior.delivered));
      if (prior.delivered.message) {
        /* Delivered then: given again as it was, at the same question - counted, never paid again. */
        this.advised++;
        const g = d.guidance as Extract<Guidance, { kind: 'advise' }>;
        this.guidance.push({ id: prior.delivered.message, question, focus: g.focus, template: g.template, text: renderGuidance(this.config.policy, g), evidence: g.evidence });
        return recorded && recorded.id === prior.delivered.message ? recorded : null;
      }
      return null;
    }
    /* Decided, never delivered (the run stopped in between): delivered now, paid now. */
    return this.deliver(question, id, d.guidance as Guidance);
  }
}

const strip = (e: J): J => { const { t: _t, type: _type, ...rest } = e; return rest; };

/** A run's policy configuration, read from its file (§5): a policy alone, or { policy, context, limits } with the policy
    inline or in a file beside it. What does not hold is said before anything is spent. */
export function readPolicyConfig(text: string, readBeside: (file: string) => string): PolicyConfig {
  let raw: J;
  try { raw = JSON.parse(text); } catch { throw new Error('not JSON'); }
  const config: J = raw && raw.format === POLICY_FORMAT ? { policy: raw } : raw;
  if (!config || typeof config !== 'object') throw new Error('a policy, or {"policy": ..., "context": ..., "limits": ...}');
  if (typeof config.policy === 'string') {
    try { config.policy = JSON.parse(readBeside(config.policy)); } catch (e) { throw new Error('its policy "' + config.policy + '": ' + String((e as Error).message ?? e)); }
  }
  const errors = checkPolicy(config.policy);
  if (errors.length) throw new Error(errors.join('; '));
  for (const [k, v] of Object.entries({ ...(config.context ?? {}), ...(config.limits ?? {}) })) if (!(Number.isInteger(v) && (v as number) > 0)) throw new Error('"' + k + '" is a whole number above 0');
  return { policy: config.policy, ...(config.context ? { context: config.context } : {}), ...(config.limits ? { limits: config.limits } : {}) };
}

/** What identifies a run's policy in its configuration (the generator's identity): what runs, how it reads, its limits, and
    whether it asks the Judge. */
export function policySummary(c: PolicyConfig): J {
  return { hash: policyHash(c.policy), contract: c.policy.contract, judge: asksJudge(c.policy), context: { ...DEFAULT_CONTEXT, ...(c.context ?? {}) }, limits: { ...DEFAULT_LIMITS, ...(c.limits ?? {}) } };
}

/** A run's policy decisions rebuilt from its journal (§11): each from its recorded capture and the Judge's recorded
    answers, through its composition again - no Judge, no inference, nothing run in the world. Its identity checked too. */
export function verifyPolicyDecisions(journal: J, runner: CodeRunner): { holds: boolean; decisions: number; rebuilt: number; problems: string[] } | null {
  const c = journal?.research_policy as PolicyConfig | undefined;
  if (!c) return null;
  const problems: string[] = [];
  if (journal.config?.research_policy?.hash !== policyHash(c.policy)) problems.push('the policy kept is not the one its configuration names');
  const events = (journal.events ?? []) as J[];
  const decided = events.filter((e) => e.type === 'research_policy_decided' && e.guidance);
  let rebuilt = 0;
  for (const d of decided) {
    const req = events.find((e) => e.type === 'research_policy_requested' && e.id === d.id);
    if (!req) { problems.push(d.id + ': no capture recorded'); continue; }
    const again = rebuildDecision(c.policy, req.capture, d.rules ?? {}, runner, { ...DEFAULT_LIMITS, ...(c.limits ?? {}) }.state_bytes);
    if (typeof again === 'string') problems.push(d.id + ': ' + again);
    else if (stableStringify(again) !== stableStringify({ guidance: d.guidance, state: d.state })) problems.push(d.id + ': rebuilt to another decision');
    else rebuilt++;
  }
  return { holds: !problems.length, decisions: decided.length, rebuilt, problems };
}
