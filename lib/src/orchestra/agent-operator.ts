import fs from 'node:fs';
import { parseJsonLoose } from '../core/net.ts';
import type { ChatClient } from '../learn/system2.ts';
import { orderOutcome, runStatus, send } from '../runtime/control.ts';
import { researcherEvents, runDigest } from './view.ts';

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

export interface AgentDecision {
  readonly at: string;
  /** How many rounds the run had when the agent decided. */
  readonly rounds: number;
  readonly decision: 'wait' | 'message' | 'stop' | 'error';
  readonly text?: string;
  readonly why?: string;
  readonly order?: string;
  outcome?: string;
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
  const record = { format: 'agent@1', agent: 'agent:' + o.id, run: o.journal, started: new Date().toISOString(), decisions: [] as AgentDecision[] };
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
      let d: AgentDecision;
      try {
        const answer = await o.llm.complete({ system: AGENT_OPERATOR_SYSTEM, user: { you_are: 'agent:' + o.id, run: digest, your_decisions: record.decisions.slice(-8), orders_left: maxOrders - orders } });
        const parsed = (parseJsonLoose(answer.content) ?? {}) as { decision?: string; text?: string; why?: string };
        const decision = parsed.decision === 'message' && parsed.text?.trim() ? 'message' : parsed.decision === 'stop' ? 'stop' : 'wait';
        d = { at: new Date().toISOString(), rounds, decision, ...(decision === 'message' ? { text: String(parsed.text).trim() } : {}), why: String(parsed.why ?? '') };
      } catch (e) {
        d = { at: new Date().toISOString(), rounds, decision: 'error', why: String((e as Error)?.message ?? e) };
      }
      if (d.decision === 'message' || d.decision === 'stop') {
        const { id } = send(o.journal, d.decision === 'message' ? { kind: 'message', text: d.text!, by: 'agent:' + o.id } : { kind: 'stop', by: 'agent:' + o.id });
        (d as { order?: string }).order = id;
        orders++;
        say('agent:' + o.id + ' after ' + rounds + ' rounds: ' + d.decision + (d.text ? ' - ' + d.text.slice(0, 120) : ''));
      }
      record.decisions.push(d);
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
