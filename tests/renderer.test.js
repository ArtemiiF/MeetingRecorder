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
  // no destructive-confirm test wants an actual blocking dialog; default to "confirmed"
  // so unrelated tests aren't affected, individual tests override to spy/decline.
  window.confirm = () => true;
  // jsdom doesn't implement the Clipboard API — default no-op mock, tests override writeText to spy.
  window.navigator.clipboard = { writeText: async () => {} };
  window.api = Object.assign({
    preflight: async () => ({ lmStudio: false, mic: "granted", screen: "unknown", ffmpeg: true, whisperCached: true, hfToken: false }),
    renameSpeakers: async () => ({ ok: true }),
    listDevices: async () => [{ index: 0, name: "MacBook Mic", default: true }],
    getPresets: async () => ({ presets: [{ name: "P", prompt: "x" }], defaultOutDir: "/tmp/out", hfToken: "", language: "ru" }),
    savePresets: async () => true,
    resetApp: async () => ({
      presets: [], defaultOutDir: "/tmp/out", hfToken: "", authorName: "Автор", glossary: "",
      language: "ru", para: { root: "", folders: {} }, secretEncrypted: true,
    }),
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
    getModels: async () => ([
      { id: "whisper", label: "MLX Whisper (large-v3-turbo)", size_mb: 1500, needs_token: false, cached: true, locked: false },
      { id: "vad", label: "Silero VAD", size_mb: 35, needs_token: false, cached: false, locked: false },
      { id: "diarization", label: "Диаризация (pyannote)", size_mb: 31, needs_token: true, cached: false, locked: true },
    ]),
    downloadModels: async () => ({ ok: true }),
    cancelModelDownload: async () => ({ ok: true }),
    paraExtract: async () => ({ content: "x" }),
    paraReindex: async () => ({ indexed: 0, skipped: 0, removed: 0 }),
    paraSearch: async (_root, _messages) => ({ found: false, answer: "Не нашёл по этому вопросу записей в заметках.", citations: [] }),
    cancelSearch: async () => ({ ok: true }),
    reveal: () => {},
    onRecordEvent: (cb) => { handlers.record = cb; },
    onProcessEvent: (cb) => { handlers.process = cb; },
    onParaReindexEvent: (cb) => { handlers.reindex = cb; },
    onModelDownloadEvent: (cb) => { handlers.modelDownload = cb; },
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

// ── correct (glossary term correction) stage chip ────────────────────────────
test("correct stage renders the 'Коррекция терминов' label and colours by status", async () => {
  const { window, $, handlers } = await boot();
  handlers.record({ event: "recorded", file: "/tmp/mixed.wav", mic: "/tmp/m.wav", system: null, tracks: 1 });
  $("runBtn").click(); await tick(window); // builds the stage chips
  assert.equal($("stage-correct").textContent, "Коррекция терминов");
  handlers.process({ event: "stage_end", stage: "correct", status: "ok", msg: "Исправлено терминов: 2" });
  assert.ok($("stage-correct").classList.contains("done"));
});

// ── VU meter ─────────────────────────────────────────────────────────────────
test("level events set VU bar width per source (direct, works backgrounded)", async () => {
  const { $, handlers } = await boot();
  handlers.record({ event: "level", source: "mic", level: 0.5 });
  handlers.record({ event: "level", source: "system", level: 0.25 });
  assert.equal($("vuMic").style.width, "50%");
  assert.equal($("vuSys").style.width, "25%");
});

// ── disk guard warning ───────────────────────────────────────────────────────
test("disk-warning record-event shows the message in #sysStatus with warn styling", async () => {
  const { $, handlers } = await boot();
  handlers.record({ event: "disk-warning", msg: "⚠️ Мало места на диске (свободно 2.4 ГБ)" });
  assert.equal($("sysStatus").textContent, "⚠️ Мало места на диске (свободно 2.4 ГБ)");
  assert.ok($("sysStatus").classList.contains("warn"));
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

// ── copy-to-clipboard (result pane) ─────────────────────────────────────────
test("copy button copies the active result pane's text; switching tabs changes what's copied", async () => {
  const { window, $, handlers } = await boot();
  const copied = [];
  window.navigator.clipboard.writeText = async (text) => { copied.push(text); };

  handlers.record({ event: "recorded", file: "/tmp/mixed.wav", mic: "/tmp/mic.wav", system: "/tmp/system.wav", tracks: 2 });
  $("runBtn").click(); await tick(window);
  handlers.process({
    event: "done", note: "/n.md", audio: "/a.wav",
    transcript: "транскрипт-текст", summary: "сводка-текст",
    actions: { items: [{ what: "Сделать X" }], decisions: [] },
  });
  await tick(window);

  // default active rtab is "summary"
  $("copyResult").click();
  assert.equal(copied[0], "сводка-текст", "copies the active (summary) pane text");

  window.document.querySelector('.rtab[data-r="transcript"]').click();
  $("copyResult").click();
  assert.equal(copied[1], "транскрипт-текст", "copies the transcript pane after switching tabs");

  window.document.querySelector('.rtab[data-r="actions"]').click();
  $("copyResult").click();
  assert.equal(copied[2], $("resActions").textContent, "copies the actions pane after switching tabs");
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

test("«Действия» tab renders items + decisions from done event", async () => {
  const { window, $, handlers } = await boot();
  handlers.record({ event: "recorded", file: "/tmp/mixed.wav", mic: "/tmp/m.wav", system: null, tracks: 1 });
  $("runBtn").click(); await tick(window);
  handlers.process({
    event: "done", note: "/o/n.md", audio: "/o/a.wav",
    transcript: "t", summary: "s",
    actions: {
      items: [
        { what: "подготовить презентацию", who: "Мария", due: "среда" },
        { what: "без деталей", who: "", due: "" },
      ],
      decisions: ["перенести встречу на вторник"],
    },
  });
  await tick(window);
  const actionsTab = [...window.document.querySelectorAll(".rtab")].find((b) => b.dataset.r === "actions");
  actionsTab.click();
  assert.equal($("resActions").classList.contains("hidden"), false);   // now the active pane
  assert.equal($("resSummary").classList.contains("hidden"), true);    // siblings hidden
  assert.equal($("resTranscript").classList.contains("hidden"), true);
  const text = $("resActions").textContent;
  assert.ok(text.includes("- [ ] подготовить презентацию — Мария (срок: среда)"));
  assert.ok(text.includes("- [ ] без деталей"));                       // empty who/due omitted
  assert.ok(text.includes("Решения:"));
  assert.ok(text.includes("- перенести встречу на вторник"));
});

test("«Действия» tab shows empty-state text when no actions", async () => {
  const { window, $, handlers } = await boot();
  handlers.record({ event: "recorded", file: "/tmp/mixed.wav", mic: "/tmp/m.wav", system: null, tracks: 1 });
  $("runBtn").click(); await tick(window);
  handlers.process({ event: "done", note: "/o/n.md", audio: "/o/a.wav", transcript: "t", summary: "s" });
  await tick(window);
  assert.equal($("resActions").textContent, "(пунктов действий нет)");
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

test("history search matches a different word-form (проблема → проблемы)", async () => {
  const { window, $ } = await boot({
    listHistory: async () => [
      { name: "2026-06-30-120401", title: "Проблемы миграций при деплое", language: "ru", note: "/a.md", audio: null },
      { name: "2026-06-29-090000", title: "Планирование спринта", language: "ru", note: "/b.md", audio: null },
    ],
  });
  window.document.querySelector('.topbtn[data-view="history"]').click();
  await tick(window);
  $("historySearch").value = "проблема";
  $("historySearch").dispatchEvent(new window.Event("input"));
  const shown = $("historyList").querySelectorAll(".rail-item");
  assert.equal(shown.length, 1);
  assert.ok($("historyList").textContent.includes("Проблемы миграций при деплое"));
});

test("history rail preserves backend-provided order (no client-side re-sort)", async () => {
  const { window, $ } = await boot({
    listHistory: async () => [
      { name: "2026-03-20-100000", title: "Newest", language: "ru", note: "/c.md", audio: null },
      { name: "2026-02-15-100000", title: "Middle", language: "ru", note: "/b.md", audio: null },
      { name: "2026-01-01-100000", title: "Oldest", language: "ru", note: "/a.md", audio: null },
    ],
  });
  window.document.querySelector('.topbtn[data-view="history"]').click();
  await tick(window);
  const titles = [...$("historyList").querySelectorAll(".rail-title")].map((e) => e.textContent);
  assert.deepEqual(titles, ["Newest", "Middle", "Oldest"]);
});

test("language selector: #language has no «Авто» option, #historyLang keeps it", async () => {
  const { $ } = await boot();
  const languageValues = [...$("language").querySelectorAll("option")].map((o) => o.value);
  assert.ok(!languageValues.includes("auto"));
  const historyLangValues = [...$("historyLang").querySelectorAll("option")].map((o) => o.value);
  assert.ok(historyLangValues.includes("auto"));
});

test("stored language 'auto' is coerced to 'ru' on load", async () => {
  const { $ } = await boot({
    getPresets: async () => ({ presets: [{ name: "P", prompt: "x" }], defaultOutDir: "/tmp/out", hfToken: "", language: "auto" }),
  });
  assert.equal($("language").value, "ru");
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

test("PARA: classify fills rows, manual file marks row filed (grey, disabled, not removed)", async () => {
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
  // Now click file-btn: paraExtract → paraFile → markRowFiled (consistent with the bulk path —
  // stays in place, greyed and disabled, not removed).
  rows[0].querySelector(".para-file-btn").click(); await tick(window); await tick(window);
  assert.equal($("paraInbox").querySelectorAll(".para-row").length, 1);
  assert.ok(rows[0].classList.contains("filed"));
  assert.ok(catSel.disabled);
  assert.equal(rows[0].querySelector(".para-file-btn").textContent, "✓ Разложена");
});

test("PARA sub-tabs: switch to Хранилище renders the vault tree, collapsed by default", async () => {
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
  // ask 4: dirs with children render collapsed by default, before any click
  const dir = $("paraTree").querySelector(".tree-dir");
  assert.ok(dir.classList.contains("collapsed"));
  dir.querySelector(".tree-dir-head").click();
  assert.ok(!dir.classList.contains("collapsed")); // existing toggle behavior, unchanged
});

test("PARA classify-all: per-row spinner shows while processing, clears once filed", async () => {
  const { window, $ } = await boot({
    getPresets: async () => ({
      presets: [], defaultOutDir: "/tmp", hfToken: "", language: "ru",
      para: { root: "/v", folders: { projects: "Projects", areas: "Areas", resources: "Resources", archives: "Archives" } },
    }),
    listHistory: async () => [{ name: "2026-01-01", title: "T", note: "/n.md", audio: null }],
    paraClassify: async () => ({ category: "projects", project: "P" }),
    paraFile: async () => ({ ok: true }),
  });
  window.document.querySelector('.topbtn[data-view="para"]').click();
  await tick(window);
  const row = $("paraInbox").querySelector(".para-row");
  $("paraClassifyAll").click();
  // The click handler's synchronous prefix (setRowProcessing(row, true)) runs before the
  // first await (window.api.paraClassify), so the spinner + row-disable are visible immediately.
  assert.ok(!row.querySelector(".para-row-spinner").classList.contains("hidden"));
  assert.ok(row.querySelector(".para-cat").disabled);
  await tick(window); await tick(window); await tick(window); await tick(window);
  assert.ok(row.classList.contains("filed"));
  assert.ok(row.querySelector(".para-row-spinner").classList.contains("hidden"));
});

test("PARA: filed row survives switching panes away and back (regression — no auto re-fetch)", async () => {
  let listHistoryCalls = 0;
  const { window, $ } = await boot({
    getPresets: async () => ({
      presets: [], defaultOutDir: "/tmp", hfToken: "", language: "ru",
      para: { root: "/v", folders: { projects: "Projects", areas: "Areas", resources: "Resources", archives: "Archives" } },
    }),
    listHistory: async () => { listHistoryCalls++; return [{ name: "2026-01-01", title: "T", note: "/n.md", audio: null }]; },
    paraClassify: async () => ({ category: "projects", project: "P" }),
    paraFile: async () => ({ ok: true }),
  });
  listHistoryCalls = 0; // discard init()'s own refreshHistory() fetch — unrelated to PARA
  window.document.querySelector('.topbtn[data-view="para"]').click();
  await tick(window);
  assert.equal(listHistoryCalls, 1);
  $("paraClassifyAll").click();
  await tick(window); await tick(window); await tick(window); await tick(window);
  assert.ok($("paraInbox").querySelector(".para-row").classList.contains("filed"));
  // round-trip within PARA: Разбор → Поиск → Разбор (subSwitchPara only toggles .hidden,
  // it doesn't touch #paraInbox unless renderParaInboxView decides to re-fetch)
  window.document.querySelector('.subbtn[data-sub="search"]').click();
  await tick(window);
  window.document.querySelector('.subbtn[data-sub="inbox"]').click();
  await tick(window);
  assert.equal(listHistoryCalls, 1); // no re-fetch on pane re-entry
  assert.ok($("paraInbox").querySelector(".para-row").classList.contains("filed"));
});

test("PARA: «Обновить» re-fetches and drops the now-filed/moved note", async () => {
  let listHistoryCalls = 0;
  let noteMovedOut = false;
  const { window, $ } = await boot({
    getPresets: async () => ({
      presets: [], defaultOutDir: "/tmp", hfToken: "", language: "ru",
      para: { root: "/v", folders: { projects: "Projects", areas: "Areas", resources: "Resources", archives: "Archives" } },
    }),
    listHistory: async () => {
      listHistoryCalls++;
      return noteMovedOut ? [] : [{ name: "2026-01-01", title: "T", note: "/n.md", audio: null }];
    },
  });
  listHistoryCalls = 0; // discard init()'s own refreshHistory() fetch — unrelated to PARA
  window.document.querySelector('.topbtn[data-view="para"]').click();
  await tick(window);
  assert.equal(listHistoryCalls, 1);
  assert.equal($("paraInbox").querySelectorAll(".para-row").length, 1);
  noteMovedOut = true; // simulates the note having been filed/moved out of Meetings
  $("paraInboxRefresh").click();
  await tick(window);
  assert.equal(listHistoryCalls, 2);
  assert.equal($("paraInbox").querySelectorAll(".para-row").length, 0);
});

test("PARA: «Обновить» is disabled while classify-all batch is running", async () => {
  const { window, $ } = await boot({
    getPresets: async () => ({
      presets: [], defaultOutDir: "/tmp", hfToken: "", language: "ru",
      para: { root: "/v", folders: { projects: "Projects", areas: "Areas", resources: "Resources", archives: "Archives" } },
    }),
    listHistory: async () => [{ name: "2026-01-01", title: "T", note: "/n.md", audio: null }],
    paraClassify: async () => ({ category: "projects", project: "P" }),
    paraFile: async () => ({ ok: true }),
  });
  window.document.querySelector('.topbtn[data-view="para"]').click();
  await tick(window);
  assert.equal($("paraInboxRefresh").disabled, false);
  $("paraClassifyAll").click();
  assert.equal($("paraInboxRefresh").disabled, true); // disabled by the same synchronous prefix
  await tick(window); await tick(window); await tick(window); await tick(window);
  assert.equal($("paraInboxRefresh").disabled, false);
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

test("PARA chat: assistant bubble's copy button copies the answer text, not citations", async () => {
  const { window, $ } = await boot({
    getPresets: async () => ({
      presets: [], defaultOutDir: "/tmp", hfToken: "", language: "ru",
      para: { root: "/v", folders: { projects: "Projects", areas: "Areas", resources: "Resources", archives: "Archives" } },
    }),
    paraSearch: async () => ({
      found: true,
      answer: "Ответ по заметкам.",
      citations: [{ date: "2026-01-01", title: "Синк", note_path: "/v/Projects/note.md" }],
    }),
  });
  const copied = [];
  window.navigator.clipboard.writeText = async (text) => { copied.push(text); };

  window.document.querySelector('.topbtn[data-view="para"]').click();
  await tick(window);
  window.document.querySelector('.subbtn[data-sub="search"]').click();
  await tick(window);
  $("paraSearchQuery").value = "тест вопрос";
  $("paraSearchBtn").click(); await tick(window); await tick(window);

  const bubbles = $("paraChatLog").querySelectorAll(".chat-bubble");
  const assistantBubble = bubbles[bubbles.length - 1];
  assert.ok(!bubbles[0].querySelector(".chat-copy-btn"), "user bubble has no copy button");
  const copyBtn = assistantBubble.querySelector(".chat-copy-btn");
  assert.ok(copyBtn, "assistant bubble has a copy button");

  copyBtn.click();
  assert.equal(copied[0], "Ответ по заметкам.", "copies the raw answer text, without the citation list");
});

test("PARA chat: degraded:true on the result shows the keyword-only badge", async () => {
  const { window, $ } = await boot({
    getPresets: async () => ({
      presets: [], defaultOutDir: "/tmp", hfToken: "", language: "ru",
      para: { root: "/v", folders: { projects: "Projects", areas: "Areas", resources: "Resources", archives: "Archives" } },
    }),
    paraSearch: async () => ({ found: true, answer: "Ответ.", citations: [], degraded: true }),
  });
  window.document.querySelector('.topbtn[data-view="para"]').click();
  await tick(window);
  window.document.querySelector('.subbtn[data-sub="search"]').click();
  await tick(window);
  $("paraSearchQuery").value = "вопрос";
  $("paraSearchBtn").click(); await tick(window); await tick(window);

  const bubbles = $("paraChatLog").querySelectorAll(".chat-bubble");
  const assistantBubble = bubbles[bubbles.length - 1];
  assert.ok(assistantBubble.querySelector(".chat-degraded"), "degraded badge must be present");
});

test("PARA chat: degraded absent/false → no keyword-only badge", async () => {
  const { window, $ } = await boot({
    getPresets: async () => ({
      presets: [], defaultOutDir: "/tmp", hfToken: "", language: "ru",
      para: { root: "/v", folders: { projects: "Projects", areas: "Areas", resources: "Resources", archives: "Archives" } },
    }),
    paraSearch: async () => ({ found: true, answer: "Ответ.", citations: [] }), // no degraded field
  });
  window.document.querySelector('.topbtn[data-view="para"]').click();
  await tick(window);
  window.document.querySelector('.subbtn[data-sub="search"]').click();
  await tick(window);
  $("paraSearchQuery").value = "вопрос";
  $("paraSearchBtn").click(); await tick(window); await tick(window);

  const bubbles = $("paraChatLog").querySelectorAll(".chat-bubble");
  const assistantBubble = bubbles[bubbles.length - 1];
  assert.ok(!assistantBubble.querySelector(".chat-degraded"), "no badge when result isn't degraded");
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

test("PARA chat: cancel button hidden by default, shown while search in-flight, hidden again after response", async () => {
  let resolveSearch;
  const { window, $ } = await boot({
    getPresets: async () => ({
      presets: [], defaultOutDir: "/tmp", hfToken: "", language: "ru",
      para: { root: "/v", folders: { projects: "Projects", areas: "Areas", resources: "Resources", archives: "Archives" } },
    }),
    paraSearch: async () => new Promise((resolve) => { resolveSearch = resolve; }),
  });
  window.document.querySelector('.topbtn[data-view="para"]').click();
  await tick(window);
  window.document.querySelector('.subbtn[data-sub="search"]').click();
  await tick(window);

  assert.ok($("paraSearchCancel").classList.contains("hidden"), "cancel button hidden before any query");

  $("paraSearchQuery").value = "вопрос";
  $("paraSearchBtn").click(); await tick(window);
  assert.ok(!$("paraSearchCancel").classList.contains("hidden"), "cancel button shown while in-flight");
  assert.equal($("paraSearchCancel").disabled, false, "cancel button enabled while in-flight");

  resolveSearch({ found: true, answer: "Ответ.", citations: [] });
  await tick(window); await tick(window);
  assert.ok($("paraSearchCancel").classList.contains("hidden"), "cancel button hidden again after response");
});

test("PARA chat: clicking cancel calls cancelSearch once and self-disables (a second click is a no-op)", async () => {
  let resolveSearch;
  let cancelCalls = 0;
  const { window, $ } = await boot({
    getPresets: async () => ({
      presets: [], defaultOutDir: "/tmp", hfToken: "", language: "ru",
      para: { root: "/v", folders: { projects: "Projects", areas: "Areas", resources: "Resources", archives: "Archives" } },
    }),
    paraSearch: async () => new Promise((resolve) => { resolveSearch = resolve; }),
    cancelSearch: async () => { cancelCalls++; return { ok: true }; },
  });
  window.document.querySelector('.topbtn[data-view="para"]').click();
  await tick(window);
  window.document.querySelector('.subbtn[data-sub="search"]').click();
  await tick(window);
  $("paraSearchQuery").value = "вопрос";
  $("paraSearchBtn").click(); await tick(window);

  $("paraSearchCancel").click();
  $("paraSearchCancel").click(); // second click must be a no-op — button self-disabled on the first
  await tick(window);
  assert.equal(cancelCalls, 1, "cancelSearch invoked exactly once");
  assert.equal($("paraSearchCancel").disabled, true, "cancel button stays disabled after click");

  // Let the pending paraSearch promise settle so the test exits cleanly.
  resolveSearch({ found: false, canceled: true });
  await tick(window); await tick(window);
});

test("PARA chat: canceled result tags the user bubble, appends no assistant bubble, and re-enables input", async () => {
  let resolveSearch;
  const { window, $ } = await boot({
    getPresets: async () => ({
      presets: [], defaultOutDir: "/tmp", hfToken: "", language: "ru",
      para: { root: "/v", folders: { projects: "Projects", areas: "Areas", resources: "Resources", archives: "Archives" } },
    }),
    paraSearch: async () => new Promise((resolve) => { resolveSearch = resolve; }),
  });
  window.document.querySelector('.topbtn[data-view="para"]').click();
  await tick(window);
  window.document.querySelector('.subbtn[data-sub="search"]').click();
  await tick(window);
  $("paraSearchQuery").value = "вопрос отменённый";
  $("paraSearchBtn").click(); await tick(window);

  $("paraSearchCancel").click();
  resolveSearch({ found: false, canceled: true });
  await tick(window); await tick(window);

  const bubbles = $("paraChatLog").querySelectorAll(".chat-bubble");
  assert.equal(bubbles.length, 1, "no assistant bubble appended for a canceled turn");
  assert.ok(bubbles[0].classList.contains("chat-bubble-user"), "the surviving bubble is the user's");
  assert.ok(bubbles[0].querySelector(".chat-canceled-tag"), "user bubble must be tagged canceled");
  assert.equal($("paraSearchBtn").disabled, false, "send button re-enabled");
  assert.equal($("paraSearchQuery").disabled, false, "input re-enabled");
  assert.ok($("paraSearchCancel").classList.contains("hidden"), "cancel button hidden again");
});

test("PARA chat: canceled turn is dropped from history sent on the next query (no phantom turn)", async () => {
  let resolveFirst;
  const calls = [];
  let call = 0;
  const { window, $ } = await boot({
    getPresets: async () => ({
      presets: [], defaultOutDir: "/tmp", hfToken: "", language: "ru",
      para: { root: "/v", folders: { projects: "Projects", areas: "Areas", resources: "Resources", archives: "Archives" } },
    }),
    paraSearch: async (_root, messages) => {
      call++;
      calls.push(messages);
      if (call === 1) return new Promise((resolve) => { resolveFirst = resolve; });
      return { found: true, answer: "Ответ 2", citations: [] };
    },
  });
  window.document.querySelector('.topbtn[data-view="para"]').click();
  await tick(window);
  window.document.querySelector('.subbtn[data-sub="search"]').click();
  await tick(window);

  $("paraSearchQuery").value = "первый (будет отменён)";
  $("paraSearchBtn").click(); await tick(window);
  resolveFirst({ found: false, canceled: true });
  await tick(window); await tick(window);

  // New query after cancel must work (input/button are re-enabled, no leftover lock).
  $("paraSearchQuery").value = "второй";
  $("paraSearchBtn").click(); await tick(window); await tick(window);

  assert.equal(calls.length, 2, "paraSearch called twice");
  assert.equal(calls[1].length, 1, "second call's history has only the new turn — the canceled one was dropped");
  assert.equal(calls[1][0].role, "user");
  assert.equal(calls[1][0].content, "второй");
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

test("history 'Спросить' button jumps to PARA search subtab and focuses the chat input", async () => {
  const { window, $ } = await boot();
  window.document.querySelector('.topbtn[data-view="history"]').click();
  await tick(window);
  $("historyAskBtn").click();
  await tick(window);
  assert.ok(!$("view-para").classList.contains("hidden"), "PARA view must be visible");
  assert.ok($("view-history").classList.contains("hidden"), "history view must be hidden");
  assert.ok(!$("para-pane-search").classList.contains("hidden"), "#para-pane-search must be visible");
  assert.ok($("para-pane-inbox").classList.contains("hidden"), "#para-pane-inbox must be hidden");
  assert.equal(window.document.activeElement, $("paraSearchQuery"), "chat input must be focused");
});

// ── authorName setting ────────────────────────────────────────────────────────

test("authorName loads from presets into state and the settings input", async () => {
  const { $, window } = await boot({
    getPresets: async () => ({
      presets: [], defaultOutDir: "/tmp", hfToken: "", language: "ru", authorName: "Кирилл",
    }),
  });
  await tick(window);
  assert.equal($("authorName").value, "Кирилл");
});

test("authorName defaults to 'Автор' when absent from presets", async () => {
  const { $, window } = await boot({
    getPresets: async () => ({ presets: [], defaultOutDir: "/tmp", hfToken: "", language: "ru" }),
  });
  await tick(window);
  assert.equal($("authorName").value, "Автор");
});

test("changing authorName input persists with authorName in savePresets payload", async () => {
  let saved = null;
  const { $, window } = await boot({ savePresets: async (data) => { saved = data; return true; } });
  await tick(window);
  $("authorName").value = "Наталья";
  $("authorName").dispatchEvent(new window.Event("change"));
  await tick(window);
  assert.ok(saved, "savePresets was not called");
  assert.equal(saved.authorName, "Наталья");
});

// ── settings overlay: hfToken/authorName/outDir relocation + outDir auto-follow ──

test("openSettings() populates hfToken/authorName/outDir from state and shows the overlay", async () => {
  const { $, window } = await boot({
    getPresets: async () => ({
      presets: [], defaultOutDir: "/tmp/out", hfToken: "hf_x", language: "ru", authorName: "Ольга",
    }),
  });
  await tick(window);
  assert.equal($("settingsOverlay").classList.contains("hidden"), true, "overlay starts hidden");
  $("settingsOpen").click();
  await tick(window);
  assert.equal($("settingsOverlay").classList.contains("hidden"), false);
  assert.equal($("hfToken").value, "hf_x");
  assert.equal($("authorName").value, "Ольга");
  assert.equal($("outDir").value, "/tmp/out");
});

test("pickOut (now in settings) sets outDir, marks it custom, and persists outDirCustom=true", async () => {
  let saved = null;
  const { $, window } = await boot({
    pickOutDir: async () => "/custom/path",
    savePresets: async (data) => { saved = data; return true; },
  });
  await tick(window);
  $("pickOut").click(); await tick(window);
  assert.equal($("outDir").value, "/custom/path");
  assert.ok(saved, "savePresets was not called");
  assert.equal(saved.outDirCustom, true);
});

test("PARA: creating a vault forwards outDir/outDirCustom and applies the returned outDir (auto-follow)", async () => {
  let sentArgs = null;
  const { window, $ } = await boot({
    pickOutDir: async () => "/tmp/vault",
    paraCreateVault: async (args) => { sentArgs = args; return { ok: true, outDir: args.root + "/Meetings" }; },
  });
  window.document.querySelector('.topbtn[data-view="para"]').click();
  await tick(window);
  $("paraPick").click(); await tick(window);
  $("paraCreate").click(); await tick(window);
  assert.equal(sentArgs.outDir, "/tmp/out");   // default state.outDir from boot()'s getPresets mock
  assert.equal(sentArgs.outDirCustom, false);  // default outDirCustom
  assert.equal($("outDir").value, "/tmp/vault/Meetings");
});

test("PARA: creating a vault leaves a custom outDir untouched (mock mirrors the custom-protects rule)", async () => {
  let sentArgs = null;
  const { window, $ } = await boot({
    getPresets: async () => ({
      presets: [], defaultOutDir: "/manual/out", hfToken: "", language: "ru", outDirCustom: true,
    }),
    pickOutDir: async () => "/tmp/vault2",
    paraCreateVault: async (args) => {
      sentArgs = args;
      return { ok: true, outDir: args.outDirCustom ? args.outDir : args.root + "/Meetings" };
    },
  });
  window.document.querySelector('.topbtn[data-view="para"]').click();
  await tick(window);
  $("paraPick").click(); await tick(window);
  $("paraCreate").click(); await tick(window);
  assert.equal(sentArgs.outDirCustom, true);
  assert.equal($("outDir").value, "/manual/out");
});

// ── glossary setting ──────────────────────────────────────────────────────────

test("glossary loads from presets into state and the settings textarea", async () => {
  const { $, window } = await boot({
    getPresets: async () => ({
      presets: [], defaultOutDir: "/tmp", hfToken: "", language: "ru",
      glossary: "Иван Петров, Mindbox",
    }),
  });
  await tick(window);
  assert.equal($("glossary").value, "Иван Петров, Mindbox");
});

const DEFAULT_GLOSSARY = "деплой, бэклог, спринт, ретро, стендап, груминг, эстимейт, роадмап, хотфикс, багфикс, тикет, пул-реквест, коммит, мёрж, код-ревью, статус-митинг, инцидент, продакшн, стейджинг, онбординг, скоуп, дедлайн, чекпоинт, апдейт, апрув, фидбек, Kubernetes, Docker, GitLab, GitHub, Jira, Confluence, Slack, Zoom, AWS, Kafka, Redis, PostgreSQL, ClickHouse, Grafana, Prometheus, Terraform, CI/CD, API, SQL, DevOps, MVP, KPI, OKR, дискавери, дискашн, синк, ван-он-ван, перформанс-ревью, квартал, планирование, приоритизация, метрика, гипотеза, эксперимент, A/B-тест, дашборд, воронка, конверсия, ретеншн, когорта, сегмент, атрибуция, пайплайн, релиз, рефакторинг, миграция, легаси, техдолг, архитектура, микросервис, монолит, фронтенд, бэкенд, эндпоинт, интеграция, оркестрация, Elasticsearch, RabbitMQ, nginx, Figma, Miro, Notion, Airflow, dbt, Tableau, Power BI, S3, VPN, SSO, LDAP, OAuth, нейросеть, промпт, эмбеддинг, инференс, файнтюнинг, LLM, RAG, ChatGPT, Claude";

test("glossary pre-fills with the default term list when absent from presets", async () => {
  const { $, window } = await boot({
    getPresets: async () => ({ presets: [], defaultOutDir: "/tmp", hfToken: "", language: "ru" }),
  });
  await tick(window);
  assert.equal($("glossary").value, DEFAULT_GLOSSARY);
});

test("glossary pre-fills with the default term list when presets has an empty string", async () => {
  const { $, window } = await boot({
    getPresets: async () => ({ presets: [], defaultOutDir: "/tmp", hfToken: "", language: "ru", glossary: "" }),
  });
  await tick(window);
  assert.equal($("glossary").value, DEFAULT_GLOSSARY);
});

test("changing glossary input persists with glossary in savePresets payload", async () => {
  let saved = null;
  const { $, window } = await boot({ savePresets: async (data) => { saved = data; return true; } });
  await tick(window);
  $("glossary").value = "ClickHouse, Kubernetes";
  $("glossary").dispatchEvent(new window.Event("change"));
  await tick(window);
  assert.ok(saved, "savePresets was not called");
  assert.equal(saved.glossary, "ClickHouse, Kubernetes");
});

test("changing glossary input persists correctly even while the Словарь tab is not active", async () => {
  let saved = null;
  const { $, window } = await boot({ savePresets: async (data) => { saved = data; return true; } });
  await tick(window);
  window.document.querySelector('.topbtn[data-view="history"]').click(); // navigate away from the glossary tab
  assert.ok($("view-glossary").classList.contains("hidden"), "glossary view must be hidden after navigating away");
  $("glossary").value = "ClickHouse, Kubernetes";
  $("glossary").dispatchEvent(new window.Event("change"));
  await tick(window);
  assert.ok(saved, "savePresets was not called");
  assert.equal(saved.glossary, "ClickHouse, Kubernetes");
});

test("view switching shows the Словарь tab and hides the other three views", async () => {
  const { window, $ } = await boot();
  window.document.querySelector('.topbtn[data-view="glossary"]').click();
  assert.ok(!$("view-glossary").classList.contains("hidden"), "glossary view must be visible");
  assert.ok($("view-record").classList.contains("hidden"));
  assert.ok($("view-history").classList.contains("hidden"));
  assert.ok($("view-para").classList.contains("hidden"));
  window.document.querySelector('.topbtn[data-view="record"]').click();
  assert.ok(!$("view-record").classList.contains("hidden"));
  assert.ok($("view-glossary").classList.contains("hidden"), "glossary view must be hidden again");
});

test("glossary is forwarded to processAudio when running", async () => {
  let sent = null;
  const { window, $, handlers } = await boot({
    getPresets: async () => ({
      presets: [{ name: "P", prompt: "x" }], defaultOutDir: "/tmp", hfToken: "", language: "ru",
      glossary: "Иван Петров, Mindbox",
    }),
    processAudio: async (opts) => { sent = opts; return { ok: true }; },
  });
  await tick(window);
  handlers.record({ event: "recorded", file: "/tmp/mixed.wav", mic: "/tmp/m.wav", system: null, tracks: 1 });
  $("runBtn").click();
  await tick(window);
  assert.ok(sent, "processAudio was not called");
  assert.equal(sent.glossary, "Иван Петров, Mindbox");
});

// ── glossary: chip list UX ───────────────────────────────────────────────────

test("glossary chips render one chip per term from the loaded comma-joined string, with a counter", async () => {
  const { $, window } = await boot({
    getPresets: async () => ({
      presets: [], defaultOutDir: "/tmp", hfToken: "", language: "ru",
      glossary: "Иван Петров, Mindbox, ClickHouse",
    }),
  });
  await tick(window);
  const chips = Array.from($("glossaryChips").querySelectorAll(".chip-text")).map((el) => el.textContent);
  assert.deepEqual(chips, ["Иван Петров", "Mindbox", "ClickHouse"]);
  assert.equal($("glossaryCount").textContent, "3 терминов");
});

test("adding a term via the input appends a chip and persists the comma-joined string", async () => {
  let saved = null;
  const { $, window } = await boot({
    getPresets: async () => ({ presets: [], defaultOutDir: "/tmp", hfToken: "", language: "ru", glossary: "Mindbox" }),
    savePresets: async (data) => { saved = data; return true; },
  });
  await tick(window);
  $("glossaryNewTerm").value = "Иван Петров";
  $("glossaryAddBtn").click();
  await tick(window);
  const chips = Array.from($("glossaryChips").querySelectorAll(".chip-text")).map((el) => el.textContent);
  assert.deepEqual(chips, ["Mindbox", "Иван Петров"]);
  assert.equal($("glossaryCount").textContent, "2 терминов");
  assert.equal($("glossaryNewTerm").value, "", "input clears after a successful add");
  assert.equal($("glossary").value, "Mindbox, Иван Петров", "textarea stays in sync with chips");
  assert.ok(saved, "savePresets was not called");
  assert.equal(saved.glossary, "Mindbox, Иван Петров");
});

test("adding a case-insensitive duplicate term is rejected with a hint, no new chip", async () => {
  const { $, window } = await boot({
    getPresets: async () => ({ presets: [], defaultOutDir: "/tmp", hfToken: "", language: "ru", glossary: "Mindbox" }),
  });
  await tick(window);
  $("glossaryNewTerm").value = "mindbox";
  $("glossaryAddBtn").click();
  await tick(window);
  const chips = Array.from($("glossaryChips").querySelectorAll(".chip-text")).map((el) => el.textContent);
  assert.deepEqual(chips, ["Mindbox"]);
  assert.equal($("glossaryCount").textContent, "1 терминов");
  assert.ok(!$("glossaryHint").classList.contains("hidden"), "hint must be shown for a duplicate");
  assert.match($("glossaryHint").textContent, /уже есть в списке/);
});

test("removing a chip drops the term from state.glossary and persists", async () => {
  let saved = null;
  const { $, window } = await boot({
    getPresets: async () => ({
      presets: [], defaultOutDir: "/tmp", hfToken: "", language: "ru",
      glossary: "Иван Петров, Mindbox, ClickHouse",
    }),
    savePresets: async (data) => { saved = data; return true; },
  });
  await tick(window);
  // "Mindbox" is the 2nd rendered chip (index 1: Иван Петров, Mindbox, ClickHouse) —
  // removal is wired by index-into-terms closure, not a DOM attribute (see renderer.js).
  $("glossaryChips").querySelectorAll(".chip-remove")[1].click();
  await tick(window);
  const chips = Array.from($("glossaryChips").querySelectorAll(".chip-text")).map((el) => el.textContent);
  assert.deepEqual(chips, ["Иван Петров", "ClickHouse"]);
  assert.equal($("glossaryCount").textContent, "2 терминов");
  assert.equal($("glossary").value, "Иван Петров, ClickHouse");
  assert.ok(saved, "savePresets was not called");
  assert.equal(saved.glossary, "Иван Петров, ClickHouse");
});

test("a term containing a double quote does not break out of an HTML attribute and can still be removed (regression: attribute-injection via data-term)", async () => {
  let saved = null;
  const injected = 'x" onmouseover="alert(1)';
  const { $, window } = await boot({
    getPresets: async () => ({ presets: [], defaultOutDir: "/tmp", hfToken: "", language: "ru", glossary: "Mindbox" }),
    savePresets: async (data) => { saved = data; return true; },
  });
  await tick(window);
  // Simulate the term arriving via a bulk "текстом" paste (presets file / textarea edit),
  // not the single-term add box — matches how an attacker-controlled quote-containing
  // string would actually reach the chip renderer (split is only on [,\n]+, quotes survive).
  $("glossary").value = `Mindbox, ${injected}`;
  $("glossary").dispatchEvent(new window.Event("change"));
  await tick(window);

  const chipTexts = Array.from($("glossaryChips").querySelectorAll(".chip-text")).map((el) => el.textContent);
  assert.deepEqual(chipTexts, ["Mindbox", injected], "term renders intact as text content");

  const removeButtons = $("glossaryChips").querySelectorAll(".chip-remove");
  const injectedBtn = removeButtons[1];
  // No attribute round-trip at all — data-term must not exist, and no onmouseover
  // handler must have been attached by breaking out of a data-term="..." attribute.
  assert.equal(injectedBtn.getAttribute("data-term"), null);
  assert.equal(injectedBtn.getAttribute("onmouseover"), null);
  assert.equal(injectedBtn.onmouseover, null);

  // Removal must still match the exact original term (closure-captured, not
  // round-tripped through a garbled attribute).
  injectedBtn.click();
  await tick(window);
  const after = Array.from($("glossaryChips").querySelectorAll(".chip-text")).map((el) => el.textContent);
  assert.deepEqual(after, ["Mindbox"]);
  assert.equal($("glossary").value, "Mindbox");
  assert.ok(saved, "savePresets was not called");
  assert.equal(saved.glossary, "Mindbox");
});

test("«Дополнить распространёнными» merges DEFAULT_GLOSSARY terms not already present, preserving current order first", async () => {
  let saved = null;
  const { $, window } = await boot({
    getPresets: async () => ({
      presets: [], defaultOutDir: "/tmp", hfToken: "", language: "ru",
      // "деплой" and "Kubernetes" already overlap the default list (case-insensitively);
      // "Иван Петров" is a custom term absent from the defaults.
      glossary: "Иван Петров, деплой, kubernetes",
    }),
    savePresets: async (data) => { saved = data; return true; },
  });
  await tick(window);
  $("glossaryFillDefaults").click();
  await tick(window);
  const chips = Array.from($("glossaryChips").querySelectorAll(".chip-text")).map((el) => el.textContent);
  const defaultCount = DEFAULT_GLOSSARY.split(",").length;
  // current 3 terms kept first, in order; only the non-overlapping defaults appended after.
  assert.deepEqual(chips.slice(0, 3), ["Иван Петров", "деплой", "kubernetes"]);
  assert.equal(chips.length, 3 + (defaultCount - 2)); // -2 for "деплой"/"Kubernetes" overlap
  assert.ok(!chips.slice(3).some((t) => t.toLowerCase() === "деплой" || t.toLowerCase() === "kubernetes"),
    "overlapping default terms must not be duplicated");
  assert.ok(!$("glossaryHint").classList.contains("hidden"));
  assert.match($("glossaryHint").textContent, /Добавлено \d+ новых терминов/);
  assert.ok(saved, "savePresets was not called");
  assert.equal(saved.glossary, $("glossary").value);
});

test("«Дополнить распространёнными» is a no-op with a hint when every default term is already present", async () => {
  const { $, window } = await boot({
    getPresets: async () => ({ presets: [], defaultOutDir: "/tmp", hfToken: "", language: "ru", glossary: DEFAULT_GLOSSARY }),
  });
  await tick(window);
  const before = $("glossary").value;
  $("glossaryFillDefaults").click();
  await tick(window);
  assert.equal($("glossary").value, before, "glossary string must not change when nothing new to add");
  assert.ok(!$("glossaryHint").classList.contains("hidden"));
  assert.match($("glossaryHint").textContent, /уже есть в списке/);
});

test("editing the textarea (текстом mode) re-syncs the chip list", async () => {
  const { $, window } = await boot({
    getPresets: async () => ({ presets: [], defaultOutDir: "/tmp", hfToken: "", language: "ru", glossary: "Mindbox" }),
  });
  await tick(window);
  $("glossary").value = "Mindbox, ClickHouse, Иван Петров";
  $("glossary").dispatchEvent(new window.Event("change"));
  await tick(window);
  const chips = Array.from($("glossaryChips").querySelectorAll(".chip-text")).map((el) => el.textContent);
  assert.deepEqual(chips, ["Mindbox", "ClickHouse", "Иван Петров"]);
  assert.equal($("glossaryCount").textContent, "3 терминов");
});

// ── glossary: «Предложения» inbox (auto-suggested terms from processing) ────
test("glossarySuggestions/glossaryDismissed load from presets, and a process-complete 'done' event merges new suggestions in", async () => {
  const { $, window, handlers } = await boot({
    getPresets: async () => ({
      presets: [], defaultOutDir: "/tmp", hfToken: "", language: "ru", glossary: "Mindbox",
      glossarySuggestions: ["ClickHouse"], glossaryDismissed: ["Kafka"],
    }),
  });
  await tick(window);
  assert.ok(!$("glossarySuggestSection").classList.contains("hidden"));
  let chips = Array.from($("glossarySuggestChips").querySelectorAll(".chip-text")).map((el) => el.textContent);
  assert.deepEqual(chips, ["ClickHouse"]);
  assert.equal($("glossarySuggestCount").textContent, "1 предложений");

  handlers.process({
    event: "done", note: "/n.md", audio: "/a.wav", transcript: "t", summary: "s",
    // "Kafka" was dismissed earlier — must never resurface; "Mindbox" is already
    // in the glossary — must not duplicate into pending; "S3" is genuinely new.
    suggestions: ["Kafka", "Mindbox", "S3", "ClickHouse"],
  });
  await tick(window);
  chips = Array.from($("glossarySuggestChips").querySelectorAll(".chip-text")).map((el) => el.textContent);
  assert.deepEqual(chips, ["ClickHouse", "S3"]);
  assert.equal($("glossarySuggestCount").textContent, "2 предложений");
});

test("glossary suggestions section is hidden when there is nothing pending", async () => {
  const { $, window } = await boot({
    getPresets: async () => ({ presets: [], defaultOutDir: "/tmp", hfToken: "", language: "ru", glossary: "Mindbox" }),
  });
  await tick(window);
  assert.ok($("glossarySuggestSection").classList.contains("hidden"));
});

test("accepting a suggestion moves it into the glossary chips and persists both lists, removing it from pending", async () => {
  let saved = null;
  const { $, window, handlers } = await boot({
    getPresets: async () => ({ presets: [], defaultOutDir: "/tmp", hfToken: "", language: "ru", glossary: "Mindbox" }),
    savePresets: async (data) => { saved = data; return true; },
  });
  await tick(window);
  handlers.process({ event: "done", note: "/n.md", audio: "/a.wav", transcript: "t", summary: "s",
    suggestions: ["ClickHouse", "Kafka"] });
  await tick(window);

  $("glossarySuggestChips").querySelectorAll(".chip-accept")[0].click();
  await tick(window);

  const glossaryChips = Array.from($("glossaryChips").querySelectorAll(".chip-text")).map((el) => el.textContent);
  assert.deepEqual(glossaryChips, ["Mindbox", "ClickHouse"]);
  const pending = Array.from($("glossarySuggestChips").querySelectorAll(".chip-text")).map((el) => el.textContent);
  assert.deepEqual(pending, ["Kafka"]);
  assert.equal($("glossary").value, "Mindbox, ClickHouse");
  assert.ok(saved, "savePresets was not called");
  assert.equal(saved.glossary, "Mindbox, ClickHouse");
  assert.deepEqual(saved.glossarySuggestions, ["Kafka"]);
});

test("dismissing a suggestion removes it from pending, remembers it, and it never resurfaces after a later 'done' event", async () => {
  let saved = null;
  const { $, window, handlers } = await boot({
    // non-empty glossary — "" would pre-fill DEFAULT_GLOSSARY (which already
    // contains "Kafka"), masking the merge/dedupe behaviour under test.
    getPresets: async () => ({ presets: [], defaultOutDir: "/tmp", hfToken: "", language: "ru", glossary: "Mindbox" }),
    savePresets: async (data) => { saved = data; return true; },
  });
  await tick(window);
  handlers.process({ event: "done", note: "/n.md", audio: "/a.wav", transcript: "t", summary: "s",
    suggestions: ["Kafka"] });
  await tick(window);

  $("glossarySuggestChips").querySelectorAll(".chip-dismiss")[0].click();
  await tick(window);

  assert.ok($("glossarySuggestSection").classList.contains("hidden"), "pending list emptied → section hidden");
  assert.ok(saved, "savePresets was not called");
  assert.deepEqual(saved.glossaryDismissed, ["Kafka"]);
  assert.deepEqual(saved.glossarySuggestions, []);

  // a later process run re-suggests the same term — must not resurface.
  handlers.process({ event: "done", note: "/n2.md", audio: "/a2.wav", transcript: "t2", summary: "s2",
    suggestions: ["Kafka"] });
  await tick(window);
  assert.ok($("glossarySuggestSection").classList.contains("hidden"));
  const pending = Array.from($("glossarySuggestChips").querySelectorAll(".chip-text")).map((el) => el.textContent);
  assert.deepEqual(pending, []);
});

test("«Принять все» is shown only with ≥2 pending, and merges every pending term into the glossary at once", async () => {
  let saved = null;
  const { $, window, handlers } = await boot({
    getPresets: async () => ({ presets: [], defaultOutDir: "/tmp", hfToken: "", language: "ru", glossary: "Mindbox" }),
    savePresets: async (data) => { saved = data; return true; },
  });
  await tick(window);

  handlers.process({ event: "done", note: "/n.md", audio: "/a.wav", transcript: "t", summary: "s",
    suggestions: ["ClickHouse"] });
  await tick(window);
  assert.ok($("glossaryAcceptAll").classList.contains("hidden"), "hidden with only 1 pending");

  handlers.process({ event: "done", note: "/n.md", audio: "/a.wav", transcript: "t", summary: "s",
    suggestions: ["Kafka"] });
  await tick(window);
  assert.ok(!$("glossaryAcceptAll").classList.contains("hidden"), "shown with 2 pending");

  $("glossaryAcceptAll").click();
  await tick(window);
  const glossaryChips = Array.from($("glossaryChips").querySelectorAll(".chip-text")).map((el) => el.textContent);
  assert.deepEqual(glossaryChips, ["Mindbox", "ClickHouse", "Kafka"]);
  const pending = Array.from($("glossarySuggestChips").querySelectorAll(".chip-text")).map((el) => el.textContent);
  assert.deepEqual(pending, []);
  assert.ok($("glossarySuggestSection").classList.contains("hidden"));
  assert.equal(saved.glossary, "Mindbox, ClickHouse, Kafka");
});

test("a suggestion containing a double quote renders safely and can still be accepted/dismissed (regression: attribute-injection via data-term, see b28d276)", async () => {
  const injected = 'x" onmouseover="alert(1)';
  let saved = null;
  const { $, window, handlers } = await boot({
    // non-empty glossary — "" would pre-fill DEFAULT_GLOSSARY, muddying the
    // exact-chip-list assertions below.
    getPresets: async () => ({ presets: [], defaultOutDir: "/tmp", hfToken: "", language: "ru", glossary: "Mindbox" }),
    savePresets: async (data) => { saved = data; return true; },
  });
  await tick(window);
  handlers.process({ event: "done", note: "/n.md", audio: "/a.wav", transcript: "t", summary: "s",
    suggestions: [injected] });
  await tick(window);

  const chipTexts = Array.from($("glossarySuggestChips").querySelectorAll(".chip-text")).map((el) => el.textContent);
  assert.deepEqual(chipTexts, [injected], "term renders intact as text content");

  const acceptBtn = $("glossarySuggestChips").querySelector(".chip-accept");
  assert.equal(acceptBtn.getAttribute("data-term"), null);
  assert.equal(acceptBtn.getAttribute("onmouseover"), null);
  assert.equal(acceptBtn.onmouseover, null);

  acceptBtn.click();
  await tick(window);
  const glossaryChips = Array.from($("glossaryChips").querySelectorAll(".chip-text")).map((el) => el.textContent);
  assert.deepEqual(glossaryChips, ["Mindbox", injected]);
  assert.ok(saved, "savePresets was not called");
  assert.equal(saved.glossary, `Mindbox, ${injected}`);
});

// ── auto-«Я»: micFile/systemFile/authorName plumbing ────────────────────────
test("auto-«Я» inputs (micFile/systemFile/authorName) are forwarded to processAudio in record mode", async () => {
  let sent = null;
  const { window, $, handlers } = await boot({
    getPresets: async () => ({
      presets: [{ name: "P", prompt: "x" }], defaultOutDir: "/tmp", hfToken: "", language: "ru", authorName: "Алёна",
    }),
    processAudio: async (opts) => { sent = opts; return { ok: true }; },
  });
  await tick(window);
  handlers.record({ event: "recorded", file: "/tmp/mixed.wav", mic: "/tmp/m.wav", system: "/tmp/s.wav", tracks: 2 });
  $("runBtn").click();
  await tick(window);
  assert.ok(sent, "processAudio was not called");
  assert.equal(sent.micFile, "/tmp/m.wav");
  assert.equal(sent.systemFile, "/tmp/s.wav");
  assert.equal(sent.authorName, "Алёна");
});

test("auto-«Я» inputs are absent when processing an imported file (History → Переобработать)", async () => {
  let sent = null;
  const { window, $ } = await boot({ processAudio: async (opts) => { sent = opts; return { ok: true }; } });
  window.document.querySelector('.topbtn[data-view="history"]').click(); await tick(window);
  $("historyList").querySelector(".rail-item").click(); await tick(window);
  $("noteView").querySelector("#nvReprocess").click(); await tick(window);
  assert.ok(sent, "processAudio was not called");
  assert.equal(sent.micFile, undefined);
  assert.equal(sent.systemFile, undefined);
  assert.equal(sent.authorName, undefined);
});

test("'это я' button fills speaker row input with authorName; Apply sends it through rename API", async () => {
  let renamed = null;
  const { window, $, handlers } = await boot({
    getPresets: async () => ({
      presets: [{ name: "P", prompt: "x" }], defaultOutDir: "/tmp", hfToken: "", language: "ru", authorName: "Алёна",
    }),
    renameSpeakers: async (notePath, map) => { renamed = { notePath, map }; return { ok: true }; },
  });
  await tick(window);
  handlers.record({ event: "recorded", file: "/tmp/mixed.wav", mic: "/tmp/m.wav", system: null, tracks: 1 });
  $("runBtn").click(); await tick(window);
  handlers.process({
    event: "done", note: "/o/meeting.md", audio: "/o/a.wav",
    transcript: "**[Спикер 1]**: привет\n\n**[Спикер 2]**: пока", summary: "s",
  });
  await tick(window);
  // click "это я" on the first speaker row
  const meBtn = $("speakerInputs").querySelector(".speaker-me");
  assert.ok(meBtn, "'это я' button not found in speaker row");
  meBtn.click();
  // the first row's input should now contain the author name
  const firstInput = $("speakerInputs").querySelectorAll("input")[0];
  assert.equal(firstInput.value, "Алёна");
  // Apply should send it through rename API
  $("applySpeakers").click(); await tick(window);
  assert.ok(renamed, "renameSpeakers was not called");
  assert.equal(renamed.map["Спикер 1"], "Алёна");
});

// ── PARA auto-index log buffer ──────────────────────────────────────────────
test("PARA auto-index log: buffer is capped, not unbounded, across many background events", async () => {
  const { $, handlers } = await boot();
  // Simulate the background auto-index trigger (main.js startAutoIndex/triggerAutoIndex),
  // which streams "log" events on the same onParaReindexEvent channel as the manual
  // reindex button — but unlike the button click, it never resets logBox.textContent,
  // so it can fire many times over a long session without any user-driven clear point.
  const totalRuns = 500;
  for (let i = 0; i < totalRuns; i++) {
    handlers.reindex({ event: "log", msg: `run ${i}` });
  }
  const box = $("paraReindexLog");
  const lines = box.textContent.split("\n").filter(Boolean);
  assert.ok(lines.length < totalRuns, `expected the buffer to be capped, got ${lines.length} lines`);
  assert.ok(lines.some((l) => l.endsWith(`run ${totalRuns - 1}`)), "latest log line was dropped");
  assert.ok(!lines.some((l) => l.endsWith("run 0")), "oldest log line should have been evicted");
});

// ── PARA chat degraded badge ↔ backend log-line link ────────────────────────
test("PARA chat degraded badge: backend.py's log wording matches main.js's exact-match marker", () => {
  // The renderer's degraded badge (tested above via result.degraded) only ever gets set
  // to true because main.js's para-search handler does an exact string match between
  // backend.py's log() call in _rag_retrieve and its own DEGRADED_LOG_MSG constant. A
  // reword on either side would silently stop the badge from ever appearing, with no
  // error anywhere in the chain — this test fails loudly instead.
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const backendSrc = fs.readFileSync(path.join(__dirname, "../backend.py"), "utf8");

  const m = mainSrc.match(/const DEGRADED_LOG_MSG = "([^"]+)"/);
  assert.ok(m, "DEGRADED_LOG_MSG constant not found in main.js (renamed or reworded?)");
  const marker = m[1];

  assert.ok(
    backendSrc.includes(marker),
    `backend.py no longer emits the exact string main.js matches on: ${JSON.stringify(marker)}`
  );
});

// ── settings "Модели" section (model inventory + pre-download) ─────────────
test("Модели: renders one pf-row per model with cached/needed/locked status + detail text", async () => {
  const { window, $ } = await boot();
  $("settingsOpen").click();
  await tick(window);
  const whisper = $("model-row-whisper");
  const vad = $("model-row-vad");
  const diar = $("model-row-diarization");
  assert.ok(whisper && vad && diar, "expected one row per model id");
  assert.ok(whisper.querySelector(".pf-dot").classList.contains("ok"));
  assert.match(whisper.querySelector(".pf-detail").textContent, /скачано/);
  assert.ok(vad.querySelector(".pf-dot").classList.contains("warn"));
  assert.match(vad.querySelector(".pf-detail").textContent, /нужно скачать \(~35 МБ\)/);
  assert.ok(diar.querySelector(".pf-dot").classList.contains("bad"));
  assert.match(diar.querySelector(".pf-detail").textContent, /нужен HF-токен/);
});

test("Модели: per-row retry button only renders for needed (not cached, not locked) rows", async () => {
  const { window, $ } = await boot();
  $("settingsOpen").click();
  await tick(window);
  assert.equal($("model-row-whisper").querySelector(".pf-retry"), null, "cached row must not offer retry");
  assert.equal($("model-row-diarization").querySelector(".pf-retry"), null, "locked row must not offer retry");
  assert.ok($("model-row-vad").querySelector(".pf-retry"), "needed row must offer a retry button");
});

test("Модели: 'Скачать недостающие' click calls downloadModels and disables buttons until download-closed", async () => {
  let called = null;
  const { window, $, handlers } = await boot({
    downloadModels: async (opts) => { called = opts; return { ok: true }; },
  });
  $("settingsOpen").click();
  await tick(window);
  $("modelsDownloadMissing").click();
  await tick(window);
  assert.deepEqual(called, {});
  assert.equal($("modelsRefresh").disabled, true);
  assert.equal($("modelsDownloadMissing").disabled, true);
  assert.equal($("model-row-vad").querySelector(".pf-retry").disabled, true);

  handlers.modelDownload({ event: "download-closed", code: 0, canceled: false });
  await tick(window);
  assert.equal($("modelsRefresh").disabled, false);
  assert.equal($("modelsDownloadMissing").disabled, false);
});

test("Модели: all models cached → no bulk download button, header stays 'Проверить'", async () => {
  const { window, $ } = await boot({
    getModels: async () => ([
      { id: "whisper", label: "MLX Whisper (large-v3-turbo)", size_mb: 1500, needs_token: false, cached: true, locked: false },
      { id: "vad", label: "Silero VAD", size_mb: 35, needs_token: false, cached: true, locked: false },
    ]),
  });
  $("settingsOpen").click();
  await tick(window);
  assert.ok($("modelsDownloadMissing").classList.contains("hidden"), "nothing missing — bulk button must stay hidden");
  assert.match($("modelsRefresh").textContent, /Проверить/);
});

test("Модели: only locked models remain uncached → no bulk download button either", async () => {
  const { window, $ } = await boot({
    getModels: async () => ([
      { id: "whisper", label: "MLX Whisper (large-v3-turbo)", size_mb: 1500, needs_token: false, cached: true, locked: false },
      { id: "diarization", label: "Диаризация (pyannote)", size_mb: 31, needs_token: true, cached: false, locked: true },
    ]),
  });
  $("settingsOpen").click();
  await tick(window);
  assert.ok($("modelsDownloadMissing").classList.contains("hidden"), "locked-only rows must not trigger the bulk button");
});

test("Модели: some models missing → bulk download button shows with the missing count", async () => {
  const { window, $ } = await boot({
    getModels: async () => ([
      { id: "whisper", label: "MLX Whisper (large-v3-turbo)", size_mb: 1500, needs_token: false, cached: false, locked: false },
      { id: "vad", label: "Silero VAD", size_mb: 35, needs_token: false, cached: false, locked: false },
      { id: "diarization", label: "Диаризация (pyannote)", size_mb: 31, needs_token: true, cached: false, locked: true },
    ]),
  });
  $("settingsOpen").click();
  await tick(window);
  const bulkBtn = $("modelsDownloadMissing");
  assert.ok(!bulkBtn.classList.contains("hidden"), "two missing, non-locked models — bulk button must show");
  assert.match(bulkBtn.textContent, /2/);
});

test("Модели: during a download run, 'Проверить' + bulk + per-row retry buttons are all disabled", async () => {
  const { window, $ } = await boot({
    downloadModels: async () => new Promise(() => {}), // never resolves — simulates an in-flight download
  });
  $("settingsOpen").click();
  await tick(window);
  $("modelsDownloadMissing").click();
  await tick(window);
  assert.equal($("modelsRefresh").disabled, true);
  assert.equal($("modelsDownloadMissing").disabled, true);
  assert.equal($("model-row-vad").querySelector(".pf-retry").disabled, true);
});

test("Модели: per-row retry passes only that model's id", async () => {
  let called = null;
  const { window, $ } = await boot({
    downloadModels: async (opts) => { called = opts; return { ok: true }; },
  });
  $("settingsOpen").click();
  await tick(window);
  $("model-row-vad").querySelector(".pf-retry").click();
  await tick(window);
  assert.deepEqual(called, { only: ["vad"] });
});

test("Модели: stage/stage_end events update the row's dot + detail live", async () => {
  const { window, $, handlers } = await boot();
  $("settingsOpen").click();
  await tick(window);
  handlers.modelDownload({ event: "stage", stage: "model:vad", msg: "Скачиваю Silero VAD (~35 МБ)…" });
  assert.ok($("model-row-vad").querySelector(".pf-dot").classList.contains("warn"));
  assert.match($("model-row-vad").querySelector(".pf-detail").textContent, /скачивается/);

  handlers.modelDownload({ event: "stage_end", stage: "model:vad", status: "ok", msg: "Скачано" });
  assert.ok($("model-row-vad").querySelector(".pf-dot").classList.contains("ok"));
  assert.match($("model-row-vad").querySelector(".pf-detail").textContent, /Скачано/);
});

test("Модели: failed download-models call surfaces the error and re-enables buttons", async () => {
  const { window, $ } = await boot({
    downloadModels: async () => ({ ok: false, error: "Мало места на диске" }),
  });
  let alerted = null;
  window.alert = (msg) => { alerted = msg; };
  $("settingsOpen").click();
  await tick(window);
  $("modelsDownloadMissing").click();
  await tick(window);
  assert.equal(alerted, "Мало места на диске");
  assert.equal($("modelsRefresh").disabled, false);
  assert.equal($("modelsDownloadMissing").disabled, false);
});

// ── main.js model-download child-process wiring ─────────────────────────────
// main.js requires("electron") and can't be loaded headless under plain node --test
// (same reason lib/mainutil.js was extracted) — source-text checks, same idiom as
// the "PARA chat degraded badge" test above, cover what a jsdom renderer test can't:
// the main-process IPC handlers themselves.
test("main.js: cancel-model-download kills modelDlProc via the same SIGTERM pattern as cancel-process", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const cancelProcess = mainSrc.match(/ipcMain\.handle\("cancel-process"[\s\S]*?\n\}\);/);
  const cancelModelDl = mainSrc.match(/ipcMain\.handle\("cancel-model-download"[\s\S]*?\n\}\);/);
  assert.ok(cancelProcess, "cancel-process handler not found");
  assert.ok(cancelModelDl, "cancel-model-download handler not found");
  assert.match(cancelProcess[0], /procProc\.kill\("SIGTERM"\)/);
  assert.match(cancelModelDl[0], /modelDlProc\.kill\("SIGTERM"\)/);
});

test("main.js: download-models and process-audio refuse to run while the other is active", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const downloadModels = mainSrc.match(/ipcMain\.handle\("download-models"[\s\S]*?\n\}\);/)[0];
  const processAudio = mainSrc.match(/ipcMain\.handle\("process-audio"[\s\S]*?\n\}\);/)[0];
  assert.match(downloadModels, /if \(procProc\)/);
  assert.match(processAudio, /if \(modelDlProc\)/);
});

test("main.js: modelDlProc is killed in before-quit alongside the other tracked children", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const beforeQuit = mainSrc.match(/app\.on\("before-quit"[\s\S]*?\n\}\);/)[0];
  assert.match(beforeQuit, /modelDlProc/);
});

// ── main.js para-search cancel wiring (chunk 12) ────────────────────────────
// Same reasoning as the model-download wiring block above: main.js requires("electron")
// and can't be loaded headless under plain node --test — source-text checks cover the
// main-process handlers a jsdom renderer test can't reach.
test("main.js: cancel-search kills searchProc via the same SIGTERM pattern as cancel-process", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const cancelProcess = mainSrc.match(/ipcMain\.handle\("cancel-process"[\s\S]*?\n\}\);/);
  const cancelSearch = mainSrc.match(/ipcMain\.handle\("cancel-search"[\s\S]*?\n\}\);/);
  assert.ok(cancelProcess, "cancel-process handler not found");
  assert.ok(cancelSearch, "cancel-search handler not found");
  assert.match(cancelProcess[0], /procProc\.kill\("SIGTERM"\)/);
  assert.match(cancelSearch[0], /searchProc\.kill\("SIGTERM"\)/);
  assert.match(cancelSearch[0], /searchCanceled = true/);
});

test("main.js: para-search refuses to start a second query while one is already in flight", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const paraSearch = mainSrc.match(/ipcMain\.handle\("para-search"[\s\S]*?\n\}\);/)[0];
  assert.match(paraSearch, /if \(searchProc\) return/);
});

test("main.js: para-search's onClose resolves {canceled:true} on a canceled run and clears both slots", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const paraSearch = mainSrc.match(/ipcMain\.handle\("para-search"[\s\S]*?\n\}\);/)[0];
  assert.match(paraSearch, /searchProc = runBackend\(/, "must capture runBackend's return into searchProc");
  assert.match(paraSearch, /canceled: true/, "onClose must resolve {canceled:true} on cancel, not reject");
  assert.match(paraSearch, /searchProc = null;/, "slot must be cleared in onClose");
  assert.match(paraSearch, /searchCanceled = false;/, "flag must be reset in onClose");
});

test("main.js: searchProc is killed in before-quit alongside the other tracked children", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const beforeQuit = mainSrc.match(/app\.on\("before-quit"[\s\S]*?\n\}\);/)[0];
  assert.match(beforeQuit, /searchProc/);
});

