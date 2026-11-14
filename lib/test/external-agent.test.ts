import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runLaboratory } from '../src/runtime/lab-runner.ts';
import { artifactsLab } from '../src/worlds/artifacts/lab.ts';
import { JuniorWorld, juniorLab } from '../src/worlds/junior/lab.ts';
import type { FetchLike } from '../src/core/net.ts';
import { answerTurn, pendingTurns, seatFetch } from '../src/core/seat.ts';
import { openAiChatClient } from '../src/learn/system2.ts';
import { exposureOf } from '../src/learn/assisted/exposure.ts';
import { checkExternal, closeExternal, contributeExternal, externalSpecProblems, formatsExternal, openExternal, readExternal, statusExternal } from '../src/orchestra/external-agent.ts';
import { BlobStore, executionHash, normalizePackage } from '../src/junior/package.ts';
import { adapterKind, bf16Bits, writeSafetensors, type RawTensor } from '../src/junior/weights.ts';
import { verifyMask, type MaskBounds } from '../src/junior/mask.ts';
import { ConfirmationService, owes } from '../src/junior/confirm.ts';
import type { CompetenceManifest } from '../src/junior/competence.ts';
import { labCli } from '../src/runtime/cli.ts';
import { userOf } from './support.ts';

/* SPEC-INVESTIGACION-EXTERNA §6.4 and §7.1, IE7-IE9: an external agent - a coding agent, a script, a person - joins a
   research through the command line: it reads a run as its researcher lived it, delivers a contribution whose artifacts
   its world checks before anything reaches the researcher, and follows what became of it; the researcher adopts an
   artifact as an act of its own, evaluated as anything of its own and marked as adopted; and an agent may serve a seat of
   the harness from a folder (LLM_URL=seat:<folder>). The agent is exposed by definition, and unobserved. */

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const inbox = (t: string): Record<string, any>[] => (fs.existsSync(t.replace(/\.json$/, '.inbox.jsonl')) ? fs.readFileSync(t.replace(/\.json$/, '.inbox.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
function journal(dir: string, name: string, experiment: string): string {
  const f = path.join(dir, name + '.json');
  fs.writeFileSync(f, JSON.stringify({ experiment, researcher: 'assisted', events: [{ type: 'start' }, { type: 'check', round: 1, laboratories: [{ place: 'lab1', holds: false }] }] }));
  return f;
}
function agentFile(dir: string, targets: string[], over: Record<string, unknown> = {}): string {
  const f = path.join(dir, 'scout.agent.json');
  fs.writeFileSync(f, JSON.stringify({ format: 'external-agent@1', id: 'scout', task: 'help where the artifact is slow', targets, budget: { max_contributions: 1, max_reads: 2, minutes: 10 }, ...over }));
  return f;
}
const write = (dir: string, name: string, text: string) => { const f = path.join(dir, name); fs.writeFileSync(f, text); return f; };

const FAST = 'import re\nTAG = re.compile(r"[a-z]+[0-9]+")\ndef main():\n    lines = open("input.csv", encoding="utf-8").read().split("\\n")\n    seen = set()\n    kept = []\n'
  + '    for line in lines[1:]:\n        if not line:\n            continue\n        key, value, tag = line.split(",")\n        if key in seen:\n            continue\n        seen.add(key)\n'
  + '        if TAG.fullmatch(tag) is None:\n            continue\n        kept.append((int(value), key, tag))\n    kept.sort(key=lambda r: (-r[0], r[1]))\n'
  + '    open("out.csv", "w", encoding="utf-8").write("key,value,tag\\n" + "".join(k + "," + str(v) + "," + t + "\\n" for v, k, t in kept))\nmain()\n';

test('IE7: an external-agent@1 file - its targets, its mode, a finite budget', () => {
  const ok = { format: 'external-agent@1', id: 'scout', targets: ['a.json'], budget: { max_contributions: 1, max_reads: 1, minutes: 1 } };
  assert.deepEqual(externalSpecProblems(ok), []);
  assert.match(externalSpecProblems({ ...ok, budget: { max_contributions: 0, max_reads: 1, minutes: 1 } }).join(), /max_contributions/);
  assert.match(externalSpecProblems({ ...ok, budget: undefined }).join(), /none unbounded/);
  assert.match(externalSpecProblems({ ...ok, mode: 'boss' }).join(), /contribute.*seat/);
  assert.match(externalSpecProblems({ ...ok, id: 'Bad Id' }).join(), /"id"/);
});

test('IE7: it reads a run within its reads, learns what its world takes, checks before it delivers; nothing malformed and nothing to a world closed to external sources is delivered; delivered once, with its unobserved exposure', () => {
  const dir = tmp('external-');
  const art = journal(dir, 'art', 'artifacts@1'), closed = journal(dir, 'nav', 'c302-navigation@1');
  const { session, resumed } = openExternal(agentFile(dir, [art, closed]));
  assert.equal(resumed, false);
  assert.equal(openExternal(agentFile(dir, [art, closed])).resumed, true, 'the same file resumes its session');
  const r = readExternal(session, 'art');
  assert.deepEqual([r.cut, r.reads_left, r.experiment], [2, 1, 'artifacts@1']);
  assert.ok(r.digest, 'the run as its researcher lived it');
  readExternal(session, 'art');
  assert.throws(() => readExternal(session, 'art'), /reads are spent/);
  /* What each world takes. */
  const f = formatsExternal(session, 'art');
  assert.deepEqual(f.formats.map((x: { id: string }) => x.id), ['artifact-files@1']);
  assert.match(f.formats[0].adopt, /"adopt"/);
  const n = formatsExternal(session, 'nav');
  assert.match(String(n.refused), /admits no external sources/);
  /* Checked as its importer would, spending nothing. */
  const bad = write(dir, 'bad.json', JSON.stringify({ files: { '../escape.py': 'x' } }));
  const good = write(dir, 'fast.json', JSON.stringify({ files: { 'main.py': FAST } }));
  assert.match(checkExternal(session, 'art', bad, 'artifact-files@1').problems.join(), /never outside it/);
  assert.deepEqual(checkExternal(session, 'art', good, 'artifact-files@1').problems, []);
  assert.match(checkExternal(session, 'art', good, 'mask@1').problems.join(), /does not take mask@1/);
  /* Nothing malformed reaches anyone. */
  const report = 'I read the base: it keeps seen keys in a list. I infer a set would help. I tested it on my machine only.';
  assert.throws(() => contributeExternal(session, { to: ['art'], report, artifacts: [{ format: 'artifact-files@1', file: bad }] }), /nothing delivered/);
  assert.equal(inbox(art).length, 0);
  /* Delivered: kept by content beside the run, a message once, never a directive, its exposure unobserved; to a world
     closed to external sources, kept and never delivered. */
  const c = contributeExternal(session, { to: ['art', 'nav'], report, summary: 'a set instead of a list', artifacts: [{ format: 'artifact-files@1', file: good }], tested: write(dir, 'tested.txt', 'twice as fast on 10k rows here') });
  assert.equal(c.contribution, 'C1-scout');
  const orders = inbox(art);
  assert.equal(orders.length, 1);
  assert.deepEqual([orders[0].kind, orders[0].by, orders[0].directive], ['message', 'agent:scout', undefined]);
  assert.deepEqual(orders[0].external_exposure, { direct: true, via: ['agent:scout'], since: null, unobserved: true });
  assert.equal(orders[0].contribution.artifacts[0].format, 'artifact-files@1');
  assert.ok(fs.existsSync(path.join(dir, 'blobs', orders[0].contribution.artifacts[0].id)), 'the artifact kept by its content beside the run');
  assert.match(orders[0].text, /EXTERNAL agent/);
  assert.match(orders[0].text, /its claim, never your environment's answer/);
  assert.match(orders[0].text, /"act": \{"adopt": \{"contribution": "C1-scout"/);
  assert.equal(inbox(closed).length, 0, 'never delivered to a world closed to external sources');
  assert.equal(c.deliveries.find((d: { to: string }) => d.to === 'nav.json').state, 'kept_world_refuses');
  assert.throws(() => contributeExternal(session, { to: ['art'], report }), /contributions to art.json are spent/);
  /* What became of it, as the recipient saw it; then closed. */
  const s = statusExternal(session);
  assert.equal(s.contributions[0].recipients[0].order, 'pending');
  assert.equal(closeExternal(session).state, 'ended');
  assert.throws(() => readExternal(session, 'art'), /session is ended/);
  const record = JSON.parse(fs.readFileSync(session, 'utf8'));
  assert.deepEqual([record.actor, record.unobserved, record.format], ['external', true, 'operator-research-record@1']);
});

/** System 2 standing in for an artifacts run: it adopts what a contribution carries in its first round, then proposes. */
function adopting(seen: Record<string, any>[], adopt: (user: Record<string, any>) => Record<string, unknown>): FetchLike {
  return async (_url, init) => {
    const b = JSON.parse(String(init.body));
    const sys = b.messages[0].content as string;
    const grading = sys.startsWith('You grade');
    const user = grading ? {} : JSON.parse(userOf(b));
    if (!grading) seen.push(user);
    const done = (user.investigation ?? []).length;
    const content = grading ? { grades: [], false_beliefs: [], form: 'compact', form_evidence: 'e' }
      : 'task' in user ? { rationale: 'r', beliefs: [{ id: 'b', stance: 'keep', why: 'w' }], lessons: ['l'], next_experiment: 'n' }
      : user.round === 1 && done === 0 ? { investigate: [{ act: { adopt: adopt(user) } }] }
      : { rationale: 'r', observations: {}, rules: {}, weights: {}, output: '(p) => p.changed.length ? 60 : 120', validate: false, beliefs: [{ id: 'b', stance: user.round === 1 ? 'new' : 'keep', statement: 's', evidence: [] }], lessons: ['l'] };
    const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 100 } });
    return { ok: true, status: 200, text: async () => text, headers: { get: () => null } };
  };
}
const ARGS = ['--artifact', 'dedup', '--scale', '0.2', '--seed', '1', '--researcher', 'assisted', '--steps', '2', '--attempts', '1', '--flat', '--no-grade', '--no-reflection', '--no-ablation', '--agents', 'scout=message'];

test('IE8: the researcher adopts what an external agent contributed as a change of its own - recorded as that change, rebuilt from it, marked adopted, its run exposed and unobserved; the agent sees what its world answered', async () => {
  const dir = tmp('adopt-');
  const run = path.join(dir, 'run.json');
  fs.writeFileSync(run, JSON.stringify({ experiment: 'artifacts@1', events: [] }));
  const { session } = openExternal(agentFile(dir, [run]));
  contributeExternal(session, { to: ['run'], report: 'Keep seen keys in a set; sort once.', artifacts: [{ format: 'artifact-files@1', file: write(dir, 'fast.json', JSON.stringify({ files: { 'main.py': FAST } })) }] });
  const seen: Record<string, any>[] = [];
  const base = (u: Record<string, any>) => (u.notebook?.episodes ?? []).find((e: any) => e.version)?.version;
  const r = await runLaboratory(artifactsLab, { args: [...ARGS, '--out', run], root: dir, llm: { url: 'http://system2.test/chat', model: 'stand-in' },
    fetch: adopting(seen, (u) => ({ contribution: 'C1-scout', artifact: 'fast.json', from: base(u), why: 'the agent says a set is faster', expect: 'faster where keys are many' })) });
  const j = JSON.parse(fs.readFileSync(r.journal, 'utf8'));
  assert.match(JSON.stringify(seen[0]), /C1-scout/, 'the contribution reached the researcher with its first question');
  const inv = j.events.find((e: any) => e.type === 'investigation');
  const asked = inv.requests[0].act.change;
  assert.equal(asked.files['main.py'], FAST, 'recorded as the change it is, whole: what rebuilds it');
  assert.deepEqual(asked.contributed.contribution, 'C1-scout');
  assert.equal(inv.results[0].accepted, true, JSON.stringify(inv.results[0]));
  const exposure = exposureOf(j);
  assert.deepEqual([exposure.via, exposure.unobserved], [['agent:scout'], true]);
  /* The finding counts it apart: received, and adopted with what its world answered. */
  const adopted = r.finding.external_research?.adopted as Record<string, unknown>[];
  assert.deepEqual(adopted.map((a) => [a.contribution, a.act, a.accepted]), [['C1-scout', 'change', true]]);
  /* The agent sees what the researcher saw. */
  const st = statusExternal(session).contributions[0].recipients[0];
  assert.deepEqual([st.order, st.received], ['accepted', true]);
  assert.equal(st.adoptions[0].answer.accepted, true);
  /* Resumed: the version made again from the change recorded. */
  const again = await runLaboratory(artifactsLab, { args: ['--resume', r.journal, '--out', path.join(dir, 'again.json')], root: dir, llm: { url: 'http://system2.test/chat', model: 'stand-in' }, fetch: adopting([], () => ({})) });
  assert.notEqual(again.stoppedBy, 'diverged');
});

test('IE8: what was never delivered to the run cannot be adopted, nor an artifact of another world', async () => {
  const dir = tmp('adopt-none-');
  const seen: Record<string, any>[] = [];
  const r = await runLaboratory(artifactsLab, { args: [...ARGS, '--out', path.join(dir, 'run.json')], root: dir, llm: { url: 'http://system2.test/chat', model: 'stand-in' },
    fetch: adopting(seen, () => ({ contribution: 'C9-nobody', artifact: 'x', from: 'v', why: 'w', exploratory: true })) });
  const inv = JSON.parse(fs.readFileSync(r.journal, 'utf8')).events.find((e: any) => e.type === 'investigation');
  assert.match(JSON.stringify(inv.warnings), /no contribution C9-nobody reached you/);
});

/* --- The junior's world: a mask contributed --------------------------------------------------------------------- */

const GATE = 'model.layers.4.mlp.gate_proj', CIRCUIT = 'model.layers.1.mlp.gate_proj';
const bf16 = (shape: number[], values: number[]): RawTensor => ({ dtype: 'BF16', shape, bytes: new Uint8Array(Uint16Array.from(values.map(bf16Bits)).buffer) });
const BOUNDS: MaskBounds = { per_module: { max_fraction: 0.5 }, total: { max_fraction: 0.5 } };

test('IE8: a mask contributed is adopted in the junior\'s world as a child within the condition\'s bounds - learned "contributed", owing its contribution, and the confirmation refuses it; past its bounds no version', async () => {
  const dir = tmp('adopt-mask-');
  const store = new BlobStore(path.join(dir, 'blobs'));
  const b = path.join(dir, 'base');
  fs.mkdirSync(b);
  fs.writeFileSync(path.join(b, 'model.safetensors'), writeSafetensors({ [GATE + '.weight']: bf16([4, 4], Array.from({ length: 16 }, (_, i) => i + 1)), [CIRCUIT + '.weight']: bf16([2, 2], [1, 2, 3, 4]) }));
  fs.writeFileSync(path.join(b, 'config.json'), JSON.stringify({ num_hidden_layers: 6 }));
  const pkg = normalizePackage({ format: 'junior-package@1', name: 'start', base: store.putTree(b), prompt: '',
    execution: { firmware: store.put('f'), tokenizer: store.put('{}'), chat_template: store.put('c'), driver: store.put('d'), verifier: store.put('v'), circuit: { chip_layers: 2 }, precision: 'bf16' } });
  const manifest = { format: 'junior-competence-manifest@1', id: 'mask', reference: executionHash(pkg),
    components: [{ id: 'a', rung: 1, mode: 'start', extractor: { id: 'probe', version: 1 }, unit: 'share', direction: 'up', target: 1, bad: 0, tolerance: 0 }],
    cases: [{ id: 'p0', kind: 'probe', partition: 'development', group: 'g-sel', component: 'a', lab: 'cells', mode: 'start', cut: { run: 'x.json', question: 0, hash: 'h' }, competence: 'protocol', instruction: 'i', checker: { id: 'protocol', version: 1 } }],
    investigation_repetitions: 1, execution: {}, sampling: { seed: 1 }, promotion: { procedure: 'paired-cases@1', alpha: 0.05, permutations: 1000, seed: 1 },
    limits: { junior_args: ['--max-tokens', '1000', '--max-judge-calls', '10'], probe_max_tokens: 500, timeout_ms: 60000 }, masks: BOUNDS } as unknown as CompetenceManifest;
  const w = new JuniorWorld({ manifest, base: pkg, blobs: path.join(dir, 'blobs'), server: 'http://127.0.0.1:9', dir: path.join(dir, 'world'), evaluations: 4, edits: 4 });
  const format = juniorLab.contributions!.formats.find((f) => f.id === 'mask@1')!;
  const bytes = Buffer.from(JSON.stringify({ format: 'mask@1', deletions: [{ module: GATE, indices: [3, 0, 1] }] }));
  assert.deepEqual(format.check(bytes), []);
  assert.match(format.check(Buffer.from(JSON.stringify({ format: 'mask@1', deletions: [{ module: GATE, indices: [-1] }] }))).join(), /non-negative/);
  const contributed = { contribution: 'C1-scout', artifact: 'a'.repeat(64), by: 'agent:scout' };
  assert.match(String(format.adopt(bytes, { from: w.reference }, contributed)), /says why/);
  const act = format.adopt(bytes, { from: w.reference, why: 'delete the smallest', exploratory: true }, contributed) as unknown as { adopt_mask: { deletions: { indices: number[] }[] } };
  assert.deepEqual(act.adopt_mask.deletions[0].indices, [0, 1, 3], 'its indices in order');
  assert.deepEqual(juniorLab.act!.asWritten!(act as never), { adopt_mask: { ...act.adopt_mask, deletions: { modules: 1, indices: 3 } } }, 'recorded by its size, never by its indices');
  assert.match(String(juniorLab.act!.parse({ adopt_mask: act.adopt_mask } as never)), /no field "adopt_mask"/, 'never written by the researcher');
  const t = await w.adoptMask(w.reference, act.adopt_mask.deletions as never, contributed, { why: 'delete the smallest', exploratory: true });
  assert.equal(t.state, 'finished', String(t.reason));
  const child = await w.packageOf(t.version!);
  assert.ok(typeof child !== 'string', String(child));
  assert.equal(adapterKind(w.blobs, child), 'mask');
  assert.equal(child.provenance.learned, 'contributed');
  assert.equal(child.provenance.realizations, undefined, 'what it was learned from is not known');
  assert.ok(child.provenance.sources.includes('contribution:C1-scout'));
  assert.deepEqual(verifyMask(w.blobs, child, BOUNDS), []);
  assert.deepEqual([owes(child).trained, owes(child).edited], [false, false]);
  assert.match(String(ConfirmationService.prototype.refusalOf.call({}, child)), /adopted from a contribution/);
  /* Past the condition's bounds, or in the circuit: no version. */
  const many = await w.adoptMask(w.reference, [{ module: GATE, indices: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] }], contributed, { why: 'w', exploratory: true });
  assert.equal(many.state, 'refused');
  const circuit = await w.adoptMask(w.reference, [{ module: CIRCUIT, indices: [0] }], contributed, { why: 'w', exploratory: true });
  assert.equal(circuit.state, 'refused');
});

test('IE8: a method program contributed is adopted in the junior\'s world as the program recipe of a training of the researcher\'s, with the contribution it came from', () => {
  const format = juniorLab.contributions!.formats.find((f) => f.id === 'method-program@1')!;
  const program = { format: 'method-program@1', entrypoint: 'main.py', files: { 'main.py': 'print(1)' }, profile: 'cpu', inputs: ['dataset.jsonl'], parameters: {}, seed: 1, output_format: 'mask@1' };
  assert.deepEqual(format.check(Buffer.from(JSON.stringify(program))), []);
  assert.match(format.check(Buffer.from(JSON.stringify({ ...program, seed: 'x' }))).join(), /seed/, 'the shape of a program is that of the executor (IE5)');
  assert.match(format.check(Buffer.from(JSON.stringify({ ...program, inputs: [] }))).join(), /dataset.jsonl/);
  const contributed = { contribution: 'C1-scout', artifact: 'b'.repeat(64), by: 'agent:scout' };
  const act = format.adopt(Buffer.from(JSON.stringify(program)), { from: 'v1', dataset: 'd'.repeat(64), why: 'a method from a paper', exploratory: true }, contributed) as unknown as { train: Record<string, any> };
  assert.equal(act.train.recipe.method, 'program');
  assert.deepEqual(act.train.recipe.admits, ['verified']);
  assert.deepEqual(act.train.contributed, contributed);
});

/* --- The external seat (IE9) -------------------------------------------------------------------------------------- */

test('IE9: a seat is a folder - a turn left as a model would receive it, answered once; a run served from it is recorded as from a model, with no address, and is exposed and unobserved', async () => {
  const dir = tmp('seat-');
  const folder = path.join(dir, 'seat');
  /* A client: its turn waits; answered, it returns; answered again, refused. */
  const client = openAiChatClient({ url: 'seat:' + folder, model: 'agent', jsonMode: true, fetch: seatFetch(undefined) });
  const asked = client.complete({ system: 'You are S', user: { hello: 1 } });
  let turns: ReturnType<typeof pendingTurns> = [];
  for (let i = 0; i < 100 && !turns.length; i++) { await new Promise((r) => setTimeout(r, 10)); turns = pendingTurns(folder); }
  assert.equal(turns.length, 1);
  assert.equal(turns[0].body.messages![0].content, 'You are S');
  assert.deepEqual(answerTurn(folder, turns[0].id, '{"ok": true}'), { ok: true });
  assert.equal((await asked).content, '{"ok": true}');
  assert.match(String((answerTurn(folder, turns[0].id, 'again') as { refused: string }).refused), /answered already/);
  assert.equal(pendingTurns(folder).length, 0);
  /* A whole run served from a seat by an agent answering its turns (here a stand-in, through the CLI). */
  const seen: Record<string, any>[] = [];
  const stand = adopting(seen, () => ({}));
  let stop = false;
  const answering = (async () => {
    while (!stop) {
      for (const t of pendingTurns(folder)) {
        const res = await stand('seat', { method: 'POST', headers: {}, body: JSON.stringify(t.body), signal: new AbortController().signal });
        const content = JSON.parse(await res.text()).choices[0].message.content as string;
        const file = path.join(dir, 'answer-' + t.id + '.json');
        fs.writeFileSync(file, content);
        const lines: string[] = [];
        assert.equal(await labCli(['external', 'answer', folder, t.id, file], { root: dir, out: (l) => lines.push(l) }), 0, lines.join('\n'));
      }
      await new Promise((r) => setTimeout(r, 20));
    }
  })();
  const plain = ARGS.filter((a, i) => a !== '--agents' && ARGS[i - 1] !== '--agents');
  const r = await runLaboratory(artifactsLab, { args: [...plain, '--out', path.join(dir, 'run.json')], root: dir, llm: { url: 'seat:' + folder, model: 'agent' } });
  stop = true;
  await answering;
  const j = JSON.parse(fs.readFileSync(r.journal, 'utf8'));
  assert.ok(j.events.some((e: any) => e.type === 'proposal'), 'the seat answered as System 2');
  assert.equal(j.config.llm_provider, 'external-seat');
  assert.equal(j.config.llm_path, undefined, 'the folder is never recorded');
  const x = exposureOf(j);
  assert.deepEqual([x.direct, x.unobserved], [true, true]);
});
