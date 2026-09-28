import { INVESTIGATION_TOOLS as INVESTIGATION, type WorldInterface } from '../../learn/prompt.ts';
import { objectiveLines } from '../../learn/objective.ts';
import { TANK_ANSWER, tankVerdict } from './objective.ts';

/** tank@1's interface to the common prompt: its objective's lines, then the parameters of its instruments. Interface
    words only (SPEC-MUNDO-FISICO I5). */
export function tankInterface(options: { regression?: boolean } = {}): WorldInterface {
  return {
    tools: ['view', 'inspect', 'act', 'measure', 'table'],
    features: ['check'],
    lines: [
      ...objectiveLines({ answer: TANK_ANSWER, verdictForm: tankVerdict(options) }),
      [INVESTIGATION, 'Requests:'],
      [['view'], '  {"view": "<episode>", "from": <step>, "to": <step>}   the rows of a stretch of one of your episodes'],
      [['act'], '  {"act": {"inputs": [<0 to 9>, ...], "start": <number>, "place": "<laboratory>"}}   start an episode yourself in one of your laboratories (default: the first): from the value `start` (optional; else the environment chooses), with the inputs you give, in order (at most 12). You get its rows (named "act<n>"). It may be refused, and you are not told why. At most `acts_left` this round.'],
      [['inspect'], '  {"inspect": "<episode>@<step>", "model": <round> | <draft> }   what a model (without "model": your latest) answered at that point, part by part: what each observation measured, what each rule answered, V, its answer and the named values its output returned - and the value that came'],
      [['measure'], '  {"measure": {"source": "(p) => ...", "range": [min, max]}, "on": ["<episode>@<step>", ...]}'],
      [['table'], '  {"table": {"source": "(p) => ...", "range": [min, max]}, "on": "episodes" | "checks"}   the points of your own episodes, or of the checks, each with the value of the code and the value that came']
    ]
  };
}
