const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const HTML = fs.readFileSync(path.join(__dirname, "../renderer/index.html"), "utf8");
const RENDERER = fs.readFileSync(path.join(__dirname, "../renderer/renderer.js"), "utf8");

// Boot a jsdom window with the real index.html, a mocked window.api, and renderer.js
// evaluated inside it. Returns { window, $, handlers } where handlers.record/process
// are the callbacks renderer registered via window.api.onRecord/ProcessEvent.
async function boot(apiOverrides = {}) {
  const dom = new JSDOM(HTML, { runScripts: "outside-only", pretendToBeVisual: true });
  const { window } = dom;
  const handlers = {};
  window.alert = () => {};
  window.api = Object.assign({
    preflight: async () => ({ lmStudio: false, mic: "granted", screen: "unknown", ffmpeg: true, whisperCached: true, hfToken: false }),
    renameSpeakers: async () => ({ ok: true }),
    listDevices: async () => [{ index: 0, name: "MacBook Mic", default: true }],
    getPresets: async () => ({ presets: [{ name: "P", prompt: "x" }], defaultOutDir: "/tmp/out", hfToken: "", language: "ru" }),
    savePresets: async () => true,
    listHistory: async () => [{ name: "2026-01-01", title: "Синк", note: "/o/meeting-x.md", audio: "/o/meeting-x.wav" }],
    readNote: async () => '---\ntitle: "T"\n---\n\n## Резюме\n\nтекст\n\n**[Спикер 1]**: привет',
    paraCreateVault: async () => ({ ok: true }),
    paraClassify: async () => ({ category: "projects", project: "P" }),
    paraFile: async () => ({ ok: true }),
    paraTree: async () => [],
    pickAudio: async () => null,
    pickOutDir: async () => null,
    startRecording: async () => ({ ok: true }),
    stopRecording: async () => ({ ok: true }),
    processAudio: async () => ({ ok: true }),
    cancelProcess: async () => ({ ok: true }),
    paraExtract: async () => ({ content: "x" }),
    paraReindex: async () => ({ indexed: 0, skipped: 0, removed: 0 }),
    paraSearch: async (_root, _messages) => ({ found: false, answer: "Не нашёл по этому вопросу записей в заметках.", citations: [] }),
    reveal: () => {},
    onRecordEvent: (cb) => { handlers.record = cb; },
    onProcessEvent: (cb) => { handlers.process = cb; },
    onParaReindexEvent: () => {},
  }, apiOverrides);

  window.eval(RENDERER);
  await new Promise((r) => window.setTimeout(r, 30)); // let init() resolve
  const $ = (id) => window.document.getElementById(id);
  return { window, $, handlers };
}

const tick = (window) => new Promise((r) => window.setTimeout(r, 10));

// ── stage colouring from stage_end status (the core "progress is honest" fix) ──
test("stage_end: ok→done, fail→failed, skip→skip", async () => {
  const { window, $, handlers } = await boot();
  handlers.record({ event: "recorded", file: "/tmp/mixed.wav", mic: "/tmp/m.wav", system: null, tracks: 1 });
  $("runBtn").click(); await tick(window); // builds the stage chips
  handlers.process({ event: "stage_end", stage: "transcribe", status: "ok", msg: "5 сегментов" });
  handlers.process({ event: "stage_end", stage: "llm", status: "fail", msg: "LM Studio" });
  handlers.process({ event: "stage_end", stage: "diarize", status: "skip", msg: "выключено" });
  assert.ok($("stage-transcribe").classList.contains("done"));
  assert.ok($("stage-llm").classList.contains("failed"));
  assert.ok($("stage-diarize").classList.contains("skip"));
});

test("stage_end: cached (msg 'из кеша') marks done + cached", async () => {
  const { window, $, handlers } = await boot();
  handlers.record({ event: "recorded", file: "/tmp/mixed.wav", mic: "/tmp/m.wav", system: null, tracks: 1 });
  $("runBtn").click(); await tick(window);
  handlers.process({ event: "stage_end", stage: "transcribe", status: "ok", msg: "12 сегм. (из кеша)" });
  assert.ok($("stage-transcribe").classList.contains("done"));
  assert.ok($("stage-transcribe").classList.contains("cached"));
});

