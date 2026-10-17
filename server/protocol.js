// cEverything wire protocol constants + validators (PROTOCOL.md §2).
// Browser-safe: no Node imports. Served to the client as /shared/protocol.js.

export const PROTOCOL_VERSION = 1;

export const EVENT_KINDS = Object.freeze([
  'session.upsert', 'session.remove', 'session.status',
  'message.add', 'message.delta', 'message.complete',
  'tool.start', 'tool.complete',
  'layout.column', 'fork', 'pipe', 'pylons',
]);

export const COMMAND_NAMES = Object.freeze([
  'send', 'pipe', 'fork', 'new', 'layout.move', 'approve', 'interrupt',
  'presence', 'audio.start', 'audio.chunk', 'audio.stop', 'voice.text', 'fixture.control',
]);

export const STATUSES = Object.freeze(['idle', 'thinking', 'responding', 'tool', 'waiting_on_you', 'done', 'error']);
export const ROLES = Object.freeze(['user', 'assistant', 'thinking', 'tool_call', 'tool_result', 'system']);
export const CATEGORIES = Object.freeze(['web', 'files', 'coding', 'memory', 'delegating', 'images', 'messaging', 'waiting', 'tools']);
export const PYLON_KINDS = Object.freeze(['browser', 'files', 'terminal', 'self']);
export const DEVICES = Object.freeze(['visionpro', 'quest', 'desktop', 'phone', 'unknown']);
export const ATTENTION_KINDS = Object.freeze(['approval', 'clarify', 'done', 'error']);
export const VIAS = Object.freeze(['voice', 'keyboard', 'pipe', 'agent', 'replay']);
export const FIXTURE_ACTIONS = Object.freeze(['pause', 'play', 'speed', 'reset', 'cue']);
export const CUES = Object.freeze(['needs_you', 'web_burst', 'patch', 'delegate', 'done']);
export const ERROR_CODES = Object.freeze(['bad_command', 'unknown_session', 'source_unavailable', 'not_supported']);

export const CATEGORY_COLORS = Object.freeze({
  coding: '#22C55E', web: '#F59E0B', files: '#14B8A6', memory: '#EC4899', delegating: '#FB923C',
  images: '#D946EF', messaging: '#3B82F6', waiting: '#EF4444', tools: '#9CA3AF',
});

export const ROLE_COLORS = Object.freeze({
  user: '#FFFFFF', assistant: '#38BDF8', thinking: '#A78BFA', tool_call: '#F59E0B',
  tool_result: '#B45309', system: '#6B7280', error: '#EF4444',
});

/** Tool name → category (bighelp mapping, PROTOCOL.md §2.3). */
export function CATEGORY_OF_TOOL(name) {
  const n = String(name || '').toLowerCase();
  if (!n) return 'tools';
  if (n === 'terminal' || n === 'execute_code' || n === 'process_manage' || n === 'bash' || n === 'shell') return 'coding';
  if (n === 'read_file' || n === 'write_file' || n === 'patch' || n === 'search_files' || n === 'list_files' || n === 'edit_file') return 'files';
  if (n === 'web_search' || n === 'web_extract' || n === 'web_fetch' || n.startsWith('browser_')) return 'web';
  if (n === 'memory' || n === 'session_search' || n.startsWith('skill') || n === 'todo') return 'memory'; // skill_view, skills_list, skill_manage
  if (n === 'delegate_task' || n.startsWith('subagent')) return 'delegating';
  if (n.startsWith('image_') || n.startsWith('vision_') || n.startsWith('video_')) return 'images';
  if (n === 'send_message' || n === 'text_to_speech') return 'messaging';
  if (n === 'clarify' || n === 'ask_user' || n === 'approval') return 'waiting';
  return 'tools';
}

/** Category → pylon the packet flies to ("self" = flash on the column's own base). */
export function TARGET_OF_CATEGORY(cat) {
  switch (cat) {
    case 'coding': return 'terminal';
    case 'files': return 'files';
    case 'web': return 'browser';
    default: return 'self';
  }
}

