import fs from 'node:fs';
import { parseJsonLoose } from '../core/net.ts';
import type { ChatClient } from '../learn/system2.ts';
import { orderOutcome, runStatus, send } from '../runtime/control.ts';
import { researcherEvents, runDigest } from './view.ts';
import { followUpDue, journalReader, juniorBrief, stuckSignals, type StuckSignals } from './reader.ts';
import { UserParts } from '../learn/system2.ts';

/* ============================================================================
 * The AGENT OPERATOR (SPEC-ORQUESTADOR §3, R1): an agent that follows an assisted run and does
 * what a person would - waits, writes to the researcher, or stops the run - through the same
 * control API (Q1). It reads the run only as its researcher lived it (`runDigest`, Q2): never
 * the hidden part, never the operator's measures, never what the world is. Each decision is
 * kept with its reason in a journal of its own (<run>.agent-<id>.json, Q5), and each order goes
 * with its author, `agent:<id>`: the run accepts it only if its policy (--agents) allows it.
 * ========================================================================== */

export const AGENT_OPERATOR_SYSTEM = [
  'You are an AGENT that assists a researcher. The researcher is an AI investigating an environment nobody has described to it: it writes models, the environment checks them and says whether they hold in each place, and it experiments, notes, and reflects.',
  'You see what the researcher did and what the environment told it - never more than it knows. You know nothing about the environment either, and you cannot know the right answer.',
  'Your role is a colleague looking over its shoulder. Most of the time, wait. Intervene only when it seems stuck: several rounds of variants of the same kind of model with no place starting to hold; an experiment it planned and did not run; alternatives it wrote down and never tested; the same investigation repeated.',
  'When you intervene, give the smallest push that could work. First, hold up its own untested ideas (quote them, with their round). Only if that did not help, ask a question whose answer would tell its rival ideas apart. Never state facts about the environment beyond what its own results show, and never tell it what the answer is. Your message is a colleague\'s suggestion, and it may be wrong.',
  'Do not repeat a push it has just received: give it a round or two to act on it. You may stop the run if it only spends without learning, if you are allowed to.',
  'Answer ONE JSON object: {"decision": "wait" | "message" | "stop", "text": "<the message, for message>", "why": "<your reason, for the record>"}'
].join('\n');

/** The SENIOR (SPEC-ORQUESTADOR §3.3): a researcher with a more capable model that reviews a junior's record when it is
    stuck and proposes a hypothesis the junior's own data suggest. Its prompt is the junior's own brief (the common
    prompt and the world's interface, `juniorBrief`) between its role and its instructions as a reviewer: the same
    method, another capability. */
export const SENIOR_HEAD = [
  'You are a SENIOR RESEARCH SCIENTIST reviewing the work of a junior researcher: an AI that investigates an environment nobody has described to it. Below, word for word, is the brief the junior works under - its persona, its method, its instruments and this environment\'s interface. That method is yours as well: apply it, with all your capability, to the junior\'s record.',
  'The difference between you is what each can do. The junior acts on the environment and proposes models. You act on nothing: you read the junior\'s record and advise it. Where the brief says "you", read "the junior"; where it describes how to answer, that is the junior\'s answer, not yours - yours is described after the brief.'
].join('\n');