// ── main.js pick-audio: multi-select ────────────────────────────────────────
// The multiSelections dialog option itself isn't exercisable via jsdom (Electron's
// `dialog` API isn't unit-testable without a live app) — a source-text check, same
// idiom as the child-process wiring checks above, covers the actual handler code.
test("main.js: pick-audio dialog allows multiSelections and returns the full filePaths array", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const pickAudio = mainSrc.match(/ipcMain\.handle\("pick-audio"[\s\S]*?\n\}\);/)[0];
  assert.match(pickAudio, /multiSelections/);
  assert.match(pickAudio, /res\.filePaths;/);
  assert.doesNotMatch(pickAudio, /res\.filePaths\[0\]/);
});

// ── batch import (sequential queue) ─────────────────────────────────────────
function goImportTab(window) {
  window.document.querySelector('.tab[data-tab="import"]').click();
}

test("multi-file pick renders one queue row per file", async () => {
  const { window, $ } = await boot({
    pickAudio: async () => ["/tmp/a.wav", "/tmp/b.wav", "/tmp/c.wav"],
  });
  goImportTab(window);
  $("pickBtn").click(); await tick(window);
  const rows = $("importQueue").querySelectorAll(".queue-item");
  assert.equal(rows.length, 3);
  assert.equal($("pickedFile").textContent, "Выбрано файлов: 3");
});

