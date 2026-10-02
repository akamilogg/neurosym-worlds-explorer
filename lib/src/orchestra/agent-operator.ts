import fs from 'node:fs';
import { parseJsonLoose } from '../core/net.ts';
import type { ChatClient } from '../learn/system2.ts';
import { orderOutcome, runStatus, send } from '../runtime/control.ts';
import { researcherEvents, runDigest } from './view.ts';
import { journalReader, juniorBrief, stuckSignals, type StuckSignals } from './reader.ts';

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
  'You are called because the junior shows signs of being stuck (`signals`). Review its record as a demanding senior would. Read its notes and the answers it got, and look for what it has not interpreted: a regularity in the answers it did not connect; a fact it recorded and did not build on; a clue it dismissed or held as "only an association"; an alternative it wrote down and never tested; a reading that its own data contradict.',
  'Your instruments read the junior\'s record only (they ask nothing of the environment): {"investigate": [{"memory": "list", "of": "beliefs" | "notes" | "methods" | "episodes" | "models" | "reflections" | "investigations" | "checks"}, {"memory": "open", "items": ["<id>", ...]}, {"memory": "find", "words": "...", "of": "<kind>" (optional)}]}. Ids: "belief:<id>", "note:<id>", "method:<id>", "episode:<episode>", "model:r<round>", "reflection:r<round>", "investigation:r<round>.<step>" (a request and what it was answered), "check:r<round>". `steps_left` says how many such answers you have; `memory` how many items of each kind there are.',
  'Then decide. If you found something, write to the junior: ONE hypothesis to explore, stated as a hypothesis; the evidence in its own record that suggests it (cite items and points, e.g. "investigation:r4.2", "g26@4"); and ONE experiment with its instruments that would test it. Never state as a fact anything its record does not show, and never hand it a complete solution: it must test the idea and build the model itself. Your message is a colleague\'s suggestion, and it may be wrong. If you found nothing worth its attention, wait.',
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
      rounds to leave the junior after a message before it may be called again (default 2). */
  readonly patience?: number;
  readonly readSteps?: number;
  readonly cooldown?: number;
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
  const maxOrders = o.maxOrders ?? 6;
  while (!o.signal?.aborted) {
    const status = fs.existsSync(o.journal) ? runStatus(o.journal) : null;
    const journal = readJson(o.journal);
    const digest = journal ? runDigest(journal) : null;
    /* Rounds it has completed: checked, or reflected on. */
    const rounds = journal ? researcherEvents(journal).filter((e) => e.type === 'check' || e.type === 'reflection').length : 0;
    const over = status?.state === 'ended' || status?.state === 'interrupted';
    /* A round completed since it last decided (and the run still going): decide. */
    if (digest && rounds > seenRounds && rounds > 0 && !over && orders < maxOrders) {
      seenRounds = rounds;
      let d: AgentDecision | null;
      if (role === 'senior') d = await seniorDecides(o, journal, digest, rounds, record.decisions, maxOrders - orders);
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
      save();
    }
    /* What the run made of its orders. */
    for (const d of record.decisions) if (d.order && (!d.outcome || d.outcome === 'pending')) {
      const out = orderOutcome(o.journal, d.order);
      d.outcome = out.state + (out.reason ? ': ' + out.reason : '');
    }
    save();
    if (over) break;
    await sleep(o.pollMs ?? 2000, o.signal);
  }
  return { decisions: record.decisions, file };
}

/** The senior's turn: nothing unless the run shows signs of being stuck (and it has left the junior time since its last
    message); then it reads the junior's record and decides. Null: it was not called (nothing is recorded). */
async function seniorDecides(o: AgentOperatorOptions, journal: Record<string, any>, digest: unknown, rounds: number, decisions: readonly AgentDecision[], ordersLeft: number): Promise<AgentDecision | null> {
  const signals: StuckSignals = stuckSignals(journal, o.patience ?? 3);
  const lastMessage = [...decisions].reverse().find((x) => x.decision === 'message');
  if (!signals.signs.length || (lastMessage && rounds - lastMessage.rounds < (o.cooldown ?? 2))) return null;
  const reader = journalReader(journal);
  const system = seniorSystem(juniorBrief(journal));
  const read: { step: number; requests: Record<string, unknown>[]; results: unknown[] }[] = [];
  const at = () => new Date().toISOString();
  const limit = o.readSteps ?? 4;
  const asked = () => read.map((r) => r.requests);
  try {
    for (let turn = 0; turn <= limit + 1; turn++) {
      const stepsLeft = Math.max(0, limit - read.length);
      const answer = await o.llm.complete({ system, user: { you_are: 'agent:' + o.id, signals: signals.signs, run: digest, memory: reader.counts(),
        ...(read.length ? { investigation: read } : {}), steps_left: stepsLeft, your_decisions: decisions.slice(-6), orders_left: ordersLeft } });
      const parsed = (parseJsonLoose(answer.content) ?? {}) as { investigate?: unknown[]; decision?: string; text?: string; why?: string; evidence?: unknown[] };
      if (Array.isArray(parsed.investigate) && stepsLeft > 0) {
        const requests = parsed.investigate.filter((q): q is Record<string, unknown> => Boolean(q) && typeof q === 'object' && typeof (q as Record<string, unknown>).memory === 'string').slice(0, 8);
        const results: unknown[] = [];
        for (const q of requests) results.push(await reader.run(q));
        read.push({ step: read.length + 1, requests, results });
        continue;
      }
      const decision = parsed.decision === 'message' && parsed.text?.trim() ? 'message' : 'wait';
      return { at: at(), rounds, decision, ...(decision === 'message' ? { text: String(parsed.text).trim() } : {}), why: String(parsed.why ?? ''), signals: signals.signs,
        read: asked(), ...(Array.isArray(parsed.evidence) ? { evidence: parsed.evidence.map(String) } : {}) };
    }
    return { at: at(), rounds, decision: 'wait', why: 'it kept reading and never decided', signals: signals.signs, read: asked() };
  } catch (e) {
    return { at: at(), rounds, decision: 'error', why: String((e as Error)?.message ?? e), signals: signals.signs };
  }
}
