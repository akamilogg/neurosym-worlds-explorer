import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LabError, runLaboratory } from '../src/runtime/lab-runner.ts';
import { send } from '../src/runtime/control.ts';
import { cellsLab } from '../src/worlds/cells/lab.ts';
import { Sources, judgeSelector, sourceFetch, textOfHtml } from '../src/learn/assisted/sources.ts';
import { SOURCES_SECTION } from '../src/learn/assisted/session.ts';
import { findingView } from '../src/learn/finding.ts';
import type { FetchLike } from '../src/core/net.ts';

/* SPEC-INVESTIGADOR-ASISTIDO A6: sources the assisted researcher reads by itself, where the operator allows. */

const NOTES = ['# Notes on the cells', 'The row wraps around: the first and the last cell are neighbours.', 'Each cell looks at its two neighbours and itself.',
  'A cell with two marked neighbours stays marked.', 'Nothing else matters.'].join('\n');
const offline: FetchLike = async () => { throw new Error('no network here'); };
function origin(): { dir: string; lib: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'src-'));
  const lib = path.join(dir, 'lib');
  fs.mkdirSync(path.join(lib, 'more'), { recursive: true });
  fs.writeFileSync(path.join(lib, 'notes.md'), NOTES);
  fs.writeFileSync(path.join(lib, 'more', 'other.txt'), 'orbits and planets\nneighbours of planets');
  fs.writeFileSync(path.join(lib, 'image.bin'), 'x');
  fs.writeFileSync(path.join(dir, 'secret.md'), 'not for the researcher');
  return { dir, lib };
}

test('the origins draw the limits: inside an allowed directory, under a URL prefix, on a domain - nothing else', () => {
  const { dir, lib } = origin();
  const s = new Sources({ allow: [lib, 'https://site.test/docs/', 'docs.test'], fetch: offline });
  assert.ok(s.permitted(path.join(lib, 'notes.md')) && s.permitted(lib));
  assert.ok(!s.permitted(path.join(lib, '..', 'secret.md')) && !s.permitted(path.join(dir, 'secret.md')) && !s.permitted('lib/notes.md'));
  assert.ok(s.permitted('https://site.test/docs/a.html') && !s.permitted('https://site.test/other.html'));
  assert.ok(s.permitted('https://docs.test/x') && s.permitted('http://api.docs.test/y') && !s.permitted('https://evildocs.test/x'));
});

test('list, open and find are primitive: documents, numbered lines read afresh, the lines that hold the words', async () => {
  const { lib } = origin();
  const s = new Sources({ allow: [lib], fetch: sourceFetch(offline) });
  assert.deepEqual((await s.list(lib)).documents, [lib + '/image.bin', lib + '/more/other.txt', lib + '/notes.md'].filter((d) => !d.endsWith('.bin')));
  const first = await s.open('notes.md', 2, 3) as Record<string, any>;
  assert.deepEqual([first.lines, first.of], [[2, 3], 5]);
  assert.equal(first.text, '2: The row wraps around: the first and the last cell are neighbours.\n3: Each cell looks at its two neighbours and itself.');
  /* The document changes: reading it again shows it - what that means is the researcher's to judge. */
  fs.writeFileSync(path.join(lib, 'notes.md'), NOTES.replace('stays marked', 'becomes blank'));
  const again = await s.open(path.join(lib, 'notes.md'), 4, 4) as Record<string, any>;
  assert.equal(again.text, '4: A cell with two marked neighbours becomes blank.');
  assert.notEqual(again.hash, first.hash);
  const found = await s.find('Neighbours cell', lib) as Record<string, any>;
  assert.deepEqual(found.lines.map((l: { line: number }) => l.line), [2, 3, 4]);
  assert.equal(found.matches, 3);
  assert.match((await s.open(path.join(path.dirname(lib), 'secret.md')) as { error: string }).error, /not in an origin/);
  assert.match((await s.open('more') as { error: string }).error, /is a directory/);
  assert.match((await s.find('x', lib + '/nothing.md') as { error: string }).error, /not found/);
  assert.equal(textOfHtml('<html><script>x()</script><p>One &amp; two</p><p>three</p></html>').split('\n').map((l) => l.trim()).filter(Boolean).join('|'), 'One & two|three');
});

