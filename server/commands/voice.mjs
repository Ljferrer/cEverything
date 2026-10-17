// The relay's `voice` command (plan 5 Task 2): `{t:'voice', sid, mime, data_url}`
// from a headset becomes a transcript through Hermes's own STT route, then a
// `say` through plan 1's command delegation seam (`ctx.commands.say.handle`).
// This module emits no slab and never calls the owner's `sendCommand`: the
// user slab and the prompt submit are plan 2's `say` command's (PIN-15,
// PIN-65). The session token and the transcribe route live only here, never
// in the client (PIN-9).
//
// Every `handle` call logs one stdout line:
//   voice <sid> <mime> <data_url bytes> <status>
// where `status` is the HTTP status when a transcribe request was made and
// otherwise the error text.

export const name = 'voice';

const DEFAULT_WS = 'ws://127.0.0.1:9119/api/ws';

/** The transcribe endpoint: `OBELISKS_TRANSCRIBE_URL`, else `HERMES_WS_URL` re-pointed at `/api/audio/transcribe` over http(s). */
export function transcribeUrl(env = process.env) {
  if (env.OBELISKS_TRANSCRIBE_URL) return env.OBELISKS_TRANSCRIBE_URL;
  const u = new URL(env.HERMES_WS_URL ?? DEFAULT_WS);
  if (u.protocol === 'ws:') u.protocol = 'http:';
  else if (u.protocol === 'wss:') u.protocol = 'https:';
  u.pathname = '/api/audio/transcribe';
  u.search = '';
  return u.href;
}

export async function handle(cmd, ctx) {
  const log = (status) => console.log('voice', cmd.sid, cmd.mime, cmd.data_url.length, status);
  const fail = (text) => {
    const frame = { t: 'error', text };
    ctx.emit(frame);
    return frame;
  };

  const owner = ctx.ownerOf(cmd.sid);
  if (!owner || typeof owner.sendCommand !== 'function') {
    log('read-only harness');
    return fail('read-only harness');
  }
  if (typeof ctx.commands?.say?.handle !== 'function') {
    log('say unavailable');
    return fail('say unavailable');
  }

  let res;
  try {
    res = await fetch(transcribeUrl(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Hermes-Session-Token': process.env.HERMES_DASHBOARD_SESSION_TOKEN ?? '',
      },
      body: JSON.stringify({ data_url: cmd.data_url, mime_type: cmd.mime }),
    });
  } catch (err) {
    const text = `transcribe failed: ${err?.message ?? err}`;
    log(text);
    return fail(text);
  }
  log(res.status);
  if (!res.ok) return fail(`transcribe failed: ${res.status}`);

  let text = '';
  try {
    text = String((await res.json())?.text ?? '');
  } catch {
    text = '';
  }
  if (!text.trim()) return fail('no speech');

  return ctx.commands.say.handle({ t: 'say', sid: cmd.sid, text }, ctx);
}
