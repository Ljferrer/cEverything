// The synthetic source (PIN-5): replays fixtures/synthetic.jsonl with 300 ms
// gaps, looping, so the room renders with no harness attached.
import { readFile } from 'node:fs/promises';

export const GAP_MS = 300;
const FIXTURE = new URL('../../fixtures/synthetic.jsonl', import.meta.url);

let timer = null;
let running = false;

export async function start({ emit }) {
  const frames = (await readFile(FIXTURE, 'utf8'))
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
  if (frames.length === 0) throw new Error('fixtures/synthetic.jsonl is empty');
  running = true;
  let i = 0;
  const tick = () => {
    if (!running) return;
    emit(frames[i]);
    i = (i + 1) % frames.length;
    timer = setTimeout(tick, GAP_MS);
  };
  tick();
}

export function stop() {
  running = false;
  clearTimeout(timer);
  timer = null;
}
