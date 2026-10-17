// Fixture replayer source (PROTOCOL.md §3): merges fixtures/<scenario>/*.jsonl by absolute offset, replays at --speed,
// loops with suffixed ids, implements send/pipe/fork/new/approve/interrupt with scripted replies, cues and reset.

import path from 'node:path';
import { CUES } from '../protocol.js';
import { loadScenario, buildTimeline, suffixIds } from './fixture-load.js';
export { loadScenario, buildTimeline, suffixIds } from './fixture-load.js';
import { defaultPylons, defaultPlacement } from '../state.js';
import { CommandError } from '../hub.js';
import {
  nextId, gap, userMessage, assistantMessage, thinkingMessage, toolCallPair, toolResultPair,
  pickCanned, pickFromHistory, replyText, thinkingText, chunksOf, CANNED, commandFromAttention,
} from './fixture-script.js';
import { clip } from './normalize.js';

const TICK_MS = 40;
const MAX_FORK_CLONE = 200;

// ---------------------------------------------------------------------------
// Source
// ---------------------------------------------------------------------------

/**
 * createFixtureSource({ dir, speed, loop, log }) → source
 * Call `await source.load()` before `source.start(hub, state)`.
 */
export function createFixtureSource(opts = {}) {
  const dir = opts.dir || 'fixtures/demo';
  const log = opts.log || (() => {});
  let speed = clampSpeed(opts.speed ?? 4);
  const loopEnabled = opts.loop !== false;
  let scenario = null;
  let timeline = [];
  let hub = null; let state = null;
  let timer = null;
  let paused = Boolean(opts.paused);
  let vt = 0; let cursor = 0; let loopIndex = 0; let lastTick = 0; let ended = false;
  const layoutEmitted = new Set();
  const held = new Set();      // sessions parked at waiting_on_you by a cue: replayed status lines must not clear the beacon
  const scripts = new Map(); // sessionId → Set<timer>
  const inflight = new Map(); // sessionId → { call, since }: a scripted tool.start whose result step has not run yet
  let forkCounter = 0; let newCounter = 0; let childCounter = 0;
  // Timestamps in the files are authored (often months off); rebase them to wall-clock on emit unless disabled.
  const rebaseTime = opts.rebaseTime !== false;
  let anchorStartedAt = 0; // newest authored startedAt across first lines → maps to runStartWall
  let runStartWall = Date.now();

  const source = {
    kind: 'fixture',
    get scenario() { return scenario; },
    get speed() { return speed; },
    get paused() { return paused; },
    load, start, stop, info, handleCommand,
    // test hooks
    get position() { return { vt, cursor, loopIndex, total: timeline.length }; },
  };

  async function load() {
    scenario = await loadScenario(dir);
    for (const w of scenario.warnings) log(`[fixture] warning: ${w}`);
    timeline = buildTimeline(scenario);
    anchorStartedAt = Math.max(0, ...scenario.files.map((f) => Number(f.lines[0]?.ev?.session?.startedAt) || 0));
    log(`[fixture] loaded "${scenario.name}": ${scenario.files.length} sessions, ${timeline.length} events, ${Math.round((timeline.at(-1)?.offset || 0) / 1000)} s of story`);
    return scenario;
  }

  function info() {
    return { label: 'FIXTURE REPLAY', speed, paused, scenario: scenario?.name || path.basename(dir), loop: loopEnabled, loopIndex, ended, position: cursor, total: timeline.length };
  }

  function start(h, s) {
    hub = h; state = s || h.state;
    if (!scenario) throw new Error('fixture: call load() before start()');
    emitPylons();
    lastTick = Date.now(); runStartWall = lastTick;
    timer = setInterval(tick, TICK_MS);
    timer.unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer); timer = null;
    for (const set of scripts.values()) for (const t of set) clearTimeout(t);
    scripts.clear();
  }

  function emitPylons() {
    const pylons = scenario.pylons || defaultPylons();
    hub.emit({ sessionId: '*', kind: 'pylons', pylons });
  }

  function tick() {
    const now = Date.now();
    const realDt = now - lastTick; lastTick = now;
    if (paused || ended || !hub) return;
    vt += realDt * speed;
    let emitted = 0;
    while (cursor < timeline.length && timeline[cursor].offset <= vt && emitted < 200) {
      emitLine(timeline[cursor]); cursor += 1; emitted += 1;
    }
    if (cursor >= timeline.length) {
      if (loopEnabled) { loopIndex += 1; cursor = 0; vt = 0; log(`[fixture] loop ${loopIndex}`); }
      else { ended = true; log('[fixture] story ended (--no-loop)'); hub.broadcastSourceInfo(); }
    }
  }

  /** Authored timestamps → wall-clock: tiles appear "now"; startedAt keeps its authored distance to the newest session. */
  function rebase(ev) {
    const now = Date.now();
    if (ev.kind === 'message.add' && ev.message) {
      ev.message = { ...ev.message, ts: rebaseTime || !ev.message.ts ? now : ev.message.ts };
    } else if (ev.kind === 'session.upsert' && ev.session && rebaseTime) {
      const s = { ...ev.session, lastActivityAt: now };
      const authored = Number(s.startedAt);
      s.startedAt = Number.isFinite(authored) && anchorStartedAt ? runStartWall - Math.max(0, anchorStartedAt - authored) : runStartWall;
      if (s.attention && typeof s.attention === 'object') s.attention = { ...s.attention, since: now };
      if (s.currentTool && typeof s.currentTool === 'object') s.currentTool = { ...s.currentTool, since: now };
      ev.session = s;
    } else if (ev.kind === 'session.status' && ev.attention && typeof ev.attention === 'object' && (rebaseTime || !ev.attention.since)) {
      ev.attention = { ...ev.attention, since: now };
    }
    return ev;
  }

  function emitLine(item) {
    let ev = rebase(suffixIds(item.ev, loopIndex));
    if (ev.kind === 'message.add' && ev.message && !ev.message.via) ev.message = { ...ev.message, via: 'replay' };
    if (held.has(ev.sessionId) && state.sessions[ev.sessionId]?.status === 'waiting_on_you') {
      // a cue parked this session for a judge: the story's own status lines wait until someone resolves it
      if (ev.kind === 'session.status') return;
      if (ev.kind === 'session.upsert' && ev.session) {
        const cur = state.sessions[ev.sessionId];
        ev = { ...ev, session: { ...ev.session, status: cur.status, attention: cur.attention, activity: cur.activity, endReason: null } };
      }
    } else held.delete(ev.sessionId);
    hub.emit(ev);
    if (ev.kind === 'session.upsert' && !layoutEmitted.has(ev.sessionId)) {
      layoutEmitted.add(ev.sessionId);
      const p = scenario.layout[ev.sessionId];
      if (p) hub.emit({ sessionId: ev.sessionId, kind: 'layout.column', placement: { sessionId: ev.sessionId, x: Number(p.x) || 0, z: Number(p.z) || 0, rot: Number(p.rot) || 0 } });
    }
  }

  // ------------------------------------------------------------------ scheduling helpers
  function schedule(sessionId, steps) {
    // steps: [{ gap, run() }] executed sequentially with the gaps between them
    let set = scripts.get(sessionId);
    if (!set) { set = new Set(); scripts.set(sessionId, set); }
    let delay = 0;
    for (const step of steps) {
      delay += step.gap;
      const t = setTimeout(() => {
        set.delete(t);
        if (!state.sessions[sessionId]) return; // removed meanwhile (reset)
        try { step.run(); } catch (err) { log(`[fixture] script step failed: ${err.message}`); }
      }, delay);
      t.unref?.();
      set.add(t);
    }
  }

  /** Cancel a session's scheduled script; a tool call left between its start and result steps is closed as interrupted. */
  function cancelScripts(sessionId) {
    const set = scripts.get(sessionId);
    if (set) { for (const t of set) clearTimeout(t); set.clear(); }
    const cur = inflight.get(sessionId);
    if (!cur) return;
    inflight.delete(sessionId);
    if (!state.sessions[sessionId]) return;
    const { message, complete } = toolResultPair(sessionId, cur.call, 'interrupted', Math.max(1, Date.now() - cur.since), Date.now(), { ok: false });
    hub.emit({ sessionId, kind: 'message.add', message });
    hub.emit(complete);
  }
  function trackCall(sessionId, call) { inflight.set(sessionId, { call, since: Date.now() }); }
  function untrackCall(sessionId, call) { const cur = inflight.get(sessionId); if (cur && cur.call === call) inflight.delete(sessionId); }

  function requireSession(id) {
    const s = state.sessions[id];
    if (!s) throw new CommandError('unknown_session', `no session ${id}`);
    return s;
  }

  function status(sessionId, st, extra = {}) { if (st !== 'waiting_on_you') held.delete(sessionId); hub.emit({ sessionId, kind: 'session.status', status: st, attention: null, ...extra }); }

  /** Draw a tool pair from the session's history or a canned bank, emit call then result. Returns steps. */
  function toolSteps(sessionId, { category, bank, firstGap = gap(300, 800), resultGap = gap(500, 1500) } = {}) {
    const history = state.messages[sessionId] || [];
    const pick = pickFromHistory(history, category) || pickCanned(bank || (category === 'web' ? 'web' : category === 'files' ? 'files' : category === 'delegating' ? 'delegate' : 'coding'));
    let call = null;
    return [
      { gap: firstGap, run() {
        call = toolCallPair(sessionId, pick.name, pick.args);
        status(sessionId, 'tool');
        hub.emit({ sessionId, kind: 'message.add', message: call.message });
        hub.emit(call.start);
        trackCall(sessionId, call);
      } },
      { gap: resultGap, run() {
        if (!call) return;
        untrackCall(sessionId, call);
        const { message, complete } = toolResultPair(sessionId, call, String(pick.result ?? 'ok'), resultGap);
        hub.emit({ sessionId, kind: 'message.add', message });
        hub.emit(complete);
      } },
    ];
  }

  /** Scripted reply: thinking → assistant (streamed) → one tool call + result → idle. */
  function replySteps(sessionId, userText) {
    const session = state.sessions[sessionId];
    const history = state.messages[sessionId] || [];
    const lastCall = [...history].reverse().find((m) => m.role === 'tool_call');
    const category = lastCall?.tool?.category || 'coding';
    const reply = replyText(userText, category);
    const assistant = assistantMessage(sessionId, reply, { streaming: true });
    const thinking = thinkingMessage(sessionId, thinkingText(userText, category, session?.title || sessionId), assistant.id);
    const chunks = chunksOf(reply, 4);
    const steps = [
      { gap: gap(300, 700), run() { status(sessionId, 'thinking', { activity: 'thinking' }); } },
      { gap: gap(600, 1200), run() { hub.emit({ sessionId, kind: 'message.add', message: { ...thinking, ts: Date.now() } }); } },
      { gap: gap(400, 900), run() { status(sessionId, 'responding', { activity: 'replying' }); hub.emit({ sessionId, kind: 'message.add', message: { ...assistant, ts: Date.now() } }); } },
    ];
    for (const c of chunks) steps.push({ gap: gap(120, 260), run() { hub.emit({ sessionId, kind: 'message.delta', messageId: assistant.id, text: c }); } });
    steps.push({ gap: gap(150, 300), run() { hub.emit({ sessionId, kind: 'message.complete', messageId: assistant.id, text: reply }); } });
    steps.push(...toolSteps(sessionId, { category }));
    steps.push({ gap: gap(300, 600), run() { status(sessionId, 'idle', { activity: 'idle' }); } });
    return steps;
  }

  function placeRightOf(parentId, x, z) {
    const p = state.layout[parentId];
    if (Number.isFinite(x) && Number.isFinite(z)) return { x, z, rot: p?.rot ?? 0 };
    if (!p) return { x: 0.8, z: -1.8, rot: 0 };
    return { x: round3(p.x + 0.8), z: round3(p.z), rot: p.rot };
  }
  const round3 = (v) => Math.round(v * 1000) / 1000;

  // ------------------------------------------------------------------ commands
  async function handleCommand(cmd, ctx = {}) {
    if (!hub) throw new CommandError('source_unavailable', 'fixture not started');
    switch (cmd.name) {
      case 'send': return doSend(cmd.sessionId, cmd.text, cmd.via || 'keyboard', cmd.from, ctx);
      case 'pipe': return doPipe(cmd, ctx);
      case 'fork': return doFork(cmd, ctx);
      case 'new': return doNew(cmd, ctx);
      case 'approve': return doApprove(cmd, ctx);
      case 'interrupt': {
        requireSession(cmd.sessionId);
        cancelScripts(cmd.sessionId);
        status(cmd.sessionId, 'idle', { activity: 'interrupted' });
        return { interrupted: true };
      }
      case 'fixture.control': return doControl(cmd, ctx);
      default: throw new CommandError('not_supported', `fixture source does not handle ${cmd.name}`);
    }
  }

  function doSend(sessionId, text, via, from, ctx, { pipeEvent } = {}) {
    const session = requireSession(sessionId);
    cancelScripts(sessionId); // first, so an interrupted tool call closes before the new user tile
    const msg = userMessage(sessionId, text, { via, from });
    if (pipeEvent) hub.emit({ ...pipeEvent, newMessageId: msg.id });
    hub.emit({ sessionId, kind: 'message.add', message: msg, by: ctx.clientId });
    if (session.status === 'waiting_on_you' && (via === 'voice' || /\b(yes|go ahead|approve|proceed|do it|ok(ay)?)\b/i.test(text))) {
      // DESIGN.md: any voice input to a needs_you session is treated as approval
      const allow = !/\b(no|don't|do not|stop|deny|cancel)\b/i.test(text);
      schedule(sessionId, continueSteps(sessionId, allow));
    } else {
      schedule(sessionId, replySteps(sessionId, text));
    }
    return { messageId: msg.id };
  }

  function doPipe(cmd, ctx) {
    const from = requireSession(cmd.fromSessionId);
    requireSession(cmd.toSessionId);
    const src = (state.messages[cmd.fromSessionId] || []).find((m) => m.id === cmd.fromMessageId);
    if (!src) throw new CommandError('bad_command', `no message ${cmd.fromMessageId} in ${cmd.fromSessionId}`);
    const text = `[from ${from.title}]: ${src.text || src.summary || ''}`.trim();
    const pipeEvent = { sessionId: cmd.toSessionId, kind: 'pipe', fromSessionId: cmd.fromSessionId, fromMessageId: cmd.fromMessageId, toSessionId: cmd.toSessionId, by: ctx.clientId };
    const res = doSend(cmd.toSessionId, text, 'pipe', { sessionId: cmd.fromSessionId, messageId: cmd.fromMessageId }, ctx, { pipeEvent });
    return { newMessageId: res.messageId };
  }

  function doFork(cmd, ctx) {
    const parent = requireSession(cmd.sessionId);
    forkCounter += 1;
    const newId = `${cmd.sessionId}~f${forkCounter}`;
    const history = state.messages[cmd.sessionId] || [];
    let upto = history;
    if (cmd.atMessageId) {
      const idx = history.findIndex((m) => m.id === cmd.atMessageId);
      if (idx < 0) throw new CommandError('bad_command', `no message ${cmd.atMessageId} in ${cmd.sessionId}`);
      upto = history.slice(0, idx + 1);
    }
    const clones = upto.slice(-MAX_FORK_CLONE);
    const place = placeRightOf(cmd.sessionId, cmd.x, cmd.z);
    const now = Date.now();
    const session = {
      id: newId, title: clip(cmd.title || `${parent.title} fork`, 60), status: 'idle', model: parent.model, cwd: parent.cwd, gitBranch: parent.gitBranch,
      parentId: cmd.sessionId, endReason: null, startedAt: now, lastActivityAt: now, activity: 'forked', summary: parent.summary,
      counts: { messages: 0, toolCalls: 0, byCategory: {} }, toolHistory: [], currentTool: null, attention: null,
    };
    hub.emit({ sessionId: newId, kind: 'session.upsert', session, by: ctx.clientId });
    hub.emit({ sessionId: newId, kind: 'layout.column', placement: { sessionId: newId, ...place }, by: ctx.clientId });
    const sfx = `:f${forkCounter}`;
    for (const m of clones) {
      const c = { ...m, id: `${m.id}${sfx}`, sessionId: newId, via: m.via || 'replay' };
      if (c.parentMessageId) c.parentMessageId = `${c.parentMessageId}${sfx}`;
      if (c.tool) c.tool = { ...c.tool, callId: `${c.tool.callId}${sfx}` };
      hub.emit({ sessionId: newId, kind: 'message.add', message: c });
    }
    hub.emit({ sessionId: newId, kind: 'fork', fromSessionId: cmd.sessionId, newSessionId: newId, atMessageId: cmd.atMessageId, by: ctx.clientId });
    return { newSessionId: newId, cloned: clones.length, placement: { sessionId: newId, ...place } };
  }

  function doNew(cmd, ctx) {
    newCounter += 1;
    const id = `new~${newCounter}`;
    const now = Date.now();
    const session = { id, title: clip(cmd.title || `new session ${newCounter}`, 60), status: 'idle', parentId: null, endReason: null, startedAt: now, lastActivityAt: now,
      activity: 'empty', counts: { messages: 0, toolCalls: 0, byCategory: {} }, toolHistory: [], currentTool: null, summary: '', attention: null };
    hub.emit({ sessionId: id, kind: 'session.upsert', session, by: ctx.clientId });
    const def = state.layout[id] || defaultPlacement(id, state.order.length - 1);
    const placement = { sessionId: id, x: Number.isFinite(cmd.x) ? cmd.x : def.x, z: Number.isFinite(cmd.z) ? cmd.z : def.z, rot: def.rot };
    hub.emit({ sessionId: id, kind: 'layout.column', placement, by: ctx.clientId });
    return { sessionId: id, placement };
  }

  /** approve: resolve waiting_on_you → continue (run the pending command) or stop. */
  function continueSteps(sessionId, allow) {
    const session = state.sessions[sessionId];
    const cmdText = commandFromAttention(session?.attention?.text);
    const steps = [];
    if (allow) {
      if (cmdText) {
        let call = null;
        steps.push({ gap: gap(300, 600), run() { status(sessionId, 'tool', { activity: `running: ${clip(cmdText, 50)}` }); } });
        steps.push({ gap: gap(200, 400), run() {
          call = toolCallPair(sessionId, 'terminal', { command: cmdText });
          hub.emit({ sessionId, kind: 'message.add', message: call.message }); hub.emit(call.start);
          trackCall(sessionId, call);
        } });
        steps.push({ gap: gap(900, 1500), run() {
          if (!call) return;
          untrackCall(sessionId, call);
          const out = `{"output":"${clip(cmdText, 30)} … done","exit_code":0}`;
          const { message, complete } = toolResultPair(sessionId, call, out, 1200);
          hub.emit({ sessionId, kind: 'message.add', message }); hub.emit(complete);
        } });
      } else {
        steps.push(...toolSteps(sessionId, { category: 'coding', firstGap: gap(300, 600) }));
      }
      steps.push({ gap: gap(400, 800), run() {
        hub.emit({ sessionId, kind: 'message.add', message: assistantMessage(sessionId, cmdText ? `Done — \`${clip(cmdText, 40)}\` finished cleanly. Anything else before I wrap up?` : 'Done. Continuing with the next step.') });
        status(sessionId, 'idle', { activity: 'idle' });
      } });
    } else {
      steps.push({ gap: gap(300, 700), run() {
        hub.emit({ sessionId, kind: 'message.add', message: assistantMessage(sessionId, 'Understood — I will not run that. Tell me how you want to proceed.') });
        status(sessionId, 'idle', { activity: 'stopped by you' });
      } });
    }
    return steps;
  }

  function doApprove(cmd, ctx) {
    const session = requireSession(cmd.sessionId);
    const wasWaiting = session.status === 'waiting_on_you';
    cancelScripts(cmd.sessionId);
    const msg = userMessage(cmd.sessionId, cmd.allow ? 'Yes, go ahead.' : 'No, hold off.', { via: 'keyboard' });
    hub.emit({ sessionId: cmd.sessionId, kind: 'message.add', message: msg, by: ctx.clientId });
    if (!wasWaiting) { status(cmd.sessionId, 'idle'); return { resolved: false, messageId: msg.id }; }
    schedule(cmd.sessionId, continueSteps(cmd.sessionId, Boolean(cmd.allow)));
    return { resolved: true, allow: Boolean(cmd.allow), messageId: msg.id, requestId: cmd.requestId || session.attention?.requestId };
  }

  // ------------------------------------------------------------------ fixture.control
  function doControl(cmd) {
    switch (cmd.action) {
      case 'pause': paused = true; hub.broadcastSourceInfo(); return info();
      case 'play': paused = false; ended = false; lastTick = Date.now(); hub.broadcastSourceInfo(); return info();
      case 'speed': speed = clampSpeed(cmd.value); hub.broadcastSourceInfo(); return info();
      case 'reset': return doReset();
      case 'cue': return doCue(cmd.value, cmd.sessionId);
      default: throw new CommandError('bad_command', `unknown fixture action ${cmd.action}`);
    }
  }

  function doReset() {
    for (const set of scripts.values()) for (const t of set) clearTimeout(t);
    scripts.clear(); inflight.clear();
    for (const id of [...state.order]) hub.emit({ sessionId: id, kind: 'session.remove' });
    layoutEmitted.clear(); held.clear();
    vt = 0; cursor = 0; loopIndex = 0; ended = false; lastTick = Date.now(); runStartWall = lastTick;
    emitPylons();
    hub.broadcastSourceInfo();
    log('[fixture] reset to demo start');
    return info();
  }

  function pickCueTarget(preferred, predicate = () => true) {
    if (preferred) return requireSession(preferred).id;
    const ids = state.order.filter((id) => state.sessions[id] && predicate(state.sessions[id]));
    if (!ids.length) throw new CommandError('unknown_session', 'no suitable session for this cue');
    return ids[Math.floor(Math.random() * ids.length)];
  }

  function doCue(cue, preferred) {
    if (!CUES.includes(cue)) throw new CommandError('bad_command', `unknown cue ${cue}`);
    switch (cue) {
      case 'needs_you': {
        const sid = pickCueTarget(preferred, (s) => s.status !== 'waiting_on_you' && s.status !== 'done');
        cancelScripts(sid);
        const history = state.messages[sid] || [];
        const lastCmd = [...history].reverse().find((m) => m.role === 'tool_call' && m.tool?.meta?.command)?.tool.meta.command;
        const command = lastCmd || CANNED.approvals[Math.floor(Math.random() * CANNED.approvals.length)];
        const requestId = nextId('req');
        const text = `Ready to run \`${command}\`. This touches shared infrastructure — shall I go ahead?`;
        hub.emit({ sessionId: sid, kind: 'message.add', message: assistantMessage(sid, text) });
        hub.emit({ sessionId: sid, kind: 'session.status', status: 'waiting_on_you', activity: 'waiting for approval',
          attention: { kind: 'approval', text: `Run \`${command}\`?`, requestId, since: Date.now() } });
        held.add(sid);
        return { cue, sessionId: sid, requestId };
      }
      case 'web_burst': {
        const sid = pickCueTarget(preferred, (s) => s.status !== 'waiting_on_you');
        cancelScripts(sid);
        const steps = [];
        for (let i = 0; i < 3; i++) steps.push(...toolSteps(sid, { category: 'web', bank: 'web', firstGap: i === 0 ? 100 : gap(300, 700), resultGap: gap(500, 1100) }));
        steps.push({ gap: gap(300, 500), run() { status(sid, 'idle', { activity: 'idle' }); } });
        schedule(sid, steps);
        return { cue, sessionId: sid };
      }
      case 'patch': {
        const sid = pickCueTarget(preferred, (s) => s.status !== 'waiting_on_you');
        cancelScripts(sid);
        const history = state.messages[sid] || [];
        const own = pickFromHistory(history.filter((m) => m.role !== 'tool_call' || m.tool?.name === 'patch' || m.role === 'tool_result'), 'files');
        const pick = own && own.name === 'patch' ? own : pickCanned('patch');
        let call = null;
        schedule(sid, [
          { gap: 100, run() { call = toolCallPair(sid, pick.name, pick.args); status(sid, 'tool'); hub.emit({ sessionId: sid, kind: 'message.add', message: call.message }); hub.emit(call.start); trackCall(sid, call); } },
          { gap: gap(700, 1300), run() { if (!call) return; untrackCall(sid, call); const { message, complete } = toolResultPair(sid, call, String(pick.result), 1000); hub.emit({ sessionId: sid, kind: 'message.add', message }); hub.emit(complete); } },
          { gap: gap(300, 500), run() { status(sid, 'idle', { activity: `edited ${pick.args.path}` }); } },
        ]);
        return { cue, sessionId: sid };
      }
      case 'delegate': {
        const sid = pickCueTarget(preferred, (s) => s.status !== 'waiting_on_you');
        cancelScripts(sid);
        childCounter += 1;
        const childId = `${sid}~child${childCounter}`;
        const pick = pickCanned('delegate');
        let call = null;
        schedule(sid, [
          { gap: 100, run() { call = toolCallPair(sid, 'delegate_task', pick.args); status(sid, 'tool', { activity: 'delegating a subtask' }); hub.emit({ sessionId: sid, kind: 'message.add', message: call.message }); hub.emit(call.start); trackCall(sid, call); } },
          { gap: gap(500, 900), run() {
            const parent = state.sessions[sid]; if (!parent) return;
            const now = Date.now();
            const place = placeRightOf(sid);
            hub.emit({ sessionId: childId, kind: 'session.upsert', session: { id: childId, title: clip(`subtask: ${pick.args.task}`, 48), status: 'thinking', model: parent.model, parentId: sid, endReason: null,
              startedAt: now, lastActivityAt: now, activity: 'thinking', counts: { messages: 0, toolCalls: 0, byCategory: {} }, toolHistory: [], currentTool: null, summary: clip(pick.args.task, 80), attention: null } });
            hub.emit({ sessionId: childId, kind: 'layout.column', placement: { sessionId: childId, x: place.x, z: round3(place.z + 0.4), rot: place.rot } });
            hub.emit({ sessionId: childId, kind: 'message.add', message: userMessage(childId, pick.args.task, { via: 'agent' }) });
          } },
          { gap: gap(800, 1400), run() {
            if (!state.sessions[childId]) return;
            const a = assistantMessage(childId, 'Scanning web/input/xr.js for controller index assumptions…');
            hub.emit({ sessionId: childId, kind: 'message.add', message: a });
            status(childId, 'responding');
          } },
          { gap: gap(1200, 1800), run() {
            if (!call) return;
            untrackCall(sid, call);
            const { message, complete } = toolResultPair(sid, call, String(pick.result), 2600);
            hub.emit({ sessionId: sid, kind: 'message.add', message }); hub.emit(complete);
            status(sid, 'idle', { activity: 'subtask returned' });
            if (state.sessions[childId]) { hub.emit({ sessionId: childId, kind: 'message.add', message: assistantMessage(childId, String(pick.result)) }); hub.emit({ sessionId: childId, kind: 'session.status', status: 'done', attention: { kind: 'done', text: 'subtask finished', since: Date.now() } }); }
          } },
        ]);
        return { cue, sessionId: sid, childSessionId: childId };
      }
      case 'done': {
        const sid = pickCueTarget(preferred, (s) => s.status !== 'done');
        cancelScripts(sid);
        hub.emit({ sessionId: sid, kind: 'message.add', message: assistantMessage(sid, 'All done — tests pass and the change is committed. Closing this session.') });
        held.delete(sid);
        hub.emit({ sessionId: sid, kind: 'session.status', status: 'done', activity: 'finished', attention: { kind: 'done', text: 'finished', since: Date.now() } });
        return { cue, sessionId: sid };
      }
      default: throw new CommandError('bad_command', `unknown cue ${cue}`);
    }
  }

  return source;
}

function clampSpeed(v) { const n = Number(v); if (!Number.isFinite(n) || n <= 0) return 1; return Math.min(64, Math.max(0.1, n)); }

export default { createFixtureSource, loadScenario, buildTimeline, suffixIds };
