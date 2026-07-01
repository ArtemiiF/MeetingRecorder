# feat/chat-ux — История entry point + degraded-mode badge

No commit/push performed per policy (working-tree changes only). Branch: `feat/chat-ux`.

## Files changed (5, all in scope)
- `renderer/index.html`
- `renderer/renderer.js`
- `renderer/style.css`
- `main.js`
- `tests/renderer.test.js`

`backend.py` untouched — the degraded signal was detectable purely from the
existing `log()` event already reaching `main.js`'s `runBackend` callback; no
new emit field was needed.

## PART 1 — chat entry from История
- `renderer/index.html:140-145` — added `#historyAskBtn` («💬 Спросить») next
  to `#historyRefresh` inside `.rail-head`, wrapped in a new `.rail-head-btns`
  flex group (kept `.rail-head`'s `justify-content: space-between` 2-child
  layout intact).
- `renderer/renderer.js:509-513` — click handler calls existing
  `switchView("para")` then `subSwitchPara("search")` then
  `$("paraSearchQuery").focus()`. No new pane/chat logic — reuses the same
  `#para-pane-search` and the same module-level `chatMessages` array/log DOM
  the PARA tab already uses, so it's the same chat instance, not a second one.
- `renderer/style.css:41` — `.rail-head-btns { display:flex; gap:6px; }`.

## PART 2 — degraded-mode badge
Traced the flow backend → main → renderer:
- `backend.py:1465` — inside `_rag_retrieve()`, when no embed model is found:
  `log("Embedding-модель недоступна — поиск только по ключевым словам")`.
- `backend.py:48-49` — `log(msg)` → `emit("log", msg=str(msg), stage=_CURRENT_STAGE)`,
  i.e. one JSON line `{"event":"log","msg":"...","stage":"general"}` on stdout.
- `backend.py:1614` — `_rag_retrieve` is called and returns *before*
  `emit("search_result", ...)` (`backend.py:1618/1645/1694`) — the log line is
  always printed strictly earlier in the same process's stdout stream than the
  terminating `search_result` event.
- `main.js:79-99` (`runBackend`) — reads stdout line-by-line via `readline`,
  calling `onEvent(JSON.parse(line))` for each line in arrival order (FIFO).
- **Bug found and fixed**: `main.js`'s old `ipcMain.handle("para-search", ...)`
  callback (`main.js:706-728`, pre-edit) only branched on
  `ev.event === "search_result"` / `"error"` — the `"log"` event was silently
  dropped. Unlike the `para-reindex` handler (`main.js:691-704`), which does
  forward `log`/`error` events to the renderer, para-search had no path for
  this signal at all. Confirmed via grep — this was the only place in
  `main.js` handling `search` subprocess events.
- **Fix** (`main.js:706-731`): added a `let degraded = false;` in the handler's
  closure; a third branch `else if (ev.event === "log" && ev.msg === DEGRADED_LOG_MSG) degraded = true;`
  sets it when the exact backend string arrives (matched against a literal
  constant, not a substring/startsWith heuristic, since it's the one known
  exact string). Because the log line always precedes `search_result` in the
  same stream, `degraded` is already correct by the time the `search_result`
  branch builds `result = { found, answer, citations, degraded }`.
- `renderer/renderer.js:869` (`runParaSearch`) — now calls
  `appendChatBubble("assistant", answerText, res.found ? (res.citations||[]) : [], !!res.degraded)`.
- `renderer/renderer.js:799-819` (`appendChatBubble`) — new 4th param
  `degraded`; when true, inserts
  `<div class="chat-degraded">⚠️ Поиск только по ключевым словам — embedding-модель не загружена</div>`
  into the assistant bubble, before the citations list.
- `renderer/style.css:279` — `.chat-degraded { margin-top:8px; font-size:11.5px; color:#f5a623; }`,
  reusing the existing warn color already used by `.sys-status.warn` / `.warn-text` / `.pf-dot.warn` (DRY on color, no new CSS var).

No detection was invented: the signal is real, singular (`grep` confirmed only
one emitter of that string in `backend.py`), and the wiring change in
`main.js` is the minimal one-branch addition the task allowed for main.js-side
detection.

## Tests added (tests/renderer.test.js)
1. `"history 'Спросить' button jumps to PARA search subtab and focuses the chat input"`
   — clicks `#historyAskBtn` from История, asserts `#view-para` visible /
   `#view-history` hidden / `#para-pane-search` visible / `#para-pane-inbox`
   hidden / `document.activeElement === $("paraSearchQuery")`.
2. `"PARA chat: degraded:true on the result shows the keyword-only badge"` —
   mocks `paraSearch` to resolve `{..., degraded: true}`, asserts the
   assistant bubble contains `.chat-degraded`.
3. `"PARA chat: degraded absent/false → no keyword-only badge"` — mocks
   `paraSearch` to resolve without a `degraded` field, asserts `.chat-degraded`
   is absent.

Existing mocks in `boot()` were not touched — the default `paraSearch` mock
already omits `degraded`, which is correctly falsy, so all prior tests keep
passing unchanged.

## Verification

`node --test tests/mainutil.test.js tests/renderer.test.js`:
```
1..67
# tests 67
# pass 67
# fail 0
# cancelled 0
# skipped 0
```
(Baseline JS was 64/64 — now 67/67, +3 new tests, 0 regressions.)

`../venv/bin/python -m pytest tests/ -q`:
```
........................................................................ [ 66%]
....................................                                     [100%]
108 passed in 0.25s
```
(Baseline PY 108/108 — unchanged, backend.py not modified.)

## Deviations from the brief
None. Scope held to the 5 files above; `backend.py` was read but not edited
(confirmed the main.js-side detection path was sufficient, as the brief
preferred). No commit, no push.
