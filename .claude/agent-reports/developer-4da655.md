# Disk-space guard before recording (feat/disk-guard)

## statfs availability
- Runtime Node: `v22.20.0` (`node -e "process.version"`), has `fs.statfsSync`/`fs.statfs` (`typeof` both `"function"`).
- Confirmed on the real project volume: `fs.statfsSync('/Users/filanovskii/MeetingRecorder/app')` → `{ type, bsize: 4096, blocks, bfree, bavail: 37166150, files, ffree }`. `bavail`/`bsize` fields exist and are used (`freeBytes = bavail * bsize`, the space actually usable by the current user, not `bfree`/root-reserved).
- App's Electron is `^33.0.0` (package.json) → bundled Node ≥20.18, which is above the 18.15 floor where `fs.statfs*` landed, so it is present at runtime under Electron too, not just the CLI `node` used for tests.

## Thresholds
- Refuse: free bytes < 1 GiB (`1024**3`).
- Warn: 1 GiB ≤ free bytes < 3 GiB.
- OK: free bytes ≥ 3 GiB (no message).
- Comment in `lib/mainutil.js` explains the WAV math backing the numbers (16kHz mono 16-bit, ~1.9 MB/min/track, ~6 MB/min / ~350 MB/h combined mic+system+mixed → 1 GiB ≈ 3h).

## Edits
- `lib/mainutil.js:96-116` — new `diskGuardVerdict(freeBytes)` pure function + `DISK_REFUSE_BYTES`/`DISK_WARN_BYTES` constants; exported at `lib/mainutil.js:169` (module.exports list).
- `main.js:9` — added `diskGuardVerdict` to the `./lib/mainutil` destructure.
- `main.js:287-298` — in the `start-recording` handler, after the "already recording" guard: `fs.statfsSync(TMP_DIR)` → `diskGuardVerdict(bavail*bsize)`; on `"refuse"` returns `{ ok: false, error: diskVerdict.msg }` immediately (same shape/flow as the existing `"Запись уже идёт"` early-return, so the renderer's existing `if (!res.ok) { alert(res.error); return; }` path handles it with no renderer change needed). `statfsSync` wrapped in try/catch — failure degrades to `"ok"` silently (guard never blocks recording on an unsupported FS).
- `main.js:356-358` — at the end of the handler, before `return { ok: true }`: if `diskVerdict.action === "warn"`, `send("record-event", { event: "disk-warning", msg: diskVerdict.msg })`. Placed after the system-audio-started/-error sends so the low-disk warning is the last (most urgent) status shown, not clobbered by the system-audio status text.
- `renderer/renderer.js:319-322` — new `else if (ev.event === "disk-warning")` branch in `onRecordEvent`: `setSysStatus(ev.msg, "warn")` (reuses the existing `.sys-status.warn` styling used by `system-audio-error`) + `appendLog(ev.msg)`.
- No max-duration cap added (explicitly deferred per task). `backend.py` untouched.

## Tests added
- `tests/mainutil.test.js` — imports `diskGuardVerdict`; 7 new boundary tests: below 1 GiB (refuse, MB-formatted message), just under 1 GiB (refuse), exactly 1 GiB (warn, not refuse), between 1–3 GiB (warn, GB-formatted message), just under 3 GiB (warn), exactly 3 GiB (ok, `msg: null`), well above 3 GiB (ok).
- `tests/renderer.test.js` — 1 new test: `handlers.record({ event: "disk-warning", msg: "..." })` → `#sysStatus` textContent matches and carries the `warn` class.
- Refuse path reuses the existing `alert(res.error)` wiring in `recBtn`'s click handler (`renderer/renderer.js:279`) verbatim — no new renderer code there, so no new test was needed for it per the task's own criterion ("only if a warning display path needs a new element").

## Verify — both suites green, ≥ baseline (JS 69/69, PY 108/108)
```
$ node --test tests/mainutil.test.js
...
1..40
# tests 40
# pass 40
# fail 0

$ node --test tests/renderer.test.js
...
1..37
# tests 37
# pass 37
# fail 0

$ node --test tests/mainutil.test.js tests/renderer.test.js   # combined, sanity
1..77
# tests 77
# pass 77
# fail 0

$ ../venv/bin/python -m pytest tests/ -q
........................................................................ [ 66%]
....................................                                     [100%]
108 passed in 0.25s
```
JS: 40 (mainutil, was 32) + 37 (renderer, was 36) = 77, +8 net new (7 mainutil + 1 renderer), 0 regressions. PY unchanged at 108/108.

## Scope
5 files touched, all in-scope: `lib/mainutil.js`, `main.js`, `renderer/renderer.js`, `tests/mainutil.test.js`, `tests/renderer.test.js`. No commit, no push (per instructions). Branch `feat/disk-guard` left with the working-tree diff only.
