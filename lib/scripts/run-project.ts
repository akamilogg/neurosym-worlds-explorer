/* A project of the planner (SPEC-ORQUESTADOR §5), in a process of its own: `lab project start <goal.json>` and
   `lab project resume <id>` start it; `lab project status|approve|reject|stop` and the console talk to it through its
   files (runs/projects/<id>/). The keys come from the environment only (see src/orchestra/launch.ts). */
import path from 'node:path';
import { runProject } from '../src/orchestra/project.ts';
import { chatFromEnv, labEndpointsFromEnv, plannerLogs, readProjectFile } from '../src/orchestra/launch.ts';
import { projectFiles } from '../src/orchestra/project.ts';

const argv = process.argv.slice(2);
const arg = (name: string) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : undefined; };
const root = path.resolve(arg('root') ?? '..');
const id = arg('project');
if (!id) { console.log('run-project.ts --root <repo> --project <id>'); process.exit(2); }
const files = projectFiles(root, id);
const goal = readProjectFile(path.join(files.dir, 'goal.json'));
const logs = plannerLogs(files.dir);
const controller = new AbortController();
process.on('SIGINT', () => controller.abort());
process.on('SIGTERM', () => controller.abort());
process.on('uncaughtException', (e) => { console.error(e instanceof Error && e.name === 'LabError' ? 'project ' + id + ': ' + e.message : e); process.exit(2); });
const r = await runProject({
  root, id, goal: { question: goal.question, ...(goal.criterion ? { criterion: goal.criterion } : {}) }, budget: goal.budget,
  autonomy: goal.autonomy ?? 'consultive', ...(goal.threshold !== undefined ? { threshold: goal.threshold } : {}), ...(goal.max_runs ? { maxRuns: goal.max_runs } : {}),
  planner: chatFromEnv(process.env, 'PLANNER_LLM', { file: logs.next, ...(logs.latest ? { from: logs.latest } : {}), channel: 'planner' }),
  agentLlm: (agent) => chatFromEnv(process.env, 'AGENT_LLM', { file: path.join(files.dir, 'agent-' + agent + '.replay.' + Date.now() + '.jsonl'), channel: 'agent' }),
  ...labEndpointsFromEnv(process.env), signal: controller.signal, print: (l) => console.log(new Date().toISOString() + ' ' + l)
});
console.log('project ' + id + ' ended: ' + r.ended?.why);
