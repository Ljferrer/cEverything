// long-think (s_think): a hard design question; very long thinking messages streamed via message.delta.
import { SessionWriter, T0 } from './lib.mjs';

const STREAM = { lo: 20, hi: 60, dtLo: 30, dtHi: 80 };

const THINK_A = `The question has three moving parts: who is allowed to write, how order is defined, and what a client may show before the server has confirmed it. Start with the writer. If both headsets and the laptop could mutate columns directly we would need CRDTs or a merge rule for every field: position, scroll, tile order. None of that is necessary if the hub is the single writer: every client sends a command, the hub validates it against canonical state, and the only thing that leaves the hub is an event with a monotonic sequence number. Order then has one definition, the server's seq, and every client that applies events in seq order converges on the same scene by construction. Hermes fits the same funnel: the adapter polls the dashboard, diffs rows, and feeds the same reducer, so an agent message and a judge's pipe command are both just events with a seq. The cost is latency on the headset's own actions, one round trip through the hub, which over a tunnel is 100 to 300 ms. That is acceptable for a tile appearing but not for a hand carrying a tile, so the carry must be predicted locally; I will come back to that. Snapshot versus replay: a joining client needs the full state once, then only deltas. The hub keeps a ring buffer of the last N events; a client reconnecting with lastSeq inside the buffer gets the gap replayed, otherwise a fresh snapshot. The snapshot must carry the seq it was taken at so the client can discard any replayed event with seq <= snapshot.seq. Without that, a snapshot followed by an overlapping replay double-applies a message.add and a ghost tile appears, which is exactly the bug the question forbids. One more subtlety: the server must take the snapshot and record its seq atomically with respect to the broadcast loop, otherwise an event can slip between the two and be neither in the snapshot nor after it.`;

const THINK_B = `Idempotency. A monotonic seq handles ordering but not duplicates across a reconnect, because the client may have applied events the server now replays again. Two layers. First, the client drops any event with seq <= its lastApplied. Second, and more robust, every entity carries a stable id: Session.id from Hermes, Message.id from the Hermes row id (with :r for the reasoning split and :callId for each tool call), tool.start and tool.complete keyed by callId. A message.add for an id the store already has is an upsert, not an append, so the tile count cannot drift even if the seq check is bypassed at a snapshot boundary. message.delta is the one non-idempotent event: appending the same chunk twice corrupts the text. So deltas are best effort, and message.complete carries the full text and replaces the buffer; a client that missed or doubled a delta heals at completion. That is also why the fixture format puts the final text in message.complete. Layout conflicts: two people can drag the same base at once. The hub applies layout.move in arrival order and emits layout.column with by: clientId; the last event wins and every client animates to it. The dragging client ignores incoming layout.column for the column it is carrying until it releases, then snaps to the authoritative position. Forks: the child gets a fresh id minted by the server, never by the client, so two clients forking the same column at the same moment produce two children, not one collision. Pipes: the composed user message is created by the hub with via: pipe and from: {sessionId, messageId}; the source tile is never mutated. Removal: session.remove is a tombstone event the client applies by fading, and the server keeps the id in a tombstone set for the ring buffer's lifetime so a late message.add for a removed session is dropped rather than resurrecting the column.`;

const THINK_C = `What may be predicted locally? Exactly one thing: the object the viewer's own hand is carrying — the tile copy during a pipe, the ghost column during a fork, the base during a move. These are per-viewer view state until release; on release the client sends the command and keeps showing the predicted result until the hub's event arrives, then reconciles, usually a no-op, sometimes a 400 ms slide to the authoritative spot. Everything else — summon, scroll offset, detail plane, LOD — is purely local and never sent, so it cannot conflict. Presence is the opposite extreme: it is sent at 10 Hz but it is not state, it is a sample; it goes through the hub without a seq and is not in the ring buffer, because replaying old head poses after a reconnect would be nonsense. Fixture replay loops are a special case of idempotency: when all files are exhausted the replayer re-emits the same messages with an id suffix so the store sees new entities and the columns keep growing; without the suffix the upserts would be no-ops and the loop would be invisible. Reset is a server-side event sequence: session.remove for judge-made forks, layout.column back to the file, then a fresh snapshot to everyone; seq keeps increasing — we never rewind seq, we only change state. Clock: event ts is the server's receive time and is used for display only; ordering never depends on it, so clock skew between a headset and the laptop is harmless. Finally the status machine: status is derived on the server from the newest row and emitted as session.status, so no client guesses the ring colour from its own partial view, and a reconnecting client gets the current colour from the snapshot rather than replaying a minute of transitions.`;

