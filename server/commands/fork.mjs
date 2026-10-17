// The `fork` command (PIN-10, PIN-34): branch the session over the owning
// source's WebSocket `session.branch`, never an HTTP route. The sibling
// obelisk arrives through the source's attach-and-announce; `room.js` places
// it beside the parent. Emits nothing; resolves to `undefined` on success.
import { READ_ONLY, title } from './say.mjs';

export const name = 'fork';

export async function handle(cmd, ctx) {
  const owner = ctx.ownerOf(cmd.sid);
  if (typeof owner?.sendCommand !== 'function') return { ...READ_ONLY };
  await owner.sendCommand('session.branch', { session_id: cmd.sid, name: title(owner, cmd.sid) + ' fork' });
  return undefined;
}