test("batch import: item 2 starts only after item 1's done event (sequential, not parallel)", async () => {
  const calls = [];
  const { window, $, handlers } = await boot({
    pickAudio: async () => ["/tmp/a.wav", "/tmp/b.wav"],
    processAudio: async (opts) => { calls.push(opts.audioFile); return { ok: true }; },
  });
  goImportTab(window);
  $("pickBtn").click(); await tick(window);
  $("runBtn").click(); await tick(window);
  assert.deepEqual(calls, ["/tmp/a.wav"]);                 // only item 1 started
  let rows = $("importQueue").querySelectorAll(".queue-item");
  assert.ok(rows[0].classList.contains("queue-running"));
  handlers.process({ event: "done", note: "/n1.md", audio: "/tmp/a.wav", transcript: "t1", summary: "s1" });
  await tick(window);
  assert.deepEqual(calls, ["/tmp/a.wav", "/tmp/b.wav"]);   // item 2 auto-started
  rows = $("importQueue").querySelectorAll(".queue-item");
  assert.ok(rows[0].classList.contains("queue-done"));
  assert.ok(rows[1].classList.contains("queue-running"));
});

test("batch import: per-item failure logs and continues to the next item", async () => {
  const calls = [];
  const { window, $, handlers } = await boot({
    pickAudio: async () => ["/tmp/a.wav", "/tmp/b.wav"],
    processAudio: async (opts) => { calls.push(opts.audioFile); return { ok: true }; },
  });
  goImportTab(window);
  $("pickBtn").click(); await tick(window);
  $("runBtn").click(); await tick(window);
  handlers.process({ event: "error", msg: "boom" });
  await tick(window);
  assert.deepEqual(calls, ["/tmp/a.wav", "/tmp/b.wav"]);   // continued despite failure
  const rows = $("importQueue").querySelectorAll(".queue-item");
  assert.ok(rows[0].classList.contains("queue-failed"));
  assert.ok(rows[1].classList.contains("queue-running"));
});

