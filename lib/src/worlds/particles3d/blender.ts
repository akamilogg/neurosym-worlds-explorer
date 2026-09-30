import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* ============================================================================
 * Starting particles3d@1's environment: a headless Blender running lib/blender/particles_service.py
 * (Node only). Blender is found in BLENDER, else where it is usually installed, else on the PATH.
 * ========================================================================== */

export const SERVICE_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../blender/particles_service.py');
/** The viewer: an episode's paths, real and as a law answers them, saved as a .blend file. */
export const VIEW_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../blender/view_trajectories.py');

/** Where Blender is, or null. */
export function findBlender(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.BLENDER && fs.existsSync(env.BLENDER)) return env.BLENDER;
  const candidates: string[] = [];
  if (process.platform === 'win32') {
    const root = 'C:\\Program Files\\Blender Foundation';
    if (fs.existsSync(root)) for (const d of fs.readdirSync(root).sort().reverse()) candidates.push(path.join(root, d, 'blender.exe'));
  } else if (process.platform === 'darwin') candidates.push('/Applications/Blender.app/Contents/MacOS/Blender');
  else candidates.push('/usr/bin/blender', '/usr/local/bin/blender', '/snap/bin/blender');
  return candidates.find((c) => fs.existsSync(c)) ?? null;
}

export interface BlenderService { readonly url: string; readonly version: string; readonly process: ChildProcess; stop(): void }

/** Starts the service on a port and waits until it answers (at most `timeoutMs`). */
export async function startBlenderService(options: { port: number; blender?: string; timeoutMs?: number; quiet?: boolean }): Promise<BlenderService> {
  const blender = options.blender ?? findBlender();
  if (!blender) throw new Error('Blender was not found: set BLENDER to its executable');
  const child = spawn(blender, ['-b', '--factory-startup', '--python', SERVICE_SCRIPT, '--', '--port', String(options.port)],
    { stdio: options.quiet ? 'ignore' : ['ignore', 'inherit', 'inherit'], windowsHide: true });
  const url = 'http://127.0.0.1:' + options.port;
  const stop = () => { if (child.exitCode === null) child.kill(); };
  const deadline = Date.now() + (options.timeoutMs ?? 60000);
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('Blender exited (' + child.exitCode + ') before its service answered');
    try {
      const r = await fetch(url + '/health');
      if (r.ok) return { url, version: String(((await r.json()) as { blender?: string }).blender ?? ''), process: child, stop };
    } catch { /* not yet */ }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  stop();
  throw new Error('the Blender service did not answer within ' + (options.timeoutMs ?? 60000) + ' ms');
}