const THINK_D = `Compaction is the case I had not covered. Hermes can rewrite history: it marks rows compacted and inserts a summary row, so a row id the adapter already emitted may vanish from the latest page while a new row appears in the middle of the transcript. Polling the latest 60 rows and diffing by row id handles additions and simply never sees a removal, which is the right default for a display: a tile that was shown stays shown, and the summary row is appended as a system message. If we ever want removals we need include_compacted plus a per-message tombstone, which the protocol does not have; add message.remove as an optional kind later rather than deleting anything locally on a hunch. The 1 Hz poll also means the live status lags up to a second behind the dashboard, which is why status should be derived from the newest row plus a 10 s liveness window, not from is_active alone, whose 300 s window would keep a ring green for minutes after the agent went quiet. And the optional /api/ws stream must be treated as a hint layer on the same ids: message.delta onto <sid>:live, which the poller's message.complete with the real row id then supersedes, so the stream can drop out at any time and the poller still converges. Nothing in the model changes; the adapter is just another client of the reducer with a slower clock.`;

const ANSWER = `**Consistency model for the shared scene**

1. **Single writer.** The hub owns canonical state. Clients send commands; the hub validates, mutates and emits events with a monotonic \`seq\`. Hermes rows enter through the same reducer. Convergence follows from applying events in \`seq\` order.
2. **Resume without ghosts.** \`join {lastSeq}\`: if the gap is inside the 5000-event ring buffer, replay it; otherwise send \`snapshot {seq}\`. Clients drop any event with \`seq <= lastApplied\` and treat \`snapshot.seq\` as the new floor. Snapshot and its seq are taken atomically.
3. **Idempotent entities.** Every session, message and tool call carries a stable id (Hermes row id, \`:r\`, \`:callId\`). \`message.add\` is an upsert; \`tool.start\`/\`tool.complete\` key on \`callId\`; \`session.remove\` leaves a tombstone so late adds are dropped.
4. **Deltas are best effort.** \`message.delta\` appends; \`message.complete\` carries the full text and replaces the buffer. Lost or doubled chunks heal at completion.
5. **Conflicts resolve by \`seq\`.** \`layout.column\` is last-writer-wins; the dragging client ignores incoming moves for the object it holds until release. Forks and pipes get server-minted ids.
6. **Local prediction = the carried object only.** Tile copy, ghost column, dragged base. Summon, scroll, detail plane and LOD are per-viewer and never sent. Presence is sampled at 10 Hz, unsequenced, not buffered.
7. **Fixture loops and reset** stay inside the model: re-emitted ids get a loop suffix, reset is an ordinary event sequence plus a snapshot; \`seq\` never rewinds. \`ts\` is display only.

Invariant to test: after any sequence of disconnects, \`store == reduce(snapshot, events.filter(e => e.seq > snapshot.seq))\` on every client.`;

