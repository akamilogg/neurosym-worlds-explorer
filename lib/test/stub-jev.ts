import { hashString, stableStringify } from '../src/core/hash.ts';

/* A deterministic stand-in for POST /v1/systemone, speaking the documented contract. The answer is a
   pure function of (what the state says, question id), so the harness and the library - fed the same
   facts - must receive the same answers. It records every request body it serves. The library itself
   ships no such thing: there is no offline Jev. */

export interface StubJev {
  bodies: any[];
  fetch: (url: string, init: { body?: string }) => Promise<{ ok: boolean; status: number; text(): Promise<string>; headers: { get(): null } }>;
}

function unit(seed: string): number {
  return (parseInt(hashString(seed), 36) % 1000) / 1000;
}

export function stubJev(): StubJev {
  const bodies: any[] = [];
  return {
    bodies,
    async fetch(_url, init) {
      const body = JSON.parse(String(init.body));
      bodies.push(body);
      const facts = stableStringify(body.state.measurements ?? body.state.cats ?? null) + '|' + body.state.side_to_move;
      const answers: Record<string, unknown> = {};
      for (const [id, q] of Object.entries<any>(body.questions)) {
        const u = unit(facts + '|' + id);
        const confidence = Math.round((0.2 + 0.7 * unit('c' + facts + id)) * 100) / 100;
        if (q.type === 'choice') {
          const keys = Object.keys(q.criteria);
          const probabilities: Record<string, number> = {};
          keys.forEach((k, i) => { probabilities[k] = i === 0 ? u : (1 - u) / Math.max(1, keys.length - 1); });
          answers[id] = { type: 'choice', choice: keys[0], probabilities, confidence };
        } else if (q.type === 'score') {
          answers[id] = { type: 'score', score: Math.floor(u * q.criteria.length) % q.criteria.length, confidence };
        } else {
          answers[id] = { type: 'noul', noul: u };
        }
      }
      const text = JSON.stringify({ model: 'stub', answers });
      return { ok: true, status: 200, text: async () => text, headers: { get: () => null } };
    }
  };
}
