// research-webxr (s_research): how Vision Pro Safari delivers WebXR input. Web bursts → browser pylon.
import { SessionWriter, T0 } from './lib.mjs';

const WEBKIT = 'https://webkit.org/blog/15162/introducing-natural-input-for-webxr-in-apple-vision-pro/';
const SPEC = 'https://www.w3.org/TR/webxr/#dom-xrtargetraymode-transient-pointer';
const MDN = 'https://developer.mozilla.org/en-US/docs/Web/API/XRInputSource/targetRayMode';
const APPLE = 'https://developer.apple.com/documentation/safari-release-notes/safari-18-release-notes';
const THREE_SRC = 'https://github.com/mrdoob/three.js/blob/r170/src/renderers/webxr/WebXRManager.js';
const THREE_DOC = 'https://threejs.org/docs/#api/en/renderers/webxr/WebXRManager';
const META_HANDS = 'https://developers.meta.com/horizon/documentation/web/webxr-hands/';
const EXPLAINER = 'https://immersive-web.github.io/webxr/input-explainer.html';

const search = (query, web) => ({
  args: { query, limit: web.length },
  text: web.map((w, i) => `${i + 1}. ${w[0]}\n   ${w[1]}\n   ${w[2]}`).join('\n'),
  summary: `→ ${web.length} results · ${new URL(web[0][1]).host}`,
});

