/* ABLATION (control): the working harness with a Jev that knows nothing (every answer neutral). A formula that
   does not beat this has learned nothing. Measured 23/09: cats d5 vs mouse d8 -> the Mouse wins all four starts.
   node --experimental-strip-types scripts/ablation-flat-jev.ts [catsDepth] [mouseDepth] */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from '../test/support.ts';

const html = fs.readFileSync(path.join(ROOT, 'fox-hounds-harness.html'), 'utf8');
const src = html.match(/<script>([\s\S]*?)<\/script>/)![1];
/* A Jev that knows nothing: every answer is the neutral middle, whatever the facts. */
const flatFetch = async (_u: string, init: any) => {
  const body = JSON.parse(init.body);
  const answers: any = {};
  for (const [id, q] of Object.entries<any>(body.questions)) {
    answers[id] = q.type === 'choice' ? { type: 'choice', probabilities: Object.fromEntries(Object.keys(q.criteria).map((k, i) => [k, i === 0 ? 0.5 : 0.25])), confidence: 0.3 }
      : q.type === 'score' ? { type: 'score', score: Math.floor((q.criteria.length - 1) / 2), confidence: 0.3 } : { type: 'noul', noul: 0.5 };
  }
  const text = JSON.stringify({ answers });
  return { ok: true, status: 200, text: async () => text, headers: { get: () => null } };
};
const sb: any = { console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, setInterval, clearInterval, performance: { now: () => Date.now() }, AbortController, fetch: flatFetch };
sb.globalThis = sb; vm.createContext(sb);
vm.runInContext(src + ';globalThis.__a={config,searchBestMove,planMouseMove,createInitialState,isTerminal,applyMove,passTurn,legalMovesForSide,normalizeRules,seedRules,moveKey};', sb);
const h = sb.__a;
Object.assign(h.config, { typesafeUrl: 'https://api.typesafe.ai/v1/systemone', typesafeKey: 'k', observationMode: 'code', promptDoctrine: 'neutral' });
const rules = h.normalizeRules(h.seedRules(), { fallback: h.seedRules(), source: 'bootstrap' }).rules;
const catsDepth = Number(process.argv[2] || 5), mouseDepth = Number(process.argv[3] || 8);
h.config.depth = catsDepth;
for (const col of [0, 2, 4, 6]) {
  let s = h.createInitialState(col);
  const t0 = Date.now();
  let end = 'cap';
  for (let i = 0; i < 80; i++) {
    const t = h.isTerminal(s);
    if (t.over) { end = t.winner + ':' + t.reason + '@' + s.ply; break; }
    if (s.turn === 'cats') {
      if (!h.legalMovesForSide(s, 'cats').length) { s = h.passTurn(s); continue; }
      s = h.applyMove(s, (await h.searchBestMove(s, rules, { depth: catsDepth })).result.bestMove);
    } else s = h.applyMove(s, h.planMouseMove(s, mouseDepth));
  }
  console.log('flat Jev (always 0.5) | cats d' + catsDepth + ' vs mouse d' + mouseDepth + ' | mouse starts col ' + col + ' -> ' + end + ' (' + Math.round((Date.now() - t0) / 1000) + ' s)');
}
