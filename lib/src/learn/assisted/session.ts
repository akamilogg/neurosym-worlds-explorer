import { UserParts, type ChatClient } from '../system2.ts';
import { LawSession, type LawSessionHost } from '../law-session.ts';
import { Sources, type LineSelector } from './sources.ts';
import { JournalMemory } from './memory.ts';
import { Experience } from './experience.ts';
import { ownLaw } from '../law-explorer.ts';

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
  'THE OPERATOR. A person who runs this investigation may write to you. Their messages arrive in `operator_messages`: as `new` where they reach you, and at the start of each round as `earlier`.',
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
  /** Its selective memory (SPEC-INVESTIGADOR-ASISTIDO §13): the Judge as the selector of its `find` (none in --flat), and
      where what the Judge picked is told. The prompt's MEMORY_SECTION is the host's to add. */
  readonly memory?: { readonly selector?: LineSelector; onSelect?(record: Record<string, unknown>): void };
  /** The records of earlier runs it may read (§12). The prompt's section is the host's to add. */
  readonly experience?: Experience;
}

/** How many times a round the assisted researcher may ask to investigate with no steps left before it is a refusal. */
export const OVERREACH = 3;

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
  /* With a question in parts (a round's growing conversation): the messages stay where they arrived, never rewritten - the
     earlier ones after the round's first part, a new one after the parts it arrived with. A new round starts afresh. */
  let roundKey = '';
  let placed: { after: number; part: Record<string, unknown> }[] = [];
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
      const standing = { ...(task ? { operator_task: task } : {}), ...(origins.length ? { sources: { origins } } : {}) };
      let user: unknown;
      if (request.user instanceof UserParts) {
        const parts = request.user.parts as Record<string, unknown>[];
        const key = JSON.stringify(parts[0]);
        if (key !== roundKey) { roundKey = key; placed = earlier.length ? [{ after: 1, part: { operator_messages: { earlier: [...earlier] } } }] : []; }
        if (fresh.length) placed.push({ after: parts.length, part: { operator_messages: { new: fresh } } });
        const out: unknown[] = [];
        parts.forEach((p, i) => { out.push(i === 0 ? { ...p, ...standing } : p); for (const x of placed) if (x.after === i + 1) out.push(x.part); });
        user = new UserParts(out);
      } else {
        const extra = { ...standing, ...(fresh.length || earlier.length ? { operator_messages: { new: fresh, earlier: [...earlier] } } : {}) };
        user = Object.keys(extra).length ? { ...(request.user as Record<string, unknown>), ...extra } : request.user;
      }
      earlier.push(...fresh);
      const system = channel.system ? channel.system() : request.system;
      return llm.complete({ ...request, system: origins.length ? system + '\n\n' + SOURCES_SECTION : system, user });
    }
  };
}

/** The assisted researcher's session: the shared session with its own prompt and its own client (nothing of it changes). */
export function assistedSession<A>(host: LawSessionHost<A>, channel: OperatorChannel): LawSession<A> {
  const sources = channel.sources;
  const memory = channel.memory;
  const reads = (q: Record<string, unknown>): boolean => sources !== undefined && sources.origins().length > 0 && Sources.accepts(q);
  const recalls = (q: Record<string, unknown>): boolean => memory !== undefined && JournalMemory.accepts(q);
  const experience = channel.experience;
  const remembers = (q: Record<string, unknown>): boolean => experience !== undefined && Experience.accepts(q);
  const session: LawSession<A> = new LawSession<A>({
    ...host, system: assistedSystem(host.system), llm: operatorClient(host.llm, channel, (t, d) => host.log(t, d)),
    /* It may insist on investigating with no steps left a few times before it is a refusal (logged). */
    overreach: OVERREACH,
    /* Its own instruments - the sources once an origin is allowed (`list`, `open`, `find`) and its memory (`memory`) -
       answered here, never by the world. */
    ...(sources || memory || experience ? {
      extraRequest: (q: Record<string, unknown>) => recalls(q) || remembers(q) || reads(q),
      runRequest: (r, budget, round) => ('extra' in r ? (recalls(r.extra) ? session.memory!.run(r.extra) : remembers(r.extra) ? experience!.run(r.extra) : sources!.run(r.extra))
        : host.runRequest(r, budget, round))
    } : {}),
    /* Its episodes and models are kept by the host and the session, not in the notebook. */
    ...(memory ? {
      memory: (s: LawSession<A>) => new JournalMemory(s.notebook, { ...(memory.selector ? { selector: memory.selector } : {}),
        onSelect: (record) => memory.onSelect?.({ round: s.currentRound, ...record }),
        episodes: () => host.episodes() as never,
        models: () => s.laws.map((l) => ({ round: l.round, fingerprint: l.fingerprint, model: ownLaw(l.law), accepted: l.accepted })) })
    } : {})
  });
  return session;
}