export function build() {
  const w = new SessionWriter({
    id: 's_research', title: 'research-webxr', status: 'idle', model: 'anthropic/claude-sonnet-4-5',
    gitBranch: 'main', activity: 'idle',
    summary: 'How does Safari on Vision Pro deliver WebXR input, and which indices do we listen on?',
    startedAt: T0 - 95_000,
  }, { seed: 11, pace: 1.84 });

  w.user(2800, 'How does Safari on Vision Pro deliver WebXR input? I need to know which input-source indices our select handlers in web/input/xr.js should listen on, whether enabling hand tracking changes them, and what three.js r170 does about it. Cite the sources.');
  w.status(400, 'thinking', 'thinking');

  let row = w.nextId();
  w.thinking(4200, 'The user wants the input model of visionOS Safari for WebXR. I remember Apple introduced a "transient-pointer" target ray mode: the input source only exists while the user pinches, and its ray starts from the eyes at selectstart. I should verify that on webkit.org and in the WebXR spec, then check how three.js\'s WebXRManager assigns controller indices to input sources that come and go, and finally compare with Quest for the fallback path.', { forId: row });
  w.status(300, 'tool', 'browsing: webkit.org');
  const s1 = search('visionOS Safari WebXR transient-pointer input source selectstart', [
    ['Introducing Natural Input for WebXR in Apple Vision Pro | WebKit', WEBKIT, 'WebXR on visionOS uses transient-pointer input sources: a pinch creates an input source whose ray starts at the gaze and follows the hand.'],
    ['WebXR Device API — XRTargetRayMode', SPEC, '"transient-pointer": the input source is not tracked persistently; its target ray is only meaningful while a select gesture is in progress.'],
    ['XRInputSource: targetRayMode property - Web APIs | MDN', MDN, 'gaze, tracked-pointer, screen, transient-pointer.'],
    ['Safari 18 Release Notes | Apple Developer Documentation', APPLE, 'WebXR enabled by default on visionOS 2; immersive-vr sessions; hand tracking behind a permission prompt.'],
  ]);
  let c = w.toolCall(600, 'web_search', s1.args, { rowId: row });
  w.toolResult(2300, c, { text: s1.text, summary: s1.summary, meta: { query: c.args.query } });

  w.status(900, 'responding', 'responding');
  w.assistant(700, 'Found Apple\'s WebKit post on natural input and the spec entry for `transient-pointer`. Reading both before I say anything about indices.');
  w.status(500, 'tool', 'browsing: webkit.org');
  c = w.toolCall(1200, 'web_extract', { urls: [WEBKIT] });
  w.toolResult(4100, c, {
    text: `# Introducing Natural Input for WebXR in Apple Vision Pro\n\nvisionOS exposes a new XRTargetRayMode, "transient-pointer". When the person pinches, an XRInputSource is added to the session and a selectstart event fires; the targetRaySpace of that source is positioned on the line of sight at the moment of the pinch and then follows the motion of the hand for as long as the pinch is held. When the fingers release, select and selectend fire and the input source is removed. Because the source exists only during the gesture, pages must handle inputsourceschange and must not assume a fixed set of controllers. Hand tracking ("hand-tracking" optional feature) is available behind a permission prompt and provides joint poses only; it never fires select events itself.`,
    summary: '→ transient-pointer: source appears at selectstart, follows the hand, removed after selectend',
    meta: { url: WEBKIT },
  });

  row = w.nextId();
  w.status(1200, 'thinking', 'thinking');
  w.thinking(5200, 'So the input source is transient: it appears at selectstart and disappears at selectend, with targetRayMode "transient-pointer". Code that attaches listeners to controller 0 only at startup could still work, because three.js maps input sources to controller slots lazily — but I need to confirm how WebXRManager picks the slot when two hands are also present as persistent input sources. Check Apple\'s release notes for the hand-tracking default, then the three.js source.', { forId: row });
  w.status(400, 'tool', 'browsing: developer.apple.com');
  c = w.toolCall(800, 'browser_navigate', { url: APPLE }, { rowId: row });
  w.toolResult(5600, c, {
    text: `Navigated to ${APPLE}\nTitle: Safari 18 Release Notes | Apple Developer Documentation\n\n- heading "WebXR" [ref=e14]\n  - "Added support for WebXR Device API on visionOS, enabled by default." \n  - "Supports immersive-vr sessions; immersive-ar is not supported."\n  - "Added the transient-pointer target ray mode for pinch input."\n  - "Hand tracking is available as an optional feature and requires user permission."\n- heading "Web Speech" [ref=e22] (no visionOS entry)\n- link "Safari 17.4 Release Notes" [ref=e40]`,
    summary: '→ visionOS: WebXR on by default, immersive-vr only, hand tracking optional + permission',
    meta: { url: APPLE },
  });

  w.status(2200, 'tool', 'browsing: threejs.org');
  const q2 = 'three.js WebXRManager getController index transient-pointer input source hand tracking';
  c = w.toolCall(1500, 'web_search', { query: q2, limit: 5 });
  w.toolResult(2100, c, {
    text: `1. WebXRManager – three.js docs\n   ${THREE_DOC}\n   getController(index): returns a Group representing the XR controller at index; created on demand.\n2. three.js/src/renderers/webxr/WebXRManager.js at r170 · GitHub\n   ${THREE_SRC}\n   onInputSourcesChange assigns added input sources to the first free controller slot.\n3. Vision Pro transient pointer: which controller index fires select? – three.js forum\n   https://discourse.threejs.org/t/vision-pro-transient-pointer-controller-index/62980\n   With hand tracking on, pinches show up on controllers 2 and 3; without it on 0 and 1.\n4. WebXR input explainer – immersive-web\n   ${EXPLAINER}\n   Target ray modes and input source lifecycle.`,
    summary: '→ 4 results · github.com (WebXRManager.js r170)',
    meta: { query: q2 },
  });
  c = w.toolCall(1900, 'web_extract', { urls: [THREE_SRC] });
  w.toolResult(3700, c, {
    text: `WebXRManager.js (r170) — excerpt\n\nfunction onInputSourcesChange( event ) {\n  // Notify disconnected\n  for ( let i = 0; i < event.removed.length; i ++ ) {\n    const inputSource = event.removed[ i ];\n    const index = controllerInputSources.indexOf( inputSource );\n    if ( index >= 0 ) {\n      controllerInputSources[ index ] = null;\n      controllers[ index ].disconnect( inputSource );\n    }\n  }\n  // Notify connected\n  for ( let i = 0; i < event.added.length; i ++ ) {\n    const inputSource = event.added[ i ];\n    let controllerIndex = controllerInputSources.indexOf( inputSource );\n    if ( controllerIndex === - 1 ) {\n      // Assign input source a controller that currently has no input source\n      for ( let i = 0; i < controllers.length; i ++ ) {\n        if ( i >= controllerInputSources.length ) {\n          controllerInputSources.push( inputSource );\n          controllerIndex = i;\n          break;\n        } else if ( controllerInputSources[ i ] === null ) {\n          controllerInputSources[ i ] = inputSource;\n          controllerIndex = i;\n          break;\n        }\n      }\n      // If all controllers do currently receive input we ignore new ones\n      if ( controllerIndex === - 1 ) break;\n    }\n    const controller = controllers[ controllerIndex ];\n    if ( controller ) controller.connect( inputSource );\n  }\n}\n\nthis.getController = function ( index ) {\n  let controller = controllers[ index ];\n  if ( controller === undefined ) {\n    controller = new WebXRController();\n    controllers[ index ] = controller;\n  }\n  return controller.getTargetRaySpace();\n};`,
    summary: '→ first-free-slot assignment; slots beyond controllers.length are ignored',
    meta: { url: THREE_SRC },
  });

  row = w.nextId();
  w.status(1400, 'thinking', 'thinking');
  w.thinking(6800, 'That settles the index question. Slots are assigned first-free, and a new input source is dropped when every existing controller already has one. With hand tracking granted, the two persistent hand input sources arrive at session start and occupy slots 0 and 1, so the transient pinch pointers land on 2 and 3. Without hand tracking, pinches land on 0 and 1. And since getController(i) is what creates a slot, any index we did not request before the session started simply never receives the pinch. Create 0..3 up front, or listen on the XRSession directly. Now the Quest side, for the fallback path.', { forId: row });
  w.status(300, 'tool', 'browsing: developers.meta.com');
  const q3 = 'Quest Browser WebXR hand tracking input sources controllers both indices';
  c = w.toolCall(700, 'web_search', { query: q3, limit: 4 }, { rowId: row });
  w.toolResult(1900, c, {
    text: `1. Hand Tracking in WebXR | Meta Horizon Developers\n   ${META_HANDS}\n   Request "hand-tracking" as an optional feature; hands appear as tracked-pointer input sources with XRHand joints.\n2. WebXR Input | Meta Horizon Developers\n   https://developers.meta.com/horizon/documentation/web/webxr-input/\n   Controllers and hands switch automatically; inputsourceschange fires on each swap.\n3. WebXR hands: joint poses and pinch detection – immersive-web\n   https://immersive-web.github.io/webxr-hand-input/\n   XRHand joint spaces, thumb-tip/index-finger-tip.\n4. Quest browser release notes – WebXR\n   https://developers.meta.com/horizon/documentation/web/browser-release-notes/`,
    summary: '→ 4 results · developers.meta.com',
    meta: { query: q3 },
  });
  c = w.toolCall(1600, 'web_extract', { urls: [META_HANDS] });
  w.toolResult(3900, c, {
    text: `# Hand Tracking in WebXR (Meta Horizon)\n\nAdd "hand-tracking" to optionalFeatures when requesting the session. When the person sets the controllers down, Browser swaps the input sources: the two controller sources are removed and two hand sources are added (targetRayMode "tracked-pointer", handedness left/right, inputSource.hand holding 25 XRJointSpaces). Pinch gestures on hands fire selectstart/select/selectend on the same input source, so a page that listens on controllers 0 and 1 keeps working across the swap. Hand meshes are the page's responsibility; Browser only provides joint poses. Passthrough (immersive-ar) is supported alongside hand tracking.`,
    summary: '→ Quest: hands/controllers swap on the same two sources; pinch fires select',
    meta: { url: META_HANDS },
  });

  w.status(1800, 'tool', 'browsing: immersive-web.github.io');
  c = w.toolCall(900, 'browser_navigate', { url: EXPLAINER });
  w.toolResult(4800, c, {
    text: `Navigated to ${EXPLAINER}\nTitle: WebXR Device API Explained — Input\n\n- heading "Input sources" [ref=e3]\n- heading "Target ray modes" [ref=e9]\n  - "gaze" — ray from the viewer's head\n  - "tracked-pointer" — ray from a tracked hand or controller\n  - "screen" — ray from a touch on a handheld AR screen\n  - "transient-pointer" — ray from an input source that exists only for the duration of a select action\n- heading "Transient input sources" [ref=e17]\n  - "A transient-pointer input source is added immediately before its selectstart event and removed immediately after its selectend event."\n- link "XRInputSource" [ref=e31]`,
    summary: '→ spec: transient source added before selectstart, removed after selectend',
    meta: { url: EXPLAINER },
  });
  c = w.toolCall(1400, 'web_extract', { urls: [MDN] });
  w.toolResult(2600, c, {
    text: `XRInputSource.targetRayMode — values\n\n"gaze": the target ray originates at the viewer's eyes and follows the direction they are facing.\n"screen": the target ray originates from a touch on a 2D screen (handheld AR).\n"tracked-pointer": the target ray comes from a tracked controller or hand.\n"transient-pointer": the input source is created for a single interaction (for example a pinch on visionOS); the ray is valid from selectstart to selectend and the source is removed afterwards.\n\nBrowser compatibility: transient-pointer — Safari on visionOS 2+.`,
    summary: '→ MDN: transient-pointer valid from selectstart to selectend',
    meta: { url: MDN },
  });

  row = w.nextId();
  w.status(1500, 'thinking', 'thinking');
  w.thinking(4400, 'I have primary sources for every claim: WebKit for the gesture lifecycle, the spec and MDN for the target ray mode, the three.js source for slot assignment, Meta for the Quest behaviour. The practical consequence for web/input/xr.js is clear: create controllers 0..3 before the session, listen on all of them plus the XRSession, resolve the ray from inputSource.targetRaySpace with frame.getPose at selectstart, and do not request hand-tracking on Vision Pro unless joints are needed. Write it up with the index table.', { forId: row });
  w.status(600, 'responding', 'responding');
  w.assistant(900, `Here is what the sources say, and what it means for \`web/input/xr.js\`.

1. **visionOS Safari exposes a pinch as a transient input source.** Its \`targetRayMode\` is \`"transient-pointer"\`; the source is added right before \`selectstart\`, its \`targetRaySpace\` starts on the line of sight at that instant and then follows the hand while the pinch is held, and it is removed right after \`selectend\` (WebKit blog; WebXR spec; MDN).
2. **three.js r170 assigns each new input source to the first free controller slot** (\`WebXRManager.onInputSourcesChange\`). Without hand tracking a pinch arrives on index 0 (a second simultaneous pinch on 1). With \`hand-tracking\` granted, the two persistent hand sources take 0 and 1 at session start, so the transient pointers appear on **2 and 3**.
3. **Slots exist only if you asked for them.** \`renderer.xr.getController(i)\` creates the slot; a source that finds no free slot is ignored. So create controllers 0..3 *before* \`requestSession\`, listen on all four, and also listen on the \`XRSession\` itself (\`selectstart\`/\`select\`/\`selectend\`) and resolve the ray with \`frame.getPose(inputSource.targetRaySpace, refSpace)\`.
4. **Do not request \`hand-tracking\` on Vision Pro by default.** It adds an in-session permission prompt and only shifts the indices; hands never fire select themselves. Quest is different: hands and controllers swap on the same two tracked-pointer sources and pinches fire select there too (Meta docs).

Rule for us: on Vision Pro the select ray at \`selectstart\` is the targeting truth (it is the eye gaze); the head ray is cosmetic.

| device | hand-tracking | pinch / trigger index |
|---|---|---|
| Vision Pro | off | 0 (second pinch 1) |
| Vision Pro | on | 2, 3 |
| Quest 3S | hands or controllers | 0, 1 |

Sources: ${WEBKIT} · ${SPEC} · ${THREE_SRC} · ${META_HANDS}`, { id: row, stream: { lo: 30, hi: 60, dtLo: 30, dtHi: 70 } });
  w.status(900, 'idle', 'idle');

  // follow-up
  w.user(14_000, 'Does the ray keep updating while the pinch is held? We need that for carry-at-distance when piping a tile.');
  w.status(500, 'thinking', 'thinking');
  row = w.nextId();
  w.thinking(3600, 'The WebKit post said the ray follows the motion of the hand for as long as the pinch is held, so yes. Worth stating how to read it per frame and the one caveat: the origin starts at the eyes, not at the hand.', { forId: row });
  w.status(300, 'responding', 'responding');
  w.assistant(800, 'Yes. While the pinch is held the transient pointer\'s `targetRaySpace` follows the hand, so you can read `frame.getPose(inputSource.targetRaySpace, refSpace)` every frame between `selectstart` and `selectend`. The caveat for carry-at-distance: the initial ray starts at the eyes, so keep the hit distance from `selectstart` and apply only the ray\'s change to the carried tile; do not re-origin it at the hand.', { id: row });
  w.status(700, 'tool', 'saving to memory');
  c = w.toolCall(1800, 'memory', { action: 'add', target: 'memory', content: 'cEverything XR input: visionOS pinches are transient-pointer input sources; three.js assigns first free controller slot, so indices are 0/1 without hand tracking and 2/3 with it. Create controllers 0..3 before the session and listen on the XRSession too.' });
  w.toolResult(600, c, { text: 'Added to memory (entry 14 of 40).', summary: '→ memory updated' });
  w.status(500, 'idle', 'idle');

  // second follow-up: the mic question
  w.user(12_000, 'Last one: does a getUserMedia audio track survive entering immersive-vr on visionOS Safari? Our push-to-talk depends on it.');
  w.status(500, 'thinking', 'thinking');
  row = w.nextId();
  w.thinking(3900, 'I do not have a primary source for this and should not guess; CONTEXT.md already marks it unverified. Search for developer reports, then say plainly what is and is not established and what the fallback is.', { forId: row });
  w.status(300, 'tool', 'browsing: webkit.org');
  const q4 = 'visionOS Safari WebXR immersive-vr getUserMedia microphone track ends session start';
  c = w.toolCall(700, 'web_search', { query: q4, limit: 4 }, { rowId: row });
  w.toolResult(2200, c, {
    text: `1. WebXR and media capture on visionOS – Apple Developer Forums\n   https://developer.apple.com/forums/tags/webxr\n   Mixed reports; one thread says an audio-only stream kept running inside an immersive session on visionOS 2.1.\n2. Bug 275318 – [visionOS] MediaStreamTrack muted when entering immersive WebXR session – WebKit Bugzilla\n   https://bugs.webkit.org/show_bug.cgi?id=275318\n   Reported against an early visionOS 2 beta; no resolution comment.\n3. Media Capture and Streams – Safari Web Technology Overview\n   https://developer.apple.com/documentation/safari-release-notes\n   Microphone permission is per page load on Safari; AudioContext must start inside a user gesture.`,
    summary: '→ 3 results · nothing authoritative; one open WebKit bug', meta: { query: q4 },
  });
  c = w.toolCall(1500, 'web_extract', { urls: ['https://bugs.webkit.org/show_bug.cgi?id=275318'] });
  w.toolResult(3400, c, {
    text: 'Bug 275318 – [visionOS] MediaStreamTrack from getUserMedia reports muted after requestSession("immersive-vr")\n\nStatus: NEW. Reported against visionOS 2 beta 4. Steps: acquire an audio track on the 2D page, enter immersive-vr, observe track.muted === true until the session ends. One later comment reports the track staying live on a newer build but with the AudioContext suspended until resumed from a gesture. No confirmation from WebKit engineers in the thread.',
    summary: '→ WebKit bug: open, beta-era report, one contradicting later comment', meta: { url: 'https://bugs.webkit.org/show_bug.cgi?id=275318' },
  });
  w.status(1100, 'responding', 'responding');
  w.assistant(900, 'Unverified, and I would not build on it. There is an open WebKit report of the audio track going muted on entering immersive-vr (filed against a visionOS 2 beta) and one later comment saying it stays live if the AudioContext is resumed from a gesture; nothing authoritative either way. Plan: acquire the mic and create the AudioContext inside the ENTER button handler on the 2D page, keep the stream alive, and if `track.muted` flips or the track ends at session start, switch to "headset looks, laptop speaks" and say so in the narration. Test it in the first Vision Pro slot, not the last.', { id: row });
  w.status(600, 'idle', 'idle');
  return [w];
}
