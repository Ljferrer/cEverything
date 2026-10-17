// The `pipe` command (PIN-6, PIN-34, PIN-36): quote one slab of `from` into
// `to` as a user prompt. The text comes from the owner's `slabText`, else the
// relay's slab cache (A11). Delegates to `ctx.commands.say.handle`, so the
// read-only gate, the user-slab echo, and the resolved value are one path.
import { title } from './say.mjs';

export const name = 'pipe';

function slabText(from, sid, id, ctx) {
  if (typeof from?.slabText === 'function') {
    const t = from.slabText(sid, id);
    if (typeof t === 'string' && t !== '') return t;
  }
  return ctx.relay.slabs.get(sid)?.find((s) => s.id === id)?.text;
}

export async function handle(cmd, ctx) {
  const from = ctx.ownerOf(cmd.from);
  const text = slabText(from, cmd.from, cmd.slab, ctx);
  if (typeof text !== 'string' || text === '') return { t: 'error', text: 'slab not found' };
  return ctx.commands.say.handle({ t: 'say', sid: cmd.to, text: 'From ' + title(from, cmd.from) + ': ' + text }, ctx);
}
