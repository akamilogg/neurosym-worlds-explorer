import fs from 'node:fs';
import path from 'node:path';
import type { FetchLike } from './net.ts';

/* ============================================================================
 * THE EXTERNAL SEAT (SPEC-INVESTIGACION-EXTERNA §6.4, IE9): a model endpoint that is a folder. Where an actor of the
 * harness would ask a model (System 2, a senior, a researching operator, a branch), with `LLM_URL=seat:<folder>` it
 * leaves its turn there - the request exactly as a model would receive it - and waits for an answer an external agent
 * writes (a coding agent, a script, a person: `lab external turn|answer`). Nothing else changes: the run's requests,
 * bags, checks, journal and resumption are the ones it has with a model, and the replay records the answer as a model's.
 *
 *   <folder>/turns/<id>.json     { id, at, pid, body }    a turn waiting (body: the chat request, system and messages)
 *   <folder>/answers/<id>.json   { id, at, content }      its answer, written once
 *   <folder>/turns/<id>.closed   the turn was answered, or its caller stopped waiting
 *
 * A turn is answered once: an answer to a turn not waiting is refused. Several actors may share a folder (a run and its
 * branches): each turn has its own id. There is no deadline here: the run waits, as it waits for a slow model; stopped or
 * killed, it resumes from its checkpoint and asks again (a new turn).
 * ========================================================================== */

export const SEAT = 'seat:';
export const isSeat = (url: string | null | undefined): boolean => typeof url === 'string' && url.startsWith(SEAT);
export const seatFolder = (url: string): string => path.resolve(url.slice(SEAT.length));

let counter = 0;
const turnsOf = (dir: string) => path.join(dir, 'turns');
const answersOf = (dir: string) => path.join(dir, 'answers');

/** A fetch that serves `seat:` URLs from their folder and passes every other to `base` (none: the host's fetch, read when
    each request is made). */
export function seatFetch(base: FetchLike | undefined, o: { readonly pollMs?: number } = {}): FetchLike {
  return async (url, init) => {
    if (!isSeat(url)) {
      const f = base ?? (globalThis.fetch as unknown as FetchLike | undefined);
      if (typeof f !== 'function') throw new Error('no fetch implementation in this host');
      return f(url, init);
    }
    const dir = seatFolder(url);
    fs.mkdirSync(turnsOf(dir), { recursive: true });
    fs.mkdirSync(answersOf(dir), { recursive: true });
    const id = new Date().toISOString().replace(/[-:.TZ]/g, '') + '-' + process.pid + '-' + (++counter);
    const body = init.body ? JSON.parse(init.body) : null;
    fs.writeFileSync(path.join(turnsOf(dir), id + '.json'), JSON.stringify({ format: 'seat-turn@1', id, at: new Date().toISOString(), pid: process.pid, body }, null, 2));
    const answer = path.join(answersOf(dir), id + '.json');
    const close = () => { try { fs.writeFileSync(path.join(turnsOf(dir), id + '.closed'), new Date().toISOString()); } catch { /* its folder gone */ } };
    return new Promise((resolve, reject) => {
      const tick = () => {
        if (init.signal?.aborted) { clearInterval(timer); close(); const e = new Error('The operation was aborted.'); e.name = 'AbortError'; reject(e); return; }
        if (!fs.existsSync(answer)) return;
        let content: string;
        try { content = String(JSON.parse(fs.readFileSync(answer, 'utf8')).content ?? ''); } catch { return; /* being written */ }
        clearInterval(timer);
        close();
        const text = JSON.stringify({ choices: [{ message: { role: 'assistant', content } }], usage: null, seat: { turn: id, unmeasured: true } });
        resolve({ ok: true, status: 200, text: async () => text, headers: { get: () => null } });
      };
      const timer = setInterval(tick, o.pollMs ?? 250);
      tick();
    });
  };
}

export interface SeatTurn { readonly id: string; readonly at: string; readonly pid: number; readonly body: { readonly messages?: readonly { role: string; content: string }[] } & Record<string, unknown> }

/** The turns waiting in a seat's folder, oldest first. */
export function pendingTurns(dir: string): SeatTurn[] {
  const t = turnsOf(dir);
  if (!fs.existsSync(t)) return [];
  return fs.readdirSync(t).filter((f) => f.endsWith('.json')).sort()
    .filter((f) => !fs.existsSync(path.join(t, f.replace(/\.json$/, '.closed'))) && !fs.existsSync(path.join(answersOf(dir), f)))
    .flatMap((f) => { try { return [JSON.parse(fs.readFileSync(path.join(t, f), 'utf8')) as SeatTurn]; } catch { return []; } });
}

/** Answers a turn waiting: refused for a turn that is not waiting (unknown, answered, or its caller gone). */
export function answerTurn(dir: string, id: string, content: string): { ok: true } | { refused: string } {
  if (!/^[0-9A-Za-z-]+$/.test(id)) return { refused: 'no turn ' + id };
  if (!fs.existsSync(path.join(turnsOf(dir), id + '.json'))) return { refused: 'no turn ' + id + ' in ' + dir };
  if (fs.existsSync(path.join(answersOf(dir), id + '.json'))) return { refused: 'the turn ' + id + ' was answered already' };
  if (fs.existsSync(path.join(turnsOf(dir), id + '.closed'))) return { refused: 'the turn ' + id + ' is no longer waiting (its caller stopped)' };
  if (!content.trim()) return { refused: 'an answer is a text (the JSON object the role takes)' };
  fs.mkdirSync(answersOf(dir), { recursive: true });
  /* Written whole, then renamed: a caller never reads half an answer. */
  const tmp = path.join(answersOf(dir), id + '.json.tmp');
  fs.writeFileSync(tmp, JSON.stringify({ format: 'seat-answer@1', id, at: new Date().toISOString(), content }));
  fs.renameSync(tmp, path.join(answersOf(dir), id + '.json'));
  return { ok: true };
}
