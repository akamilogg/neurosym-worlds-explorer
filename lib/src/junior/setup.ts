import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/* ============================================================================
 * The junior's MACHINE checked before every investigation (SPEC-METAPOLITICA-APRENDIZAJE §12). Copies, snapshots, the
 * network and quotas are the operator's setup: the harness installs and configures nothing. It checks that each piece
 * is covered by at least one check of the operator's, and that every check holds; otherwise it refuses to start.
 *
 * junior-machine-check@1:
 *   { "format": "junior-machine-check@1", "checks": [ { "id", "covers": [piece...], "kind", ... } ] }
 *
 * Pieces: backups (copies off the machine), snapshots, keys (no provider key here), proxy (the providers' proxy reached),
 * egress (the network limited), limits (disk, GPU hours or tokens bounded outside the model's reach).
 * Kinds: no_keys {allow?: [names]}, writable {path}, command {argv, exit?}, http {url, expect?: [status]},
 *        unreachable {url}, disk_free {path, min_gb}.
 * ========================================================================== */

export const PIECES = ['backups', 'snapshots', 'keys', 'proxy', 'egress', 'limits'] as const;
export type Piece = typeof PIECES[number];

export interface MachineCheck {
  readonly id: string;
  readonly covers: readonly Piece[];
  readonly kind: 'no_keys' | 'writable' | 'command' | 'http' | 'unreachable' | 'disk_free';
  readonly allow?: readonly string[];
  readonly path?: string;
  readonly argv?: readonly string[];
  readonly exit?: number;
  readonly url?: string;
  readonly expect?: readonly number[];
  readonly min_gb?: number;
}

export interface CheckResult { readonly id: string; readonly ok: boolean; readonly detail: string }
export interface MachineReport { readonly ok: boolean; readonly results: readonly CheckResult[]; readonly uncovered: readonly Piece[] }

/** Names that look like a provider's secret. A client token of the proxy is allowed by name (`allow`). */
const SECRET = /(API_?KEY|_KEY|SECRET|TOKEN|PASSWORD)$/i;

export function validateMachineCheck(raw: unknown): MachineCheck[] {
  const c = raw as { format?: unknown; checks?: unknown };
  if (!c || c.format !== 'junior-machine-check@1' || !Array.isArray(c.checks)) throw new Error('a junior-machine-check@1 with its checks');
  const ids = new Set<string>();
  for (const k of c.checks as MachineCheck[]) {
    if (!k.id || ids.has(k.id)) throw new Error('every check has an id of its own');
    ids.add(k.id);
    if (!Array.isArray(k.covers) || !k.covers.length || k.covers.some((p) => !PIECES.includes(p))) throw new Error(k.id + ': covers one or more of ' + PIECES.join(', '));
    const need: Record<string, string[]> = { writable: ['path'], command: ['argv'], http: ['url'], unreachable: ['url'], disk_free: ['path', 'min_gb'], no_keys: [] };
    if (!(k.kind in need)) throw new Error(k.id + ': unknown kind ' + k.kind);
    for (const f of need[k.kind]) if ((k as unknown as Record<string, unknown>)[f] === undefined) throw new Error(k.id + ': ' + k.kind + ' needs ' + f);
  }
  return c.checks as MachineCheck[];
}

async function one(k: MachineCheck, env: NodeJS.ProcessEnv, fetchImpl: typeof globalThis.fetch): Promise<CheckResult> {
  try {
    switch (k.kind) {
      case 'no_keys': {
        const found = Object.keys(env).filter((n) => SECRET.test(n) && env[n] && !(k.allow ?? []).includes(n));
        return { id: k.id, ok: !found.length, detail: found.length ? 'secrets in the environment: ' + found.join(', ') : 'no provider key in the environment' };
      }
      case 'writable': {
        const probe = path.join(k.path!, '.junior-check-' + process.pid);
        fs.writeFileSync(probe, 'x');
        fs.rmSync(probe);
        return { id: k.id, ok: true, detail: k.path + ' is writable' };
      }
      case 'command': {
        const r = spawnSync(k.argv![0], k.argv!.slice(1), { encoding: 'utf8', timeout: 60_000 });
        const want = k.exit ?? 0;
        return { id: k.id, ok: r.status === want, detail: k.argv!.join(' ') + ' exited ' + (r.status ?? r.error?.message) + (r.status === want ? '' : ' (wanted ' + want + ')') };
      }
      case 'http': {
        const r = await fetchImpl(k.url!, { signal: AbortSignal.timeout(10_000) });
        const ok = (k.expect ?? [200]).includes(r.status);
        return { id: k.id, ok, detail: k.url + ' answered ' + r.status };
      }
      case 'unreachable': {
        try {
          const r = await fetchImpl(k.url!, { signal: AbortSignal.timeout(10_000) });
          return { id: k.id, ok: false, detail: k.url + ' is reachable (' + r.status + '): the network is not limited' };
        } catch { return { id: k.id, ok: true, detail: k.url + ' is unreachable' }; }
      }
      case 'disk_free': {
        const s = fs.statfsSync(k.path!);
        const gb = (s.bavail * s.bsize) / 1e9;
        return { id: k.id, ok: gb >= k.min_gb!, detail: k.path + ': ' + gb.toFixed(1) + ' GB free (at least ' + k.min_gb + ')' };
      }
    }
  } catch (e) { return { id: k.id, ok: false, detail: String((e as Error)?.message ?? e) }; }
}

/** Every check run; the machine is ready only if each piece is covered by at least one check and every check holds. */
export async function checkMachine(raw: unknown, o: { env?: NodeJS.ProcessEnv; fetch?: typeof globalThis.fetch } = {}): Promise<MachineReport> {
  const checks = validateMachineCheck(raw);
  const results: CheckResult[] = [];
  for (const k of checks) results.push(await one(k, o.env ?? process.env, o.fetch ?? globalThis.fetch));
  const uncovered = PIECES.filter((p) => !checks.some((k) => k.covers.includes(p)));
  return { ok: !uncovered.length && results.every((r) => r.ok), results, uncovered };
}