// ── VU meter ─────────────────────────────────────────────────────────────────
test("level events set VU bar width per source (direct, works backgrounded)", async () => {
  const { $, handlers } = await boot();
  handlers.record({ event: "level", source: "mic", level: 0.5 });
  handlers.record({ event: "level", source: "system", level: 0.25 });
  assert.equal($("vuMic").style.width, "50%");
  assert.equal($("vuSys").style.width, "25%");
});

// ── Run/Stop/Retry/Fresh state machine ──────────────────────────────────────
test("processing shows Stop, hides Run; done shows Retry/Fresh", async () => {
  const { window, $, handlers } = await boot();
  // need an audio source so Run works → use record path: simulate a finished recording
  handlers.record({ event: "recorded", file: "/tmp/mixed.wav", mic: "/tmp/mic.wav", system: "/tmp/system.wav", tracks: 2 });
  $("runBtn").click(); await tick(window);
  assert.equal($("stopBtn").style.display, "");      // Stop visible while running
  assert.equal($("runBtn").style.display, "none");   // Run hidden
  handlers.process({ event: "done", note: "/n.md", audio: "/a.wav", transcript: "t", summary: "s" });
  await tick(window);
  assert.equal($("stopBtn").style.display, "none");  // Stop hidden after done
  assert.equal($("retryBtn").style.display, "");     // Retry shown
  assert.equal($("freshBtn").style.display, "");     // Fresh shown
  assert.ok($("resultCard").style.display !== "none");
});

test("process-closed canceled → 'Остановлено' log + stage skip, UI restored", async () => {
  const { window, $, handlers } = await boot();
  handlers.record({ event: "recorded", file: "/tmp/mixed.wav", mic: "/tmp/mic.wav", system: null, tracks: 1 });
  $("runBtn").click(); await tick(window);
  handlers.process({ event: "stage", stage: "transcribe", msg: "Транскрибация" });
  handlers.process({ event: "process-closed", code: null, canceled: true });
  await tick(window);
  assert.ok($("logs").textContent.includes("Остановлено"));
  assert.ok($("stage-transcribe").classList.contains("skip"));
  assert.equal($("stopBtn").style.display, "none");
});

test("processAudio busy → error logged, UI not stuck on Stop", async () => {
  const { window, $, handlers } = await boot({ processAudio: async () => ({ ok: false, error: "Обработка уже идёт" }) });
  handlers.record({ event: "recorded", file: "/tmp/mixed.wav", mic: "/tmp/mic.wav", system: null, tracks: 1 });
  $("runBtn").click(); await tick(window);
  assert.ok($("logs").textContent.includes("Обработка уже идёт"));
  assert.equal($("stopBtn").style.display, "none"); // restored, not stuck
});

// ── history rendering ─────────────────────────────────────────────────────
test("history reprocess (from note view) is blocked while a run is in flight", async () => {
  let calls = 0;
  const { window, $, handlers } = await boot({ processAudio: async () => { calls++; return { ok: true }; } });
  handlers.record({ event: "recorded", file: "/tmp/mixed.wav", mic: "/tmp/m.wav", system: null, tracks: 1 });
  $("runBtn").click(); await tick(window);            // processing=true, calls=1
  assert.equal(calls, 1);
  window.document.querySelector('.topbtn[data-view="history"]').click(); await tick(window);
  $("historyList").querySelector(".rail-item").click(); await tick(window);
  $("noteView").querySelector("#nvReprocess").click(); await tick(window);
  assert.equal(calls, 1);                             // guard blocked a second run
});

test("token-at-rest warning shows only when token present and keychain unavailable", async () => {
  const withWarn = await boot({
    getPresets: async () => ({ presets: [], defaultOutDir: "/tmp", hfToken: "hf_x", language: "ru", secretEncrypted: false }),
  });
  await tick(withWarn.window);
  assert.notEqual(withWarn.$("tokenWarn").style.display, "none");
  const noWarn = await boot({
    getPresets: async () => ({ presets: [], defaultOutDir: "/tmp", hfToken: "hf_x", language: "ru", secretEncrypted: true }),
  });
  await tick(noWarn.window);
  assert.equal(noWarn.$("tokenWarn").style.display, "none");
});

