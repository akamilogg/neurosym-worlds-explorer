/* Builds a VISUAL SYNTHESIS of a run from its journal: one self-contained HTML page (no dependencies, no network), to
   look at a run afterwards or to present it.

     node --experimental-strip-types scripts/journal-view.ts runs/<journal>.json [--out file.html]
         -> the page with that journal inside it (default: next to the journal, .html)
     node --experimental-strip-types scripts/journal-view.ts --blank [--out file.html]
         -> the page without a journal: drop any journal on it (default: ../journal-viewer.html)

   The page (src/view/page.ts) shows the most relevant moments in order - a relevance threshold and "only the path to the
   final model" select them - the laboratories' checks round by round, the lineage of each belief, every moment on a
   timeline, the final model, and, apart, what only the operator sees. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const lib = path.resolve(here, '..');

export async function viewerScript(): Promise<string> {
  const result = await build({
    stdin: { contents: "import { boot } from './src/view/page.ts'; boot();", resolveDir: lib, loader: 'ts' },
    absWorkingDir: lib, bundle: true, write: false, format: 'iife', target: 'es2020', platform: 'browser', legalComments: 'none', charset: 'utf8', minify: true
  });
  return result.outputFiles[0].text;
}

const CSS = `
:root { color-scheme: light;
  --page: #f9f9f7; --surface: #fcfcfb; --surface-2: #f3f2ef; --border: #e2e1dc;
  --text: #0b0b0b; --text-2: #52514e; --muted: #7a7973;
  --accent: #2a78d6; --good: #0ca30c; --critical: #d03b3b;
  --st-new: #2a78d6; --st-revise: #eb6834; --st-confirm: #1baf7a; --st-keep: #9b9a93; --st-drop: #e34948;
  --path: #4a3aa7; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { color-scheme: dark;
  --page: #0d0d0d; --surface: #1a1a19; --surface-2: #232321; --border: #33332f;
  --text: #ffffff; --text-2: #c3c2b7; --muted: #8f8e86;
  --accent: #3987e5; --st-new: #3987e5; --st-revise: #d95926; --st-confirm: #199e70; --st-keep: #6f6e67; --st-drop: #e66767; --path: #9085e9; } }
:root[data-theme="dark"] { color-scheme: dark;
  --page: #0d0d0d; --surface: #1a1a19; --surface-2: #232321; --border: #33332f;
  --text: #ffffff; --text-2: #c3c2b7; --muted: #8f8e86;
  --accent: #3987e5; --st-new: #3987e5; --st-revise: #d95926; --st-confirm: #199e70; --st-keep: #6f6e67; --st-drop: #e66767; --path: #9085e9; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--page); color: var(--text); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
#app { max-width: 1080px; margin: 0 auto; padding: 24px 16px 64px; }
h1 { font-size: 26px; margin: 0; letter-spacing: -0.01em; }
h2 { font-size: 18px; margin: 0; }
h3 { font-size: 15px; margin: 12px 0 6px; }
.sub, .hint, .muted { color: var(--text-2); }
.hint { font-size: 13px; margin: 4px 0 12px; }
.muted { font-size: 13px; }
code, pre { font: 12.5px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.top { margin-bottom: 20px; }
.title-row { display: flex; gap: 16px; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; }
.sub { margin: 4px 0 0; font-size: 13px; }
.badge { display: inline-flex; gap: 8px; align-items: center; padding: 6px 12px; border-radius: 999px; border: 1px solid var(--border); background: var(--surface); font-weight: 600; font-size: 14px; }
.badge.good .badge-icon { color: var(--good); }
.badge.neutral .badge-icon { color: var(--muted); }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin-top: 16px; }
.tile { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; }
.tile-label { font-size: 12px; color: var(--text-2); }
.tile-value { font-size: 22px; font-weight: 650; margin-top: 2px; }
.tile-sub { font-size: 12px; color: var(--muted); }
.panel { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 16px; margin-top: 16px; }
.panel-head { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; flex-wrap: wrap; }
.controls { display: flex; gap: 20px; flex-wrap: wrap; align-items: center; font-size: 14px; margin-bottom: 12px; }
.controls input[type=range] { vertical-align: middle; width: 160px; accent-color: var(--accent); }
.story { list-style: none; margin: 0; padding: 0 0 0 14px; border-left: 2px solid var(--border); }
.card { position: relative; background: var(--surface-2); border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; margin: 0 0 10px 8px; cursor: pointer; }
.card::before { content: ''; position: absolute; left: -23px; top: 16px; width: 10px; height: 10px; border-radius: 50%; background: var(--muted); border: 2px solid var(--surface); }
.card.on-path { border-color: var(--path); }
.card.on-path::before { background: var(--path); }
.card:hover, .card:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.card-head { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; font-size: 12px; color: var(--text-2); }
.round { font-weight: 700; color: var(--text); }
.card-title { font-weight: 600; margin: 4px 0 2px; }
.card-line { font-size: 13px; color: var(--text-2); overflow-wrap: anywhere; }
.rel { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: var(--muted); }
.rel-track { display: inline-block; width: 60px; height: 4px; border-radius: 2px; background: var(--border); overflow: hidden; }
.rel-fill { display: block; height: 100%; background: var(--accent); border-radius: 2px; }
.chart-wrap { position: relative; }
.chart, .timeline { width: 100%; height: auto; display: block; }
.timeline { min-width: 640px; }
.chart { min-width: 460px; }
.spacetime { display: block; max-width: 100%; height: auto; border-radius: 6px; margin: 6px 0; }
.spacetime.thumb { max-height: 90px; width: auto; }
.rows-view .spacetime { max-height: 460px; width: auto; }
.st-bg { fill: var(--surface-2); } .st-on { fill: var(--accent); }
pre.code { white-space: pre-wrap; overflow-wrap: anywhere; }
.model .part { margin-bottom: 10px; }
.question { margin: 4px 0; padding: 8px 10px; border-left: 3px solid var(--accent); background: var(--surface-2); border-radius: 0 6px 6px 0; font-size: 13px; }
.grid { stroke: var(--border); stroke-width: 1; }
.axis { fill: var(--text-2); font-size: 11px; }
.line { fill: none; stroke: var(--accent); stroke-width: 2; stroke-linejoin: round; }
.dot { fill: var(--surface); stroke: var(--accent); stroke-width: 2; }
.dot.held { fill: var(--accent); }
.hit { fill: transparent; }
.glyph { fill: var(--text); font-size: 12px; }
.pt:focus { outline: none; }
.pt:focus .dot, .pt:hover .dot { stroke-width: 3; }
.tip { position: absolute; left: 50%; top: 4px; transform: translateX(-50%); background: var(--text); color: var(--surface); font-size: 12px; padding: 4px 8px; border-radius: 6px; opacity: 0; pointer-events: none; transition: opacity .12s; max-width: 90%; }
.tip.on { opacity: 1; }
.mark { cursor: pointer; }
.mark circle { fill: var(--muted); stroke: var(--surface); stroke-width: 2; }
.mark.k-propose circle { fill: var(--st-new); }
.mark.k-check circle, .mark.k-validate circle { fill: var(--st-confirm); }
.mark.k-investigate circle, .mark.k-replay circle { fill: var(--st-revise); }
.mark.on-path circle { stroke: var(--path); stroke-width: 2.5; }
.mark:hover circle, .mark:focus circle { stroke: var(--text); }
.legend { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; }
.chip { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; color: #fff; white-space: nowrap; }
.st-new { background: var(--st-new); } .st-revise { background: var(--st-revise); } .st-confirm { background: var(--st-confirm); }
.st-keep { background: var(--st-keep); } .st-drop { background: var(--st-drop); }
.scroll { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: 13px; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
.lineage td { text-align: center; }
.lineage th[scope=row] { min-width: 220px; max-width: 360px; }
.stmt { font-weight: 400; color: var(--text-2); font-size: 12px; }
.small { font-size: 12px; color: var(--text-2); }
.grade { font-weight: 700; }
.g-exact { color: var(--good); } .g-wrong { color: var(--critical); } .g-partial { color: var(--st-revise); } .g-absent { color: var(--muted); }
.operator { border-style: dashed; }
pre.code, pre.rows { background: var(--surface-2); border: 1px solid var(--border); border-radius: 8px; padding: 10px; overflow: auto; max-height: 420px; white-space: pre; }
pre.rows { line-height: 1.15; letter-spacing: 0.08em; }
.frames { display: flex; flex-wrap: wrap; gap: 8px; }
.frames figure { margin: 0; }
.frames figcaption { font-size: 11px; color: var(--muted); }
.msgs { padding-left: 0; list-style: none; }
.msgs li { padding: 4px 0; border-bottom: 1px solid var(--border); font-size: 13px; }
.mark.m0, .mark.m1 { display: inline-block; min-width: 18px; text-align: center; border-radius: 4px; font-weight: 700; }
span.mark.m1 { background: var(--st-confirm); color: #fff; } span.mark.m0 { background: var(--st-keep); color: #fff; }
.vals { padding-left: 16px; font-size: 13px; }
.drawer { position: fixed; top: 0; right: 0; bottom: 0; width: min(560px, 100vw); background: var(--surface); border-left: 1px solid var(--border); box-shadow: -8px 0 24px rgba(0,0,0,.12); padding: 20px 16px; overflow-y: auto; transform: translateX(105%); transition: transform .18s; z-index: 10; }
.drawer.open { transform: none; }
.close { position: absolute; top: 10px; right: 12px; border: 0; background: none; color: var(--text); font-size: 26px; cursor: pointer; }
.kicker { font-size: 12px; color: var(--text-2); }
.req { margin: 12px 0; }
.req-head code { display: block; overflow-wrap: anywhere; font-size: 12px; color: var(--text-2); margin-bottom: 4px; }
.note { font-size: 13px; } .warn { font-size: 13px; color: var(--critical); }
.why { color: var(--text-2); }
details { margin-top: 10px; } summary { cursor: pointer; color: var(--accent); font-size: 13px; }
.drop { border: 2px dashed var(--border); border-radius: 14px; padding: 48px 16px; text-align: center; background: var(--surface); margin-top: 40px; }
.drop.over { border-color: var(--accent); }
.err { color: var(--critical); }
@media (max-width: 640px) { .tile-value { font-size: 18px; } #app { padding: 16px 16px 48px; } }
`;

/** A journal inside a <script> element: nothing in it may close the element. */
const embeddable = (json: string) => json.replace(/</g, '\\u003c');

export async function viewerHtml(journal: unknown | null): Promise<string> {
  const script = await viewerScript();
  return '<!doctype html>\n<html lang="es">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n'
    + '<title>Síntesis del run</title>\n<style>' + CSS + '</style>\n</head>\n<body>\n<main id="app"></main>\n'
    + (journal ? '<script id="journal" type="application/json">' + embeddable(JSON.stringify(journal)) + '</script>\n' : '')
    + '<script>' + script + '</script>\n</body>\n</html>\n';
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const outAt = argv.indexOf('--out');
  const out = outAt >= 0 ? argv[outAt + 1] : null;
  const blank = argv.includes('--blank');
  const input = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--out');
  if (!blank && !input) { console.error('usage: journal-view.ts <journal.json> [--out file.html]  |  journal-view.ts --blank [--out file.html]'); process.exit(2); }
  const journal = blank ? null : JSON.parse(fs.readFileSync(input!, 'utf8'));
  const target = out ?? (blank ? path.resolve(lib, '..', 'journal-viewer.html') : input!.replace(/\.json$/i, '') + '.html');
  fs.writeFileSync(target, await viewerHtml(journal));
  console.log('wrote ' + target);
}
