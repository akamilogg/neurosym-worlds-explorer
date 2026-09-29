import type { ChatClient } from '../system2.ts';
import { LawSession, type LawSessionHost } from '../law-session.ts';
import { Sources } from './sources.ts';

/* ============================================================================
 * The ASSISTED researcher (SPEC-INVESTIGADOR-ASISTIDO §6, A4): the one the operator may help.
 *
 * It is a researcher of its own, and it changes nothing of the unknown-world one: it does not
 * touch the shared session (LawSession), its prompt or its instruments. It is built by
 * composition - the same session, given
 *
 *   - its own system prompt: the common one and a section of its own on the operator, that
 *     only it sees (`assistedSystem`);
 *   - its own client for System 2, which adds the operator's messages to the next question:
 *     `operator_messages: { new: [...], earlier: [...] }`. A question with no message ever
 *     is the unknown-world researcher's question, byte for byte;
 *   - where the operator allows origins of sources (A6), instruments of its own to read them -
 *     `list`, `open`, `find` (`sources.ts`); the world never answers them.
 *
 * Every message is logged when it is delivered (`operator_message`, with the number of the
 * question it went with). A resumed run delivers each at the same question - so what it asks
 * is what the run it resumes asked, and the replay recognises it - and new ones live.
 *
 * The criterion does not change: a message is not evidence. Whether a model holds is decided
 * by the checks, from what the world answers (P4).
 * ========================================================================== */

export interface OperatorMessage {
  readonly id: string;
  readonly text: string;
  readonly by?: string;
  readonly at: string;
  /** A change of what counts (SPEC-INVESTIGADOR-ASISTIDO §6.2): applied when the message is delivered, so a resumed run
      applies it at the same question. */
  readonly focus?: { readonly facet: string; readonly task?: string };
  /** An origin of sources the operator allows (a directory, a URL prefix, a domain), from when the message is delivered. */
  readonly source?: string;
}

/** What only the assisted researcher is told: that a person may write to it, and what that is worth. */
export const ASSISTED_SECTION = [
  'THE OPERATOR. A person who runs this investigation may write to you. Their messages arrive in `operator_messages`: `new` since your last answer, and `earlier`.',
  'Read them as a colleague\'s suggestions: they may help you out of a dead end, and they may be wrong. They are not evidence about the environment: whether your model holds is decided only by the checks, from what the environment answers.',
  'When a message leads you to a belief, test it with your instruments, and cite the message in that belief\'s evidence as "operator:<id>" next to the points of your episodes that support it.',
  'The operator may also state what they want to understand (`operator_task`) and change what of your answer counts: the interface says what counts now.'
].join('\n');

/** What it is told once it may read sources: its instruments to read them, and what a source is worth. */
export const SOURCES_SECTION = [
  'SOURCES. You may read documents from the origins the operator allows (`sources.origins`: directories, web addresses, domains). Three more investigation requests read them:',
  '{"list": "<directory>"} answers the documents in it; {"open": "<document>", "from": 1, "to": 120} answers those lines of it, numbered, read afresh every time; {"find": "words", "in": "<document or directory>"} answers the lines that hold all the words.',
  'When a find answers too many lines, add "select": "what you need": the Judge then picks, of the lines found, those that speak to it (by what they are about, not by whether they are right).',
  'A source is a REFERENCE, never a truth: what someone wrote, an approximation of what they could see with their own instruments, and it may be wrong, partial, outdated or about something else. It is not evidence of what the environment does. Question it as you question your own beliefs: test what it says with your instruments, and open it again when you need to check it, when it contradicts what the environment answers or another source.',
  'When a source does not fit what you observe, refute it: the environment\'s answers weigh more than any text. Keep in your notes what you took from each source, and which sources (or parts) you refuted and why. When a belief rests on a source, cite it in that belief\'s evidence as "src:<document>#L<from>-<to>", next to the points of your episodes that support it.'
].join('\n');

/** The assisted researcher's system prompt: the common one (as the unknown-world researcher's), then its own section. */
export const assistedSystem = (common: string): string => common + '\n\n' + ASSISTED_SECTION;

export interface OperatorChannel {
  /** Messages the operator sent that have not been delivered yet (taken: they will be). */
  take(): OperatorMessage[];
  /** Resuming: the messages the run it resumes delivered, by the question they went with. */
  readonly scheduled?: ReadonlyMap<number, readonly OperatorMessage[]>;
  /** The system prompt now (it changes with a focus); default: the one the session was given. */
  system?(): string;
  /** What the operator wants understood, if they said: sent with every question as `operator_task`. */
  task?(): string | null;
  /** Told of each message as it is delivered, with its question (a focus is applied, a source read, then). */
  onDeliver?(message: OperatorMessage, question: number): void | Promise<void>;
  /** The sources it may read: once an origin is allowed, the prompt says how, and each question lists the origins. */
  readonly sources?: Sources;
}

/** The messages a journal delivered, by question: what a resumed run delivers again at the same questions. */
export function deliveredMessages(journal: { events?: readonly Record<string, any>[] } | null): Map<number, OperatorMessage[]> {
  const out = new Map<number, OperatorMessage[]>();
  for (const e of journal?.events ?? []) if (e.type === 'operator_message' && typeof e.question === 'number') out.set(e.question, [...(out.get(e.question) ?? []), ...(e.messages ?? [])]);
  return out;
}

/** System 2's client for the assisted researcher: each question carries the operator's messages, the new ones and the earlier. */
export function operatorClient(llm: ChatClient, channel: OperatorChannel, log: (type: string, data?: Record<string, unknown>) => void): ChatClient {
  let question = 0;
  const earlier: OperatorMessage[] = [];
  const lastScheduled = Math.max(0, ...(channel.scheduled ? [...channel.scheduled.keys()] : []));
  return {
    async complete(request) {
      question++;
      /* Resuming, up to where the run it resumes went: exactly what it delivered, at the same questions. Then, live. */
      const fresh = channel.scheduled?.has(question) ? [...channel.scheduled.get(question)!]
        : question <= lastScheduled ? [] : channel.take();
      if (fresh.length) log('operator_message', { question, messages: fresh });
      for (const m of fresh) await channel.onDeliver?.(m, question);
      const task = channel.task?.() ?? null;
      const origins = channel.sources?.origins() ?? [];
      const user = fresh.length || earlier.length || task || origins.length
        ? { ...(request.user as Record<string, unknown>), ...(task ? { operator_task: task } : {}), ...(origins.length ? { sources: { origins } } : {}),
          ...(fresh.length || earlier.length ? { operator_messages: { new: fresh, earlier: [...earlier] } } : {}) }
        : request.user;
      earlier.push(...fresh);
      const system = channel.system ? channel.system() : request.system;
      return llm.complete({ ...request, system: origins.length ? system + '\n\n' + SOURCES_SECTION : system, user });
    }
  };
}

/** The assisted researcher's session: the shared session with its own prompt and its own client (nothing of it changes). */
export function assistedSession<A>(host: LawSessionHost<A>, channel: OperatorChannel): LawSession<A> {
  const sources = channel.sources;
  return new LawSession<A>({
    ...host, system: assistedSystem(host.system), llm: operatorClient(host.llm, channel, (t, d) => host.log(t, d)),
    /* Its own instruments, once an origin is allowed: `list`, `open`, `find` - answered here, never by the world. */
    ...(sources ? {
      extraRequest: (q: Record<string, unknown>) => sources.origins().length > 0 && Sources.accepts(q),
      runRequest: (r, budget, round) => ('extra' in r ? sources.run(r.extra) : host.runRequest(r, budget, round))
    } : {})
  });
}
