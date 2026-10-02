/* How does the provider cache prompts? A few cheap calls to the endpoint in LLM_URL / LLM_KEY / LLM_MODEL (a cheap model is
   enough), each printed with the tokens it reports cached and its cost:

     1. a prompt (the researcher's real system prompt, and a long user message)
     2. the same prompt again                                 - is anything cached at all?
     3. the same, with text appended to the user message      - is a common beginning reused (prefix caching)?
     4. the same, with a second user message appended         - is a common sequence of whole messages reused?

     node --experimental-strip-types scripts/cache-probe.ts

   Nothing is written; keys come from the environment only. */
import { explorerSystem } from '../src/learn/explorer.ts';

const url = process.env.LLM_URL, key = process.env.LLM_KEY, model = process.env.LLM_MODEL;
if (!url || !model) { console.error('LLM_URL and LLM_MODEL (and LLM_KEY) are needed'); process.exit(2); }

const system = explorerSystem();
/* A long, fixed user message: well over the 1024 tokens a cache usually needs. */
const block = Array.from({ length: 120 }, (_, i) => 'Step ' + i + ': the picture of episode g' + (i % 9) + ' at step ' + i + ' shows the same board as before, row by row.').join('\n');
const extra = '\nOne more step: a new line appended at the end, the way an investigation grows.';

async function ask(label: string, messages: { role: string; content: string }[]): Promise<void> {
  const res = await fetch(url!, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: 'Bearer ' + key } : {}) },
    body: JSON.stringify({ model, temperature: 0, max_tokens: 5, messages: [{ role: 'system', content: system }, ...messages] }) });
  const data = await res.json() as { usage?: { prompt_tokens?: number; cost?: number; prompt_tokens_details?: { cached_tokens?: number } }; error?: unknown };
  if (!res.ok) { console.log(label + ': HTTP ' + res.status + ' ' + JSON.stringify(data.error ?? data).slice(0, 200)); return; }
  const u = data.usage ?? {};
  console.log(label.padEnd(44) + ' prompt ' + String(u.prompt_tokens ?? '?').padStart(6) + '   cached ' + String(u.prompt_tokens_details?.cached_tokens ?? '?').padStart(6) + (u.cost !== undefined ? '   cost $' + u.cost : ''));
}
const pause = () => new Promise((r) => setTimeout(r, 3000));

await ask('1. a prompt', [{ role: 'user', content: block }]);
await pause();
await ask('2. the same prompt again', [{ role: 'user', content: block }]);
await pause();
await ask('3. text appended to the user message', [{ role: 'user', content: block + extra }]);
await pause();
await ask('4. a second user message appended', [{ role: 'user', content: block }, { role: 'user', content: extra }]);
console.log('\nIf 3 caches about as much as 2, the provider reuses a common beginning (prefix caching): putting what changes last is enough.');
console.log('If only 4 does, it reuses whole messages: an investigation would have to grow as messages of its own.');
console.log('If only the system part is cached in every case, the user message is never reused, whatever its order.');
