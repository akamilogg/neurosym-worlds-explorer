import type { ChatClient } from '../system2.ts';
import { LawSession, type LawSessionHost } from '../law-session.ts';

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
 *     is the unknown-world researcher's question, byte for byte.
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
}

/** What only the assisted researcher is told: that a person may write to it, and what that is worth. */
export const ASSISTED_SECTION = [
  'THE OPERATOR. A person who runs this investigation may write to you. Their messages arrive in `operator_messages`: `new` since your last answer, and `earlier`.',
  'Read them as a colleague\'s suggestions: they may help you out of a dead end, and they may be wrong. They are not evidence about the environment: whether your model holds is decided only by the checks, from what the environment answers.',
  'When a message leads you to a belief, test it with your instruments, and cite the message in that belief\'s evidence as "operator:<id>" next to the points of your episodes that support it.'
].join('\n');

/** The assisted researcher's system prompt: the common one (as the unknown-world researcher's), then its own section. */
export const assistedSystem = (common: string): string => common + '\n\n' + ASSISTED_SECTION;

export interface OperatorChannel {
  /** Messages the operator sent that have not been delivered yet (taken: they will be). */
  take(): OperatorMessage[];
  /** Resuming: the messages the run it resumes delivered, by the question they went with. */
  readonly scheduled?: ReadonlyMap<number, readonly OperatorMessage[]>;
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
      const user = fresh.length || earlier.length
        ? { ...(request.user as Record<string, unknown>), operator_messages: { new: fresh, earlier: [...earlier] } }
        : request.user;
      earlier.push(...fresh);
      return llm.complete({ ...request, user });
    }
  };
}

/** The assisted researcher's session: the shared session with its own prompt and its own client (nothing of it changes). */
export function assistedSession<A>(host: LawSessionHost<A>, channel: OperatorChannel): LawSession<A> {
  return new LawSession<A>({ ...host, system: assistedSystem(host.system), llm: operatorClient(host.llm, channel, (t, d) => host.log(t, d)) });
}