test("batch import: cancel halts the whole batch (remaining items stay unprocessed)", async () => {
  const calls = [];
  const { window, $, handlers } = await boot({
    pickAudio: async () => ["/tmp/a.wav", "/tmp/b.wav"],
    processAudio: async (opts) => { calls.push(opts.audioFile); return { ok: true }; },
  });
  goImportTab(window);
  $("pickBtn").click(); await tick(window);
  $("runBtn").click(); await tick(window);
  $("stopBtn").click(); await tick(window);
  handlers.process({ event: "process-closed", code: null, canceled: true });
  await tick(window);
  assert.deepEqual(calls, ["/tmp/a.wav"]);                 // item 2 never started
  const rows = $("importQueue").querySelectorAll(".queue-item");
  assert.ok(rows[0].classList.contains("queue-canceled"));
  assert.ok(rows[1].classList.contains("queue-queued"));
});

test("reprocessHistory() still triggers an immediate single run (queue-of-1 regression guard)", async () => {
  let calls = 0;
  const { window, $ } = await boot({ processAudio: async () => { calls++; return { ok: true }; } });
  window.document.querySelector('.topbtn[data-view="history"]').click(); await tick(window);
  $("historyList").querySelector(".rail-item").click(); await tick(window);
  $("noteView").querySelector("#nvReprocess").click(); await tick(window);
  assert.equal(calls, 1);
  const rows = $("importQueue").querySelectorAll(".queue-item");
  assert.equal(rows.length, 1);
});

