# Sound overrides

Drop a sound file here to replace one of the synthesized room sounds.
`src/features/sound.js` tries `/sfx/<cue>.ogg` first, then `/sfx/<cue>.mp3`.
If a file loads and decodes, it plays for that cue. Any cue without a file keeps its synthesized sound.

Accepted extensions: `.ogg`, `.mp3`.

| Cue | Plays on |
|---|---|
| `select` | select an obelisk base |
| `slab` | select a slab |
| `miss` | click on nothing |
| `spawn` | a new obelisk appears |
| `waiting` | a session starts waiting for its user |
| `tool-browser` | a browser tool starts |
| `tool-filesystem` | a filesystem tool starts |
| `tool-shell` | a shell tool starts |
| `tool-other` | any other tool starts |
| `tool-complete` | any tool completes |
| `fork` | a fork is sent |
| `pipe` | a pipe is sent |
| `say` | a typed message is sent |
| `voice-start` | voice recording starts |
| `voice-sent` | a voice recording is sent |
| `voice-dropped` | a voice recording is dropped |
| `error` | a relay or voice error |

Keep files short (under a second or two). Spawn, waiting and tool sounds play at most 3 per second.
Files load when the page opens and decode after the first click or key press.