export function build() {
  const w = new SessionWriter({
    id: 's_think', title: 'long-think', status: 'idle', model: 'nousresearch/hermes-4-405b', gitBranch: 'main',
    activity: 'idle', summary: 'Design the consistency model for the shared scene: ordering, idempotency, local prediction',
    startedAt: T0 - 8_000,
  }, { seed: 41, pace: 1.37 });

  w.user(4000, 'Design the consistency model for the shared scene. Two headsets and a laptop mutate the same columns through the Node hub; Hermes keeps appending messages concurrently; clients reconnect over flaky venue Wi-Fi and must never see duplicates or ghost tiles. Be concrete: ordering, idempotency, what may be predicted locally, and how fixture replay loops fit in.');
  w.status(600, 'thinking', 'thinking');
  const row = w.nextId();
  w.thinking(6500, THINK_A, { forId: row, stream: STREAM });
  w.status(1500, 'thinking', 'reasoning · 2.0k chars');

  w.status(22_000, 'tool', 'reading docs/PROTOCOL.md');
  let c = w.toolCall(800, 'read_file', { path: 'docs/PROTOCOL.md', offset: 63, limit: 8 });
  w.toolResult(900, c, {
    text: '63: ## 2. Transport\n64: \n65: - One WebSocket endpoint `/ws`. JSON text frames, one envelope per frame. Binary frames are **not** used (audio travels as base64 inside JSON for simplicity).\n66: - Connect sequence: client → `{t:"join", device, name, lastSeq?}`; server → `hello`, then either `snapshot` (new client or gap too large) or a replay of `event` frames with `seq > lastSeq`, then live frames.\n67: - Every state change is a server `event` with a monotonic `seq`. Clients never mutate shared state locally except the object they are carrying (local prediction); they send a command and apply the resulting events like everyone else.\n68: - Per-viewer local view state (summon, scroll offset, detail plane, LOD) is never sent.\n69: \n70: ### 2.1 Server → client frames',
    summary: '→ §2 Transport: join{lastSeq} → hello → snapshot | replay', meta: { path: 'docs/PROTOCOL.md' },
  });
  w.status(1200, 'thinking', 'thinking');
  // Second and third reasoning blocks belong to the same assistant turn; Hermes stores them as one reasoning
  // field, the normalizer would split on paragraph gaps. In the fixture each block is its own thinking message.
  const row2 = w.nextId();
  w.thinking(26_000, THINK_B, { forId: row2, stream: STREAM });
  w.status(1800, 'thinking', 'reasoning · 4.1k chars');
  const row3 = w.nextId();
  w.thinking(30_000, THINK_C, { forId: row3, stream: STREAM });
  w.status(1500, 'thinking', 'reasoning · 6.0k chars');

  w.status(16_000, 'tool', 'saving to memory');
  c = w.toolCall(700, 'memory', { action: 'add', target: 'memory', content: 'cEverything consistency: the hub is the single writer; server seq is the only order; message ids are idempotency keys; message.complete carries the full text so lost deltas heal; the carried object is the only client-side prediction.' }, { rowId: row3 });
  w.toolResult(700, c, { text: 'Added to memory (entry 15 of 40).', summary: '→ memory updated' });
  w.status(9000, 'responding', 'responding');
  w.assistant(1200, ANSWER, { id: row3, stream: { lo: 30, hi: 60, dtLo: 30, dtHi: 70 } });
  w.status(900, 'idle', 'idle');

  // follow-up
  w.user(28_000, 'What about the Hermes side? The adapter polls at 1 Hz and Hermes can compact history. Does that break anything?');
  w.status(600, 'thinking', 'thinking');
  const row4 = w.nextId();
  w.thinking(7000, THINK_D, { forId: row4, stream: STREAM });
  w.status(1200, 'responding', 'responding');
  w.assistant(2400, 'No. Compaction only ever adds rows from the poller\'s point of view (we never remove on a missing id), so shown tiles stay and the summary row is appended as a system message. Status should come from the newest row plus a 10 s liveness window rather than `is_active`. The optional `/api/ws` stream is a hint layer on the same ids that the poller\'s `message.complete` supersedes, so it can drop out without affecting convergence. If we ever need removals, add an optional `message.remove` tombstone kind; never delete locally.', { id: row4, stream: { lo: 30, hi: 60, dtLo: 30, dtHi: 70 } });
  w.status(800, 'idle', 'idle');
  return [w];
}