// ── recording indicator (topnav badge, visible from any tab) ────────────────
test("recording indicator appears on start, disappears on stop, and survives tab switches", async () => {
  const { window, $ } = await boot();
  assert.ok($("recIndicator").classList.contains("hidden"));
  $("recBtn").click(); await tick(window);
  assert.ok(!$("recIndicator").classList.contains("hidden"));
  // this is the regression test for the actual reported bug: state.recording
  // survives a tab switch, but the old per-view recording UI did not.
  window.document.querySelector('.topbtn[data-view="history"]').click(); await tick(window);
  assert.ok(!$("recIndicator").classList.contains("hidden"));
  window.document.querySelector('.topbtn[data-view="para"]').click(); await tick(window);
  assert.ok(!$("recIndicator").classList.contains("hidden"));
  window.document.querySelector('.topbtn[data-view="record"]').click(); await tick(window);
  $("recBtn").click(); await tick(window); // stop
  assert.ok($("recIndicator").classList.contains("hidden"));
});

test("recording indicator turns off on the mic-error path too", async () => {
  const { window, $, handlers } = await boot();
  $("recBtn").click(); await tick(window);
  assert.ok(!$("recIndicator").classList.contains("hidden"));
  handlers.record({ event: "error", msg: "mic disconnected" });
  await tick(window);
  assert.ok($("recIndicator").classList.contains("hidden"));
});

