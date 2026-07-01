# Auto-index after `process` — implementation report

Branch: feat/auto-index (already checked out, no commit/push made).

## Files changed

- /Users/filanovskii/MeetingRecorder/app/lib/mainutil.js
- /Users/filanovskii/MeetingRecorder/app/tests/mainutil.test.js
- /Users/filanovskii/MeetingRecorder/app/main.js

## Grounding (read before editing)

- main.js:420-466 `process-audio` handler — spawns backend `process`, streams events via `send("process-event", ev)`, resolves `{ok:true}` immediately (fire-and-forget from the renderer's perspective; UI tracks progress via the event stream, not the resolved promise).
- backend.py:791-797 confirms the completion event is `emit("done", note=str(note_path), audio=..., ...)` — fired once per successful run, before the process exits. `note` is the full path to the saved .md file, written under `OBSIDIAN_PATH` which is exactly the `--out-dir` argument main.js passed in (`outDir || DEFAULT_OUT`). So `path.dirname(doneNote)` == the run's outDir — no need to separately track/pass outDir.
- main.js:638(orig)-651(orig) `para-reindex` handler — spawns `backend.py index --root <root> --db <DB_PATH>`, streams `log`/`error` events to renderer via `send("para-reindex-event", ev)`, resolves a summary on close. `root` arrives as an IPC arg, not read from presets by main.
- main.js:239-264 `get-presets` — the only handler that reads `PRESETS_FILE` directly (with `PRESETS_EXAMPLE` fallback for a fresh clone) and applies `expandHome` to `data.para.root`.
- Confirmed pattern: **every existing handler that needs config (`para-reindex`, `para-tree`, `para-search`, `para-classify`, `para-file`) receives it as an IPC arg from the renderer's cached `state.para`** (preload.js:19-24, renderer.js:747,756,833,940,958,1003). There is no existing handler that is self-triggered from a background completion callback with no renderer round-trip to piggyback config on — auto-index is the first. Since main.js already owns the direct-file-read pattern for presets (in `get-presets`), and there is no renderer call in the loop for a background trigger, I had the new `readParaRoot()` read `PRESETS_FILE` directly (mirroring `get-presets`'s read+fallback) rather than plumbing `para.root` through `process-audio`'s opts — this avoids relying on the renderer to remember to forward a value it doesn't otherwise need for that call, and matches the only present example of main reading config on its own initiative.
- renderer.js:734-744: `onParaReindexEvent` is a **global** listener (not scoped to the reindex button's click handler) that appends to a normally-hidden `#paraReindexLog` box via `paraSearchLog()`. Reusing this channel for the background trigger therefore produces exactly the "quiet log" the task asked for with zero renderer/preload changes — the box only becomes visible when the user opens the reindex UI, which they haven't for an auto-triggered run.

## Implementation

main.js:638-689 (new), also touches 691-702 (existing `para-reindex`, extracted call site):

- `indexArgs(root)` — the `["index", "--root", root, "--db", DB_PATH]` array, extracted so `para-reindex` and the new auto-index path spawn the identical command instead of duplicating the literal (task explicitly asked to reuse, not duplicate).
- `readParaRoot()` — reads `PRESETS_FILE` (fallback `PRESETS_EXAMPLE`, catch-and-return-null on any failure), returns `expandHome(data.para.root)` or `null`.
- `startAutoIndex(root)` — spawns via `indexArgs(root)`, forwards `log`/`error` events to `para-reindex-event`, and on close runs the serialization step (below) before deciding whether to spawn again.
- `triggerAutoIndex(notePath)` — the entry point called from `process-audio`'s close handler:
  1. `readParaRoot()` → if falsy, return (silent skip, requirement 2).
  2. `isOutsideRoot(path.dirname(notePath), root)` → if true, emit one `log` event on `para-reindex-event` noting the note is outside the indexed root (requirement 3) — the index run itself still targets `para.root` regardless, so it still covers the vault.
  3. Feed `"trigger"` into the `indexRunReducer` in-flight/queue state machine; spawn only if it says to.

main.js:420-466 (process-audio handler): the `onEvent` closure now captures `ev.note` when `ev.event === "done"` into a per-invocation `doneNote` local; the `onClose` closure calls `triggerAutoIndex(doneNote)` iff the run wasn't canceled, exited 0, and a `done` event was actually seen. The renderer-facing behavior (`process-closed` event, promptFile cleanup, `procProc`/`procCanceled` reset) is unchanged and still happens first — `triggerAutoIndex` starts a detached background spawn and returns immediately, so `process-audio`'s own resolution/close event is not delayed (requirement 1, non-blocking).

Requirement 4 (embedding model unavailable → backend already degrades, don't fail anything): no special-casing needed — `startAutoIndex`'s close callback ignores `code`/`stderr` entirely and only ever forwards `log`/`error` events to a UI channel nothing awaits; nothing in the new code path can throw or reject.

### In-flight guard (requirement 5)

Implemented as a small pure reducer, `indexRunReducer(state, action)` in lib/mainutil.js, with `state = { inFlight, queued }` and `action ∈ {"trigger","complete"}`:

- `trigger` while idle → starts now, `{inFlight:true, queued:false}`.
- `trigger` while `inFlight` → does not start, sets `queued:true` (coalesces any number of triggers during a run into exactly one trailing run — chosen over "skip" because `process-audio` is otherwise unserialized once its own run closes, so a second `process` run can legitimately finish while the first run's index is still going; queuing avoids silently dropping that note from the index until some later manual reindex).
- `complete` with `queued:true` → immediately starts the trailing run and clears the queue flag.
- `complete` with `queued:false` → goes idle.

main.js holds the single mutable `indexRunState` module-level variable and threads it through `readParaRoot`'s caller (`triggerAutoIndex`) and `startAutoIndex`'s close callback; the reducer itself is pure and holds no state.

## Deviations from the prompt

None. Placement stayed in main.js as instructed (no materially cleaner point found — main.js already owns the spawn logic, `DB_PATH`, and the `done` event). No renderer.js or preload.js changes were needed; the existing `para-reindex-event` channel and its already-hidden-by-default log box absorbed the "quiet log" requirement with zero additional wiring. backend.py was not touched.

## Tests added (lib/mainutil.js pure functions, tests/mainutil.test.js)

- `isOutsideRoot`: inside root → false; equal to root → false; outside → true; no root configured → false; no dir → false.
- `indexRunReducer`: trigger-while-idle starts; trigger-while-in-flight queues (no start); second trigger while already queued stays queued (no pile-up); complete-with-no-queue goes idle; complete-with-queue starts trailing run and clears queue; undefined initial state defaults to idle.

## Verification (both suites green)

```
$ node --test tests/mainutil.test.js
...
1..33
# tests 33
# pass 33
# fail 0

$ node --test tests/renderer.test.js
...
1..29
# tests 29
# pass 29
# fail 0

$ node --test tests/mainutil.test.js tests/renderer.test.js   # combined
1..62
# tests 62
# pass 62
# fail 0

$ ../venv/bin/python -m pytest tests/ -q
........................................................................ [ 75%]
........................                                                 [100%]
96 passed in 0.40s
```

Baseline was JS 51/51, PY 96/96. New totals: JS 62/62 (mainutil 22→33, +11 new tests; renderer unchanged at 29/29), PY 96/96 unchanged (backend.py untouched, as instructed).

`node --check main.js` and `node --check lib/mainutil.js` both clean before the test runs.

No commit, no push — working tree left dirty on `feat/auto-index` per instructions.
