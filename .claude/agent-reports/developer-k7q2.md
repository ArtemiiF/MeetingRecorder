# Task: action items / decisions extraction (feat/action-items)

Branch: `feat/action-items` (pre-existing, stayed on it). NOT committed, NOT pushed (per instructions).

## Files changed
- `backend.py` — extraction call + note section + done payload wiring
- `renderer/index.html` — third result tab + pane
- `renderer/renderer.js` — tab switch + render logic
- `tests/test_backend.py` — 12 new tests + 2 fixtures patched
- `tests/renderer.test.js` — 2 new tests

## backend.py edits (file:line, current state)

1. `Pipeline._extract_json_object` (staticmethod) — backend.py:583-611 (approx, right after `infer_speaker_names`, before `set_frontmatter`). Brace-balancing JSON-object scanner tolerating a ```` ```json ... ``` ```` fence and surrounding prose. Added because the two existing JSON-extraction patterns in the file (`infer_speaker_names` backend.py:574 `re.search(r"\{[^{}]*\}", ...)`, and `cmd_classify` backend.py:1012 `re.findall(r"\{[^{}]*\}", ..., re.S)` + reversed-scan-and-validate) only match **flat, non-nested** objects — our contract `{"items":[{...}], "decisions":[...]}` has arrays of objects inside it, which those regexes cannot match. This is a genuinely new small helper, not a duplicate.

2. `Pipeline.extract_actions(self, transcript)` — backend.py:613-660 (approx). One `requests.post` call to `self.LMSTUDIO_API`, `temperature=0.1, max_tokens=4000, timeout=180`. Parses via `_extract_json_object`, validates schema (drops items with empty `what`, coerces `who`/`due` to stripped strings, drops falsy decisions). Returns `{}` on: non-200, empty content+reasoning_content, no valid JSON object, non-dict JSON, or any exception (logged via `log(f"⚠️ Извлечение действий не удалось: {e}")`).

3. `Pipeline.add_actions_section(self, note, actions)` — backend.py:~662-678, right before `add_transcript`. No-op (returns `note` unchanged) when `items` and `decisions` are both empty/missing. Otherwise appends:
   ```
   ## Действия

   - [ ] what — who (срок: due)
   ...
   **Решения:**
   - decision
   ```
   Empty `who`/`due` per item are omitted from that item's line (verified by test).

4. Wiring in `process()`:
   - `actions = {}` initialized alongside `title`/`speakers` in the "meta" stage (backend.py, inside `stage("meta", ...)` block).
   - Inside the existing `if summary:` branch (same gate as `generate_title`) — added `actions = self.extract_actions(transcript_for_llm)` right after title generation.
   - `note = self.add_actions_section(note, actions)` inserted between `note = self.add_audio_link(...)` and `note = self.add_transcript(...)` — puts the section after the LLM summary body, above the transcript, matching the requested ordering.
   - `emit("done", ..., actions=actions)` — added `actions` key to the done payload.
   - Updated the module-level docstring's `done` event shape comment (lines 13-14) for accuracy.

## Extraction prompt + JSON contract

System: `"Ты извлекаешь из транскрипта встречи задачи, договорённости и решения. Отвечай только JSON."`
User: instructs to extract concrete actions/agreements and decisions, "ничего не выдумывай", and demands strict JSON:
```json
{"items":[{"what":"что сделать","who":"кто (или пустая строка)","due":"срок (или пустая строка)"}],
 "decisions":["принятое решение", ...]}
```
followed by `f"ТРАНСКРИПТ:\n{transcript[:8000]}"`.

