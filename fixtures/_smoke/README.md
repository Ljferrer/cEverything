# fixtures/_smoke

Tiny two-session scenario used by `test/protocol.test.mjs` (not the demo).

- `alpha.jsonl` — `fix-parser-tests`: user → thinking → read_file → patch (with a unified diff) → terminal → assistant → idle.
- `beta.jsonl` — `deploy-staging`: user → web_extract → assistant → parked at `waiting_on_you` (approval `req_beta_1`).

Whole story is ~3.5 s of fixture time, so at `--speed 4` it replays in under a second.