export const SENIOR_ROLE = [
  'YOUR ROLE AS SENIOR.',
  'You see exactly what the junior saw and did - its notes, beliefs, methods and models, every request it made with what the environment answered, the verdicts of its checks, its episodes and their scores - never more. You know nothing about the environment beyond that record, and you cannot know the right answer.',
  'YOUR TASK is the junior\'s task: to understand this environment. You are a researcher in your own right, and the junior\'s record is your data - its episodes, the answers to its experiments, the verdicts of its checks. Do not only review its work and polish how it operates: investigate that record yourself, with your own method and greater capability. Look across all its episodes for correlations it never considered, regularities that hold in every case, and tactics its data reveal; and form NEW hypotheses of your own - rival theories it never entertained - rather than refinements of its current model.',
  'Put first what the environment IS: what it allows and refuses, how episodes end and with what score. A model built on rules that the record confirms beats any tuned heuristic; adjusting the weights or features of the junior\'s model is worth a message only once those rules are clear. A hypothesis about the rules is worth more than a fix to its model.',
  'You are called because the junior shows signs of being stuck (`signals`). Review its record as a demanding senior would. Read its notes and the answers it got, and look for what it has not interpreted: a regularity in the answers it did not connect; a fact it recorded and did not build on; a clue it dismissed or held as "only an association"; an alternative it wrote down and never tested; a reading that its own data contradict.',
  'Your instruments read the junior\'s record only (they ask nothing of the environment): {"investigate": [{"memory": "list", "of": "beliefs" | "notes" | "methods" | "episodes" | "models" | "reflections" | "investigations" | "checks"}, {"memory": "open", "items": ["<id>", ...]}, {"memory": "find", "words": "...", "of": "<kind>" (optional)}]}. Ids: "belief:<id>", "note:<id>", "method:<id>", "episode:<episode>", "model:r<round>", "reflection:r<round>", "investigation:r<round>.<step>" (a request and what it was answered), "check:r<round>". Each of your reading answers comes back, with what it read, as a part of its own (`investigation_step`), and `steps_left` says how many such answers you have; `memory` how many items of each kind there are. A large item comes clipped (its beginning and its size): add \"whole\": true to the open request to read it entire.',
  'You may be called at the end of one of its rounds, or during a round (`during_round`), when it keeps looking without testing anything or keeps asking to investigate with no steps left: your message then reaches it within that round, before it answers again. Then help it commit: point to the hypothesis its own record supports best and tell it to propose a model that tests it now - a model that fails also teaches.',
  'You may also be called to FOLLOW UP (`follow_up`): after your last message the junior ran an experiment; `follow_up` holds your message and that experiment as its record keeps it - what it asked and what it was answered. Read it there: a follow-up allows you one reading of the record at most, since the experiment is already in front of you. If the junior\'s own results confirm the hypothesis, with no counterexample in its record, tell it plainly: its data confirm it (cite them); adopt it as a working rule in its beliefs, and propose now a model built on it. If they refute it, say so, so that it drops it. If they are inconclusive, wait. A follow-up that would only propose another small adjustment of the junior\'s model is rarely worth a message: look instead for what the record still says about the environment.',
  'Finding a rule is not enough: a junior often states a rule its record supports and never builds it into its model, which keeps scoring on other features. So with a hypothesis, guide how its model would use it once confirmed, in the form the environment asks for - which points the rule makes worth the least or the most, what an observation would have to measure, what the model should stop relying on. And when its record already confirms a rule its model does not use, say so plainly and show how the model would use it. Never write the model\'s code: the junior builds it, and treats your guidance as a reference to test, like everything you say.',
  'Then decide. If you found something, write to the junior: ONE hypothesis to explore, stated as a hypothesis; the evidence in its own record that suggests it (cite items and points, e.g. "investigation:r4.2", "g26@4"); ONE experiment with its instruments that would test it; and how its model would use the hypothesis once the experiment confirms it. Never state as a fact anything its record does not show, and never hand it a complete solution: it must test the idea and build the model itself. Your message is a colleague\'s suggestion, and it may be wrong. If you found nothing worth its attention, wait.',
  'Answer ONE JSON object: {"investigate": [ ...requests ]} while you read, then {"decision": "wait" | "message", "text": "<the message, for message>", "evidence": ["<the items you rely on>"], "why": "<your reason, for the record>"}'
].join('\n');

/** The senior's system prompt: its role, the junior's brief word for word (when its world is known here), its instructions. */
export const seniorSystem = (brief: string | null): string =>
  brief ? SENIOR_HEAD + '\n\n=== THE JUNIOR\'S BRIEF ===\n\n' + brief + '\n\n=== END OF THE JUNIOR\'S BRIEF ===\n\n' + SENIOR_ROLE : SENIOR_HEAD + '\n\n' + SENIOR_ROLE;

export type AgentRole = 'coach' | 'senior';

export interface AgentDecision {
  readonly at: string;
  /** How many rounds the run had when the agent decided. */
  readonly rounds: number;
  readonly decision: 'wait' | 'message' | 'stop' | 'error';
  readonly text?: string;
  readonly why?: string;
  readonly order?: string;
  outcome?: string;
  /** The senior's: the signs it was called for, what it read of the junior's record, and the items its message relies on. */
  readonly signals?: readonly string[];
  readonly read?: readonly unknown[];
  readonly evidence?: readonly string[];
  /** The round in course when the senior was called during it (not at its end). */
  readonly during_round?: number;
  /** How many times it was reminded to decide after asking to read with no readings left. */
  readonly reminded?: number;
  /** A follow-up of its message: the junior's experiment it read (an item of the junior's record). */
  readonly follow_up?: string;
  /** What the decision cost: its calls to the model, their tokens (in, of them cached, out) and the provider's cost when it
      reports one (OpenRouter: `usage.cost`). */
  readonly usage?: Usage;
}

export interface Usage { calls: number; tokens_in: number; cached_in: number; tokens_out: number; cost: number }

