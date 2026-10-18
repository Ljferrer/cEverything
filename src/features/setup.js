// CHATS: a setup screen on every 2D page to pick which main chats stand in the
// room. The relay holds the pick for every viewer (the `include` command) and
// streams only the picked chats and their subagents. An editor (`?key=edit`)
// can change it; anyone can see it. When the pick changes, the relay sends the
// new chat list and then the picked chats again, so each page clears its room
// first (room.js `reset`, which keeps the slot map) and rebuilds in place.

/** A stable key for a pick: null (every chat) or the sorted sids. */
export const pickKey = (include) => (include ? JSON.stringify([...include].sort()) : 'all');

/** The `include` command for a set of checked sids: null when every chat is checked. */
export function includeCommand(checked, chats) {
  const all = chats.every((c) => checked.has(c.sid));
  return { t: 'include', sids: all ? null : chats.filter((c) => checked.has(c.sid)).map((c) => c.sid) };
}

/** The sids a pick shows, out of the listed chats. */
export const pickedOf = (include, chats) => new Set(include ? include.filter((s) => chats.some((c) => c.sid === s)) : chats.map((c) => c.sid));

export function install({ bus, net }) {
  if (typeof document === 'undefined') return;
  let list = { chats: [], include: null };
  let canEdit = false;
  let shownKey = null; // the pick this page's room was built for
  let checked = new Set();

  const style = document.createElement('style');
  style.textContent = `
    #chats-btn { position: fixed; top: 92px; right: 12px; z-index: 999; cursor: pointer; font: 700 12px/1 system-ui, sans-serif;
      letter-spacing: .08em; color: #ff6a5a; background: rgba(0,0,0,.75); border: 1px solid #5a1a14; border-radius: 6px; padding: 8px 10px; }
    @media (width < 600px) { #chats-btn { top: 212px; } }
    #chats-setup { position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,.6); }
    #chats-setup[hidden] { display: none; }
    #chats-setup .card { width: min(560px, calc(100vw - 32px)); max-height: 85vh; display: flex; flex-direction: column; padding: 16px 18px;
      font: 14px/1.4 system-ui, sans-serif; color: #eee; background: #0b0b0b; border: 1px solid #ff2a1a; border-radius: 8px; }
    #chats-setup h3 { margin: 0 0 4px; color: #ff6a5a; letter-spacing: .06em; }
    #chats-setup .note { color: #999; font-size: 12px; margin-bottom: 8px; }
    #chats-setup .list { overflow: auto; flex: 1; border-top: 1px solid #222; border-bottom: 1px solid #222; }
    #chats-setup label { display: flex; gap: 10px; align-items: center; padding: 6px 2px; border-bottom: 1px solid #161616; cursor: pointer; }
    #chats-setup label .t { flex: 1; min-width: 0; overflow-wrap: anywhere; }
    #chats-setup label .h { font-size: 11px; color: #aaa; border: 1px solid #333; border-radius: 3px; padding: 1px 5px; }
    #chats-setup label .h.codex { color: #5fe0d0; border-color: #1f5f58; }
    #chats-setup label .h.hermes { color: #ffcc55; border-color: #5f4a1a; }
    #chats-setup label .k { font-size: 11px; color: #888; white-space: nowrap; }
    #chats-setup .row { display: flex; gap: 8px; margin-top: 10px; align-items: center; }
    #chats-setup .row .count { flex: 1; color: #aaa; font-size: 12px; }
    #chats-setup button.b { cursor: pointer; font: 700 12px/1 system-ui, sans-serif; color: #ddd; background: #1a1a1a; border: 1px solid #444; border-radius: 4px; padding: 7px 10px; }
    #chats-setup button.apply { color: #fff; background: #7a1a12; border-color: #ff2a1a; }
    #chats-setup button:disabled, #chats-setup input:disabled { opacity: .5; cursor: default; }
    #chats-setup .close { position: absolute; }
  `;
  const button = Object.assign(document.createElement('button'), { id: 'chats-btn', type: 'button' });
  button.setAttribute('aria-haspopup', 'dialog');
  const overlay = Object.assign(document.createElement('div'), { id: 'chats-setup', hidden: true });
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-label', 'Choose the chats in the room');
  overlay.innerHTML = `<div class="card">
      <h3>Chats in the room</h3>
      <div class="note"></div>
      <div class="list"></div>
      <div class="row"><span class="count"></span>
        <button type="button" class="b all">All</button><button type="button" class="b none">None</button>
        <button type="button" class="b cancel">Close</button><button type="button" class="b apply">Apply</button></div>
    </div>`;
  const note = overlay.querySelector('.note');
  const rows = overlay.querySelector('.list');
  const count = overlay.querySelector('.count');
  const apply = overlay.querySelector('.apply');

  const renderButton = () => {
    const shown = pickedOf(list.include, list.chats).size;
    button.textContent = `CHATS ${shown}/${list.chats.length}`;
  };
  const renderCount = () => {
    count.textContent = `${checked.size} of ${list.chats.length} chats, ${list.chats.filter((c) => checked.has(c.sid)).reduce((n, c) => n + c.agents, 0)} subagents`;
    apply.disabled = !canEdit || checked.size === 0 || pickKey(includeCommand(checked, list.chats).sids) === pickKey(list.include);
  };
  const renderList = () => {
    note.textContent = canEdit
      ? 'Pick the chats every viewer sees. Each brings its subagents. Apply rebuilds the room for everyone.'
      : 'Viewing only. Open this page with ?key=edit to change the room.';
    rows.replaceChildren(
      ...list.chats.map((c) => {
        const row = document.createElement('label');
        const box = Object.assign(document.createElement('input'), { type: 'checkbox', checked: checked.has(c.sid), disabled: !canEdit });
        box.addEventListener('change', () => {
          if (box.checked) checked.add(c.sid);
          else checked.delete(c.sid);
          renderCount();
        });
        const h = Object.assign(document.createElement('span'), { className: `h ${c.harness}`, textContent: c.harness });
        const t = Object.assign(document.createElement('span'), { className: 't', textContent: c.title || c.sid });
        const k = Object.assign(document.createElement('span'), { className: 'k', textContent: c.agents ? `+${c.agents} subagents` : '' });
        row.append(box, h, t, k);
        return row;
      }),
    );
    renderCount();
  };
  const open = () => {
    checked = pickedOf(list.include, list.chats);
    renderList();
    overlay.hidden = false;
  };
  const close = () => (overlay.hidden = true);
  button.addEventListener('click', open);
  overlay.querySelector('.cancel').addEventListener('click', close);
  overlay.addEventListener('click', (e) => e.target === overlay && close());
  document.addEventListener('keydown', (e) => e.key === 'Escape' && close());
  overlay.querySelector('.all').addEventListener('click', () => {
    checked = new Set(list.chats.map((c) => c.sid));
    renderList();
  });
  overlay.querySelector('.none').addEventListener('click', () => {
    checked = new Set();
    renderList();
  });
  apply.addEventListener('click', () => {
    net?.send(includeCommand(checked, list.chats));
    close();
  });

  bus.addEventListener('mode', (e) => {
    canEdit = Boolean(e.detail?.canEdit);
    if (!overlay.hidden) renderList();
  });
  // Load room.js's reset now, so a changed pick clears the room before the next frame arrives.
  let resetRoom = null;
  import('./room.js').then((m) => (resetRoom = m.reset));
  bus.addEventListener('chats', (e) => {
    list = { chats: e.detail.chats, include: e.detail.include ?? null };
    const key = pickKey(list.include);
    if (shownKey !== null && key !== shownKey) resetRoom?.(); // the relay re-sends the picked chats right after this frame
    shownKey = key;
    renderButton();
    if (!overlay.hidden) renderCount();
  });

  renderButton();
  document.head.append(style);
  document.body.append(button, overlay);
}
