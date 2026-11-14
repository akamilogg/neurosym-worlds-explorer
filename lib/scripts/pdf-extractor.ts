/* ============================================================================
 * A PDF extractor for PDF_EXTRACTOR (SPEC-INVESTIGACION-EXTERNA §5.2): reads a PDF on its standard input and writes
 * {"pages": [...], "version": "..."} - each page's text, and what extracted it. It uses `pdftotext` (Xpdf or Poppler),
 * which the environment provides or not: the harness never installs it, and without an extractor a PDF answers
 * `unsupported_media`.
 *
 *   PDF_EXTRACTOR="node --experimental-strip-types --no-warnings=ExperimentalWarning scripts/pdf-extractor.ts"
 *
 * With PDFTOTEXT, the path of the binary (default: pdftotext on the PATH).
 * ========================================================================== */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const bin = process.env.PDFTOTEXT || 'pdftotext';
const chunks: Buffer[] = [];
for await (const c of process.stdin) chunks.push(c as Buffer);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-'));
try {
  const pdf = path.join(dir, 'in.pdf'), txt = path.join(dir, 'out.txt');
  fs.writeFileSync(pdf, Buffer.concat(chunks));
  const r = spawnSync(bin, ['-enc', 'UTF-8', '-layout', pdf, txt], { timeout: 110_000 });
  if (r.status !== 0) { process.stderr.write(bin + ' failed: ' + String(r.stderr ?? r.error ?? '').slice(0, 300)); process.exit(1); }
  const v = spawnSync(bin, ['-v']);
  const version = (String(v.stderr ?? '') + String(v.stdout ?? '')).split('\n')[0].trim() || bin;
  /* pdftotext ends each page with a form feed. */
  const pages = fs.readFileSync(txt, 'utf8').split('\f');
  if (pages.length > 1 && !pages[pages.length - 1].trim()) pages.pop();
  process.stdout.write(JSON.stringify({ pages, version }));
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