/** Adds an answer's usage, as an OpenAI-compatible endpoint reports it, to a decision's. */
function addUsage(u: Usage, raw: unknown): void {
  const r = (raw ?? {}) as { usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number; prompt_tokens_details?: { cached_tokens?: number } } };
  u.calls++;
  u.tokens_in += r.usage?.prompt_tokens ?? 0;
  u.cached_in += r.usage?.prompt_tokens_details?.cached_tokens ?? 0;
  u.tokens_out += r.usage?.completion_tokens ?? 0;
  u.cost = Math.round((u.cost + (r.usage?.cost ?? 0)) * 1e6) / 1e6;
}

export interface AgentOperatorOptions {
  readonly id: string;
  /** The run it follows (its journal). */
  readonly journal: string;
  /** Its LLM (the caller wraps it with a replay log when it should be resumable). */
  readonly llm: ChatClient;
  /** At most this many orders in all (default 6). */
  readonly maxOrders?: number;
  readonly pollMs?: number;
  readonly signal?: AbortSignal;
  readonly say?: (line: string) => void;
  /** coach (default): a colleague who waits and gives the smallest push. senior: called only when the run shows signs of
      being stuck; it reads the junior's record and proposes a hypothesis its data suggest. */
  readonly role?: AgentRole;
  /** The senior: checks in a row holding nowhere before it is a sign (default 3); answers reading the record (default 4);
      rounds to leave the junior after a message before it may be called again (default 2); answers of a round only looking
      (no experiment) before it is a sign (default 3). */
  readonly patience?: number;
  readonly looking?: number;
  readonly readSteps?: number;
  readonly cooldown?: number;
  /** The senior: rounds of the run given in full in each call (default 3); the rest of the record is there to read. */
  readonly digestRounds?: number;
  /** The senior: items of the junior's record larger than this many characters are opened clipped (default 4000). */
  readonly openLimit?: number;
}

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

const readJson = (file: string): any => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

/** The agent's journal next to the run's. */
export const agentFile = (journal: string, id: string): string => journal.replace(/\.json$/, '') + '.agent-' + id + '.json';