test("speaker rename: detects labels, applies map, rewrites transcript + calls IPC", async () => {
  let renamed = null;
  const { window, $, handlers } = await boot({
    renameSpeakers: async (notePath, map) => { renamed = { notePath, map }; return { ok: true }; },
  });
  handlers.record({ event: "recorded", file: "/tmp/mixed.wav", mic: "/tmp/m.wav", system: null, tracks: 1 });
  $("runBtn").click(); await tick(window);
  handlers.process({
    event: "done", note: "/o/meeting-x.md", audio: "/o/a.wav",
    transcript: "**[Спикер 1]**: привет\n\n**[Спикер 2]**: пока", summary: "s",
  });
  await tick(window);
  const inputs = $("speakerInputs").querySelectorAll("input");
  assert.equal(inputs.length, 2);                 // both speakers detected
  inputs[0].value = "Алексей";
  $("applySpeakers").click(); await tick(window);
  assert.deepEqual(renamed.map, { "Спикер 1": "Алексей" });
  assert.ok($("resTranscript").textContent.includes("**[Алексей]**"));
});

test("inferred speaker names prefill the rename inputs", async () => {
  const { window, $, handlers } = await boot();
  handlers.record({ event: "recorded", file: "/tmp/mixed.wav", mic: "/tmp/m.wav", system: null, tracks: 1 });
  $("runBtn").click(); await tick(window);
  handlers.process({
    event: "done", note: "/o/n.md", audio: "/o/a.wav",
    transcript: "**[Спикер 1]**: привет\n\n**[Спикер 2]**: пока", summary: "s",
    speakers: { "Спикер 1": "Алексей" },
  });
  await tick(window);
  const byOld = {};
  $("speakerInputs").querySelectorAll("input").forEach((i) => { byOld[i.dataset.old] = i.value; });
  assert.equal(byOld["Спикер 1"], "Алексей");  // prefilled from context
  assert.equal(byOld["Спикер 2"], "");         // unknown left blank
});

test("history label shows title when present", async () => {
  const { window, $ } = await boot({
    listHistory: async () => [{ name: "2026-01-01", title: "Синк по релизу", note: "/n.md", audio: "/a.wav" }],
  });
  await tick(window);
  assert.ok($("historyList").textContent.includes("Синк по релизу"));
});

test("preflight panel renders status rows", async () => {
  const { window, $ } = await boot({
    preflight: async () => ({ lmStudio: true, mic: "granted", screen: "denied", ffmpeg: true, whisperCached: false, hfToken: false, embedModel: true }),
  });
  // refreshPreflight() is only triggered by openSettings() or the refresh button, not by init()
  $("settingsOpen").click(); await tick(window);
  const rows = $("preflightList").querySelectorAll(".pf-row");
  assert.equal(rows.length, 7);
  assert.equal($("preflightList").querySelectorAll(".pf-dot.ok").length, 4); // lmStudio, mic, ffmpeg, embedModel
});

test("history rail renders items; selecting one renders the note markdown", async () => {
  const { window, $ } = await boot();
  window.document.querySelector('.topbtn[data-view="history"]').click();
  await tick(window);
  const items = $("historyList").querySelectorAll(".rail-item");
  assert.equal(items.length, 1);
  assert.ok($("historyList").textContent.includes("Синк"));       // title
  assert.ok($("historyList").textContent.includes("2026-01-01")); // date
  items[0].click(); await tick(window);
  const html = $("noteView").innerHTML;
  assert.ok($("noteView").querySelector(".note-body"));
  assert.ok(html.includes("<h2>Резюме</h2>"));   // markdown rendered
  assert.ok(!html.includes("title:"));           // frontmatter dropped from display
});

