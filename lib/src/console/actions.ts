import fs from 'node:fs';
import path from 'node:path';
import { ResearchStore, assertId, read, write, hash, type Json } from './store.ts';
import { orderOutcome, runFiles, runStatus, startRun, resumeRun, type RunOrder } from '../runtime/control.ts';
import type { Analysts } from './analyst.ts';
import { LABS } from '../worlds/labs.ts';

/** Durable outbox. Message writes can be reconciled; ambiguous process launches are never repeated. */
export class Actions {
  readonly store: ResearchStore;
  readonly analysts: Analysts;
  readonly env?: NodeJS.ProcessEnv;
  constructor(store: ResearchStore, analysts: Analysts, env?: NodeJS.ProcessEnv) { this.store = store; this.analysts = analysts; this.env = env; }
  file(id: string): string { assertId(id); return path.join(this.store.dir, 'orders', id + '.json'); }
  list(): Json[] {
    const dir = path.join(this.store.dir, 'orders');
    return fs.existsSync(dir) ? fs.readdirSync(dir).filter(x => x.endsWith('.json')).map(x => this.get(x.slice(0, -5))) : [];
  }
  get(id: string): Json {
    const v = read(this.file(id)); if (!v) throw new Error('Order not found');
    for (const target of v.targets ?? []) {
      if (target.error) continue;
      try {
        const s = this.store.source(target.entity), journal = s.journal;
        const delivered = (journal.events ?? []).find((e: Json) => e.type === 'operator_message' && (e.messages ?? []).some((m: Json) => m.id === target.id));
        const outcome = orderOutcome(s.file, target.id);
        target.state = delivered ? 'delivered' : outcome.state;
        if (outcome.reason) target.reason = outcome.reason;
        const state = runStatus(s.file).state;
        if (v.input.kind === 'stop' && state === 'ended') target.state = 'ended';
        else if (!delivered && state === 'ended' && outcome.state !== 'refused') target.state = 'undelivered';
      } catch { target.state = 'unknown'; }
    }
    return v;
  }
  send(input: Json): Json {
    const id = String(input.key ?? ''); assertId(id);
    const was = read(this.file(id));
    if (was && was.fingerprint !== hash(input)) throw new Error('Idempotency key already used for a different action');
    if (was?.state === 'dispatched') return this.get(id);
    if (was && ['start', 'resume', 'branch'].includes(input.kind)) throw new Error('Launch outcome is uncertain; inspect the catalogue before creating another run');
    const kinds = ['message', 'stop', 'focus', 'source', 'start', 'resume', 'branch'];
    if (!kinds.includes(input.kind)) throw new Error('Unknown control action');
    if (input.analysis) {
      const a = this.analysts.get(String(input.analysis));
      if (a.profile !== 'researcher' || !a.reports.length) throw new Error('Only researcher-profile reports may be shared');
      const s = this.store.snapshot(a.snapshot);
      if (input.kind !== 'message' || s.entities.length !== 1 || input.targets?.length !== 1 || input.targets[0] !== s.entities[0].id) throw new Error('Cross-run analytic assistance needs a declared team condition; teams are not implemented');
      if (!a.reports.some(r => JSON.stringify(r.report).includes(String(input.text)))) throw new Error('Share an exact report passage; edits must be sent as a human message');
    }
    const v: Json = was ?? { id, at: new Date().toISOString(), fingerprint: hash(input), input, state: 'prepared', targets: [] };
    if (!was) write(this.file(id), v);
    if (input.kind === 'start') {
      if (!LABS[input.lab]) throw new Error('Unknown lab');
      const args: string[] = [];
      for (const [key, flag] of [['seed', '--seed'], ['attempts', '--attempts'], ['budget', '--max-tokens']]) {
        const n = Number(input[key]); if (!Number.isSafeInteger(n) || n < 1) throw new Error('Positive integer required: ' + key); args.push(flag, String(n));
      }
      if (input.level !== undefined && input.level !== '') { if (!Number.isSafeInteger(Number(input.level)) || Number(input.level) < 1) throw new Error('Invalid level'); args.push('--level', String(input.level)); }
      if (!['assisted', 'unknown-world'].includes(input.researcher)) throw new Error('Unknown researcher');
      if (input.flat === true) args.push('--flat');
      if (input.task) { if (input.researcher !== 'assisted') throw new Error('Tasks require an assisted researcher'); args.push('--task', String(input.task)); }
      v.result = startRun(input.lab, { root: this.store.root, args, researcher: input.researcher, env: this.env });
    } else if (['resume', 'branch'].includes(input.kind)) {
      const s = this.store.source(String(input.entity)), entity = this.store.catalogue().find(x => x.id === input.entity)!;
      if (entity.revision !== input.revision) throw new Error('The run changed. Refresh before acting.');
      if (!entity.capabilities.resume) throw new Error('The run is still active');
      const args: string[] = [];
      if (!Number.isSafeInteger(input.budget) || input.budget < 1) throw new Error('A token budget is required');
      args.push('--max-tokens', String(input.budget));
      if (input.kind === 'branch') {
        if (!entity.capabilities.branch || !Number.isSafeInteger(input.attempts) || input.attempts <= Number(s.journal.config?.attempts)) throw new Error('Branch needs a budget-ended run and a larger round limit');
        if (!String(input.condition ?? '').trim()) throw new Error('Declare the branch condition');
        args.push('--attempts', String(input.attempts));
        if (input.text) args.push('--researcher', 'assisted');
      }
      v.result = resumeRun(s.file, { args, env: this.env });
      if (input.kind === 'branch' && input.text) {
        fs.appendFileSync(runFiles(v.result.journal).inbox, JSON.stringify({ id: 'console-' + id + '-initial', at: v.at, kind: 'message',
          text: String(input.text), by: 'human:console' }) + '\n');
      }
    } else {
      const ids: string[] = input.targets;
      if (!Array.isArray(ids) || !ids.length || ids.length > 100 || new Set(ids).size !== ids.length) throw new Error('Select distinct recipients');
      if (input.kind === 'message' && (!String(input.text ?? '').trim() || input.text.length > 20000)) throw new Error('Message must have 1–20000 characters');
      for (let i = 0; i < ids.length; i++) {
        const entity = ids[i], oid = 'console-' + id + '-' + i;
        if (v.targets.some((t: Json) => t.entity === entity)) continue;
        try {
          const s = this.store.source(entity), cap = this.store.catalogue().find(x => x.id === entity)!;
          if (input.revisions?.[entity] !== cap.revision) throw new Error('The run changed. Refresh before acting.');
          if (input.kind === 'stop' ? !cap.capabilities.stop : !cap.capabilities.message) throw new Error('This run cannot receive this order');
          const order: RunOrder = input.kind === 'stop' ? { kind: 'stop', by: 'human:console' }
            : input.kind === 'message' ? { kind: 'message', text: String(input.text), by: input.analysis ? 'human:console/analysis:' + input.analysis : 'human:console' }
            : input.kind === 'focus' ? { kind: 'focus', facet: String(input.facet ?? ''), by: 'human:console' }
            : { kind: 'source', source: String(input.source ?? ''), by: 'human:console' };
          const inbox = runFiles(s.file).inbox;
          const lines = fs.existsSync(inbox) ? fs.readFileSync(inbox, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return {}; } }) : [];
          if (!lines.some(x => x.id === oid)) fs.appendFileSync(inbox, JSON.stringify({ id: oid, at: v.at, ...order }) + '\n');
          v.targets.push({ entity, id: oid, state: 'pending' });
        } catch (e) { v.targets.push({ entity, id: oid, state: 'refused', error: String((e as Error).message) }); }
        write(this.file(id), v);
      }
    }
    v.state = 'dispatched'; write(this.file(id), v); return this.get(id);
  }
}