/** Follows a run until it ends (or the signal aborts): after each round it completes, the agent decides. */
export async function runAgentOperator(o: AgentOperatorOptions): Promise<{ decisions: AgentDecision[]; file: string }> {
  const file = agentFile(o.journal, o.id);
  const role: AgentRole = o.role ?? 'coach';
  const record = { format: 'agent@1', agent: 'agent:' + o.id, role, run: o.journal, started: new Date().toISOString(), decisions: [] as AgentDecision[] };
  const save = () => fs.writeFileSync(file, JSON.stringify(record, null, 2));
  save();
  const say = o.say ?? (() => {});
  let seenRounds = -1, orders = 0;
  /* The senior is also called during a round, once per round, when a sign is about the round in course. */
  const calledInRound = new Set<number>();
  /* Each of its messages is followed up once: when the junior, having got it, runs an experiment. */
  const followedUp = new Set<number>();
  const maxOrders = o.maxOrders ?? 6;
  while (!o.signal?.aborted) {
    const status = fs.existsSync(o.journal) ? runStatus(o.journal) : null;
    const journal = readJson(o.journal);
    const digest = journal ? runDigest(journal) : null;
    /* Rounds it has completed: checked, or reflected on. */
    const rounds = journal ? researcherEvents(journal).filter((e) => e.type === 'check' || e.type === 'reflection').length : 0;
    /* A reflection is how a run ends: after it nothing more is asked of the researcher, so a message would never reach it
       (and would spend the run's help budget). A continuation that goes on after one is decided on at its next check. */
    const lastCompleted = journal ? [...researcherEvents(journal)].reverse().find((e) => e.type === 'check' || e.type === 'reflection') : undefined;
    const ended = status?.state === 'ended' || status?.state === 'interrupted';
    const over = ended || lastCompleted?.type === 'reflection';
    /* The senior, during a round: a sign about the round in course (it only looks, or insists with no steps left). */
    const now = role === 'senior' && journal ? stuckSignals(journal, o.patience ?? 3, o.looking ?? 3) : null;
    const duringRound = Boolean(now?.in_round && !calledInRound.has(now.current_round));
    /* The senior, following up its message: the junior got it and has run an experiment since. */
    const due = role === 'senior' && journal ? followUpDue(journal, o.id) : null;
    const followUp = due && !followedUp.has(due.message) ? due : null;
    /* A round completed since it last decided, or (the senior) a sign within the round (and the run still going): decide. */
    if (digest && ((rounds > seenRounds && rounds > 0) || duringRound || followUp) && !over && orders < maxOrders) {
      if (followUp) followedUp.add(followUp.message);
      else if (duringRound) calledInRound.add(now!.current_round);
      /* A round completed (not the run's start, before any round): otherwise it is called during the round in course. */
      const completed = rounds > seenRounds && rounds > 0;
      seenRounds = Math.max(seenRounds, rounds);
      let d: AgentDecision | null;
      if (role === 'senior') d = await seniorDecides(o, journal, digest, rounds, record.decisions, maxOrders - orders, !completed && duringRound ? now!.current_round : null, followUp);
      else try {
        const answer = await o.llm.complete({ system: AGENT_OPERATOR_SYSTEM, user: { you_are: 'agent:' + o.id, run: digest, your_decisions: record.decisions.slice(-8), orders_left: maxOrders - orders } });
        const parsed = (parseJsonLoose(answer.content) ?? {}) as { decision?: string; text?: string; why?: string };
        const decision = parsed.decision === 'message' && parsed.text?.trim() ? 'message' : parsed.decision === 'stop' ? 'stop' : 'wait';
        d = { at: new Date().toISOString(), rounds, decision, ...(decision === 'message' ? { text: String(parsed.text).trim() } : {}), why: String(parsed.why ?? '') };
      } catch (e) {
        d = { at: new Date().toISOString(), rounds, decision: 'error', why: String((e as Error)?.message ?? e) };
      }
      if (d && (d.decision === 'message' || d.decision === 'stop')) {
        const { id } = send(o.journal, d.decision === 'message' ? { kind: 'message', text: d.text!, by: 'agent:' + o.id } : { kind: 'stop', by: 'agent:' + o.id });
        (d as { order?: string }).order = id;
        orders++;
        say('agent:' + o.id + ' after ' + rounds + ' rounds: ' + d.decision + (d.text ? ' - ' + d.text.slice(0, 120) : ''));
      } else if (d) {
        /* A wait or an error is said too: an agent that cannot reach its model must not look like one that is waiting. */
        say('agent:' + o.id + ' after ' + rounds + ' rounds: ' + d.decision + (d.why ? ' - ' + d.why.slice(0, 160) : '') + (d.signals?.length ? ' [signals: ' + d.signals.join('; ') + ']' : ''));
      }
      if (d) record.decisions.push(d);
      /* What it has cost so far, added up from its decisions (what its model's endpoint reported). */
      if (d?.usage) {
        const t = ((record as { usage?: Usage }).usage ??= { calls: 0, tokens_in: 0, cached_in: 0, tokens_out: 0, cost: 0 });
        t.calls += d.usage.calls; t.tokens_in += d.usage.tokens_in; t.cached_in += d.usage.cached_in; t.tokens_out += d.usage.tokens_out;
        t.cost = Math.round((t.cost + d.usage.cost) * 1e6) / 1e6;
      }
      save();
    }
    /* What the run made of its orders. */
    for (const d of record.decisions) if (d.order && (!d.outcome || d.outcome === 'pending')) {
      const out = orderOutcome(o.journal, d.order);
      d.outcome = out.state + (out.reason ? ': ' + out.reason : '');
    }
    save();
    if (ended) break;
    await sleep(o.pollMs ?? 2000, o.signal);
  }
  return { decisions: record.decisions, file };
}

/** The senior's turn: nothing unless the run shows signs of being stuck (and it has left the junior time since its last
    message); then it reads the junior's record and decides. Null: it was not called (nothing is recorded). */
