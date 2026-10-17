// node fixtures/demo/_authoring/build.mjs — regenerates fixtures/demo/*.jsonl, layout.json, pylons.json and
// fixtures/raw/hermes-export-sample.json deterministically. Edit the session scripts, re-run, then run fixtures/validate.mjs.
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as research from './research.mjs';
import * as fix from './fix.mjs';
import * as deploy from './deploy.mjs';
import * as think from './think.mjs';
import * as orch from './orch.mjs';
import * as readme from './readme.mjs';
import { buildRawSample } from './raw-sample.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const demoDir = path.resolve(here, '..');
const rawDir = path.resolve(here, '../../raw');

// Front arc r = 1.8 m at −60°,−30°,0°,30°,60° (angle from −z toward +x); second arc r = 2.6 m at 22.5° steps
// offset 11.25°. rot = −θ so every column faces the origin (rot 0 faces +z). The child sits next to its parent.
const deg = (d) => (d * Math.PI) / 180;
const place = (r, thetaDeg) => ({
  x: +(r * Math.sin(deg(thetaDeg))).toFixed(3), z: +(-r * Math.cos(deg(thetaDeg))).toFixed(3), rot: +(-deg(thetaDeg)).toFixed(4),
});
const LAYOUT = {
  s_fix: place(1.8, 0),
  s_research: place(1.8, -30),
  s_deploy: place(1.8, 30),
  s_think: place(1.8, -60),
  s_orch: place(1.8, 60),
  s_orch_child: place(2.6, 48),      // next to its parent, clear of the terminal pylon
  s_readme: place(2.6, 11.25),
};
const PYLONS = [
  { kind: 'browser', x: -2.5, z: -1.0, label: 'web' },
  { kind: 'terminal', x: 2.5, z: -1.0, label: 'terminal' },
  { kind: 'files', x: 0, z: -3.2, label: 'codebase' },
];

const writers = [...research.build(), ...fix.build(), ...deploy.build(), ...think.build(), ...orch.build(), ...readme.build()];
const stats = [];
for (const w of writers) {
  if (!LAYOUT[w.id]) throw new Error(`no layout entry for ${w.id}`);
  await writeFile(path.join(demoDir, `${w.id}.jsonl`), w.toJSONL());
  const msgs = w.lines.filter((l) => l.kind === 'message.add').length;
  const deltas = w.lines.filter((l) => l.kind === 'message.delta').length;
  stats.push({ id: w.id, lines: w.lines.length, messages: msgs, deltas, seconds: +(w.t / 1000).toFixed(1) });
}
await writeFile(path.join(demoDir, 'layout.json'), JSON.stringify(LAYOUT, null, 2) + '\n');
await writeFile(path.join(demoDir, 'pylons.json'), JSON.stringify(PYLONS, null, 2) + '\n');
await writeFile(path.join(rawDir, 'hermes-export-sample.json'), JSON.stringify(buildRawSample(), null, 2) + '\n');

console.table(stats);
console.log(`scenario length at speed 1: ${Math.max(...stats.map((s) => s.seconds))} s · total events ${stats.reduce((a, s) => a + s.lines, 0)} · total messages ${stats.reduce((a, s) => a + s.messages, 0)}`);