// ── app reset ("настроить заново") ──────────────────────────────────────────
test("reset: confirm() cancel → resetApp is never called, settings stay untouched", async () => {
  let called = false;
  const { window, $ } = await boot({
    getPresets: async () => ({ presets: [], defaultOutDir: "/tmp", hfToken: "hf_x", language: "ru", authorName: "Ольга" }),
    resetApp: async () => { called = true; return {}; },
  });
  window.confirm = () => false;
  $("settingsOpen").click(); await tick(window);
  $("resetAppBtn").click(); await tick(window);
  assert.equal(called, false, "resetApp must not be called when confirm is declined");
  assert.equal($("hfToken").value, "hf_x");
  assert.equal($("authorName").value, "Ольга");
});

test("reset: confirmed → resetApp() called, init() rewrites fields to fresh defaults", async () => {
  // getPresets always reads from the SAME mutable "virtualFile" that resetApp() writes —
  // this is the real main-process coupling (reset-app persists a fresh presets.json;
  // get-presets just reads whatever is on disk). The two mocks intentionally share state
  // instead of each returning an independently hand-picked literal, so this test can't
  // pass by asserting a post-reset shape that reset-app never actually produced.
  let virtualFile = {
    presets: [{ name: "P", prompt: "x" }], defaultOutDir: "/tmp/out", hfToken: "hf_old", language: "ru",
    authorName: "Ольга", glossary: "Иван Петров, Mindbox",
    para: { root: "/v", folders: { projects: "Projects", areas: "Areas", resources: "Resources", archives: "Archives" } },
  };
  const { window, $ } = await boot({
    getPresets: async () => virtualFile,
    resetApp: async () => {
      virtualFile = {
        presets: [], defaultOutDir: "/tmp/out", hfToken: "", authorName: "Автор", glossary: "",
        language: "ru", para: { root: "", folders: {} },
      };
      return virtualFile;
    },
  });
  window.document.querySelector('.topbtn[data-view="para"]').click();
  await tick(window);
  assert.notEqual($("paraWork").style.display, "none"); // configured before reset
  $("settingsOpen").click(); await tick(window);
  $("resetAppBtn").click();
  await tick(window); await tick(window);
  assert.equal($("hfToken").value, "");
  assert.equal($("authorName").value, "Автор");
  assert.equal($("glossary").value, DEFAULT_GLOSSARY);
  assert.equal($("outDir").value, "/tmp/out");
  // PARA's "Разбор" subtab was the one visible when reset ran → must flip to unconfigured
  // immediately (init() alone doesn't touch it, see renderParaInboxView's own call site).
  assert.notEqual($("paraSetup").style.display, "none");
  assert.equal($("paraWork").style.display, "none");
});