test('find with many lines says so; "select" asks the selector for the lines that speak to the need, and says when it cannot', async () => {
  const { lib } = origin();
  fs.writeFileSync(path.join(lib, 'long.md'), Array.from({ length: 60 }, (_, i) => 'cell ' + i + (i === 42 ? ' the rule of the row' : '')).join('\n'));
  const plain = await new Sources({ allow: [lib], fetch: sourceFetch(offline) }).find('cell', lib + '/long.md') as Record<string, any>;
  assert.deepEqual([plain.matches, plain.lines.length], [60, 40]);
  assert.match(plain.note, /"select"/);
  const records: Record<string, unknown>[] = [];
  const s = new Sources({ allow: [lib], fetch: sourceFetch(offline), selector: async (_need, lines) => lines.map((l) => (/rule/.test(l) ? 1 : 0)), onSelect: (r) => records.push({ ...r }) });
  const picked = await s.find('cell', lib + '/long.md', 'what the rule is') as Record<string, any>;
  assert.deepEqual([picked.matches, picked.selected, picked.lines[0].line], [60, 1, 43]);
  assert.deepEqual([records[0].need, records[0].lines], ['what the rule is', 60]);
  const none = await new Sources({ allow: [lib], fetch: sourceFetch(offline) }).find('cell', lib + '/long.md', 'x') as Record<string, any>;
  assert.match(none.note, /no Judge/);
  const failing = await new Sources({ allow: [lib], fetch: sourceFetch(offline), selector: async () => { throw new Error('down'); } }).find('cell', lib + '/long.md', 'x') as Record<string, any>;
  assert.match(failing.note, /could not select \(down\)/);
});

test('the Judge as the selector sees what is needed and the lines only, one score question each, in batches', async () => {
  const asked: Record<string, any>[] = [];
  const judge = { id: 'j', judge: async (r: Record<string, any>) => { asked.push(r); return Object.fromEntries(Object.keys(r.questions).map((id, i) => [id, { value: i / 3, confidence: 1 }])); } };
  assert.deepEqual(await judgeSelector(judge as never, 2)('the rule', ['A', 'B', 'C']), [0, 1 / 3, 0]);
  assert.equal(asked.length, 2);
  assert.deepEqual(asked[0].texts, { need: 'the rule', text_1: 'A', text_2: 'B' });
  assert.equal(asked[0].rulesOfTheWorld, '');
  assert.match(asked[0].questions.text_1.instructions, /not whether it is right/);
});

/* --- Whole assisted runs, System 2 standing in: it lists, opens and finds, then cites a source (and the model it proposes,
   what the source says taken as it is, is false in this world). */
function system2(asked: { system: string; user: Record<string, any> }[] = [], hook: (n: number) => void = () => {}, select = false): FetchLike {
  return async (url, init) => {
    if (!/system2\.test/.test(url)) return { ok: false, status: 404, text: async () => 'not here', headers: { get: () => null } };
    const b = JSON.parse(String(init.body));
    const sys = b.messages[0].content as string, raw = b.messages[b.messages.length - 1].content as string;
    const user = sys.startsWith('You grade') ? {} : JSON.parse(raw);
    if (!sys.startsWith('You grade')) { asked.push({ system: sys, user }); hook(asked.length); }
    const origins: string[] = user.sources?.origins ?? [];
    const inv: Record<string, any>[] = user.investigation ?? [];
    const doc = inv[0]?.results?.[0]?.documents?.find((d: string) => d.endsWith('notes.md')) ?? origins[0];
    const stance = user.round === 1 ? 'new' : 'revise';
    const content = sys.startsWith('You grade') ? { grades: [], false_beliefs: [], form: 'compact', form_evidence: 'e' }
      : 'task' in user ? { rationale: 'r', beliefs: [{ id: 'b1', stance: 'confirm', why: 'w' }], lessons: ['l'], next_experiment: 'n' }
      : origins.length && inv.length === 0 ? { investigate: [{ list: origins[0] }] }
      : origins.length && inv.length === 1 ? { investigate: [{ open: doc, from: 1, to: 5 }] }
      : origins.length && inv.length === 2 ? { investigate: [{ find: 'neighbours', in: origins[0], ...(select ? { select: 'which cells a cell looks at' } : {}) }] }
      : !origins.length && !inv.length && user.round % 2 === 1 ? { investigate: [{ view: 'ep1', from: 0, to: 3 }] }
      : { rationale: 'r', observations: {}, rules: {}, weights: {}, output: '(p) => p.rows[p.rows.length - 1]', validate: true, lessons: ['l'],
        beliefs: origins.length ? [{ id: 'b1', stance, statement: 'a cell looks at its two neighbours', evidence: ['ep1@2', 'src:' + doc + '#L3-3'] },
          { id: 'b2', stance, statement: 'marked cells stay marked', evidence: ['src:' + doc + '#L4-4'] }]
          : [{ id: 'b1', stance, statement: 's', evidence: ['ep1@2'] }] };
    const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 100 } });
    return { ok: true, status: 200, text: async () => text, headers: { get: () => null } };
  };
}
const ARGS = ['--seed', '1', '--level', '1', '--attempts', '3', '--flat', '--no-grade', '--researcher', 'assisted'];
const llm = { url: 'http://system2.test/chat', model: 'stand-in' };
const eventsOf = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8')).events as Record<string, any>[];