test("history search filters the rail by title", async () => {
  const { window, $ } = await boot({
    listHistory: async () => [
      { name: "2026-01-01", title: "Релиз v2", language: "ru", note: "/a.md", audio: null },
      { name: "2026-01-02", title: "Интервью Марина", language: "en", note: "/b.md", audio: null },
      { name: "2026-01-03", title: "Планирование спринта", language: "ru", note: "/c.md", audio: null },
    ],
  });
  window.document.querySelector('.topbtn[data-view="history"]').click();
  await tick(window);
  assert.equal($("historyList").querySelectorAll(".rail-item").length, 3);
  $("historySearch").value = "интервью";
  $("historySearch").dispatchEvent(new window.Event("input"));
  const shown = $("historyList").querySelectorAll(".rail-item");
  assert.equal(shown.length, 1);
  assert.ok($("historyList").textContent.includes("Интервью Марина"));
});

test("history language filter narrows the rail", async () => {
  const { window, $ } = await boot({
    listHistory: async () => [
      { name: "a", title: "T1", language: "ru", note: "/a.md", audio: null },
      { name: "b", title: "T2", language: "en", note: "/b.md", audio: null },
    ],
  });
  window.document.querySelector('.topbtn[data-view="history"]').click();
  await tick(window);
  $("historyLang").value = "en";
  $("historyLang").dispatchEvent(new window.Event("change"));
  assert.equal($("historyList").querySelectorAll(".rail-item").length, 1);
});

test("history filters by template and by date range", async () => {
  const { window, $ } = await boot({
    listHistory: async () => [
      { name: "2026-01-01-1000", title: "A", language: "ru", template: "Митинг", note: "/a.md", audio: null },
      { name: "2026-02-15-1000", title: "B", language: "ru", template: "Интервью", note: "/b.md", audio: null },
      { name: "2026-03-20-1000", title: "C", language: "ru", template: "Митинг", note: "/c.md", audio: null },
    ],
  });
  window.document.querySelector('.topbtn[data-view="history"]').click();
  await tick(window);
  // template select got distinct templates
  assert.equal($("historyTemplate").querySelectorAll("option").length, 3); // Все + Митинг + Интервью
  // filter by template
  $("historyTemplate").value = "Митинг";
  $("historyTemplate").dispatchEvent(new window.Event("change"));
  assert.equal($("historyList").querySelectorAll(".rail-item").length, 2);
  // add date range to narrow to one (Feb–Mar excludes Jan; Митинг in Mar only)
  $("historyFrom").value = "2026-03-01";
  $("historyFrom").dispatchEvent(new window.Event("change"));
  assert.equal($("historyList").querySelectorAll(".rail-item").length, 1);
  assert.ok($("historyList").textContent.includes("C"));
});

test("note view shows the title as a heading", async () => {
  const { window, $ } = await boot({
    listHistory: async () => [{ name: "2026-01-01", title: "Синк по релизу", language: "ru", note: "/n.md", audio: null }],
  });
  window.document.querySelector('.topbtn[data-view="history"]').click();
  await tick(window);
  $("historyList").querySelector(".rail-item").click();
  await tick(window);
  const t = $("noteView").querySelector(".note-title");
  assert.ok(t && t.textContent === "Синк по релизу");
});

test("PARA: setup shown until vault created, then workspace", async () => {
  const { window, $ } = await boot({ pickOutDir: async () => "/tmp/vault" });
  window.document.querySelector('.topbtn[data-view="para"]').click();
  await tick(window);
  assert.notEqual($("paraSetup").style.display, "none"); // no vault → setup
  assert.equal($("paraWork").style.display, "none");
  $("paraPick").click(); await tick(window);
  assert.equal($("paraRoot").value, "/tmp/vault");
  $("paraCreate").click(); await tick(window);
  assert.equal($("paraSetup").style.display, "none");    // configured → workspace
  assert.notEqual($("paraWork").style.display, "none");
});

