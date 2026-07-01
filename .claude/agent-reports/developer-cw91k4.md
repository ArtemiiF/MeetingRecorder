# Concurrency fix: manual para-reindex vs auto-index race

Branch: feat/whisper-dictionary (no commit/push made, per instructions).

## Grounding

- Read main.js:640-740 — `indexRunState`/`indexRunReducer` guard used by `triggerAutoIndex`/`startAutoIndex` (auto-index path), and the unguarded `para-reindex` IPC handler (manual path).
- Read lib/mainutil.js:156-187 — `indexRunReducer(state, action)` pure reducer: `"trigger"` returns `shouldStart:false` + `queued:true` when already `inFlight`; `"complete"` starts the queued run if present.
- Read tests/mainutil.test.js:223-252 — existing reducer tests (untouched; reducer semantics not changed).
- Read renderer/renderer.js:806-824 — `paraReindexBtn` click handler already renders `res.error` into `#paraReindexStatus` (`"❌ " + res.error`), so an "already indexing" result needs no new UI code.
- Read backend.py:1013-1029 — `_db_connect` plain `sqlite3.connect`, no busy_timeout; confirmed via grep (backend.py:1257, 1434-1472) that `chunks_fts` lives on connections obtained through this same function — one fix point covers it.
- Read tests/test_backend.py:291-324 — established test pattern for `_db_connect` (tmp_path, `backend._db_connect(db)`, direct query, `conn.close()`).

## Fix 1 — main.js: manual reindex routed through the existing guard

File: `main.js`, `ipcMain.handle("para-reindex", ...)` (was line 705, now 705-731).

Reused the *same* `indexRunState` + `indexRunReducer` mechanism the auto-index path already uses — no second state variable:

```js
ipcMain.handle("para-reindex", async (_e, { root }) => {
  const trig = indexRunReducer(indexRunState, "trigger");
  indexRunState = trig.state;
  if (!trig.shouldStart) {
    return { error: "Индексация уже выполняется — запрос поставлен в очередь" };
  }
  return new Promise((resolve) => {
    let summary = null;
    runBackend(indexArgs(root),
      (ev) => { ... },
      (_code, stderr) => {
        if (!summary) summary = { error: stderr || "нет ответа от backend" };
        const next = indexRunReducer(indexRunState, "complete");
        indexRunState = next.state;
        if (next.shouldStart) startAutoIndex(root);
        resolve(summary);
      });
  });
});
```

**Guard mechanism picked:** hybrid of both options offered in the task — queue via the existing reducer (so the request isn't lost: if triggered while in flight, `queued:true` guarantees a trailing run via the normal `startAutoIndex` completion path) **and** resolve the IPC call immediately with an `{ error: ... }` shape the renderer already knows how to render, instead of leaving the button's promise hanging on a run that will never start under this handle. This was the natural fit: making the button literally await the trailing queued run would require plumbing a second promise/callback path into `startAutoIndex`, which doesn't currently return anything to its caller — immediate resolve + reuse of the existing error-display slot avoided that complexity with a minimal diff.

Net effect: a manual reindex and a background auto-index can never spawn two `index` subprocesses concurrently against the same `index.db` — either the manual call proceeds and marks `inFlight`, or it finds `inFlight` already true and defers (queued) while telling the user immediately.

## Fix 2 — backend.py: busy_timeout pragma

File: `backend.py:1013-1023`, `_db_connect`:

```python
conn = sqlite3.connect(db_path)
conn.execute("PRAGMA busy_timeout=10000")
conn.execute("""CREATE TABLE IF NOT EXISTS meetings(...
```

Belt-and-suspenders alongside Fix 1: any residual overlap (e.g. two independently-spawned backend processes momentarily touching the db before the JS-side guard takes effect, or any other future caller of `_db_connect`) now degrades to a 10s wait instead of an immediate `SQLITE_BUSY` — reducing the risk of a failed write/lost chunk on `chunks_fts` (INSERT-only, so a failed write there is not simply idempotent-retryable) during a race.

## Test added

`tests/test_backend.py` — new `test_db_connect_sets_busy_timeout` (placed right before `test_process_records_template_in_index_and_frontmatter`, matching the existing `_db_connect`-usage pattern in this file):

```python
def test_db_connect_sets_busy_timeout(tmp_path):
    db = str(tmp_path / "i.db")
    conn = backend._db_connect(db)
    timeout_ms = conn.execute("PRAGMA busy_timeout").fetchone()[0]
    conn.close()
    assert timeout_ms == 10000
```

No JS test added: `indexRunReducer` semantics were not changed (already covered by tests/mainutil.test.js:223-252); the main.js change is IPC glue reusing the existing reducer, which is the established "fine untested" pattern per the task brief.

## Verification — both suites green

### `node --test tests/mainutil.test.js tests/renderer.test.js`
```
1..81
# tests 81
# suites 0
# pass 81
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 3368.599042
```
81/81 — matches baseline (unchanged; no new JS test was warranted).

### `../venv/bin/python -m pytest tests/ -q`
```
........................................................................ [ 61%]
.............................................                            [100%]
117 passed in 0.28s
```
117/117 — baseline 116 + 1 new test (`test_db_connect_sets_busy_timeout`).

## Files changed (diff --stat)

```
backend.py             |  4 ++++
main.js                | 13 +++++++++++++
tests/test_backend.py  | 11 +++++++++++
3 files changed, 28 insertions(+)
```

No commit, no push — left as working-tree changes per instructions.