test('--sources-allow: it lists, opens and finds by itself and cites what it read; the finding says what rests on the world and what only on sources; a source does not make a false model hold', async () => {
  const { dir, lib } = origin();
  const asked: { system: string; user: Record<string, any> }[] = [];
  const r = await runLaboratory(cellsLab, { args: [...ARGS, '--sources-allow', 'lib', '--out', path.join(dir, 'run.json')], root: dir, llm, fetch: system2(asked) });
  assert.notEqual(r.stoppedBy, 'accepted', 'the source proposes, the world decides');
  assert.ok(asked.every((q) => q.system.endsWith(SOURCES_SECTION) && q.user.sources.origins[0] === lib));
  const inv = eventsOf(r.journal).filter((e) => e.type === 'investigation');
  assert.ok(inv[0].results[0].documents.includes(lib + '/notes.md'));
  assert.match(inv[1].results[0].text, /^1: # Notes on the cells/);
  assert.deepEqual(inv[2].results[0].lines.map((l: { doc: string; line: number }) => [path.basename(l.doc), l.line]), [['other.txt', 2], ['notes.md', 2], ['notes.md', 3], ['notes.md', 4]]);
  const grounded = Object.fromEntries(r.finding.claims.map((c) => [c.id, c.grounded]));
  assert.deepEqual(grounded, { b1: ['world', 'sources'], b2: ['sources'] });
  const s = r.finding.assistance!.sources;
  assert.deepEqual([s.origins, s.opened[0], s.found[0]], [['lib'], lib + '/notes.md#L1-5', 'neighbours in ' + lib]);
  assert.deepEqual(findingView(r.finding, 'researcher').assistance, r.finding.assistance);
  assert.ok(!eventsOf(r.journal).some((e) => e.type === 'source_select'), 'it did not ask the Judge');
});

test('what may not read sources says so: the unknown-world researcher, an origin that is not there', async () => {
  const { dir } = origin();
  const base = (args: string[]) => ({ args: ['--seed', '1', '--flat', '--no-grade', ...args, '--out', path.join(dir, 'x.json')], root: dir, llm, fetch: system2() });
  await assert.rejects(runLaboratory(cellsLab, base(['--sources-allow', 'lib'])), (e) => e instanceof LabError && /only the assisted/.test(e.message));
  await assert.rejects(runLaboratory(cellsLab, base(['--researcher', 'assisted', '--sources-allow', 'nowhere'])), (e) => e instanceof LabError && /no file or directory/.test(e.message));
});

test('cut and resumed, a run is answered what it read before, even if the document changed since; an origin allowed live comes with the next question', async () => {
  const { dir, lib } = origin();
  let journal = '';
  const hook = (n: number) => { if (n === 2) { send(journal, { kind: 'source', source: path.join(dir, 'nowhere'), by: 'operator' }); send(journal, { kind: 'source', source: lib, by: 'operator' }); } };
  const run = (name: string, more: string[]) => runLaboratory(cellsLab, { args: [...ARGS, ...more, '--out', path.join(dir, name)], root: dir, llm, onJournal: (f) => { journal = f; }, fetch: system2([], hook) });
  const whole = await run('whole.json', []);
  const events = eventsOf(whole.journal);
  assert.match(events.find((e) => e.type === 'operator_command_refused')!.reason, /no file or directory/);
  assert.deepEqual(events.filter((e) => e.type === 'sources_allowed').map((e) => [e.question, e.origin]), [[3, lib]]);
  assert.ok(events.some((e) => e.type === 'investigation' && e.requests.some((q: Record<string, unknown>) => 'open' in q)));
  const cut = await run('cut.json', ['--max-tokens', '650']);
  assert.equal(cut.stoppedBy, 'token_budget');
  assert.ok(eventsOf(cut.journal).some((e) => e.type === 'investigation' && e.requests.some((q: Record<string, unknown>) => 'open' in q)), 'the cut came after a read');
  fs.writeFileSync(path.join(lib, 'notes.md'), 'changed since');
  const resumed = await runLaboratory(cellsLab, { args: ['--resume', cut.journal, '--out', path.join(dir, 'resumed.json')], root: dir, llm, fetch: system2() });
  assert.equal(resumed.stoppedBy, whole.stoppedBy, 'it did not diverge');
  /* Up to the cut, what it read then (the log answers); after it, the document as it is now (read live). */
  const readsOf = (f: string) => eventsOf(f).filter((e) => e.type === 'investigation' && 'open' in e.requests[0]).map((e) => e.results[0].text as string);
  const before = readsOf(cut.journal).length;
  assert.deepEqual(readsOf(resumed.journal).slice(0, before), readsOf(whole.journal).slice(0, before));
  assert.ok(readsOf(resumed.journal).slice(before).some((t) => t === '1: changed since'), 'afterwards, read afresh');
});

test('a source on the web, on an allowed domain, is read through the run\'s log; with the Judge, "select" picks lines, seeing only the need and the lines', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'src-'));
  const page = '<html><body>' + NOTES.split('\n').map((l) => '<p>' + l + '</p>').join('') + '</body></html>';
  const judged: Record<string, any>[] = [];
  const web = (up: boolean, select: boolean): FetchLike => {
    const s2 = system2([], () => {}, select);
    return async (url, init) => {
      if (/docs\.test/.test(url)) return up ? { ok: true, status: 200, text: async () => page, headers: { get: () => null } } : { ok: false, status: 503, text: async () => 'down', headers: { get: () => null } };
      if (/jev\.test/.test(url)) {
        const body = JSON.parse(String(init.body));
        judged.push(body);
        const texts = body.state.observed_texts as Record<string, string>;
        const answers = Object.fromEntries(Object.keys(body.questions).map((id) => [id, { type: 'score', score: /looks at/.test(texts[id]) ? 3 : 0, confidence: 0.9 }]));
        return { ok: true, status: 200, text: async () => JSON.stringify({ answers }), headers: { get: () => null } };
      }
      return s2(url, init);
    };
  };
  /* The page is its origin: it cannot be listed, so the stand-in opens it by its URL and finds in it. */
  const url = 'https://www.docs.test/cells.html';
  const args = ['--seed', '1', '--level', '1', '--attempts', '2', '--no-grade', '--no-ablation', '--researcher', 'assisted', '--sources-allow', url];
  const judge = { url: 'http://jev.test/v1/systemone', key: 'x' };
  const cut = await runLaboratory(cellsLab, { args: [...args, '--max-tokens', '350', '--out', path.join(dir, 'cut.json')], root: dir, llm, judge, fetch: web(true, true) });
  const inv = eventsOf(cut.journal).filter((e) => e.type === 'investigation');
  assert.match(inv[1].results[0].text, /3: Each cell looks at its two neighbours/);
  assert.deepEqual(inv[2].results[0].lines.map((l: { line: number }) => l.line), [3], 'the Judge picked the line that speaks to the need');
  const select = eventsOf(cut.journal).find((e) => e.type === 'source_select')!;
  assert.equal(select.lines, 3);
  const asked = judged.find((j) => j.state.observed_texts?.need)!;
  assert.ok(!JSON.stringify(asked).includes('rows'), 'the Judge is not shown the world');
  const resumed = await runLaboratory(cellsLab, { args: ['--resume', cut.journal, '--out', path.join(dir, 'resumed.json')], root: dir, llm, judge, fetch: web(false, true) });
  assert.notEqual(resumed.stoppedBy, 'diverged', 'the page is down now: the log answered what was read');
});