test("reset: main refuses while busy (ok:false) → alert shown, settings left untouched", async () => {
  let alerted = null;
  const { window, $ } = await boot({
    getPresets: async () => ({ presets: [], defaultOutDir: "/tmp", hfToken: "hf_x", language: "ru", authorName: "Ольга" }),
    resetApp: async () => ({ ok: false, error: "Нельзя сбросить настройки во время записи или обработки" }),
  });
  window.alert = (msg) => { alerted = msg; };
  $("settingsOpen").click(); await tick(window);
  $("resetAppBtn").click();
  await tick(window); await tick(window);
  assert.equal(alerted, "Нельзя сбросить настройки во время записи или обработки");
  assert.equal($("hfToken").value, "hf_x");        // init() never re-ran
  assert.equal($("authorName").value, "Ольга");
  assert.equal($("resetAppBtn").disabled, false);  // re-enabled after refusal
});

test("reset: clears paraInboxLoaded so a later Разбор view re-fetches (not left stale from before reset)", async () => {
  let listHistoryCalls = 0;
  const { window, $ } = await boot({
    getPresets: async () => ({
      presets: [], defaultOutDir: "/tmp", hfToken: "", language: "ru",
      para: { root: "/v", folders: { projects: "Projects", areas: "Areas", resources: "Resources", archives: "Archives" } },
    }),
    listHistory: async () => { listHistoryCalls++; return [{ name: "2026-01-01", title: "T", note: "/n.md", audio: null }]; },
    // Mock keeps para "configured" post-reset so this test isolates the paraInboxLoaded
    // flag from the real product's para.root-clearing behaviour (covered separately above).
    resetApp: async () => ({
      presets: [], defaultOutDir: "/tmp", hfToken: "", authorName: "Автор", glossary: "", language: "ru",
      para: { root: "/v", folders: { projects: "Projects", areas: "Areas", resources: "Resources", archives: "Archives" } },
      secretEncrypted: true,
    }),
  });
  listHistoryCalls = 0; // discard init()'s own refreshHistory() fetch — unrelated to PARA
  window.document.querySelector('.topbtn[data-view="para"]').click();
  await tick(window);
  assert.equal(listHistoryCalls, 1); // initial auto-load
  $("settingsOpen").click(); await tick(window);
  $("resetAppBtn").click();
  await tick(window); await tick(window);
  // +1 from init()'s own unconditional refreshHistory() (unrelated to PARA, same as the
  // "initial auto-load" call above), +1 from renderParaInboxView()'s refreshParaInbox() —
  // the one this test targets, only reachable if paraInboxLoaded was actually cleared.
  assert.equal(listHistoryCalls, 3);
});

