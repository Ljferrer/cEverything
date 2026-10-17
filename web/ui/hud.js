// Desktop DOM HUD (PROTOCOL.md §1 ui/hud.js): session list with status dots + activity, focused transcript (full
// text), compose box (Enter send / Shift+Enter newline), approval cards for waiting_on_you, fixture controls,
// mode + connection + voice badges, help overlay, stats line, toasts. Pure DOM; talks to the app via `actions`.

import { ROLE_COLORS, CATEGORY_COLORS } from '/shared/protocol.js';

const STATUS_DOT = { idle: '#9ca3af', thinking: '#A78BFA', responding: '#38BDF8', tool: '#F59E0B', waiting_on_you: '#EF4444', done: '#22C55E', error: '#EF4444' };
const ROLE_LABEL = { user: 'you', assistant: 'agent', thinking: 'thinking', tool_call: 'tool', tool_result: 'result', system: 'system' };
const HELP = [
  ['Enter', 'send to the focused session (Shift+Enter newline)'], ['Space (hold)', 'push-to-talk into the focused session'],
  ['click', 'focus a column / select a tile'], ['drag tile → column', 'pipe the message into that session'],
  ['drag base', 'move the column (everyone sees it slide)'], ['drag title > 0.5 m', 'fork the session'],
  ['F', 'fork the focused session (lands 0.8 m right)'], ['P', 'pipe mode: selected tile → click a column'],
  ['S / double-click', 'summon the column to you (local)'], ['wheel over column · Home', 'scroll history (local)'],
  ['T', 'top-down view'], ['C', 'recenter reading height'], ['V', 'spectator: follow the headset'], ['H', 'hide / show the side panels'],
  ['1–5', 'demo cues: needs you · web burst · patch · delegate · done'], ['R', 'reset the demo'], ['D', 'debug console'], ['Esc', 'close detail / cancel'],
];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; };
const fmtTime = (ts) => { const d = new Date(ts); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`; };

export function createHUD({ store, net, actions, flags = {}, root = document.getElementById('hud') }) {
  if (!root) throw new Error('hud: #hud container missing');
  root.innerHTML = `
    <div id="hud-top">
      <span id="hud-mode" class="badge">…</span><span id="hud-conn" class="badge">connecting</span><span id="hud-voice" class="badge">voice: —</span>
      <span id="hud-fixture"></span><span class="spacer"></span>
      <span id="hud-flags"></span><button id="hud-help-btn" class="btn" title="help (?)">?</button>
    </div>
    <aside id="hud-left"><div class="panel-title">sessions <button id="hud-new" class="btn cue" title="create an empty session">+ new</button></div><div id="hud-sessions"></div></aside>
    <aside id="hud-right">
      <div id="hud-approvals"></div>
      <div id="hud-focus" class="panel-title">no session focused — click a column</div>
      <div id="hud-transcript"></div>
      <div id="hud-voicebar" hidden></div>
      <div id="hud-compose"><textarea id="hud-text" rows="2" placeholder="type to the focused session · Enter sends · Shift+Enter newline"></textarea><button id="hud-send" class="btn primary">send</button></div>
    </aside>
    <div id="hud-stats"></div>
    <div id="hud-toasts"></div>
    <div id="hud-help" hidden><div class="help-card"><h2>cEverything — laptop controls</h2><table>${HELP.map(([k, v]) => `<tr><td><kbd>${esc(k)}</kbd></td><td>${esc(v)}</td></tr>`).join('')}</table><p>Headset: walk up to read · look at a column and hold left pinch to talk · pinch-drag a tile onto another column to pipe · pull a title plate to fork.</p><button class="btn" id="hud-help-close">close</button></div></div>`;

  const $ = (id) => root.querySelector('#' + id);
  const ui = { mode: $('hud-mode'), conn: $('hud-conn'), voice: $('hud-voice'), fixture: $('hud-fixture'), flags: $('hud-flags'), sessions: $('hud-sessions'), approvals: $('hud-approvals'), focus: $('hud-focus'), transcript: $('hud-transcript'), text: $('hud-text'), send: $('hud-send'), stats: $('hud-stats'), toasts: $('hud-toasts'), help: $('hud-help'), voicebar: $('hud-voicebar') };

  let focusedId = null; let selectedId = null; let dirty = { sessions: true, transcript: true, approvals: true, fixture: true };
  let userScrolledUp = false;
  const flagBadges = [];

  // ---------------------------------------------------------------- top bar
  function renderMode() {
    const info = store.sourceInfo || {};
    const fixture = store.source === 'fixture';
    ui.mode.textContent = `${info.label || (fixture ? 'FIXTURE REPLAY' : 'LIVE')}${fixture && info.speed ? ` · ${info.speed}×${info.paused ? ' · paused' : ''}` : ''}`;
    ui.mode.className = `badge ${fixture ? 'fixture' : 'live'}`;
    ui.fixture.hidden = !fixture || flags.judge;
    if (fixture && dirty.fixture) {
      ui.fixture.innerHTML = `<button class="btn" data-fx="toggle">${info.paused ? '▶ play' : '⏸ pause'}</button>
        <select class="btn" data-fx="speed">${[1, 2, 4, 8, 16].map((s) => `<option value="${s}" ${Number(info.speed) === s ? 'selected' : ''}>${s}×</option>`).join('')}</select>
        <button class="btn" data-fx="reset" title="R">reset</button>
        <span class="cues">${['needs_you', 'web_burst', 'patch', 'delegate', 'done'].map((c, i) => `<button class="btn cue" data-cue="${c}" title="key ${i + 1}">${i + 1} ${c.replace('_', ' ')}</button>`).join('')}</span>`;
      dirty.fixture = false;
    }
  }
  ui.fixture.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.cue) { actions.cue?.(b.dataset.cue, focusedId); return; }
    if (b.dataset.fx === 'toggle') actions.fixture?.(store.sourceInfo?.paused ? 'play' : 'pause');
    if (b.dataset.fx === 'reset') actions.reset?.();
  });
  ui.fixture.addEventListener('change', (e) => { if (e.target.dataset.fx === 'speed') actions.fixture?.('speed', Number(e.target.value)); });
  $('hud-help-btn').addEventListener('click', () => toggleHelp());
  $('hud-new').addEventListener('click', () => { const title = prompt('title for the new session', 'new session'); if (title !== null) actions.newSession?.(title.trim() || undefined); });
  ui.focus.addEventListener('click', (e) => { const b = e.target.closest('button[data-interrupt]'); if (b && focusedId) { b.disabled = true; actions.interrupt?.(focusedId); } });
  $('hud-help-close').addEventListener('click', () => toggleHelp(false));
  ui.help.addEventListener('click', (e) => { if (e.target === ui.help) toggleHelp(false); });
  function toggleHelp(force) { ui.help.hidden = force === undefined ? !ui.help.hidden : !force; }

  function setConnection(status) {
    ui.conn.textContent = status === 'open' ? `connected${store.clientId ? ' · ' + store.clientId : ''}` : status;
    ui.conn.className = `badge ${status === 'open' ? 'ok' : status === 'reconnecting' ? 'bad' : 'warn'}`;
  }
  function setVoice(engine, note) { ui.voice.textContent = `voice: ${engine || 'none'}${note ? ' · ' + note : ''}`; ui.voice.className = `badge ${engine && engine !== 'none' ? 'ok' : 'warn'}`; }
  function setFlag(name, on) {
    const i = flagBadges.indexOf(name);
    if (on && i < 0) flagBadges.push(name); if (!on && i >= 0) flagBadges.splice(i, 1);
    ui.flags.innerHTML = flagBadges.map((f) => `<span class="badge flag">${esc(f)}</span>`).join('');
  }

  // ---------------------------------------------------------------- sessions list
  function renderSessions() {
    const rows = [];
    for (const id of store.order) {
      const s = store.sessions.get(id); if (!s) continue;
      const dot = STATUS_DOT[s.status] || '#9ca3af';
      const hist = (s.toolHistory || []).map((c) => `<i style="background:${CATEGORY_COLORS[c] || '#9ca3af'}"></i>`).join('');
      rows.push(`<div class="sess ${id === focusedId ? 'focused' : ''} ${s.status === 'waiting_on_you' ? 'waiting' : ''}" data-id="${esc(id)}">
        <div class="row1"><span class="dot ${s.status}" style="background:${dot}"></span><span class="title">${esc(s.title)}</span><span class="model">${esc(shortModel(s.model))}</span></div>
        <div class="row2"><span class="activity">${esc(s.activity || s.status)}</span></div>
        <div class="row3"><span class="hist">${hist}</span><span class="counts">${s.counts?.messages ?? 0} msgs · ${s.counts?.toolCalls ?? 0} tools${s.parentId ? ' · ↳ ' + esc(store.sessions.get(s.parentId)?.title || s.parentId) : ''}</span></div>
      </div>`);
    }
    ui.sessions.innerHTML = rows.join('') || '<div class="empty">no sessions yet</div>';
  }
  ui.sessions.addEventListener('click', (e) => { const row = e.target.closest('.sess'); if (row) actions.focusSession?.(row.dataset.id); });

  // ---------------------------------------------------------------- approvals
  function renderApprovals() {
    const waiting = store.waiting();
    ui.approvals.innerHTML = waiting.map((s) => `<div class="approval" data-id="${esc(s.id)}">
      <div class="approval-title">⚑ ${esc(s.title)} needs you</div>
      <div class="approval-text">${esc(s.attention?.text || 'waiting for approval')}</div>
      <div class="approval-actions"><button class="btn ok" data-allow="1">Approve</button><button class="btn bad" data-allow="0">Deny</button><button class="btn" data-focus="1">show</button></div>
    </div>`).join('');
  }
  ui.approvals.addEventListener('click', (e) => {
    const b = e.target.closest('button'); const card = e.target.closest('.approval'); if (!b || !card) return;
    const id = card.dataset.id; const s = store.sessions.get(id);
    if (b.dataset.focus) { actions.focusSession?.(id); return; }
    actions.approve?.(id, s?.attention?.requestId, b.dataset.allow === '1');
    b.disabled = true;
  });

  // ---------------------------------------------------------------- transcript
  function renderTranscript() {
    const s = focusedId ? store.sessions.get(focusedId) : null;
    if (!s) { ui.focus.textContent = 'no session focused — click a column'; ui.transcript.innerHTML = ''; return; }
    const running = s.status === 'thinking' || s.status === 'responding' || s.status === 'tool';
    ui.focus.innerHTML = `<span class="dot" style="background:${STATUS_DOT[s.status] || '#9ca3af'}"></span> <b>${esc(s.title)}</b> <span class="model">${esc(s.model || '')}${s.gitBranch ? ' · ' + esc(s.gitBranch) : ''}</span> <span class="status">${esc(s.status)}${s.activity ? ' · ' + esc(s.activity) : ''}</span>${running ? ' <button class="btn cue" data-interrupt="1" title="interrupt the running turn">⏹ stop</button>' : ''}`;
    const msgs = store.messagesOf(focusedId).filter((m) => !m.hidden);
    const start = Math.max(0, msgs.length - 200);
    const parts = [];
    if (start > 0) parts.push(`<div class="earlier">+${start} earlier messages</div>`);
    for (let i = start; i < msgs.length; i++) parts.push(renderMessage(msgs[i]));
    ui.transcript.innerHTML = parts.join('');
    if (!userScrolledUp) ui.transcript.scrollTop = ui.transcript.scrollHeight;
  }

  function renderMessage(m) {
    const color = m.role === 'tool_result' && m.tool?.ok === false ? ROLE_COLORS.error : (ROLE_COLORS[m.role] || ROLE_COLORS.system);
    let body = '';
    if (m.role === 'tool_call') {
      const args = m.tool?.args; const diff = m.tool?.meta?.diff;
      body = `<div class="summary">${esc(m.summary)}</div>${args ? `<pre class="args">${esc(typeof args === 'string' ? args : JSON.stringify(args, null, 1))}</pre>` : ''}${diff ? renderDiff(diff) : ''}`;
    } else if (m.role === 'tool_result') {
      const diff = m.tool?.meta?.diff;
      body = `<pre class="result">${esc(m.text)}</pre>${diff && !m.text?.includes('@@') ? renderDiff(diff) : ''}`;
    } else body = `<div class="text ${m.role}">${esc(m.text || m.summary)}${m.streaming ? '<span class="cursor">▍</span>' : ''}</div>`;
    const chip = m.role === 'tool_call' && m.tool?.category ? `<span class="chip" style="background:${CATEGORY_COLORS[m.tool.category] || '#9ca3af'}">${esc(m.tool.category)}</span>` : '';
    const via = m.via && m.via !== 'replay' ? `<span class="via">${esc(m.via)}${m.from ? ' ← ' + esc(store.sessions.get(m.from.sessionId)?.title || m.from.sessionId) : ''}</span>` : '';
    const dur = m.tool && Number.isFinite(m.tool.durationMs) && m.role === 'tool_result' ? `<span class="dur">${(m.tool.durationMs / 1000).toFixed(1)} s${m.tool.ok === false ? ' ✗' : ''}</span>` : '';
    return `<div class="msg ${m.role} ${m.id === selectedId ? 'selected' : ''}" data-id="${esc(m.id)}" style="border-color:${color}"><div class="head"><span class="glyph" style="color:${color}">${esc(m.glyph || '')}</span><span class="role" style="color:${color}">${ROLE_LABEL[m.role] || m.role}${m.tool?.name ? ' · ' + esc(m.tool.name) : ''}</span>${chip}${via}${dur}<span class="time">${fmtTime(m.ts)}</span></div>${body}</div>`;
  }

  function renderDiff(diff) {
    const lines = String(diff).split('\n').slice(0, 400);
    return `<pre class="diff">${lines.map((l) => `<span class="${l.startsWith('+') && !l.startsWith('+++') ? 'add' : l.startsWith('-') && !l.startsWith('---') ? 'del' : l.startsWith('@@') ? 'hunk' : 'ctx'}">${esc(l)}</span>`).join('\n')}</pre>`;
  }
  ui.transcript.addEventListener('scroll', () => { userScrolledUp = ui.transcript.scrollTop + ui.transcript.clientHeight < ui.transcript.scrollHeight - 40; });
  ui.transcript.addEventListener('click', (e) => { const row = e.target.closest('.msg'); if (row) actions.selectMessage?.(focusedId, row.dataset.id); });

  // ---------------------------------------------------------------- compose
  function send() {
    const text = ui.text.value.trim();
    if (!text) return;
    if (!focusedId) { toast('click a column first', 'warn'); return; }
    ui.text.value = '';
    actions.send?.(focusedId, text);
  }
  ui.send.addEventListener('click', send);
  ui.text.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });

  // ---------------------------------------------------------------- toasts / stats / voice
  function toast(text, kind = 'info', ms = 3500) {
    const t = el('div', `toast ${kind}`, esc(text));
    ui.toasts.appendChild(t);
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 400); }, ms);
  }
  function setStats(o) { if (flags.judge) { ui.stats.hidden = true; return; } ui.stats.textContent = Object.entries(o).map(([k, v]) => `${k} ${v}`).join(' · '); }
  function setTranscriptLive(text, final, who) {
    if (!text) { ui.voicebar.hidden = true; return; }
    ui.voicebar.hidden = false; ui.voicebar.className = final ? 'final' : 'partial';
    ui.voicebar.textContent = `${who ? who + ': ' : '🎤 '}${text}`;
    if (final) setTimeout(() => { if (ui.voicebar.textContent.endsWith(text)) ui.voicebar.hidden = true; }, 4000);
  }

  // ---------------------------------------------------------------- store wiring (coalesced to one render per frame)
  let raf = 0;
  function schedule() { if (!raf) raf = requestAnimationFrame(flush); }
  function flush() {
    raf = 0;
    if (dirty.sessions) { renderSessions(); dirty.sessions = false; }
    if (dirty.approvals) { renderApprovals(); dirty.approvals = false; }
    if (dirty.transcript) { renderTranscript(); dirty.transcript = false; }
    renderMode();
  }
  const mark = (...keys) => { for (const k of keys) dirty[k] = true; schedule(); };
  store.on('snapshot', () => { dirty.fixture = true; mark('sessions', 'approvals', 'transcript'); });
  store.on('hello', () => { dirty.fixture = true; mark('sessions'); });
  store.on('source', () => { dirty.fixture = true; schedule(); });
  store.on('session.upsert', () => mark('sessions', 'approvals', 'transcript'));
  store.on('session.created', () => mark('sessions'));
  store.on('session.remove', (ev) => { if (ev.sessionId === focusedId) focusedId = null; mark('sessions', 'approvals', 'transcript'); });
  store.on('session.status', () => mark('sessions', 'approvals', 'transcript'));
  for (const k of ['message.add', 'message.delta', 'message.complete', 'tool.start', 'tool.complete']) store.on(k, (ev) => { mark('sessions'); if (ev.sessionId === focusedId) mark('transcript'); });
  store.on('transcript', (f) => setTranscriptLive(f.text, f.final, f.clientId !== store.clientId ? (store.presence.get(f.clientId)?.name || 'headset') : ''));
  store.on('voice.unavailable', (f) => { setVoice('none', f.reason); });
  store.on('error', (f) => toast(`${f.code}: ${f.message}`, 'bad'));
  net?.on?.('status', setConnection);

  schedule();
  return {
    setFocused(id) { if (id === focusedId) return; focusedId = id; userScrolledUp = false; mark('sessions', 'transcript'); },
    setSelected(messageId) { selectedId = messageId || null; mark('transcript'); },
    get focusedId() { return focusedId; },
    setConnection, setVoice, setFlag, setStats, toast, toggleHelp, setTranscriptLive,
    togglePanels(force) { const on = force === undefined ? !root.classList.contains('panels-hidden') : Boolean(force); root.classList.toggle('panels-hidden', on); setFlag('panels hidden (H)', on); },
    focusCompose() { ui.text.focus(); },
    hide(on) { root.hidden = Boolean(on); },
    elements: ui,
  };
}

function shortModel(model) { if (!model) return ''; const m = String(model).split('/').pop().replace(/^claude-/, ''); return m.length > 22 ? m.slice(0, 21) + '…' : m; }

export default { createHUD };