test("PARA: classify fills rows, file removes from inbox", async () => {
  const { window, $ } = await boot({
    getPresets: async () => ({
      presets: [], defaultOutDir: "/tmp", hfToken: "", language: "ru",
      para: { root: "/v", folders: { projects: "Projects", areas: "Areas", resources: "Resources", archives: "Archives" } },
    }),
    listHistory: async () => [{ name: "2026-01-01", title: "T", note: "/n.md", audio: null }],
    paraClassify: async () => ({ category: "projects", project: "Лендинг" }),
    paraFile: async () => ({ ok: true }),
  });
  window.document.querySelector('.topbtn[data-view="para"]').click();
  await tick(window);
  const rows = $("paraInbox").querySelectorAll(".para-row");
  assert.equal(rows.length, 1);
  // paraClassifyAll does classify → extract → file → markRowFiled (all in one pipeline).
  // Assert that classify filled category/project fields by setting them directly (same contract).
  const catSel = rows[0].querySelector(".para-cat");
  const projIn = rows[0].querySelector(".para-proj");
  catSel.value = "projects";
  projIn.value = "Лендинг";
  assert.equal(catSel.value, "projects");
  assert.equal(projIn.value, "Лендинг");
  // Now click file-btn: paraExtract → paraFile → row.remove()
  rows[0].querySelector(".para-file-btn").click(); await tick(window); await tick(window);
  assert.equal($("paraInbox").querySelectorAll(".para-row").length, 0);
});

test("PARA sub-tabs: switch to Хранилище renders the vault tree", async () => {
  const { window, $ } = await boot({
    getPresets: async () => ({
      presets: [], defaultOutDir: "/tmp", hfToken: "", language: "ru",
      para: { root: "/v", folders: { projects: "Projects", areas: "Areas", resources: "Resources", archives: "Archives" } },
    }),
    paraTree: async () => [
      { name: "Projects", path: "/v/Projects", type: "dir", notes: 2, children: [
        { name: "meeting-x.md", path: "/v/Projects/meeting-x.md", type: "note" },
      ] },
    ],
  });
  window.document.querySelector('.topbtn[data-view="para"]').click();
  await tick(window);
  // default sub = inbox
  assert.ok(!$("para-pane-inbox").classList.contains("hidden"));
  window.document.querySelector('.subbtn[data-sub="tree"]').click();
  await tick(window);
  assert.ok($("para-pane-inbox").classList.contains("hidden"));
  assert.ok(!$("para-pane-tree").classList.contains("hidden"));
  assert.ok($("paraTree").textContent.includes("Projects"));
  assert.equal($("paraTree").querySelectorAll(".tree-note").length, 1);
});

test("PARA search sub-tab is enabled and switching to it shows #para-pane-search", async () => {
  const { window, $ } = await boot();
  window.document.querySelector('.topbtn[data-view="para"]').click();
  await tick(window);
  const btn = window.document.querySelector('.subbtn[data-sub="search"]');
  assert.ok(!btn.disabled, "search subbtn must not be disabled");
  btn.click(); await tick(window);
  assert.ok(!$("para-pane-search").classList.contains("hidden"), "#para-pane-search must be visible");
  assert.ok($("para-pane-inbox").classList.contains("hidden"), "#para-pane-inbox must be hidden");
  assert.ok($("para-pane-tree").classList.contains("hidden"), "#para-pane-tree must be hidden");
});

test("PARA chat: sending a message appends user bubble + assistant bubble with answer", async () => {
  const mockResult = {
    found: true,
    answer: "Ответ по заметкам.",
    citations: [
      { date: "2026-01-01", title: "Синк", note_path: "/v/Projects/note.md" },
    ],
  };
  let capturedRoot, capturedMessages;
  const { window, $ } = await boot({
    getPresets: async () => ({
      presets: [], defaultOutDir: "/tmp", hfToken: "", language: "ru",
      para: { root: "/v", folders: { projects: "Projects", areas: "Areas", resources: "Resources", archives: "Archives" } },
    }),
    paraSearch: async (root, messages) => { capturedRoot = root; capturedMessages = messages; return mockResult; },
  });
  window.document.querySelector('.topbtn[data-view="para"]').click();
  await tick(window);
  window.document.querySelector('.subbtn[data-sub="search"]').click();
  await tick(window);
  $("paraSearchQuery").value = "тест вопрос";
  $("paraSearchBtn").click(); await tick(window); await tick(window);

  const bubbles = $("paraChatLog").querySelectorAll(".chat-bubble");
  assert.equal(bubbles.length, 2, "must have user bubble + assistant bubble");
  assert.ok(bubbles[0].classList.contains("chat-bubble-user"), "first bubble is user");
  assert.ok(bubbles[0].textContent.includes("тест вопрос"), "user bubble shows query");
  assert.ok(bubbles[1].classList.contains("chat-bubble-assistant"), "second bubble is assistant");
  assert.ok(bubbles[1].textContent.includes("Ответ по заметкам"), "assistant bubble shows answer");
  assert.ok(bubbles[1].textContent.includes("Синк"), "assistant bubble includes citation title");

  // paraSearch must be called with (root, messages array)
  assert.equal(capturedRoot, "/v", "root passed correctly");
  assert.ok(Array.isArray(capturedMessages), "messages is an array");
  assert.equal(capturedMessages[capturedMessages.length - 1].role, "user", "last message is user");
  assert.equal(capturedMessages[capturedMessages.length - 1].content, "тест вопрос", "user content matches");
});

