/* The FINDING of finished runs (SPEC-OBJETIVO O10, O14): for each journal given, writes next to it the operator's view
   (<journal>.finding.json: with the hidden truth, for audit) and the researcher's (<journal>.finding.researcher.json:
   without it, for another agent), and prints it in a few lines. Works on any world's journal, including runs made
   before findings existed.

     node --experimental-strip-types scripts/finding.ts runs/messages-s1-....json [more journals]

   The commit is the one the journal names, if any (runs made before O10 name none). */
import fs from 'node:fs';
import { findingOf, findingText, findingView } from '../src/learn/finding.ts';

const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!files.length) { console.error('usage: scripts/finding.ts <journal.json> [...]'); process.exit(2); }
for (const file of files) {
  const journal = JSON.parse(fs.readFileSync(file, 'utf8'));
  const finding = findingOf(journal, { journal: file.replace(/\\/g, '/').split('/').pop() });
  const out = file.replace(/\.json$/, '') + '.finding.json';
  fs.writeFileSync(out, JSON.stringify(finding, null, 2));
  const researcher = file.replace(/\.json$/, '') + '.finding.researcher.json';
  fs.writeFileSync(researcher, JSON.stringify(findingView(finding, 'researcher'), null, 2));
  console.log(findingText(finding) + '\n  -> ' + out + '\n  -> ' + researcher + '\n');
}
