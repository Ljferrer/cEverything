// deploy-staging (s_deploy): terminal commands, then parked at an approval (waiting_on_you). The file ends there.
import { SessionWriter, T0, hermes } from './lib.mjs';

const IMAGE = 'registry.staging.internal/ceverything:2026-10-17';

export function build() {
  const w = new SessionWriter({
    id: 's_deploy', title: 'deploy-staging', status: 'idle', model: 'anthropic/claude-opus-4-1', gitBranch: 'main',
    activity: 'idle', summary: 'Deploy main to staging: tests, smoke, image, push; ask before anything destructive',
    startedAt: T0 - 20_000,
  }, { seed: 37, pace: 1.1 });

  w.user(3500, 'Deploy the current main to staging: run the tests and the headless smoke, build the image, push it, then make origin/main match what we deployed. Ask me before anything destructive.');
  w.status(400, 'thinking', 'thinking');
  let row = w.nextId();
  w.thinking(3800, 'Sequence: confirm the tree is clean and what commit we are on, run the unit tests, run the Playwright smoke, build and push the image, then sync the remote. The last step is the only one that can be destructive if origin has moved, so I will fetch and compare before pushing anything.', { forId: row });
  w.status(300, 'tool', 'running: git status');
  let c = w.toolCall(500, 'terminal', { command: 'git status --short && git rev-parse --short HEAD' }, { rowId: row });
  w.toolResult(900, c, { text: hermes.terminal('4f2c9ab\n').text, summary: '→ clean tree at 4f2c9ab', meta: { command: c.args.command, exitCode: 0 } });
  c = w.toolCall(1200, 'terminal', { command: 'git log --oneline -3' });
  w.toolResult(700, c, { text: hermes.terminal('4f2c9ab feat(web): pooled tile textures with LOD hysteresis\nb81e3d0 fix(hub): resume from ring buffer by lastSeq\ne339d91 docs: MOLTEN briefing, Skyline design, wire protocol; package scaffold\n').text, summary: '→ HEAD 4f2c9ab feat(web): pooled tile textures with LOD hysteresis', meta: { command: c.args.command, exitCode: 0 } });

  w.status(600, 'tool', 'running: npm test');
  c = w.toolCall(1400, 'terminal', { command: 'npm test 2>&1 | tail -10', timeout: 180 });
  w.toolResult(3200, c, { text: hermes.terminal('ℹ tests 14\nℹ suites 0\nℹ pass 14\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\nℹ duration_ms 812.4\n').text, summary: '→ exit 0 · 14 tests pass', meta: { command: c.args.command, exitCode: 0 } });
  w.status(500, 'tool', 'running: node test/smoke.mjs');
  c = w.toolCall(1100, 'terminal', { command: 'node test/smoke.mjs', timeout: 300 });
  w.toolResult(11_800, c, { text: hermes.terminal('[smoke] server http://127.0.0.1:43127 (source=fixture, speed=8)\n[smoke] chromium 141.0.7390.37 headless\n[smoke] waiting for >= 6 columns … 7 columns after 2.9 s\n[smoke] console errors: 0\n[smoke] saved test-results/desktop.png\n[smoke] saved test-results/topdown.png\n[smoke] OK (9.4 s)\n').text, summary: '→ smoke OK · 7 columns · 0 console errors', meta: { command: c.args.command, exitCode: 0 } });
  w.status(800, 'responding', 'responding');
  w.assistant(900, 'Tests and smoke are green: 14 tests, 7 columns rendered in headless Chromium, zero console errors. Building the staging image from 4f2c9ab.');

  w.status(500, 'tool', 'reading Dockerfile');
  c = w.toolCall(900, 'read_file', { path: 'Dockerfile' });
  w.toolResult(600, c, { text: hermes.readFile('FROM node:22-alpine\nWORKDIR /app\nCOPY package.json package-lock.json ./\nRUN npm ci --omit=dev\nCOPY server ./server\nCOPY web ./web\nENV PORT=8787\nEXPOSE 8787\nCMD ["node", "server/index.js", "--host", "0.0.0.0", "--source", "fixture", "--speed", "2"]\n').text, summary: '→ 9 lines · node:22-alpine, fixture mode, port 8787', meta: { path: 'Dockerfile' } });
  c = w.toolCall(1100, 'search_files', { pattern: 'registry.staging.internal', path: 'deploy', output_mode: 'content' });
  w.toolResult(700, c, { text: 'deploy/staging.env\n  2: IMAGE=registry.staging.internal/ceverything\n  3: TAG=2026-10-17\ndeploy/compose.staging.yml\n  6:     image: ${IMAGE}:${TAG}\n\n3 matches in 2 files', summary: '→ staging pulls registry.staging.internal/ceverything:2026-10-17' });
  w.status(500, 'tool', 'running: docker build');
  c = w.toolCall(800, 'terminal', { command: `docker build -t ${IMAGE} .`, timeout: 600 });
  w.toolResult(31_500, c, { text: hermes.terminal(`[+] Building 29.8s (11/11) FINISHED\n => [internal] load build definition from Dockerfile                    0.0s\n => [internal] load .dockerignore                                       0.0s\n => [internal] load metadata for docker.io/library/node:22-alpine        1.1s\n => [1/6] FROM docker.io/library/node:22-alpine@sha256:5a4b7c0e2f1d3e6a 0.0s\n => [internal] load build context                                       0.3s\n => => transferring context: 1.84MB                                     0.3s\n => CACHED [2/6] WORKDIR /app                                           0.0s\n => [3/6] COPY package.json package-lock.json ./                        0.0s\n => [4/6] RUN npm ci --omit=dev                                        21.6s\n => [5/6] COPY server ./server                                          0.1s\n => [6/6] COPY web ./web                                                0.1s\n => exporting to image                                                  0.4s\n => => naming to ${IMAGE}\n`).text, summary: '→ image built in 29.8 s (11/11 steps)', meta: { command: c.args.command, exitCode: 0 } });
  w.status(600, 'tool', 'running: docker push');
  c = w.toolCall(900, 'terminal', { command: `docker push ${IMAGE}`, timeout: 600 });
  w.toolResult(18_400, c, { text: hermes.terminal(`The push refers to repository [registry.staging.internal/ceverything]\n9c1e4f20a7b3: Pushed\n3f7d2a91c0e8: Pushed\nb2a6e5d14c77: Layer already exists\n0e8c3b7f5a19: Layer already exists\n2026-10-17: digest: sha256:7d1f0c3a9e4b6258c1a7f0e9d3b4c5a6f7e8d9c0b1a2f3e4d5c6b7a8f9e0d1c2 size: 1783\n`).text, summary: '→ pushed · digest sha256:7d1f0c3a… size 1783', meta: { command: c.args.command, exitCode: 0 } });

  row = w.nextId();
  w.status(900, 'thinking', 'thinking');
  w.thinking(3600, 'Image is up and staging pulls by tag. Now the branch: fetch and compare before any push, since the user wants to be asked before anything destructive.', { forId: row });
  w.status(300, 'tool', 'running: git fetch');
  c = w.toolCall(600, 'terminal', { command: 'git fetch origin && git status -sb' }, { rowId: row });
  w.toolResult(2900, c, { text: hermes.terminal('## main...origin/main [ahead 3, behind 2]\n').text, summary: '→ main…origin/main [ahead 3, behind 2] — diverged', meta: { command: c.args.command, exitCode: 0 } });
  c = w.toolCall(1300, 'terminal', { command: 'git log --oneline main..origin/main' });
  w.toolResult(700, c, { text: hermes.terminal('a91e0f2 chore: bump playwright pin to 1.56.1\n7c3d55e fix(hud): approval card above the compose box\n').text, summary: '→ 2 commits on origin we do not have (a91e0f2, 7c3d55e)', meta: { command: c.args.command, exitCode: 0 } });

  row = w.nextId();
  w.status(1000, 'thinking', 'thinking');
  w.thinking(5400, 'origin/main has two commits we do not have — a teammate pushed while the build ran. A plain push is rejected as non-fast-forward. A force push makes origin/main equal the tested tree but drops a91e0f2 and 7c3d55e from main. A rebase keeps their work but changes what we tested and deployed, so the image would no longer match the branch. Neither is mine to decide; this is exactly the destructive step the user asked to approve. Lay out the options and stop.', { forId: row });
  w.status(400, 'responding', 'responding');
  w.assistant(1200, `The image \`${IMAGE}\` is pushed and staging is pulling it. But origin/main moved while we built: it has 2 commits we don't (a91e0f2 playwright pin, 7c3d55e HUD approval card) and we are ahead by 3. Making origin/main match the deployed tree needs a force push, which would drop those two commits. The alternative is to rebase onto origin/main and rebuild, which means the deployed image no longer matches the branch. I'm pausing for your call.`, { id: row });
  w.status(900, 'waiting_on_you', 'waiting for approval', {
    kind: 'approval', text: 'Run: git push origin main --force? (y/n)', requestId: 's_deploy:approval:1',
  });
  // Parked. The replayer resumes this session on `approve`.
  return [w];
}