export const ROLE_GLYPHS = Object.freeze({
  user: 'U', assistant: 'A', thinking: '✎', tool_result: '↩', system: 'S',
});
export const CATEGORY_GLYPHS = Object.freeze({
  web: '🔍', files: '📁', coding: '>_', memory: '🧠', delegating: '⇄', images: '🖼',
  messaging: '✉', waiting: '⚑', tools: '⚙',
});

/** Glyph for a message (1–2 chars). tool_call glyphs come from the category. */
export function GLYPH_OF(role, category) {
  if (role === 'tool_call') return CATEGORY_GLYPHS[category] || CATEGORY_GLYPHS.tools;
  return ROLE_GLYPHS[role] || '?';
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const isStr = (v) => typeof v === 'string';
const isNonEmptyStr = (v) => typeof v === 'string' && v.length > 0;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isBool = (v) => typeof v === 'boolean';
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isVec3 = (v) => Array.isArray(v) && v.length === 3 && v.every(isNum);
const isQuat = (v) => Array.isArray(v) && v.length === 4 && v.every(isNum);

function fail(error) { return { ok: false, error }; }
const OK = Object.freeze({ ok: true, error: null });

/** Field requirements per command: [field, predicate, required]. */
const COMMAND_FIELDS = {
  send: [['sessionId', isNonEmptyStr, true], ['text', isStr, true], ['via', (v) => v === 'voice' || v === 'keyboard' || v === 'pipe', false], ['from', isObj, false]],
  pipe: [['fromSessionId', isNonEmptyStr, true], ['fromMessageId', isNonEmptyStr, true], ['toSessionId', isNonEmptyStr, true]],
  fork: [['sessionId', isNonEmptyStr, true], ['atMessageId', isNonEmptyStr, false], ['x', isNum, false], ['z', isNum, false], ['title', isStr, false]],
  new: [['title', isStr, false], ['x', isNum, false], ['z', isNum, false]],
  'layout.move': [['sessionId', isNonEmptyStr, true], ['x', isNum, true], ['z', isNum, true], ['rot', isNum, true]],
  approve: [['sessionId', isNonEmptyStr, true], ['requestId', isStr, false], ['allow', isBool, true]],
  interrupt: [['sessionId', isNonEmptyStr, true]],
  presence: [
    ['head', (v) => isObj(v) && isVec3(v.p) && isQuat(v.q), false],
    ['hands', (v) => Array.isArray(v) && v.length === 2 && v.every((h) => h === null || (isObj(h) && isVec3(h.p))), false],
    ['gazeSessionId', (v) => v === null || isStr(v), false],
    ['hover', (v) => v === null || (isObj(v) && isNonEmptyStr(v.sessionId)), false],
    ['ray', (v) => v === null || (isObj(v) && isVec3(v.o) && isVec3(v.d)), false],
  ],
  'audio.start': [['sessionId', isNonEmptyStr, true], ['sampleRate', (v) => v === 16000, true]],
  'audio.chunk': [['data', isStr, true]],
  'audio.stop': [],
  'voice.text': [['sessionId', isNonEmptyStr, true], ['text', isStr, true], ['final', isBool, true]],
  'fixture.control': [['action', (v) => FIXTURE_ACTIONS.includes(v), true], ['value', () => true, false], ['sessionId', isStr, false]],
};

/** validateCommand(frame) → { ok, error }. Checks envelope, name and per-command field types. */
export function validateCommand(frame) {
  if (!isObj(frame)) return fail('frame must be an object');
  if (frame.t !== 'command') return fail(`t must be "command" (got ${JSON.stringify(frame.t)})`);
  if (!isNonEmptyStr(frame.id)) return fail('id must be a non-empty string');
  if (!COMMAND_NAMES.includes(frame.name)) return fail(`unknown command name ${JSON.stringify(frame.name)}`);
  const spec = COMMAND_FIELDS[frame.name] || [];
  for (const [field, pred, required] of spec) {
    const v = frame[field];
    if (v === undefined) {
      if (required) return fail(`${frame.name}: missing field "${field}"`);
      continue;
    }
    if (!pred(v)) return fail(`${frame.name}: invalid field "${field}"`);
  }
  if (frame.name === 'fixture.control') {
    if (frame.action === 'speed' && !(isNum(frame.value) && frame.value > 0)) return fail('fixture.control speed: value must be a positive number');
    if (frame.action === 'cue' && !CUES.includes(frame.value)) return fail(`fixture.control cue: value must be one of ${CUES.join(', ')}`);
  }
  return OK;
}

/** validateEvent(ev) → { ok, error } for fixture lines / server events (t/seq/ts optional). */
export function validateEvent(ev) {
  if (!isObj(ev)) return fail('event must be an object');
  if (!EVENT_KINDS.includes(ev.kind)) return fail(`unknown event kind ${JSON.stringify(ev.kind)}`);
  if (!isNonEmptyStr(ev.sessionId)) return fail('event.sessionId must be a non-empty string');
  switch (ev.kind) {
    case 'session.upsert': if (!isObj(ev.session) || !isNonEmptyStr(ev.session.id)) return fail('session.upsert: session.id required'); break;
    case 'session.status': if (!STATUSES.includes(ev.status)) return fail('session.status: invalid status'); break;
    case 'message.add': if (!isObj(ev.message) || !isNonEmptyStr(ev.message.id) || !ROLES.includes(ev.message.role)) return fail('message.add: message{id,role} required'); break;
    case 'message.delta': if (!isNonEmptyStr(ev.messageId) || !isStr(ev.text)) return fail('message.delta: messageId,text required'); break;
    case 'message.complete': if (!isNonEmptyStr(ev.messageId)) return fail('message.complete: messageId required'); break;
    case 'tool.start': if (!isNonEmptyStr(ev.messageId) || !isNonEmptyStr(ev.callId) || !isNonEmptyStr(ev.name)) return fail('tool.start: messageId,callId,name required'); break;
    case 'tool.complete': if (!isNonEmptyStr(ev.messageId) || !isNonEmptyStr(ev.callId)) return fail('tool.complete: messageId,callId required'); break;
    case 'layout.column': if (!isObj(ev.placement) || !isNum(ev.placement.x) || !isNum(ev.placement.z)) return fail('layout.column: placement{x,z} required'); break;
    case 'fork': if (!isNonEmptyStr(ev.fromSessionId) || !isNonEmptyStr(ev.newSessionId)) return fail('fork: fromSessionId,newSessionId required'); break;
    case 'pipe': if (!isNonEmptyStr(ev.fromSessionId) || !isNonEmptyStr(ev.toSessionId)) return fail('pipe: fromSessionId,toSessionId required'); break;
    case 'pylons': if (!Array.isArray(ev.pylons)) return fail('pylons: pylons[] required'); break;
    default: break;
  }
  return OK;
}

/** Backwards-friendly alias used by PROTOCOL.md ("validate(frame)"). */
export function validate(frame) {
  if (isObj(frame) && frame.t === 'command') return validateCommand(frame);
  if (isObj(frame) && (frame.t === 'event' || (frame.t === undefined && frame.kind))) return validateEvent(frame);
  return fail('not a command or event frame');
}

export default {
  PROTOCOL_VERSION, EVENT_KINDS, COMMAND_NAMES, STATUSES, ROLES, CATEGORIES, PYLON_KINDS, DEVICES,
  ATTENTION_KINDS, VIAS, FIXTURE_ACTIONS, CUES, ERROR_CODES, CATEGORY_COLORS, ROLE_COLORS,
  CATEGORY_OF_TOOL, TARGET_OF_CATEGORY, GLYPH_OF, validateCommand, validateEvent, validate,
};
