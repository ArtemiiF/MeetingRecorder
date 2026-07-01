# Task: copy-to-clipboard buttons (feat/copy-buttons)

Branch: feat/copy-buttons (already checked out, not committed per instructions).

## Clipboard mechanism

`navigator.clipboard.writeText` — standard Chromium Clipboard API, called directly
from the renderer. Confirmed usable (not just assumed) by reading:

- `main.js:102-115` `createWindow()` — `webPreferences: { preload, contextIsolation: true,
  nodeIntegration: false }`, no `sandbox: true` override.
- `renderer/index.html` — no `<meta http-equiv="Content-Security-Policy">` tag restricting
  script/clipboard behavior.
- `preload.js` — only exposes `window.api.*` via `contextBridge`; no clipboard-blocking or
  permission-request handler anywhere in `main.js`.
- `package.json` — Electron `^33.0.0`.

Clipboard Web API is independent of Node integration/contextIsolation (it's a Chromium
renderer-side API, not a Node/Electron-internal one), and nothing in this app's config
blocks it, so no IPC/main-process plumbing was needed — implemented purely in
`renderer/renderer.js`.

## Edits (file:line)

- `renderer/index.html:116` — added `#copyResult` button (`⧉ Копировать`) inside
  `.result-actions`, next to `#openNote`.
- `renderer/renderer.js:45-63` — added `copyToClipboard(text, btn)` helper (writeText +
  1s "✓" flip feedback, no prior setTimeout-revert pattern existed in the app so this is
  the first such pattern) and a static `$("copyResult")` click listener that reads the
  currently-active `.rtab` and copies the matching pane's `textContent`
  (`resSummary`/`resTranscript`/`resActions`).
- `renderer/renderer.js:845-857` — `appendChatBubble`: for `role === "assistant"`, appends
  a `.chat-copy-row > .chat-copy-btn` ("⧉") after the bubble is built; its click handler
  copies the closure's raw `content` param (the answer text passed into the function,
  before markdown rendering and before citations are appended) — so citations are
  excluded by construction, not by string-stripping.
- `renderer/style.css:280-284` — minimal styling for `.chat-copy-row` / `.chat-copy-btn`.
- `tests/renderer.test.js:18-19` — `boot()` now seeds `window.navigator.clipboard =
  { writeText: async () => {} }` (jsdom has no Clipboard API); individual tests override
  `writeText` with a spy.
- `tests/renderer.test.js:102-129` — new test: copy button copies active pane text;
  reasserts after switching to `transcript` and `actions` tabs.
- `tests/renderer.test.js:464-495` — new test: assistant chat bubble's copy button copies
  only the raw answer text (verified distinct from the citation list), and the user bubble
  has no copy button.

No commit, no push (per instructions).

## Test results

JS (`node --test tests/mainutil.test.js tests/renderer.test.js`): **69/69 pass**
(baseline 67/67 + 2 new copy tests). Relevant lines:
```
ok 5 - copy button copies the active result pane's text; switching tabs changes what's copied
ok 26 - PARA chat: assistant bubble's copy button copies the answer text, not citations
...
1..69
# tests 69
# pass 69
# fail 0
```

Python (`../venv/bin/python -m pytest tests/ -q`): **108/108 pass** (unchanged, backend
untouched):
```
........................................................................ [ 66%]
....................................                                     [100%]
108 passed in 0.25s
```

## Scope check

4 files touched (index.html, renderer.js, style.css, renderer.test.js) — all within the
requested feature. No backend/main.js changes (clipboard needed none). No unrelated
refactors.
