/* ============================================================================
 * THE SESSION TEST OF MA1 (lib/examples/junior.setup.md §4.3, junior.checklist.md): against a junior server already
 * running, one session asked to keep a fact and then to recall it, a second session that continues from the first and is
 * asked again, and the memory read as files. It prints what each answer did and the session files to verify without a
 * model (lab junior verify). It judges nothing: whether the junior kept and recalled the fact is read by the operator.
 *
 *   node --experimental-strip-types scripts/junior-smoke.ts --server http://127.0.0.1:18700 --package package.json
 *        [--root <the server's --root>] [--fact "the colour of the door is green"] [--name door]
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';

const arg = (name: string, dflt?: string): string | undefined => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : dflt; };
const server = (arg('server', 'http://127.0.0.1:18700') as string).replace(/\/$/, '');
const pkgFile = arg('package');
if (!pkgFile) { console.error('--package <package.json> is needed'); process.exit(2); }
const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
const fact = arg('fact', 'the colour of the door is green') as string;
const name = arg('name', 'door') as string;
const root = arg('root');

async function call(route: string, body?: unknown): Promise<any> {
  const r = await fetch(server + route, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await r.text();
  let json: any;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!r.ok) throw new Error(route + ': HTTP ' + r.status + ' ' + text.slice(0, 400));
  return json;
}
const ask = async (session: string, user: string) => {
  const a = await call('/sessions/' + encodeURIComponent(session) + '/v1/chat/completions', { messages: [{ role: 'system', content: 'You have a memory you can write and read with your memory calls.' }, { role: 'user', content: user }] });
  const info = await call('/sessions/' + encodeURIComponent(session));
  const receipt = await call('/sessions/' + encodeURIComponent(session) + '/receipts/' + encodeURIComponent(a.junior?.receipt ?? a.id));
  return { answer: a.choices?.[0]?.message?.content ?? null, terminal: a.junior?.terminal ?? null, state_after: a.junior?.state_after ?? null, ops: receipt?.receipt?.ops ?? receipt?.ops ?? null, head: info.head };
};
const show = (label: string, r: Awaited<ReturnType<typeof ask>>) => {
  console.log('\n== ' + label);
  console.log('terminal:', r.terminal, '| state after:', r.state_after);
  console.log('memory calls:', JSON.stringify(r.ops)?.slice(0, 600));
  console.log('answer:', String(r.answer).slice(0, 600));
};

const run = 'smoke-' + Date.now().toString(36);
const first = await call('/sessions', { run_id: run, pkg });
console.log('session 1:', first.session_id, '| execution', first.execution);
const put = await ask(first.session_id, 'Keep this in your memory under the name "' + name + '": ' + fact + '. Use a put call.');
show('1. put', put);
const get = await ask(first.session_id, 'What did you keep under the name "' + name + '"? Read it with a get call and say it.');
show('2. get, same session', get);
const second = await call('/sessions', { run_id: run + '-b', pkg, continues: { session_id: first.session_id } });
console.log('\nsession 2:', second.session_id, '| continues', JSON.stringify(second.origin));
const again = await ask(second.session_id, 'What is kept under the name "' + name + '" in your memory? Read it with a get call and say it.');
show('3. get, a session that continues the first', again);
if (again.head?.twin) {
  try { console.log('\n== the memory as files\n' + JSON.stringify(await call('/render', { pkg, twin: again.head.twin }), null, 2).slice(0, 2000)); }
  catch (e) { console.log('\n== the memory as files: ' + String((e as Error).message)); }
}
for (const s of [first.session_id, second.session_id]) await call('/sessions/' + encodeURIComponent(s) + '/close', {}).catch(() => {});
console.log('\nTo verify without a model (junior.setup.md §4.4), each session:');
for (const s of [first.session_id, second.session_id]) console.log('  ' + (root ? path.join(root, 'sessions', s + '.jsonl') : '<the server\'s --root>/sessions/' + s + '.jsonl'));
console.log('\nRead it yourself: the fact kept in 1 (a put), recalled in 2 and 3 (a get with the fact), and the files show it.');
