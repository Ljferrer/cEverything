// The `include` command: an editor picks which main chats every viewer sees.
// `sids` null (or absent) shows them all. Each chat brings its subagents. The
// relay re-sends the chat list, and each viewer reloads into the new room.
export const name = 'include';

export async function handle(cmd, ctx) {
  ctx.relay.setInclude(Array.isArray(cmd.sids) ? cmd.sids : null);
}
