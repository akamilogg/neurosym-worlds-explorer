import { INVESTIGATION_TOOLS as INVESTIGATION, type WorldInterface } from '../../learn/prompt.ts';
import { objectiveLines } from '../../learn/objective.ts';
import { CELLS_ANSWER, cellsVerdict } from './objective.ts';

/** cells@1's interface to the common prompt: its objective's lines, then the parameters of its instruments. Interface
    words only (SPEC-MUNDO-FISICO I5). */
export function cellsInterface(options: { regression?: boolean } = {}): WorldInterface {
  return {
    tools: ['view', 'inspect', 'act', 'measure', 'simulate', 'table'],
    features: ['check'],
    lines: [
      ...objectiveLines({ answer: CELLS_ANSWER, verdictForm: cellsVerdict(options) }),
      [INVESTIGATION, 'Requests:'],
      [['view'], '  {"view": "<episode>", "from": <step>, "to": <step>}   the rows of a stretch of one of your episodes (at most 60 per request)'],
      [['act'], '  {"act": {"row": "<string>", "place": "<laboratory>"}}   start an episode yourself in one of your laboratories (default: the first), from a row you write: as long as the rows seen there, with the symbols seen there - or {"act": {"rows": ["<string>", ...]}} from several rows (at most 4), oldest first, the last being the present. You get its rows (named "act<n>"). It may be refused, and you are not told why. At most `acts_left` this round.'],
      [['inspect'], '  {"inspect": "<episode>@<step>", "model": <round> | <draft> }   what a model (without "model": your latest) answered at that point, part by part: what each observation measured, what each rule answered, V, its answer and the named values its output returned - and the row that came next'],
      [['measure'], '  {"measure": {"source": "(p) => ...", "range": [min, max]}, "on": ["<episode>@<step>", ...]}'],
      [['simulate'], '  {"simulate": "<episode>@<step>", "model": <round> | <draft>, "steps": <n>}   each next row is the model\'s answer, row after row (at most 40), next to the row seen there if any was'],
      [['table'], '  {"table": {"source": "(p) => ...", "range": [min, max]}, "on": "episodes" | "checks"}   the points of your own episodes, or of the checks, each with the value of the code and the row that came next there']
    ]
  };
}