async function seniorDecides(o: AgentOperatorOptions, journal: Record<string, any>, _digest: unknown, rounds: number, decisions: readonly AgentDecision[], ordersLeft: number,
  duringRound: number | null = null, followUp: ReturnType<typeof followUpDue> = null): Promise<AgentDecision | null> {
  const signals: StuckSignals = stuckSignals(journal, o.patience ?? 3, o.looking ?? 3);
  /* A follow-up is called for by the junior's experiment, not by a sign; anything else waits for a sign and for the junior
     to have had time with its last message. */
  if (!followUp && (!signals.signs.length || waitingOnMessage(journal, o.id, o.cooldown ?? 2))) return null;
  const reader = journalReader(journal, { openLimit: o.openLimit ?? 4000 });
  const system = seniorSystem(juniorBrief(journal));
  const usage: Usage = { calls: 0, tokens_in: 0, cached_in: 0, tokens_out: 0, cost: 0 };
  /* A follow-up brings the experiment it is about, as the junior's record keeps it: it is decided in one call, as a rule. */
  const experiment = followUp ? ((await reader.run({ memory: 'open', items: [followUp.experiment] })) as { items?: { item?: unknown }[] }).items?.[0]?.item ?? null : null;
  /* The run in its latest rounds only: the rest of the record is there to read. */
  const brief = runDigest(journal, { rounds: o.digestRounds ?? 3 });
  const read: { step: number; requests: Record<string, unknown>[]; results: unknown[] }[] = [];
  const at = () => new Date().toISOString();
  /* A follow-up has the junior's experiment in front of it: one reading at most. A decision on a sign, `readSteps`. */
  const limit = followUp ? 1 : o.readSteps ?? 4;
  const asked = () => read.map((r) => r.requests);
  /* Its conversation only grows: the first part with the readings it may make, then each reading (or reminder) after. */
  const tail: Record<string, unknown>[] = [];
  let reminded = 0;
  try {
    for (let turn = 0; turn <= limit + 3; turn++) {
      const stepsLeft = Math.max(0, limit - read.length);
      const context = { you_are: 'agent:' + o.id, signals: signals.signs, ...(duringRound !== null ? { during_round: duringRound } : {}),
        ...(followUp ? { follow_up: { your_message: followUp.text, experiment: followUp.experiment, in_round: followUp.round, ...(experiment ? { its_record: experiment } : {}) } } : {}),
        run: brief, memory: reader.counts(), your_decisions: decisions.slice(-6), orders_left: ordersLeft };
      const answer = await o.llm.complete({ system, user: new UserParts([{ ...context, steps_left: limit }, ...tail]) });
      addUsage(usage, answer.raw);
      const parsed = (parseJsonLoose(answer.content) ?? {}) as { investigate?: unknown[]; decision?: string; text?: string; why?: string; evidence?: unknown[] };
      if (Array.isArray(parsed.investigate) && stepsLeft > 0) {
        const requests = parsed.investigate.filter((q): q is Record<string, unknown> => Boolean(q) && typeof q === 'object' && typeof (q as Record<string, unknown>).memory === 'string').slice(0, 8);
        const results: unknown[] = [];
        for (const q of requests) results.push(await reader.run(q));
        read.push({ step: read.length + 1, requests, results });
        tail.push({ investigation_step: read[read.length - 1], steps_left: Math.max(0, limit - read.length) });
        continue;
      }
      /* It asks to read again with no readings left: no error - it is reminded what its part is, and asked once more. */
      if (Array.isArray(parsed.investigate) && reminded < 2) {
        reminded++;
        tail.push({ steps_left: 0, reminder: 'You have no readings left. Your part is not to do the junior\'s work: decide now. Write to the junior the hypothesis it should go on with, or the task it should carry on (with the evidence in its record and one experiment), or wait if there is nothing worth its attention.' });
        continue;
      }
      const decision = parsed.decision === 'message' && parsed.text?.trim() ? 'message' : 'wait';
      return { at: at(), rounds, ...(duringRound !== null ? { during_round: duringRound } : {}), ...(followUp ? { follow_up: followUp.experiment } : {}), decision, ...(decision === 'message' ? { text: String(parsed.text).trim() } : {}),
        why: String(parsed.why ?? (Array.isArray(parsed.investigate) ? 'it kept asking to read after being reminded to decide' : '')), signals: signals.signs,
        read: asked(), ...(Array.isArray(parsed.evidence) ? { evidence: parsed.evidence.map(String) } : {}), ...(reminded ? { reminded } : {}), usage };
    }
    return { at: at(), rounds, decision: 'wait', why: 'it kept reading and never decided', signals: signals.signs, read: asked(), usage };
  } catch (e) {
    return { at: at(), rounds, decision: 'error', why: String((e as Error)?.message ?? e), signals: signals.signs, usage };
  }
}

/** Whether the junior is still to act on the senior's latest message: not delivered yet (it reaches the junior with its
    next question), or delivered fewer than `cooldown` checks ago. Counted from when the junior got it, not from when it
    was sent: a message sent during a long answer arrives a round later. */
export function waitingOnMessage(journal: Record<string, any>, id: string, cooldown: number): boolean {
  const events = (Array.isArray(journal?.events) ? journal.events : []) as Record<string, any>[];
  const by = 'agent:' + id;
  const sent = events.filter((e) => e.type === 'operator_command' && e.by === by && e.accepted).length;
  const delivered = events.map((e, i) => ({ e, i })).filter(({ e }) => e.type === 'operator_message' && (e.messages ?? []).some((m: { by?: string }) => m.by === by));
  if (sent > delivered.length) return true;
  if (!delivered.length) return false;
  const at = delivered[delivered.length - 1].i;
  return events.slice(at + 1).filter((e) => e.type === 'check').length < cooldown;
}
