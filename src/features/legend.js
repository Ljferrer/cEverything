// A collapsible legend in the laptop view: what each color, shape and control
// means. It reads the real color tables from colors.js, so it never drifts
// from the scene. Laptop and phone only (the same rule as laptop.js); the
// open/closed choice is a per-viewer convenience kept in localStorage.
import { ROLE_COLORS, STATE_COLORS, MONOLITH_RED, CODEX_TEAL } from '../colors.js';
import { shouldInstallLaptop } from '../input.js';

const STORE_KEY = 'obelisks.legend.open';

const hex = (n) => '#' + n.toString(16).padStart(6, '0');

/** The legend's sections as plain data, so a test can check them without a DOM. */
export function legendSections() {
  return [
    {
      title: 'Slab colors (message role)',
      rows: Object.entries(ROLE_COLORS).map(([role, color]) => ({ swatch: hex(color), label: role })),
    },
    {
      title: 'Base colors (session state)',
      rows: Object.entries(STATE_COLORS).map(([status, color]) => ({ swatch: hex(color), label: status })),
    },
    {
      title: 'Monolith edges (harness)',
      rows: [
        { swatch: hex(MONOLITH_RED), label: 'Black stone, red edges: Claude Code or Hermes' },
        { swatch: hex(CODEX_TEAL), label: 'Teal stone, teal edges, ">_" glyph: Codex' },
      ],
    },
    {
      title: 'Shapes',
      rows: [
        { label: 'Tall monolith: one chat (Hermes, Claude Code, or Codex)' },
        { label: 'Small monoliths beside it: its subagents' },
        { label: 'Glyph and number: the chat id' },
        { label: 'White cone above: the chat waits for you' },
        { label: 'Wall pylons: browser, filesystem, shell, other tools' },
        { label: 'Flying spark: a tool call heading to its pylon' },
      ],
    },
    {
      title: 'Controls',
      rows: [
        { label: 'W/S: walk. A/D: turn. Q/E: strafe. Shift: run' },
        { label: 'Drag: look around. Wheel: zoom toward the mouse' },
        { label: 'Click a slab: select that chat' },
        { label: 'Click a base: fork the chat' },
        { label: 'Slab, then another base: pipe that message' },
        { label: 'Headset: hold a pinch to talk' },
        { label: 'Timeline: drag back, Play, LIVE' },
        { label: 'M: mute sounds' },
      ],
    },
  ];
}

export async function install() {
  if (!(await shouldInstallLaptop())) return;
  let open = false;
  try {
    open = localStorage.getItem(STORE_KEY) === '1';
  } catch {}

  const panel = document.createElement('div');
  panel.id = 'legend';
  const style = document.createElement('style');
  style.textContent = `
    #legend { position: fixed; top: 12px; right: 12px; z-index: 5; max-width: 280px; font: 12px/1.4 system-ui, sans-serif;
      color: #ddd; background: rgba(0,0,0,.75); border: 1px solid #5a1a14; border-radius: 6px; }
    #legend button { all: unset; cursor: pointer; display: block; padding: 6px 10px; color: #ff6a5a; font-weight: 700; letter-spacing: .08em; }
    #legend .body { padding: 0 10px 8px; max-height: 70vh; overflow: auto; }
    #legend h4 { margin: 8px 0 4px; font-size: 11px; color: #aaa; font-weight: 600; }
    #legend .row { display: flex; align-items: center; gap: 6px; }
    #legend .sw { width: 12px; height: 12px; border-radius: 2px; flex: none; }
    @media (width < 600px) { #legend { top: auto; bottom: 200px; max-width: 220px; } }
  `;
  const toggle = document.createElement('button');
  toggle.type = 'button';
  const body = document.createElement('div');
  body.className = 'body';
  for (const section of legendSections()) {
    const h = document.createElement('h4');
    h.textContent = section.title;
    body.append(h);
    for (const row of section.rows) {
      const r = document.createElement('div');
      r.className = 'row';
      if (row.swatch) {
        const sw = document.createElement('span');
        sw.className = 'sw';
        sw.style.background = row.swatch;
        r.append(sw);
      }
      const t = document.createElement('span');
      t.textContent = row.label;
      r.append(t);
      body.append(r);
    }
  }
  const render = () => {
    toggle.textContent = open ? 'LEGEND ▾' : 'LEGEND ▸';
    toggle.setAttribute('aria-expanded', String(open));
    body.hidden = !open;
  };
  toggle.addEventListener('click', () => {
    open = !open;
    try {
      localStorage.setItem(STORE_KEY, open ? '1' : '0');
    } catch {}
    render();
  });
  panel.append(toggle, body);
  document.head.append(style);
  document.body.append(panel);
  render();
}
