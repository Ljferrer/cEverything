---
name: consolidate-exts-v2-timeout
description: Why ConsolidateExtsV2Handler times out at 900s on big cases, why redrives eventually succeed, and the Phase-1 fix (run_parallel fan-out + SFN retry) that landed
metadata: 
  seededFrom: work-audit-refine/docs/seed@0.21.15
  node_type: memory
  type: project
  keywords: [timeout, sequential S3 fetch, redrive, checkpointing, run_parallel fan-out, ConsolidateExtsV2]
  slug: consolidate-exts-v2-timeout
  tags: [consolidate, timeout, run_parallel, sfn-retry, step-functions]
---

ConsolidateExtsV2Handler (`auto_index/stacks/summary/AssistiveMetadataV2/consolidate/consolidate_page_extractions.py`) times out at its 900s limit on large cases. Diagnosed 2026-06-30 for prod case `76c7c224` (6303 pages).

**Root cause:** Step 3 (lines ~289-364) fetches "missing" pagekeys from S3 one at a time — a sequential `list_bucket_objects` + `stream_file_s3` per pagekey, per extraction type. Only the two non-medical types (`author_info`, `all_dates`) run Step 3; the 6 MEDICAL_EXTRACTIONS skip it. Measured ~187 ms/pagekey → **~2709 missing pagekeys ≈ 507s for ONE type**. Two expensive types ≈ 1014s > 900s → timeout. The number of "missing" pagekeys is whatever the OmniExtraction distributed-map gather (`gather_tmp_outputs`) did NOT return; that gather count is unstable across runs (observed 0, 1771, 2177, 3591, 3990, 25158).

**Why a redrive / re-run "eventually" succeeds:** consolidation is **checkpointed to S3 per extraction type** — Step 5 writes each type's full consolidated file *inside* the loop (lines ~382-399), and Step 1 (lines ~228-247) loads any existing file on the next run so those pagekeys are no longer "missing". Each timed-out attempt therefore monotonically shrinks the next attempt's work. The successful redrive of case 76c7c224 inherited a complete `author_info` checkpoint (2 missing instead of 2709), leaving only `all_dates` (507s) expensive → 525s total < 900s. It's partly luck-of-the-gather: a low-gather attempt can still exceed 900s on one type alone.

**Aggravating factor:** `consolidate_exts_task` has NO Step Functions retry (only `deduplicate_extractions_task` gets `add_retry` — assistive_summary_stack.py:757-765), so one 900s timeout = `ExecutionFailed`, requiring a manual redrive.

**FIX LANDED (2026-06-30), 2 tasks:**

- **T1 (`perf(consolidate): parallelize Step 3 …`)** extracted the per-pagekey body of the `# Step 3` loop into two module-level (picklable, no-closure) functions `_fetch_one_pagekey` / `_fetch_missing_pagekeys` in `consolidate_page_extractions.py` and replaced the sequential `for pk in missing_pks` with a `run_parallel` fan-out. Concurrency is env-tunable: `MAX_PARALLEL = int(os.environ.get('MAX_PARALLEL', 8))`, default 8 (set to `"8"` in `assistive_summary_config.json` → `ConsolidateExtractionsV2Lmb.additional_env_vars`). 8-way turns ~507s/type into ~65s. Behavior-preserving: same record shapes, same per-type S3 checkpointing (Step 5), not-found still → pk absent.
- **T2 (`fix(consolidate): add SFN retry …`)** added `assistive_meta_v2_steps['consolidate_extractions_task']` to BOTH `# Add retry logic` loops in `assistive_summary_stack.py` — the standalone `create_assistive_metadata_state_machine_v2` loop AND the prod `create_assistive_index_state_machine_v3` loop (each previously held only `deduplicate_extractions_task`). Errors default to `States.ALL`, mirroring siblings; retry reloads prior per-type checkpoints so a timeout self-heals. Locate cues (pre-fix tip): the `consolidate_extractions_task` key is registered at `assistive_summary_stack.py:718`; the two retry loops are at `:795` (standalone) and `:1818` (prod) — anchor by the `# Add retry logic` comment + the `deduplicate_extractions_task` entry, NOT the line number (a rebase already shifted this file ~36 lines once).
- **§5.3 gather instability** (the unstable 0..25158 gather count above) was **deferred** — T1 makes Step 3 fast enough that the count no longer matters operationally.

**REUSABLE GOTCHA — `run_parallel` is Pipe-based; the target `conn.send(...)`s, it does NOT `return`.** This tripped the plan into a whole "non-obvious, load-bearing" design note, and the same recipe repeats at the other fan-out sites, so keep it handy (all `code-verified` @ `auto_index/utils/layers/boto_helpers/mlp_helper.py` — verify still present before acting):
- `run_parallel(iter_args, static_args, target_func, iter_args_first, max_parallel)` (def `mlp_helper.py:133`). It calls the target as `target_func(*iter_arg, *static_args, conn)` — it **appends `conn` itself**, so do NOT put `conn` in `static_args`. The target MUST end with `conn.send(result); conn.close()` and must NOT `return` (mirror `stream_file_wrapper`, `mlp_helper.py:214`). `run_parallel` returns the list of sent values in input order.
- `iter_args_first` is a **required positional (no default)**; `max_parallel` **defaults to 5** — you must pass your own (T1 passes `MAX_PARALLEL`).
- Target must be **module-level / picklable** (no closures) — multiprocessing pickles it.
- **Test seam (DP3):** under macOS **spawn** a child re-imports the module and loses monkeypatched S3 fakes (works under Linux **fork** in CI, flaky locally). So the fan-out/merge unit test monkeypatches `run_parallel` to a serial fake and asserts the merge; a separate in-process test covers `_fetch_one_pagekey` with a stub `conn` capturing `.send()`/`.close()`. Production uses the real `run_parallel`. (Repo idiom: real-layer import via `sys.path` to the layer dirs + monkeypatch S3, per `test_assistive_metadata_v2_image_prep.py`.)