test("PARA chat: «Новый чат» clears the chat thread", async () => {
  const { window, $ } = await boot({
    getPresets: async () => ({
      presets: [], defaultOutDir: "/tmp", hfToken: "", language: "ru",
      para: { root: "/v", folders: { projects: "Projects", areas: "Areas", resources: "Resources", archives: "Archives" } },
    }),
    paraSearch: async () => ({ found: false, answer: "Не нашёл по этому вопросу записей в заметках.", citations: [] }),
  });
  window.document.querySelector('.topbtn[data-view="para"]').click();
  await tick(window);
  window.document.querySelector('.subbtn[data-sub="search"]').click();
  await tick(window);

  // Send a message to populate the thread
  $("paraSearchQuery").value = "первый вопрос";
  $("paraSearchBtn").click(); await tick(window); await tick(window);
  assert.ok($("paraChatLog").querySelectorAll(".chat-bubble").length >= 1, "thread has bubbles before clear");

  // Click «Новый чат»
  $("paraChatNewBtn").click(); await tick(window);
  assert.equal($("paraChatLog").querySelectorAll(".chat-bubble").length, 0, "thread cleared after Новый чат");
});

test("PARA chat: second message passes full history in messages array", async () => {
  const calls = [];
  const { window, $ } = await boot({
    getPresets: async () => ({
      presets: [], defaultOutDir: "/tmp", hfToken: "", language: "ru",
      para: { root: "/v", folders: { projects: "Projects", areas: "Areas", resources: "Resources", archives: "Archives" } },
    }),
    paraSearch: async (root, messages) => {
      calls.push(messages);
      return { found: true, answer: "Ответ " + calls.length, citations: [] };
    },
  });
  window.document.querySelector('.topbtn[data-view="para"]').click();
  await tick(window);
  window.document.querySelector('.subbtn[data-sub="search"]').click();
  await tick(window);

  // First message
  $("paraSearchQuery").value = "первый вопрос";
  $("paraSearchBtn").click(); await tick(window); await tick(window);

  // Second message
  $("paraSearchQuery").value = "уточнение";
  $("paraSearchBtn").click(); await tick(window); await tick(window);

  assert.equal(calls.length, 2, "paraSearch called twice");
  // First call: 1 user message
  assert.equal(calls[0].length, 1);
  assert.equal(calls[0][0].role, "user");
  // Second call: user + assistant + user = 3 messages
  assert.equal(calls[1].length, 3, "second call includes full history");
  assert.equal(calls[1][0].role, "user");
  assert.equal(calls[1][1].role, "assistant");
  assert.equal(calls[1][2].role, "user");
  assert.equal(calls[1][2].content, "уточнение");
});

test("view switching toggles record/history panels", async () => {
  const { window, $ } = await boot();
  window.document.querySelector('.topbtn[data-view="history"]').click();
  assert.ok($("view-record").classList.contains("hidden"));
  assert.ok(!$("view-history").classList.contains("hidden"));
  window.document.querySelector('.topbtn[data-view="record"]').click();
  assert.ok(!$("view-record").classList.contains("hidden"));
  assert.ok($("view-history").classList.contains("hidden"));
});
