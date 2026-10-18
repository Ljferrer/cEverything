// A HEADSET HELP button on every 2D page (laptop, phone, and Quest Browser
// before Enter VR): step-by-step instructions to get into the room in a
// headset and use it. Inside an immersive session the page DOM is hidden, so
// the panel is for before you put the headset on, or for whoever helps you.
export const STEPS = Object.freeze([
  'On the Quest, open Quest Browser.',
  'Open this page: type the address shown below, or scan the QR code on the laptop.',
  'Press Enter VR at the bottom of the page.',
  'Allow the microphone when the headset asks, so you can talk to agents.',
]);

export const CONTROLS = Object.freeze([
  'Follow the glowing path: each tall monolith beside it is one agent chat, its subagents stand behind it.',
  'Point and pull the trigger (or pinch) on a message: select that chat.',
  'Pinch a monolith base: fork that chat into a new one.',
  'Pinch a message, then another base: pipe that message into the other chat.',
  'Select a chat, then hold the pinch on it and speak: release to send your voice.',
  'Turn to face a monolith to read it: detail opens in front of you.',
  'Press the Meta button to leave VR.',
]);

/** The address to type on the headset: this page's origin plus the edit key when the page has one. */
export function headsetAddress(loc = location) {
  const key = new URLSearchParams(loc.search).get('key');
  return `${loc.host}/${key ? `?key=${encodeURIComponent(key)}` : ''}`;
}

export function install() {
  if (typeof document === 'undefined') return;
  const style = document.createElement('style');
  style.textContent = `
    #headset-help-btn { position: fixed; top: 52px; right: 12px; z-index: 999; cursor: pointer; font: 700 12px/1 system-ui, sans-serif;
      letter-spacing: .08em; color: #ff6a5a; background: rgba(0,0,0,.75); border: 1px solid #5a1a14; border-radius: 6px; padding: 8px 10px; }
    @media (width < 600px) { #headset-help-btn { top: 172px; } } /* below the phone QR panel */
    #headset-help { position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,.6); }
    #headset-help[hidden] { display: none; }
    #headset-help .card { max-width: 520px; width: calc(100vw - 32px); max-height: 85vh; overflow: auto; padding: 16px 18px;
      font: 15px/1.45 system-ui, sans-serif; color: #eee; background: #0b0b0b; border: 1px solid #ff2a1a; border-radius: 8px; }
    #headset-help h3 { margin: 0 0 8px; color: #ff6a5a; letter-spacing: .06em; }
    #headset-help h4 { margin: 14px 0 6px; color: #aaa; font-size: 13px; }
    #headset-help ol, #headset-help ul { margin: 0; padding-left: 20px; }
    #headset-help li { margin: 4px 0; }
    #headset-help .addr { display: block; margin: 8px 0; padding: 8px; font: 600 16px/1.3 ui-monospace, monospace; color: #fff;
      background: #1a1a1a; border-radius: 4px; word-break: break-all; }
    #headset-help .close { float: right; cursor: pointer; color: #aaa; background: none; border: 0; font-size: 20px; }
  `;
  const button = document.createElement('button');
  button.id = 'headset-help-btn';
  button.type = 'button';
  button.textContent = 'HEADSET HELP';
  button.setAttribute('aria-haspopup', 'dialog');

  const overlay = document.createElement('div');
  overlay.id = 'headset-help';
  overlay.hidden = true;
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-label', 'Headset instructions');
  const card = document.createElement('div');
  card.className = 'card';
  const close = document.createElement('button');
  close.className = 'close';
  close.type = 'button';
  close.textContent = '×';
  close.setAttribute('aria-label', 'Close');
  const h = document.createElement('h3');
  h.textContent = 'Use Obelisks in a headset';
  const steps = document.createElement('ol');
  for (const s of STEPS) steps.append(Object.assign(document.createElement('li'), { textContent: s }));
  const addr = Object.assign(document.createElement('code'), { className: 'addr', textContent: headsetAddress() });
  const h2 = Object.assign(document.createElement('h4'), { textContent: 'In VR' });
  const controls = document.createElement('ul');
  for (const s of CONTROLS) controls.append(Object.assign(document.createElement('li'), { textContent: s }));
  card.append(close, h, steps, addr, h2, controls);
  overlay.append(card);

  const show = (on) => (overlay.hidden = !on);
  button.addEventListener('click', () => show(true));
  close.addEventListener('click', () => show(false));
  overlay.addEventListener('click', (e) => e.target === overlay && show(false));
  document.addEventListener('keydown', (e) => e.key === 'Escape' && show(false));

  document.head.append(style);
  document.body.append(button, overlay);
}
