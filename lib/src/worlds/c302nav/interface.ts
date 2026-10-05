import { INVESTIGATION_TOOLS as INVESTIGATION, type WorldInterface } from '../../learn/prompt.ts';
import { objectiveLines } from '../../learn/objective.ts';
import { c302NavAnswer, c302NavVerdict } from './objective.ts';
import { namingOf, type NamesMode } from './world.ts';

/** c302-navigation@1's interface to the common prompt: its objective's lines, then the parameters of its instruments.
    Interface words only (SPEC-MUNDO-FISICO I5). */
export function c302NavInterface(options: { regression?: boolean; names?: NamesMode } = {}): WorldInterface {
  /* The names it is told: the list of cells and the signals' names do not depend on the run's permutation. */
  const naming = namingOf(options.names ?? 'real', 0);
  return {
    tools: ['view', 'inspect', 'act', 'measure', 'table'],
    features: ['check'],
    lines: [
      ...objectiveLines({ answer: c302NavAnswer(naming.signals), verdictForm: c302NavVerdict({ ...options, signals: naming.signals }) }),
      [INVESTIGATION, 'Requests:'],
      [['view'], '  {"view": "<episode>", "from": <step>, "to": <step>}   the rows of a stretch of one of your episodes (at most 60 per request): the time, the current into each stimulated cell, the two signals and the calcium of each cell recorded'],
      [['act'], '  {"act": {"stimuli": [<stimulus>, ...], "record": ["<cell>", ...], "remove": ["<connection>", ...], "scale": {"<connection>": <factor>}, "polarity": {"<connection>": "exc" | "inh"}, "parameters": {"<name>": "<value with its unit>"}, "duration_ms": <up to 9000>, "place": "<laboratory>"}}   simulate an episode yourself in one of your laboratories (default: the first); everything but "stimuli" is optional. '
        + 'A stimulus is {"cell": "<cell>", "delay_ms": <n>, "duration_ms": <n>, "amplitude_pa": <n>} (a square pulse) or the same with "kind": "sine", "period_ms": <n>, "phase_rad": <n>. '
        + 'The cells are ' + naming.cells.join(', ') + '. A connection is "<pre>-<post>" (chemical) or "<pre>-<post>_GJ" (gap junction). "parameters" are the model\'s own, by name. '
        + 'Or {"act": {"wiring": true}}: the connections among the cells. You get the episode (named "act<n>"); view it. It may be refused, and you are not told why. At most `acts_left` this round.'],
      [['inspect'], '  {"inspect": "<episode>@<step>", "model": <round> | <draft> }   what a model (without "model": your latest) answered at that point, part by part: what each observation measured, what each rule answered, V, its answer and the named values its output returned - and the signals that came'],
      [['measure'], '  {"measure": {"source": "(p) => ...", "range": [min, max]}, "on": ["<episode>@<step>", ...]}'],
      [['table'], '  {"table": {"source": "(p) => ...", "range": [min, max]}, "on": "episodes" | "checks"}   the points of your own episodes, or of the checks, each with the value of the code and the signals that came']
    ]
  };
}
