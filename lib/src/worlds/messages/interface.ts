import { INVESTIGATION_TOOLS as INVESTIGATION, type WorldInterface } from '../../learn/prompt.ts';
import { objectiveLines } from '../../learn/objective.ts';
import { MESSAGES_ANSWER, messagesVerdict } from './objective.ts';

/** messages@1's interface to the common prompt: its objective's lines, then the parameters of its instruments. There is
    no act here: the environment writes the texts. Interface words only (SPEC-MUNDO-FISICO I5). */
export function messagesInterface(options: { regression?: boolean } = {}): WorldInterface {
  return {
    tools: ['view', 'inspect', 'measure', 'table'],
    features: ['check'],
    lines: [
      ...objectiveLines({ answer: MESSAGES_ANSWER, verdictForm: messagesVerdict(options) }),
      [INVESTIGATION, 'Requests:'],
      [['view'], '  {"view": "<episode>", "from": <step>, "to": <step>}   what was perceived at each step of a stretch of one of your episodes, with the mark given there (at most 30 per request)'],
      [['inspect'], '  {"inspect": "<episode>@<step>", "model": <round> | <draft> }   what a model (without "model": your latest) answered at that point, part by part: what each observation measured, what each rule answered, V, its answer and the named values its output returned - and the mark given there'],
      [['measure'], '  {"measure": {"source": "(p) => ...", "range": [min, max]}, "on": ["<episode>@<step>", ...]}'],
      [['table'], '  {"table": {"source": "(p) => ...", "range": [min, max]}, "on": "episodes" | "checks"}   the points of your own episodes, or of the checks, each with the value of the code and the mark given there']
    ]
  };
}