Output contract after parsing: `{"items": [{"what": str, "who": str, "due": str}], "decisions": [str]}` — always both keys present when non-empty; `{}` on any failure (never a partially-filled dict, so `add_actions_section`'s emptiness check and the `done` payload stay simple).

## Deviation flagged: reasoning_content fallback

The task brief said to follow "the reasoning-model contract at backend.py:507-512 — content empty → None, NEVER reasoning_content" for both `summarize` and `infer_speaker_names`. Reading the actual code contradicts that for `infer_speaker_names`: backend.py (pre-existing) line `c = (msg.get("content") or "") or (msg.get("reasoning_content") or "")` — it **does** fall back to `reasoning_content`, unlike `summarize()`/`cmd_extract()` which explicitly never do (because their raw output becomes the note body verbatim — leaking chain-of-thought there would be visible/embarrassing). `cmd_classify` also falls back to `reasoning_content` for the same reason: the result is schema-validated JSON, not echoed text.

Since `extract_actions` is structurally identical to `infer_speaker_names`/`cmd_classify` (schema-validated JSON snippet, not verbatim text), I followed **the actual code pattern** (allow reasoning_content fallback) rather than the task's paraphrase of the summarize-only contract. This is a design default per the task's own framing ("design defaults — owner notified, critic validates") — flagging it explicitly as requested.

## Note section placement

Between the LLM summary body (`add_audio_link` output) and the transcript section (`add_transcript`), i.e.:
`[frontmatter] [🎵 audio link] [LLM summary body] [## Действия] [## 📄 Полный транскрипт]`
Verified by test: `note_text.index("## Действия") < note_text.index("## 📄 Полный транскрипт")`.

Heading is exactly `## Действия` (no emoji) — matched the task's literal backtick-quoted string, even though sibling sections (`## 📝 Сводка`, `## 🎵 Аудио запись`, `## 📄 Полный транскрипт`) use emoji. Flagging this as a judgment call in case emoji consistency was actually wanted.

## Cache decision (point 5) — no caching added

Investigated `_cache`/`_cache_write`/`_cache_read` plumbing (backend.py ~225-257) and the three cached stages: `mono.wav`, `transcribe-{lang}.json`, `diarize.json`. **The summary/title/speakers LLM calls are NOT cached at all** — they re-run on every `process()` call, including Retry-from-cache reruns. Since `extract_actions` sits in that same "meta" stage alongside `generate_title`/`infer_speaker_names`, doing the same (no cache) is the consistent choice, not a shortcut — there is no existing per-LLM-call cache slot to hook into for any of the three metadata calls. No caching added; noted here as requested instead of over-building new cache plumbing.

## Cancellation

Confirmed via `main.js`: cancellation (`stopBtn` → `cancel-process` IPC → `procProc.kill("SIGTERM")`) kills the whole backend child process; there is no in-backend SIGTERM handler (`grep -n "SIGTERM\|signal\." backend.py` → no matches). So `extract_actions`, like `generate_title`/`infer_speaker_names`, has no special cancellation behavior to add — killing the process mid-call just aborts it, same as today for the other two calls. Nothing built here.

## Renderer changes

- `renderer/index.html`: added `<button class="rtab" data-r="actions">Действия</button>` next to Сводка/Транскрипт, and `<pre id="resActions" class="result-pane hidden"></pre>` next to `resSummary`/`resTranscript` (same tag, same class — task explicitly allowed "checkboxes can be plain markdown text", so kept it a plain `<pre>` like its siblings rather than using the existing `renderMarkdown()` HTML renderer used elsewhere for note display).
- `renderer/renderer.js`:
  - rtab click handler extended with `$("resActions").classList.toggle("hidden", r !== "actions")`.
  - New `formatActions(actions)` helper: builds `- [ ] what — who (срок: due)` lines (omitting empty who/due) + `Решения:` sub-list, or returns `"(пунктов действий нет)"` when both items and decisions are empty — chose the empty-state-text approach (not tab-hiding) to match how `resSummary` already handles the empty case (`ev.summary || "(сводка пустая — LM Studio запущен?)"`) rather than hiding tabs, since no existing rtab is ever hidden.
  - `showResult(ev)` extended with `$("resActions").textContent = formatActions(ev.actions);`.

## Tests added

### Python (tests/test_backend.py) — 12 new, using existing `pipe`/`install_fake_requests`/`capture`/`_mock_pipe` patterns:
- `test_extract_actions_happy_path` — full items+decisions JSON parses correctly, who/due defaulted.
- `test_extract_actions_wrapped_in_prose_and_fence` — nested JSON inside a ```` ```json ``` ```` fence + surrounding prose parses (this is what `_extract_json_object` exists for).
- `test_extract_actions_empty_lists_returns_empty_dict_shape`
- `test_extract_actions_malformed_output_degrades_to_empty` — reasoning-only prose, no JSON → `{}`.
- `test_extract_actions_empty_content_returns_empty`
- `test_extract_actions_non_200_returns_empty`
- `test_extract_actions_swallows_exception`
- `test_add_actions_section_renders_checklist_and_decisions` — checks exact bullet format incl. omission of empty who/due.
- `test_add_actions_section_empty_is_noop` — `{}`, `{"items":[],"decisions":[]}`, `None` all no-op.
- `test_process_appends_actions_section_and_done_payload` — full `process()` run, mocked `extract_actions`, asserts note contains `## Действия` above `## 📄 Полный транскрипт`, and `done["actions"]` matches.
- `test_process_no_summary_mode_skips_actions_call` — `do_summary=False`: `extract_actions` never called (spy counter), no section, `done["actions"] == {}`.
- `test_process_malformed_actions_output_degrades_without_crash` — `extract_actions` returns `{}`: no error event, no section, done still emitted.

Also patched `_mock_pipe` and `_mock_pipe_diarized` fixtures (both used by ~10 pre-existing tests) to stub `extract_actions` → `{}` — without this, any pre-existing test with a truthy summary would trigger a **real** `requests.post` call now that `process()` invokes `extract_actions`. Verified no other `Pipeline.process()`-driving test has a truthy `summarize()` return without going through one of these two fixtures (checked all `Pipeline(` / `.process(` call sites in the file).

### JS (tests/renderer.test.js) — 2 new, using existing `boot()`/`handlers.process()` pattern:
- `«Действия» tab renders items + decisions from done event` — fires `done` with an `actions` payload, clicks the new rtab, asserts pane visibility toggling (siblings hidden) and exact rendered text.
- `«Действия» tab shows empty-state text when no actions` — `done` event with no `actions` field → `resActions.textContent === "(пунктов действий нет)"`.

## Verification (both suites, tails)

JS: `node --test tests/mainutil.test.js tests/renderer.test.js`
```
1..64
# tests 64
# pass 64
# fail 0
```
(baseline 62/62 → 64/64, +2 new, 0 regressions)

Python: `../venv/bin/python -m pytest tests/ -q`
```
........................................................................ [ 66%]
....................................                                     [100%]
108 passed in 0.25s
```
(baseline 96/96 → 108/108, +12 new, 0 regressions)

## Scope check
5 files changed (backend.py, renderer/index.html, renderer/renderer.js, tests/test_backend.py, tests/renderer.test.js) — within the ≤10-file red-flag threshold, no file outside the task's named surfaces (no main.js change needed since it forwards `done` events verbatim already).

No commit, no push — per explicit instruction.