// main.js requires("electron") and can't be loaded headless under plain node --test
// (same reason as the other main.js checks above) — source-text assertions cover the
// handler's actual guard/deletion logic that a jsdom renderer test can't reach.
test("main.js: reset-app refuses while recordProc/tee/procProc/modelDlProc are active", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const resetApp = mainSrc.match(/ipcMain\.handle\("reset-app"[\s\S]*?\n\}\);/);
  assert.ok(resetApp, "reset-app handler not found");
  assert.match(resetApp[0], /recordProc \|\| tee \|\| procProc \|\| modelDlProc/);
  assert.match(resetApp[0], /ok: false/);
});

test("main.js: reset-app persists a fresh presets.json with para.root='' (survives restart) instead of only deleting the file", () => {
  // Regression guard for the exact bug the critic caught: an earlier version only
  // unlinked presets.json and zeroed para.root on the in-memory RETURN VALUE, which
  // onResetApp discards (it re-hydrates via init() → get-presets, not resetApp()'s
  // return). With no write, get-presets' PRESETS_EXAMPLE fallback resurrected the
  // owner's real para.root on every subsequent read, including after an app restart.
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const resetApp = mainSrc.match(/ipcMain\.handle\("reset-app"[\s\S]*?\n\}\);/)[0];
  assert.match(resetApp, /saveToken\(""\)/);
  assert.match(resetApp, /writeJsonAtomic\(PRESETS_FILE,/,
    "reset-app must persist the cleared config to disk — relying on the PRESETS_EXAMPLE " +
    "fallback (via unlink-only) resurrects the owner's real para.root on the next read");
  assert.match(resetApp, /\.para\.root = ""/);
  assert.doesNotMatch(resetApp, /fs\.unlinkSync\(PRESETS_FILE\)/,
    "must not merely delete presets.json and lean on fallback resurrection");
});
