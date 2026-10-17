// The `say` command (PIN-6, PIN-34): echo the typed text as a user slab on
// the session, then submit it to the owning source as `prompt.submit`.
// The error frame is the resolved value (the relay returns it to the issuer)
// and is never emitted. Success resolves to `undefined`.
//
// The slab id is `'user-' + Date.now() + '-' + <per-module counter>`: the
// client's `addSlab` replaces a slab whose id repeats, so two `say` calls
// inside one millisecond (a burst caller, or `pipe` right after `say`) must
// not share an id. The counter never resets while the module is loaded.
// The plan slice pins the literal `'user-' + Date.now()`: the suffix is a
// conscious deviation under the plan's mechanism latitude (End state 4 pins
// no id form, and no consumer keys on the id).
//
// `title` is the shared title rule (PIN-36) that fork and pipe import; it
// lives here because every `server/commands/*.mjs` is loaded as a command.

export const name = 'say';

export const READ_ONLY = { t: 'error', text: 'read-only harness' };

let slabSeq = 0;

/** `owner.titleOf(sid)` when it is a function returning a non-empty string, else `sid` (a throw included). */
export function title(owner, sid) {
  if (typeof owner?.titleOf !== 'function') return sid;
  try {
    const t = owner.titleOf(sid);
    return typeof t === 'string' && t !== '' ? t : sid;
  } catch {
    return sid;
  }
}

export async function handle(cmd, ctx) {
  const owner = ctx.ownerOf(cmd.sid);
  if (typeof owner?.sendCommand !== 'function') return { ...READ_ONLY };
  const now = Date.now();
  slabSeq += 1;
  ctx.emit({ t: 'slab', sid: cmd.sid, id: 'user-' + now + '-' + slabSeq, role: 'user', text: cmd.text, ts: now });
  await owner.sendCommand('prompt.submit', { session_id: cmd.sid, text: cmd.text });
  return undefined;
}
