import { ApiError } from '../../core/net.ts';
import type { ChatClient } from '../system2.ts';
import { TransportFailure, type Mutator } from './engine.ts';

/* The mutator of an evolutionary search: a model asked through the harness's own client (its requests logged for replay
   and counted where the client is wired), given the context the policy fixed (§7.2) and answering a patch. Its reasons
   are declarations; what the program does is the evaluator's to measure. */

export const MUTATOR_SYSTEM = [
  'You transform programs for a search. You are given a task, an operator and what it needs: a program to change locally or rewrite, one to repair, two to combine, or nothing - a program to write from scratch.',
  'Answer ONLY a JSON object: {"files": {"<path>": "<the whole new text of the file>" | null}, "why": "<what you changed and what you expect of it>"}.',
  'Every file you list is replaced whole (null removes it); the files you do not list stay as they are. Keep what the task says every answer must keep.',
  'Measures are of the exploration workloads only. What you say of your change is recorded as your declaration, not as a fact: the runs decide.'
].join('\n');

/** The tokens an answer reports, or null where its provider did not (unknown, never zero). */
function tokensOf(raw: unknown): number | null {
  const u = (raw as { usage?: { total_tokens?: unknown; prompt_tokens?: unknown; completion_tokens?: unknown } })?.usage;
  if (typeof u?.total_tokens === 'number') return u.total_tokens;
  if (typeof u?.prompt_tokens === 'number' && typeof u?.completion_tokens === 'number') return u.prompt_tokens + u.completion_tokens;
  return null;
}

export function chatMutator(client: ChatClient): Mutator {
  return {
    async propose(context, signal) {
      try {
        const a = await client.complete({ system: MUTATOR_SYSTEM, user: context, signal: signal ?? null });
        return { text: a.content, tokens: tokensOf(a.raw) };
      } catch (e) {
        if (e instanceof ApiError) throw new TransportFailure(e.message);
        throw e;
      }
    }
  };
}
