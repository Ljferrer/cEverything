// Obelisks wire protocol (PIN-22): the exact shapes every client and every
// relay source or command module speaks. Plans 2–6 build on these and add none.
//
// server → client
//   {t:'mode',    mode:'live'|'replay'|'synthetic', canEdit:boolean}
//   {t:'session', sid, harness:'hermes'|'claude'|'codex'|'synthetic', kind:'chat'|'agent', title, status, parent, phase}
//   {t:'slab',    sid, id, role:'user'|'assistant'|'thinking'|'tool', text, ts}
//   {t:'delta',   sid, id, role, text}
//   {t:'tool',    sid, id, name, phase:'start'|'complete', args, summary, diff}
//   {t:'state',   sid, status:'idle'|'working'|'streaming'|'waiting'|'error'}
//   {t:'error',   text}
//   {t:'chats',   chats:[{sid, harness, title, status, agents}], include:[sid]|null}
//                 every main chat the relay knows, and the room's selection (null = all)
// client → server
//   {t:'say',   sid, text}
//   {t:'fork',  sid}
//   {t:'pipe',  from, to, slab}
//   {t:'voice', sid, mime, data_url}
//   {t:'include', sids:[sid]|null}   pick the main chats every viewer sees (null = all)

export const MODES = Object.freeze(['live', 'replay', 'synthetic']);
export const HARNESSES = Object.freeze(['hermes', 'claude', 'codex', 'synthetic']);
export const KINDS = Object.freeze(['chat', 'agent']);
export const ROLES = Object.freeze(['user', 'assistant', 'thinking', 'tool']);
export const TOOL_PHASES = Object.freeze(['start', 'complete']);
export const STATUSES = Object.freeze(['idle', 'working', 'streaming', 'waiting', 'error']);

export const SERVER_EVENTS = Object.freeze(['mode', 'session', 'slab', 'delta', 'tool', 'state', 'error', 'chats']);
export const CLIENT_COMMANDS = Object.freeze(['say', 'fork', 'pipe', 'voice', 'include']);

/** Every event name, grouped by direction. Clients subscribe to `bus` under these names. */
export const EVENTS = Object.freeze({ server: SERVER_EVENTS, client: CLIENT_COMMANDS });

// Field checkers. `req` fields must pass; `opt` fields may be absent or null.
const str = (v) => typeof v === 'string';
const bool = (v) => typeof v === 'boolean';
const num = (v) => typeof v === 'number' && Number.isFinite(v);
const oneOf = (list) => (v) => list.includes(v);
const any = () => true;
const strs = (v) => Array.isArray(v) && v.every(str);
const chatList = (v) =>
  Array.isArray(v) && v.every((c) => c && str(c.sid) && HARNESSES.includes(c.harness) && str(c.title) && STATUSES.includes(c.status) && num(c.agents));

const SERVER_SHAPES = {
  mode: { req: { mode: oneOf(MODES), canEdit: bool }, opt: {} },
  session: {
    req: { sid: str, harness: oneOf(HARNESSES), kind: oneOf(KINDS), title: str, status: oneOf(STATUSES) },
    opt: { parent: str, phase: str },
  },
  slab: { req: { sid: str, id: str, role: oneOf(ROLES), text: str, ts: num }, opt: {} },
  delta: { req: { sid: str, id: str, role: oneOf(ROLES), text: str }, opt: {} },
  tool: {
    req: { sid: str, id: str, name: str, phase: oneOf(TOOL_PHASES) },
    opt: { args: any, summary: str, diff: str },
  },
  state: { req: { sid: str, status: oneOf(STATUSES) }, opt: {} },
  error: { req: { text: str }, opt: {} },
  chats: { req: { chats: chatList }, opt: { include: strs } },
};

const CLIENT_SHAPES = {
  say: { req: { sid: str, text: str }, opt: {} },
  fork: { req: { sid: str }, opt: {} },
  pipe: { req: { from: str, to: str, slab: str }, opt: {} },
  voice: { req: { sid: str, mime: str, data_url: str }, opt: {} },
  include: { req: {}, opt: { sids: strs } },
};

function matches(shapes, o) {
  if (o === null || typeof o !== 'object' || Array.isArray(o)) return false;
  const shape = Object.prototype.hasOwnProperty.call(shapes, o.t) ? shapes[o.t] : null;
  if (!shape) return false;
  for (const [k, check] of Object.entries(shape.req)) {
    if (!check(o[k])) return false;
  }
  for (const [k, check] of Object.entries(shape.opt)) {
    if (o[k] !== undefined && o[k] !== null && !check(o[k])) return false;
  }
  return true;
}

/** True when `o` is one of the server → client frames above. */
export function isServerEvent(o) {
  return matches(SERVER_SHAPES, o);
}

/** True when `o` is one of the client → server commands above. */
export function isClientCommand(o) {
  return matches(CLIENT_SHAPES, o);
}
