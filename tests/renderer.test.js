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
    preflight: async () => ({ lmStudio: false, mic: "granted", screen: "unknown", ffmpeg: true, whisperCached: true, hfToken: false, backendInstalled: true }),
    // Ready by default so the setup gate stays hidden and doesn't interfere with
    // the other ~230 tests below — gate-specific tests override this.
    appReadiness: async () => ({ backend: true, whisper: true, vad: true, models: true }),
    requestMicAccess: async () => true,
    openPrivacySettings: async () => {},
    openExternal: async () => {},
    renameSpeakers: async () => ({ ok: true }),
    listDevices: async () => [{ index: 0, name: "MacBook Mic", default: true }],
    getPresets: async () => ({ presets: [{ name: "P", prompt: "x" }], defaultOutDir: "/tmp/out", hfToken: "", language: "ru" }),
    savePresets: async () => true,
    resetApp: async () => ({
      presets: [], defaultOutDir: "/tmp/out", hfToken: "", authorName: "Автор", glossary: "",
      language: "ru", para: { root: "", folders: {} }, secretEncrypted: true,
    }),
    listHistory: async () => [{ name: "2026-01-01", base_stamp: "2026-01-01", title: "Синк", note: "/o/meeting-x.md", audio: "/o/meeting-x.wav" }],
    readNote: async () => '---\ntitle: "T"\n---\n\n## Резюме\n\nтекст\n\n**[Спикер 1]**: привет',
    deleteHistoryNote: async () => ({ ok: true }),
    deleteHistoryRecording: async () => ({ ok: true }),
    listTrash: async () => ({ items: [], totalBytes: 0 }),
    restoreTrashEntry: async () => ({ ok: true }),
    deleteTrashEntry: async () => ({ ok: true }),
    emptyTrash: async () => ({ ok: true }),
    paraCreateVault: async () => ({ ok: true }),
    paraClassify: async () => ({ category: "projects", project: "P" }),
    classifyGlossaryTerms: async () => ({ categories: {} }),
    paraFile: async () => ({ ok: true }),
    paraTree: async () => [],
    pickAudio: async () => null,
    pickOutDir: async () => null,
    startRecording: async () => ({ ok: true }),
    stopRecording: async () => ({ ok: true }),
    listPendingRecordings: async () => [],
    removePendingRecording: async () => ({ ok: true }),
    processAudio: async () => ({ ok: true }),
    cancelProcess: async () => ({ ok: true }),
    listLmModels: async () => ([]),
    getModels: async () => ([
      { id: "whisper", label: "MLX Whisper (large-v3-turbo)", size_mb: 1500, needs_token: false, cached: true, locked: false },
      { id: "vad", label: "Silero VAD", size_mb: 35, needs_token: false, cached: false, locked: false },
      { id: "diarization", label: "Диаризация (pyannote)", size_mb: 31, needs_token: true, cached: false, locked: true },
    ]),
    downloadModels: async () => ({ ok: true }),
    redownloadModel: async () => ({ ok: true }),
    cancelModelDownload: async () => ({ ok: true }),
    backendStatus: async () => ({ installed: true, pythonVersion: "3.11.15", stale: false }),
    installBackend: async () => ({ ok: true }),
    cancelInstallBackend: async () => ({ ok: true }),
    uninstallBackend: async () => ({ ok: true }),
    checkAppUpdate: async () => ({
      ok: true, current: "1.0.0", latest: "1.0.0", hasUpdate: false, assetUrl: null, releaseNotes: null, isPackaged: true,
    }),
    downloadAndInstallUpdate: async () => ({ ok: true }),
    cancelAppUpdate: async () => ({ ok: true }),
    // extract retired with the accumulator scheme — filing must never call it again.
    // Throwing sentinel (not a removal): any resurrected call site fails loudly here.
    paraExtract: async () => { throw new Error("paraExtract retired — filing must not call it"); },
    paraReindex: async () => ({ indexed: 0, skipped: 0, removed: 0 }),
    paraSearch: async (_root, _messages) => ({ found: false, answer: "Не нашёл по этому вопросу записей в заметках.", citations: [] }),
    cancelSearch: async () => ({ ok: true }),
    reveal: () => {},
    notifyRecordingState: () => {},
    onRecordEvent: (cb) => { handlers.record = cb; },
    onProcessEvent: (cb) => { handlers.process = cb; },
    onParaReindexEvent: (cb) => { handlers.reindex = cb; },
    onModelDownloadEvent: (cb) => { handlers.modelDownload = cb; },
    onInstallBackendEvent: (cb) => { handlers.installBackend = cb; },
    onAppUpdateEvent: (cb) => { handlers.appUpdate = cb; },
    onTrayRecordToggle: (cb) => { handlers.trayRecordToggle = cb; },
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
  handlers.record({ event: "recorded", id: "r1", name: "Запись 1", file: "/tmp/mixed.wav", mic: "/tmp/m.wav", system: null, tracks: 1 });
  $("historyList").querySelector(".pending-play-btn").click(); await tick(window); // builds the stage chips
  handlers.process({ event: "stage_end", stage: "transcribe", status: "ok", msg: "5 сегментов" });
  handlers.process({ event: "stage_end", stage: "llm", status: "fail", msg: "LM Studio" });
  handlers.process({ event: "stage_end", stage: "diarize", status: "skip", msg: "выключено" });
  assert.ok($("stage-transcribe").classList.contains("done"));
  assert.ok($("stage-llm").classList.contains("failed"));
  assert.ok($("stage-diarize").classList.contains("skip"));
});

test("stage_end: cached (msg 'из кеша') marks done + cached", async () => {
  const { window, $, handlers } = await boot();
  handlers.record({ event: "recorded", id: "r1", name: "Запись 1", file: "/tmp/mixed.wav", mic: "/tmp/m.wav", system: null, tracks: 1 });
  $("historyList").querySelector(".pending-play-btn").click(); await tick(window);
  handlers.process({ event: "stage_end", stage: "transcribe", status: "ok", msg: "12 сегм. (из кеша)" });
  assert.ok($("stage-transcribe").classList.contains("done"));
  assert.ok($("stage-transcribe").classList.contains("cached"));
});

// ── correct (glossary term correction) stage chip ────────────────────────────
test("correct stage renders the 'Коррекция терминов' label and colours by status", async () => {
  const { window, $, handlers } = await boot();
  handlers.record({ event: "recorded", id: "r1", name: "Запись 1", file: "/tmp/mixed.wav", mic: "/tmp/m.wav", system: null, tracks: 1 });
  $("historyList").querySelector(".pending-play-btn").click(); await tick(window); // builds the stage chips
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
// Retry/Fresh are exclusively an import-mode affordance (state.hasRun/currentAudio()
// only resolve to something in import mode — record-mode processing always goes
// through an explicit pending-queue item, which has no single "current audio" to
// retry/fresh against; see currentAudio()/startProcessing).
test("processing shows Stop, hides Run; done shows Retry/Fresh (import mode)", async () => {
  const { window, $, handlers } = await boot({ pickAudio: async () => ["/tmp/a.wav"] });
  goImportTab(window);
  $("pickBtn").click(); await tick(window);
  $("runBtn").click(); await tick(window);
  assert.equal($("stopBtn").style.display, "");      // Stop visible while running
  assert.equal($("runBtn").style.display, "none");   // Run hidden
  handlers.process({ event: "done", note: "/n.md", audio: "/tmp/a.wav", transcript: "t", summary: "s" });
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

  handlers.record({ event: "recorded", id: "r1", name: "Запись 1", file: "/tmp/mixed.wav", mic: "/tmp/mic.wav", system: "/tmp/system.wav", tracks: 2 });
  $("historyList").querySelector(".pending-play-btn").click(); await tick(window);
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
  handlers.record({ event: "recorded", id: "r1", name: "Запись 1", file: "/tmp/mixed.wav", mic: "/tmp/mic.wav", system: null, tracks: 1 });
  $("historyList").querySelector(".pending-play-btn").click(); await tick(window);
  handlers.process({ event: "stage", stage: "transcribe", msg: "Транскрибация" });
  handlers.process({ event: "process-closed", code: null, canceled: true });
  await tick(window);
  assert.ok($("logs").textContent.includes("Остановлено"));
  assert.ok($("stage-transcribe").classList.contains("skip"));
  assert.equal($("stopBtn").style.display, "none");
});

test("processAudio busy → error logged, UI not stuck on Stop", async () => {
  const { window, $, handlers } = await boot({ processAudio: async () => ({ ok: false, error: "Обработка уже идёт" }) });
  handlers.record({ event: "recorded", id: "r1", name: "Запись 1", file: "/tmp/mixed.wav", mic: "/tmp/mic.wav", system: null, tracks: 1 });
  $("historyList").querySelector(".pending-play-btn").click(); await tick(window);
  assert.ok($("logs").textContent.includes("Обработка уже идёт"));
  assert.equal($("stopBtn").style.display, "none"); // restored, not stuck
});

// ── history rendering ─────────────────────────────────────────────────────
// Note: the История rail also renders the just-recorded item as an always-visible pending
// row (see renderRail) — this test's r1 pending row and the mocked real note both land in
// #historyList now, so ".rail-item" alone is no longer disjoint between "pending" and
// "history"; target the real note row specifically via :not(.pending).
test("history reprocess (from note view) is blocked while a run is in flight", async () => {
  let calls = 0;
  const { window, $, handlers } = await boot({ processAudio: async () => { calls++; return { ok: true }; } });
  handlers.record({ event: "recorded", id: "r1", name: "Запись 1", file: "/tmp/mixed.wav", mic: "/tmp/m.wav", system: null, tracks: 1 });
  $("historyList").querySelector(".pending-play-btn").click(); await tick(window); // processing=true, calls=1
  assert.equal(calls, 1);
  window.document.querySelector('.topbtn[data-view="history"]').click(); await tick(window);
  $("historyList").querySelector(".rail-item:not(.pending)").click(); await tick(window);
  $("noteView").querySelector("#nvReprocess").click(); await tick(window);
  assert.equal(calls, 1);                             // guard blocked a second run
});

// ── reprocess audio resolution (Task 1: always resolve audio, never a silent no-op) ──
// backend.py's out_dir-only pairing (_reconcile/_find_audio) leaves item.audio null for
// any note whose parent dir isn't out_dir (e.g. PARA-archived) — the renderer must still
// recover the audio from the note's own ![[...]] embed rather than silently doing nothing.
test("nvReprocess resolves audio from the note's ![[...]] embed when item.audio is null (e.g. a PARA-archived note)", async () => {
  let sentAudioFile = null;
  const { window, $ } = await boot({
    listHistory: async () => [{
      name: "2026-01-01", title: "Архивная", note: "/vault/Projects/P1/meeting-2026-01-01-100000.md", audio: null,
    }],
    readNote: async () =>
      '---\ntitle: "Архивная"\n---\n\n## Сводка\n\nтекст\n\n## 🎵 Аудио запись\n\n![[meeting-2026-01-01-100000.wav]]\n',
    processAudio: async (opts) => { sentAudioFile = opts.audioFile; return { ok: true }; },
  });
  window.document.querySelector('.topbtn[data-view="history"]').click(); await tick(window);
  $("historyList").querySelector(".rail-item:not(.pending)").click(); await tick(window);
  const btn = $("noteView").querySelector("#nvReprocess");
  assert.equal(btn.disabled, false, "must not be disabled — the embed still resolves the audio");
  btn.click(); await tick(window);
  $("noteView").querySelector("#reprocessConfirm").click(); await tick(window);
  assert.equal(sentAudioFile, "/vault/Projects/P1/meeting-2026-01-01-100000.wav",
    "resolved from the note's own directory + the embedded filename, not item.audio (which was null)");
});

test("nvReprocess is disabled with a visible reason when audio is genuinely unrecoverable (no item.audio, no embed in the note)", async () => {
  const { window, $ } = await boot({
    listHistory: async () => [{ name: "2026-01-01", title: "Без аудио", note: "/vault/meeting-x.md", audio: null }],
    readNote: async () => '---\ntitle: "Без аудио"\n---\n\n## Сводка\n\nтекст без ссылки на аудио',
  });
  window.document.querySelector('.topbtn[data-view="history"]').click(); await tick(window);
  $("historyList").querySelector(".rail-item:not(.pending)").click(); await tick(window);
  const btn = $("noteView").querySelector("#nvReprocess");
  assert.equal(btn.disabled, true, "never a silent no-op — the button itself must show it's unavailable");
  assert.match(btn.title, /Аудио не найдено/);
});

// ── reprocessHistory must hide #processLatestBtn too (design-layout fix) ─────
// #processLatestBtn used to live inside #pane-record, so reprocessHistory() hiding that
// pane hid it "for free". Since the record-action-bar relocation it's a sibling of both
// tabpanes — left unfixed, it would stay visible (and, once the run ends and
// refreshProcessLatestBtn() re-enables it, clickable) even though state.mode is now
// "import" and the rest of the UI shows the import pane; a click would then process the
// latest RECORDING, not this reprocess.
test("reprocessHistory hides #processLatestBtn (not just #pane-record) and it stays hidden through and after the run", async () => {
  const { window, $, handlers } = await boot({
    listHistory: async () => [{ name: "2026-01-01", title: "Синк", note: "/o/a.md", audio: "/o/a.wav" }],
  });
  window.document.querySelector('.topbtn[data-view="history"]').click(); await tick(window);
  $("historyList").querySelector(".rail-item:not(.pending)").click(); await tick(window);
  assert.equal($("processLatestBtn").classList.contains("hidden"), false, "record mode by default — visible before any reprocess");
  $("noteView").querySelector("#nvReprocess").click(); await tick(window);
  $("noteView").querySelector("#reprocessConfirm").click(); await tick(window);
  assert.equal($("processLatestBtn").classList.contains("hidden"), true,
    "reprocessHistory() flips state.mode to import — the bar's record-mode button must hide");
  // refreshProcessLatestBtn() (called on the run's terminal event) only ever toggles
  // .disabled, never .hidden — the run finishing must not un-hide it.
  handlers.process({ event: "done", note: "/o/a.md", audio: "/o/a.wav", transcript: "t", summary: "s" });
  await tick(window);
  assert.equal($("processLatestBtn").classList.contains("hidden"), true, "still hidden after the reprocess run ends");
  // "back to Запись" in the reported bug means the top-level Запись VIEW nav button, not
  // the record/import tab inside the Источник card — switchView() never touches state.mode.
  window.document.querySelector('.topbtn[data-view="record"]').click(); await tick(window);
  assert.equal($("processLatestBtn").classList.contains("hidden"), true,
    "still hidden after navigating back to the Запись view — only an explicit record-tab click restores record mode");
});

// ── jump-to-recording button in note headers (Task 3) ────────────────────────
test("nvGoRecord (История note header) switches to the Запись view", async () => {
  const { window, $ } = await boot();
  window.document.querySelector('.topbtn[data-view="history"]').click(); await tick(window);
  $("historyList").querySelector(".rail-item:not(.pending)").click(); await tick(window);
  $("noteView").querySelector("#nvGoRecord").click(); await tick(window);
  assert.ok(!$("view-record").classList.contains("hidden"));
  assert.ok($("view-history").classList.contains("hidden"));
});

// ── copy note path (История note view) ───────────────────────────────────────
test("nvCopyPath: copies the note's absolute path and shows brief feedback", async () => {
  const { window, $ } = await boot({
    listHistory: async () => [{ name: "2026-01-01", title: "Синк", note: "/Users/x/vault/meeting-x.md", audio: null }],
  });
  const copied = [];
  window.navigator.clipboard.writeText = async (text) => { copied.push(text); };
  window.document.querySelector('.topbtn[data-view="history"]').click(); await tick(window);
  $("historyList").querySelector(".rail-item:not(.pending)").click(); await tick(window);
  const btn = $("noteView").querySelector("#nvCopyPath");
  assert.equal(btn.textContent, "📋 Путь");
  btn.click(); await tick(window);
  assert.equal(copied[0], "/Users/x/vault/meeting-x.md");
  assert.equal(btn.textContent, "✓ Скопировано");
  await new Promise((r) => window.setTimeout(r, 1600));
  assert.equal(btn.textContent, "📋 Путь");             // reverts after the feedback window
});

test("pending row in the История rail stays visible under an active filter that would exclude it", async () => {
  const { window, $, handlers } = await boot({
    listHistory: async () => [{ name: "2026-01-01", title: "Синк", language: "ru", note: "/a.md", audio: null }],
  });
  handlers.record({ event: "recorded", id: "r1", name: "Запись 1", file: "/tmp/mixed.wav", mic: "/tmp/m.wav", system: null, tracks: 1 });
  window.document.querySelector('.topbtn[data-view="history"]').click(); await tick(window);
  // a language filter that matches nothing would normally empty the rail of notes —
  // the pending row must stay regardless (pending items have no language yet).
  $("historyLang").value = "en";
  $("historyLang").dispatchEvent(new window.Event("change"));
  assert.equal($("historyList").querySelectorAll(".rail-item.pending").length, 1);
});

test("clicking a pending row's body in the История rail does not open a note (no readNote call)", async () => {
  let readNoteCalls = 0;
  const { window, $, handlers } = await boot({ readNote: async () => { readNoteCalls++; return "x"; } });
  handlers.record({ event: "recorded", id: "r1", name: "Запись 1", file: "/tmp/mixed.wav", mic: "/tmp/m.wav", system: null, tracks: 1 });
  window.document.querySelector('.topbtn[data-view="history"]').click(); await tick(window);
  const before = readNoteCalls; // auto-open may already have read the boot-mock's real note on entry
  $("historyList").querySelector(".rail-item.pending").click(); await tick(window);
  assert.equal(readNoteCalls, before);
});

test("▶ on the rail's inline pending row starts processing (reuses processPendingRecording)", async () => {
  let calls = 0;
  const { window, $, handlers } = await boot({ processAudio: async (opts) => { calls++; return { ok: true }; } });
  handlers.record({ event: "recorded", id: "r1", name: "Запись 1", file: "/tmp/mixed.wav", mic: "/tmp/m.wav", system: null, tracks: 1 });
  window.document.querySelector('.topbtn[data-view="history"]').click(); await tick(window);
  $("historyList").querySelector(".rail-item.pending .pending-play-btn").click(); await tick(window);
  assert.equal(calls, 1);
});

// ── Запись-tab «Обработать» quick action (#processLatestBtn) ────────────────
// Always targets the LATEST finished recording (last-appended entry in
// state.pendingRecordings) directly from the record view — distinct from the
// История rail's per-row ▶ / "Обработать все". Gated the same way as
// processPendingRecording: blocked while state.recording or state.processing.
test("#processLatestBtn: no pending recordings → disabled (refreshProcessLatestBtn actively enforces it, not just the HTML default)", async () => {
  const { window, $ } = await boot();
  $("processLatestBtn").disabled = false; // force-enable first, so the assertion below is load-bearing
  window.refreshProcessLatestBtn();
  assert.equal($("processLatestBtn").disabled, true);
});

test("#processLatestBtn: after a 'recorded' event with no active recording, enabled and processes the latest pending item", async () => {
  const opts = [];
  const { window, $, handlers } = await boot({
    processAudio: async (o) => { opts.push(o); return { ok: true }; },
  });
  handlers.record({ event: "recorded", id: "r1", name: "Запись 1", file: "/tmp/mixed1.wav", mic: "/tmp/m1.wav", system: null, tracks: 1 });
  assert.equal($("processLatestBtn").disabled, false);
  $("processLatestBtn").click(); await tick(window);
  assert.equal(opts.length, 1);
  assert.equal(opts[0].audioFile, "/tmp/mixed1.wav");
});

test("#processLatestBtn: disabled while a recording is active, even with a pending item queued", async () => {
  const { window, $, handlers } = await boot();
  handlers.record({ event: "recorded", id: "r1", name: "Запись 1", file: "/tmp/mixed1.wav", mic: "/tmp/m1.wav", system: null, tracks: 1 });
  assert.equal($("processLatestBtn").disabled, false);
  $("recBtn").click(); await tick(window); // start a new recording
  assert.equal($("processLatestBtn").disabled, true);
});

test("#processLatestBtn: record→stop→record blocks during the 2nd recording AND its mixing window (Fix #1 race), then targets the 2nd (latest) recording once it lands", async () => {
  const opts = [];
  const { window, $, handlers } = await boot({
    processAudio: async (o) => { opts.push(o); return { ok: true }; },
  });
  // 1st recording finishes and lands in the pending queue, left unprocessed.
  handlers.record({ event: "recorded", id: "r1", name: "Запись 1", file: "/tmp/mixed1.wav", mic: "/tmp/m1.wav", system: null, tracks: 1 });
  assert.equal($("processLatestBtn").disabled, false, "enabled after the 1st recording finishes");

  // Start the 2nd recording — must block again even though r1 is still pending.
  $("recBtn").click(); await tick(window);
  assert.equal($("processLatestBtn").disabled, true, "blocked while the 2nd recording is active");

  // Stop the 2nd recording — its "recorded" event has NOT landed yet (still mixing).
  // This is the exact window Fix #1 (awaitingRecorded) closes: without it,
  // latestPendingRecording() would still return r1 (the only item so far) and the
  // button would wrongly enable, targeting the WRONG (stale) recording.
  $("recBtn").click(); await tick(window);
  assert.equal($("processLatestBtn").disabled, true,
    "must stay disabled during the mixing window — must NOT target the older r1");

  // Now the 2nd recording's mix lands, appended after r1 as the new latest.
  handlers.record({ event: "recorded", id: "r2", name: "Запись 2", file: "/tmp/mixed2.wav", mic: "/tmp/m2.wav", system: null, tracks: 1 });
  assert.equal($("processLatestBtn").disabled, false, "enabled once the 2nd recording actually lands");

  $("processLatestBtn").click(); await tick(window);
  assert.equal(opts.length, 1);
  assert.equal(opts[0].audioFile, "/tmp/mixed2.wav", "targets the latest (2nd) recording, never the older r1");
});

test("#processLatestBtn: disabled while state.processing is true, even when the run is processing a NON-latest item (Fix #2 — isolates the !state.processing clause from item.status)", async () => {
  const { window, $, handlers } = await boot({
    processAudio: () => new Promise(() => {}), // never resolves — keep processing in flight
  });
  // Two pending items: r1 (older) and r2 (latest), both left "pending".
  handlers.record({ event: "recorded", id: "r1", name: "Запись 1", file: "/tmp/mixed1.wav", mic: "/tmp/m1.wav", system: null, tracks: 1 });
  handlers.record({ event: "recorded", id: "r2", name: "Запись 2", file: "/tmp/mixed2.wav", mic: "/tmp/m2.wav", system: null, tracks: 1 });
  window.document.querySelector('.topbtn[data-view="history"]').click(); await tick(window);
  // Process the OLDER row (r1) via its own per-row ▶ (История rail) — r2, the
  // "latest" item processLatestBtn targets, is left untouched at status "pending".
  $("historyList").querySelectorAll(".rail-item.pending")[0].querySelector(".pending-play-btn").click();
  await tick(window);
  assert.equal($("processLatestBtn").disabled, true,
    "state.processing alone must disable the button, even though the latest item (r2) is still 'pending'");
});

test("import-mode origin: a multi-file queue reports 'batch', a single pick reports 'file'", async () => {
  const opts = [];
  const { window, $ } = await boot({
    pickAudio: async () => ["/tmp/a.wav", "/tmp/b.wav"],
    processAudio: async (o) => { opts.push(o); return { ok: true }; },
  });
  goImportTab(window);
  $("pickBtn").click(); await tick(window);
  $("runBtn").click(); await tick(window);
  assert.equal(opts[0].origin, "batch");

  const single = [];
  const { window: w2, $: $2 } = await boot({
    pickAudio: async () => ["/tmp/a.wav"],
    processAudio: async (o) => { single.push(o); return { ok: true }; },
  });
  goImportTab(w2);
  $2("pickBtn").click(); await tick(w2);
  $2("runBtn").click(); await tick(w2);
  assert.equal(single[0].origin, "file");
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
  handlers.record({ event: "recorded", id: "r1", name: "Запись 1", file: "/tmp/mixed.wav", mic: "/tmp/m.wav", system: null, tracks: 1 });
  $("historyList").querySelector(".pending-play-btn").click(); await tick(window);
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
  handlers.record({ event: "recorded", id: "r1", name: "Запись 1", file: "/tmp/mixed.wav", mic: "/tmp/m.wav", system: null, tracks: 1 });
  $("historyList").querySelector(".pending-play-btn").click(); await tick(window);
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
  handlers.record({ event: "recorded", id: "r1", name: "Запись 1", file: "/tmp/mixed.wav", mic: "/tmp/m.wav", system: null, tracks: 1 });
  $("historyList").querySelector(".pending-play-btn").click(); await tick(window);
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
  handlers.record({ event: "recorded", id: "r1", name: "Запись 1", file: "/tmp/mixed.wav", mic: "/tmp/m.wav", system: null, tracks: 1 });
  $("historyList").querySelector(".pending-play-btn").click(); await tick(window);
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
    preflight: async () => ({ lmStudio: true, mic: "granted", screen: "denied", ffmpeg: true, whisperCached: false, hfToken: false, embedModel: true, backendInstalled: true }),
  });
  // refreshPreflight() is only triggered by openSettings() or the refresh button, not by init()
  $("settingsOpen").click(); await tick(window);
  const rows = $("preflightList").querySelectorAll(".pf-row");
  assert.equal(rows.length, 8);
  assert.equal($("preflightList").querySelectorAll(".pf-dot.ok").length, 5); // backendInstalled, lmStudio, mic, ffmpeg, embedModel
});

test("preflight: granted mic/screen rows show no action button", async () => {
  const { window, $ } = await boot({
    preflight: async () => ({ lmStudio: true, mic: "granted", screen: "granted", ffmpeg: true, whisperCached: true, hfToken: true, embedModel: true, backendInstalled: true }),
  });
  $("settingsOpen").click(); await tick(window);
  const rows = $("preflightList").querySelectorAll(".pf-row");
  assert.equal(rows[2].querySelector(".pf-retry"), null, "granted mic row must not show a button");
  assert.equal(rows[3].querySelector(".pf-retry"), null, "granted screen row must not show a button");
});

test("preflight: not-determined mic shows «Разрешить», wired to requestMicAccess + re-checks status", async () => {
  let micCalls = 0;
  let preflightCalls = 0;
  const { window, $ } = await boot({
    preflight: async () => {
      preflightCalls++;
      return { lmStudio: true, mic: micCalls ? "granted" : "not-determined", screen: "granted", ffmpeg: true, whisperCached: true, hfToken: true, embedModel: true, backendInstalled: true };
    },
    requestMicAccess: async () => { micCalls++; return true; },
  });
  $("settingsOpen").click(); await tick(window);
  const beforePf = preflightCalls;
  const btn = $("preflightList").querySelectorAll(".pf-row")[2].querySelector(".pf-retry");
  assert.equal(btn.textContent, "Разрешить");
  btn.click(); await tick(window);
  assert.equal(micCalls, 1, "requestMicAccess must be called");
  assert.ok(preflightCalls > beforePf, "preflight must be re-checked after the prompt so a granted mic turns the row green");
  assert.equal($("preflightList").querySelectorAll(".pf-row")[2].querySelector(".pf-retry"), null, "now-granted mic row should drop the button");
});

test("preflight: denied mic shows «Открыть настройки», wired to openPrivacySettings(\"microphone\")", async () => {
  let opened = null;
  const { window, $ } = await boot({
    preflight: async () => ({ lmStudio: true, mic: "denied", screen: "granted", ffmpeg: true, whisperCached: true, hfToken: true, embedModel: true, backendInstalled: true }),
    openPrivacySettings: async (target) => { opened = target; },
  });
  $("settingsOpen").click(); await tick(window);
  const btn = $("preflightList").querySelectorAll(".pf-row")[2].querySelector(".pf-retry");
  assert.equal(btn.textContent, "Открыть настройки");
  btn.click(); await tick(window);
  assert.equal(opened, "microphone");
});

test("preflight: ungranted system audio shows «Открыть настройки», wired to openPrivacySettings(\"screen\")", async () => {
  let opened = null;
  const { window, $ } = await boot({
    preflight: async () => ({ lmStudio: true, mic: "granted", screen: "not-determined", ffmpeg: true, whisperCached: true, hfToken: true, embedModel: true, backendInstalled: true }),
    openPrivacySettings: async (target) => { opened = target; },
  });
  $("settingsOpen").click(); await tick(window);
  const btn = $("preflightList").querySelectorAll(".pf-row")[3].querySelector(".pf-retry");
  assert.equal(btn.textContent, "Открыть настройки");
  btn.click(); await tick(window);
  assert.equal(opened, "screen");
});

// ── system audio: honest three-state readiness (grey when unconfirmed/denied,
// never the alarming red a real failure would show — AudioTee's screen-capture
// TCC category has no advance-check API, see main.js's open-privacy-settings) ──
test("preflight: system audio — granted is green with 'разрешено'", async () => {
  const { window, $ } = await boot({
    preflight: async () => ({ lmStudio: true, mic: "granted", screen: "granted", ffmpeg: true, whisperCached: true, hfToken: true, embedModel: true, backendInstalled: true }),
  });
  $("settingsOpen").click(); await tick(window);
  const row = $("preflightList").querySelectorAll(".pf-row")[3];
  assert.ok(row.querySelector(".pf-dot").classList.contains("ok"));
  assert.match(row.querySelector(".pf-detail").textContent, /разрешено/);
});

test("preflight: system audio — not-determined is grey (neutral), never red", async () => {
  const { window, $ } = await boot({
    preflight: async () => ({ lmStudio: true, mic: "granted", screen: "not-determined", ffmpeg: true, whisperCached: true, hfToken: true, embedModel: true, backendInstalled: true }),
  });
  $("settingsOpen").click(); await tick(window);
  const row = $("preflightList").querySelectorAll(".pf-row")[3];
  assert.ok(row.querySelector(".pf-dot").classList.contains("neutral"));
  assert.ok(!row.querySelector(".pf-dot").classList.contains("bad"), "unconfirmed must never read as the alarming red 'broken' state");
  assert.match(row.querySelector(".pf-detail").textContent, /проверяется при записи/);
});

test("preflight: system audio — explicitly denied is STILL grey (not red), and the settings button remains", async () => {
  const { window, $ } = await boot({
    preflight: async () => ({ lmStudio: true, mic: "granted", screen: "denied", ffmpeg: true, whisperCached: true, hfToken: true, embedModel: true, backendInstalled: true }),
    openPrivacySettings: async () => {},
  });
  $("settingsOpen").click(); await tick(window);
  const row = $("preflightList").querySelectorAll(".pf-row")[3];
  assert.ok(row.querySelector(".pf-dot").classList.contains("neutral"), "denied must read the same calm grey as not-determined — no confirmed-broken state exists");
  assert.ok(!row.querySelector(".pf-dot").classList.contains("bad"));
  assert.equal(row.querySelector(".pf-retry").textContent, "Открыть настройки", "the settings deep-link must still be offered");
});

test("preflight: system audio row carries a tooltip explaining the check-only-at-recording-time behavior", async () => {
  const { window, $ } = await boot({
    preflight: async () => ({ lmStudio: true, mic: "granted", screen: "not-determined", ffmpeg: true, whisperCached: true, hfToken: true, embedModel: true, backendInstalled: true }),
  });
  $("settingsOpen").click(); await tick(window);
  const row = $("preflightList").querySelectorAll(".pf-row")[3];
  assert.match(row.title, /AudioTee/);
  assert.match(row.title, /записью/);
});

test("preflight: header verdict is unaffected by system-audio state — a denied/unconfirmed screen row never contradicts 'Всё готово'", async () => {
  const { window, $ } = await boot({
    preflight: async () => ({ lmStudio: true, mic: "granted", screen: "denied", ffmpeg: true, whisperCached: true, hfToken: true, embedModel: true, backendInstalled: true }),
  });
  $("settingsOpen").click(); await tick(window);
  assert.match($("preflightVerdict").textContent, /Всё готово/,
    "backend+LM Studio+ffmpeg+mic all satisfied — a merely-unconfirmed system-audio row must not flip this to 'не готово'");
});

test("history rail renders items; selecting one renders the note markdown", async () => {
  const { window, $ } = await boot();
  window.document.querySelector('.topbtn[data-view="history"]').click();
  await tick(window);
  // Every recording (even a solitary обработка) now renders as a collapsible group —
  // see buildNotesRecordingRow — so the one obrabotka row still carries `.rail-item`.
  const items = $("historyList").querySelectorAll(".rail-item");
  assert.equal(items.length, 1);
  assert.ok($("historyList").textContent.includes("Синк"));       // title
  assert.ok($("historyList").querySelector(".rail-date-header"), "a date-group header separates days");
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
      { name: "2026-03-20-100000", base_stamp: "2026-03-20-100000", title: "Newest", language: "ru", note: "/c.md", audio: null },
      { name: "2026-02-15-100000", base_stamp: "2026-02-15-100000", title: "Middle", language: "ru", note: "/b.md", audio: null },
      { name: "2026-01-01-100000", base_stamp: "2026-01-01-100000", title: "Oldest", language: "ru", note: "/a.md", audio: null },
    ],
  });
  window.document.querySelector('.topbtn[data-view="history"]').click();
  await tick(window);
  // A recording's own title now lives in its group header (.rail-title is the
  // обработка's own template/version label, e.g. "Без шаблона · v1") — check header order.
  const headers = [...$("historyList").querySelectorAll(".rail-group-header")];
  assert.equal(headers.length, 3);
  assert.ok(headers[0].textContent.includes("Newest"));
  assert.ok(headers[1].textContent.includes("Middle"));
  assert.ok(headers[2].textContent.includes("Oldest"));
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

// ── История date-group headers (owner: chronological log + "N per day" without a
// calendar) — grouped over the FILTERED (shown) list, non-interactive dividers ─────────
test("history rail: date-group headers separate days, with per-day counts", async () => {
  const { window, $ } = await boot({
    listHistory: async () => [
      { name: "2026-07-08-190000", base_stamp: "2026-07-08-190000", title: "C", language: "ru", note: "/c.md", audio: null },
      { name: "2026-07-08-184655", base_stamp: "2026-07-08-184655", title: "B", language: "ru", note: "/b.md", audio: null },
      { name: "2026-07-07-120000", base_stamp: "2026-07-07-120000", title: "A", language: "ru", note: "/a.md", audio: null },
    ],
  });
  window.document.querySelector('.topbtn[data-view="history"]').click();
  await tick(window);
  const headers = [...$("historyList").querySelectorAll(".rail-date-header")].map((h) => h.textContent);
  assert.deepEqual(headers, ["8 июля · 2", "7 июля · 1"]);
});

test("history rail: date-group headers carry no idx and are not clickable", async () => {
  const { window, $ } = await boot({
    listHistory: async () => [
      { name: "2026-07-08-190000", base_stamp: "2026-07-08-190000", title: "C", language: "ru", note: "/c.md", audio: null },
    ],
  });
  window.document.querySelector('.topbtn[data-view="history"]').click();
  await tick(window);
  const header = $("historyList").querySelector(".rail-date-header");
  assert.ok(header);
  assert.equal(header.dataset.idx, undefined);
  const beforeNoteView = $("noteView").innerHTML;
  header.click(); await tick(window);
  assert.equal($("noteView").innerHTML, beforeNoteView); // divider click must not open a note
});

test("history rail: date-group counts follow active filters, not raw per-day totals", async () => {
  const { window, $ } = await boot({
    listHistory: async () => [
      { name: "2026-07-08-190000", base_stamp: "2026-07-08-190000", title: "Релиз", language: "ru", note: "/c.md", audio: null },
      { name: "2026-07-08-184655", base_stamp: "2026-07-08-184655", title: "Интервью", language: "en", note: "/b.md", audio: null },
    ],
  });
  window.document.querySelector('.topbtn[data-view="history"]').click();
  await tick(window);
  assert.equal($("historyList").querySelector(".rail-date-header").textContent, "8 июля · 2");
  $("historyLang").value = "en";
  $("historyLang").dispatchEvent(new window.Event("change"));
  const headers = $("historyList").querySelectorAll(".rail-date-header");
  assert.equal(headers.length, 1);
  assert.equal(headers[0].textContent, "8 июля · 1");
});

// Audio-first rail redesign (design "Вариант A"): a pending recording is no longer a
// separate always-first section — it interleaves at its OWN real chronological
// position among notes/orphans (buildRecordings' unified sort). A real "recorded"
// event's id IS the recording's own stamp (main.js: `id = sess.stamp`, literal
// "T"-format) — these two tests use a realistic stamp-shaped id (not the "r1" shorthand
// most other fixtures use, since "r1" isn't parseable and always sorts last).
test("history rail: a pending recording NEWER than an existing note renders above it", async () => {
  const { window, $, handlers } = await boot({
    listHistory: async () => [
      { name: "2026-07-08-190000", base_stamp: "2026-07-08-190000", title: "C", language: "ru", note: "/c.md", audio: null },
    ],
  });
  window.document.querySelector('.topbtn[data-view="history"]').click();
  await tick(window);
  handlers.record({
    event: "recorded", id: "2026-07-09T10-00-00-a1b2", name: "Запись новая",
    file: "/tmp/mixed.wav", mic: "/tmp/m.wav", system: null, tracks: 1,
  });
  await tick(window);
  const children = [...$("historyList").children];
  const pendingIdx = children.findIndex((c) => c.classList.contains("pending"));
  const groupIdx = children.findIndex((c) => c.classList.contains("rail-group"));
  assert.ok(pendingIdx !== -1 && groupIdx !== -1 && pendingIdx < groupIdx,
    "2026-07-09 pending is newer than the 2026-07-08 note — must render first");
});

test("history rail: a pending recording OLDER than an existing note renders below it", async () => {
  const { window, $, handlers } = await boot({
    listHistory: async () => [
      { name: "2026-07-08-190000", base_stamp: "2026-07-08-190000", title: "C", language: "ru", note: "/c.md", audio: null },
    ],
  });
  window.document.querySelector('.topbtn[data-view="history"]').click();
  await tick(window);
  handlers.record({
    event: "recorded", id: "2026-07-01T10-00-00-a1b2", name: "Запись старая",
    file: "/tmp/mixed.wav", mic: "/tmp/m.wav", system: null, tracks: 1,
  });
  await tick(window);
  const children = [...$("historyList").children];
  const pendingIdx = children.findIndex((c) => c.classList.contains("pending"));
  const groupIdx = children.findIndex((c) => c.classList.contains("rail-group"));
  assert.ok(groupIdx !== -1 && pendingIdx !== -1 && groupIdx < pendingIdx,
    "2026-07-01 pending is older than the 2026-07-08 note — must render after it");
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

// ── history filters collapse (Фильтры ▾/▸ toggle + active-count badge) ──────────
test("history filters: collapsed by default, toggle flips the caret, and the badge counts only non-default values", async () => {
  const { window, $ } = await boot();
  window.document.querySelector('.topbtn[data-view="history"]').click();
  await tick(window);
  assert.ok($("historyFiltersBody").classList.contains("hidden"), "collapsed by default");
  assert.ok($("historyFiltersBadge").classList.contains("hidden"), "no active filters yet — badge hidden");
  $("historyFiltersToggle").click();
  assert.ok(!$("historyFiltersBody").classList.contains("hidden"), "toggle expands the body");
  assert.equal($("historyFiltersCaret").textContent, "▾");
  $("historyLang").value = "en";
  $("historyLang").dispatchEvent(new window.Event("change"));
  assert.ok(!$("historyFiltersBadge").classList.contains("hidden"));
  assert.equal($("historyFiltersBadge").textContent, "1");
  $("historyFrom").value = "2026-01-01";
  $("historyFrom").dispatchEvent(new window.Event("change"));
  assert.equal($("historyFiltersBadge").textContent, "2", "lang + from both count toward the badge");
  $("historyFiltersToggle").click();
  assert.ok($("historyFiltersBody").classList.contains("hidden"), "toggle collapses again");
  assert.equal($("historyFiltersCaret").textContent, "▸");
});

// ── История empty states ─────────────────────────────────────────────────────
test("История: no notes and no pending → centered empty state with a button back to Запись", async () => {
  const { window, $ } = await boot({ listHistory: async () => [] });
  window.document.querySelector('.topbtn[data-view="history"]').click();
  await tick(window);
  const empty = $("noteView").querySelector(".note-view-empty");
  assert.ok(empty, "empty state must render when История has nothing at all");
  assert.ok($("noteView").textContent.includes("Пока нет заметок"));
  assert.ok($("noteView").textContent.includes("Запиши первую встречу"));
  $("noteView").querySelector("#nvEmptyGoRecord").click();
  assert.ok($("view-history").classList.contains("hidden"));
  assert.ok(!$("view-record").classList.contains("hidden"), "empty-state button switches back to Запись");
});

test("История: no finished notes yet but a restart-era pending recording exists → not the empty state", async () => {
  const { window, $ } = await boot({
    listHistory: async () => [],
    listPendingRecordings: async () => ([
      { id: "r1", name: "Запись 1", mixed: "/rec/r1/mixed.wav", mic: "/rec/r1/mic.wav", system: null, tracks: 1 },
    ]),
  });
  window.document.querySelector('.topbtn[data-view="history"]').click();
  await tick(window);
  assert.ok(!$("noteView").querySelector(".note-view-empty"),
    "a pending recording means История isn't truly empty — no CTA to record when one's already queued");
  assert.equal($("historyList").querySelectorAll(".rail-item.pending").length, 1);
});

test("История: notes exist but none clicked yet → auto-opens the most recent note instead of the old hint", async () => {
  const { window, $ } = await boot({
    listHistory: async () => [
      { name: "2026-07-08-190000", title: "Newest", language: "ru", note: "/c.md", audio: null },
      { name: "2026-01-01-100000", title: "Oldest", language: "ru", note: "/a.md", audio: null },
    ],
  });
  window.document.querySelector('.topbtn[data-view="history"]').click();
  await tick(window);
  const t = $("noteView").querySelector(".note-title");
  assert.ok(t, "a note must be auto-opened, not the static hint");
  assert.equal(t.textContent, "Newest", "the most recent note (stamp-DESC first) is the one auto-opened");
  assert.ok($("historyList").querySelector('.rail-item[data-idx="0"]').classList.contains("active"),
    "the auto-opened row is also highlighted active, same as a manual click");
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
  // paraClassifyAll does classify → file → markRowFiled (extract retired with the accumulator).
  // Assert that classify filled category/project fields by setting them directly (same contract).
  const catSel = rows[0].querySelector(".para-cat");
  const projIn = rows[0].querySelector(".para-proj");
  catSel.value = "projects";
  projIn.value = "Лендинг";
  assert.equal(catSel.value, "projects");
  assert.equal(projIn.value, "Лендинг");
  // Now click file-btn: paraFile → markRowFiled (consistent with the bulk path —
  // stays in place, greyed and disabled, not removed). The default paraExtract mock throws,
  // so this test also locks «filing works without any extract call».
  rows[0].querySelector(".para-file-btn").click(); await tick(window); await tick(window);
  assert.equal($("paraInbox").querySelectorAll(".para-row").length, 1);
  assert.ok(rows[0].classList.contains("filed"));
  assert.ok(catSel.disabled);
  assert.equal(rows[0].querySelector(".para-file-btn").textContent, "✓ Разложена");
});

test("PARA: fileParaRow with empty category auto-classifies via LLM, then files", async () => {
  let classifyArg = null;
  const { window, $ } = await boot({
    getPresets: async () => ({
      presets: [], defaultOutDir: "/tmp", hfToken: "", language: "ru",
      para: { root: "/v", folders: { projects: "Projects", areas: "Areas", resources: "Resources", archives: "Archives" } },
    }),
    listHistory: async () => [{ name: "2026-01-01", title: "T", note: "/n.md", audio: null }],
    paraClassify: async (arg) => { classifyArg = arg; return { category: "projects", project: "Лендинг" }; },
    paraFile: async () => ({ ok: true }),
  });
  window.document.querySelector('.topbtn[data-view="para"]').click();
  await tick(window);
  const rows = $("paraInbox").querySelectorAll(".para-row");
  assert.equal(rows[0].querySelector(".para-cat").value, "", "no category picked yet");
  rows[0].querySelector(".para-file-btn").click();
  await tick(window); await tick(window); await tick(window);
  assert.ok(classifyArg, "paraClassify was not called");
  assert.equal(classifyArg.note, "/n.md");
  assert.equal(rows[0].querySelector(".para-cat").value, "projects");
  assert.equal(rows[0].querySelector(".para-proj").value, "Лендинг");
  assert.ok(rows[0].classList.contains("filed"));
});

test("PARA: fileParaRow with a manually-picked category skips classify, files directly", async () => {
  let classifyCalled = false;
  const { window, $ } = await boot({
    getPresets: async () => ({
      presets: [], defaultOutDir: "/tmp", hfToken: "", language: "ru",
      para: { root: "/v", folders: { projects: "Projects", areas: "Areas", resources: "Resources", archives: "Archives" } },
    }),
    listHistory: async () => [{ name: "2026-01-01", title: "T", note: "/n.md", audio: null }],
    paraClassify: async () => { classifyCalled = true; return { category: "projects", project: "P" }; },
    paraFile: async () => ({ ok: true }),
  });
  window.document.querySelector('.topbtn[data-view="para"]').click();
  await tick(window);
  const rows = $("paraInbox").querySelectorAll(".para-row");
  rows[0].querySelector(".para-cat").value = "areas";
  rows[0].querySelector(".para-file-btn").click();
  await tick(window); await tick(window);
  assert.equal(classifyCalled, false, "paraClassify must not be called when a category was already picked");
  assert.ok(rows[0].classList.contains("filed"));
});

test("PARA: fileParaRow auto-classify failure alerts and leaves the row unfiled", async () => {
  const { window, $ } = await boot({
    getPresets: async () => ({
      presets: [], defaultOutDir: "/tmp", hfToken: "", language: "ru",
      para: { root: "/v", folders: { projects: "Projects", areas: "Areas", resources: "Resources", archives: "Archives" } },
    }),
    listHistory: async () => [{ name: "2026-01-01", title: "T", note: "/n.md", audio: null }],
    paraClassify: async () => ({ error: "модель недоступна" }),
  });
  let alerted = null;
  window.alert = (msg) => { alerted = msg; };
  window.document.querySelector('.topbtn[data-view="para"]').click();
  await tick(window);
  const rows = $("paraInbox").querySelectorAll(".para-row");
  const btn = rows[0].querySelector(".para-file-btn");
  const prevLabel = btn.textContent;
  btn.click();
  await tick(window); await tick(window);
  assert.ok(alerted && alerted.includes("модель недоступна"), `expected alert mentioning the error, got: ${alerted}`);
  assert.equal(rows[0].classList.contains("filed"), false);
  assert.equal(btn.disabled, false);
  assert.equal(btn.textContent, prevLabel);
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

// T3: PARA flat navigation (design ref: para-horizontal-a.html вариант A —
// сегмент-контрол). The old vertical .para-subnav aside is retired in favor of a
// horizontal pill group living inside .para-main; subSwitchPara/data-sub switching
// itself is covered by the ~15 existing "click .subbtn[data-sub=...]" tests above and
// below — this locks the structural move only.
test("PARA flat nav: vertical .para-subnav aside is gone, .subbtn/data-sub buttons now live in a horizontal .para-seg group inside .para-main", async () => {
  const { window, $ } = await boot({});
  window.document.querySelector('.topbtn[data-view="para"]').click();
  await tick(window);
  assert.ok(!window.document.querySelector(".para-subnav"), "the old vertical subnav aside must be gone");
  const seg = window.document.querySelector(".para-seg");
  assert.ok(seg, "a segmented pill group must exist");
  assert.ok($("para-pane-inbox").closest(".para-main").contains(seg),
    "the segment group must be nested inside para-main, not a separate sidebar column");
  const subs = Array.from(seg.querySelectorAll(".subbtn")).map((b) => b.dataset.sub);
  assert.deepEqual(subs, ["inbox", "search", "tree"], "all three subviews present, same order as before");
});

// ── copy note path (PARA Хранилище/tree note view) ───────────────────────────
test("ptvCopyPath: copies the tree note's absolute path and shows brief feedback", async () => {
  const { window, $ } = await boot({
    getPresets: async () => ({
      presets: [], defaultOutDir: "/tmp", hfToken: "", language: "ru",
      para: { root: "/v", folders: { projects: "Projects", areas: "Areas", resources: "Resources", archives: "Archives" } },
    }),
    paraTree: async () => [
      { name: "meeting-x.md", path: "/v/Projects/meeting-x.md", type: "note" },
    ],
  });
  const copied = [];
  window.navigator.clipboard.writeText = async (text) => { copied.push(text); };
  window.document.querySelector('.topbtn[data-view="para"]').click(); await tick(window);
  window.document.querySelector('.subbtn[data-sub="tree"]').click(); await tick(window);
  $("paraTree").querySelector(".tree-note").click(); await tick(window);
  const btn = $("paraTreeView").querySelector("#ptvCopyPath");
  assert.equal(btn.textContent, "📋 Путь");
  btn.click(); await tick(window);
  assert.equal(copied[0], "/v/Projects/meeting-x.md");
  assert.equal(btn.textContent, "✓ Скопировано");
  await new Promise((r) => window.setTimeout(r, 1600));
  assert.equal(btn.textContent, "📋 Путь");             // reverts after the feedback window
});

// ── jump-to-recording button in note headers (Task 3) ────────────────────────
test("ptvGoRecord (PARA tree note header) switches to the Запись view", async () => {
  const { window, $ } = await boot({
    getPresets: async () => ({
      presets: [], defaultOutDir: "/tmp", hfToken: "", language: "ru",
      para: { root: "/v", folders: { projects: "Projects", areas: "Areas", resources: "Resources", archives: "Archives" } },
    }),
    paraTree: async () => [
      { name: "meeting-x.md", path: "/v/Projects/meeting-x.md", type: "note" },
    ],
  });
  window.document.querySelector('.topbtn[data-view="para"]').click(); await tick(window);
  window.document.querySelector('.subbtn[data-sub="tree"]').click(); await tick(window);
  $("paraTree").querySelector(".tree-note").click(); await tick(window);
  $("paraTreeView").querySelector("#ptvGoRecord").click(); await tick(window);
  assert.ok(!$("view-record").classList.contains("hidden"));
  assert.ok($("view-para").classList.contains("hidden"));
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

test("PARA: a failed first fetch doesn't set paraInboxLoaded, so the next tab entry retries (not just «Обновить»)", async () => {
  let listHistoryCalls = 0;
  let failNext = false;
  const { window, $ } = await boot({
    getPresets: async () => ({
      presets: [], defaultOutDir: "/tmp", hfToken: "", language: "ru",
      para: { root: "/v", folders: { projects: "Projects", areas: "Areas", resources: "Resources", archives: "Archives" } },
    }),
    listHistory: async () => {
      listHistoryCalls++;
      if (failNext) throw new Error("boom");
      return [{ name: "2026-01-01", title: "T", note: "/n.md", audio: null }];
    },
  });
  listHistoryCalls = 0; // discard init()'s own refreshHistory() fetch — unrelated to PARA
  failNext = true;
  window.document.querySelector('.topbtn[data-view="para"]').click();
  await tick(window);
  assert.equal(listHistoryCalls, 1);
  assert.equal($("paraInbox").querySelectorAll(".para-row").length, 0);

  failNext = false;
  window.document.querySelector('.topbtn[data-view="para"]').click(); // re-entry after the failure
  await tick(window);
  assert.equal(listHistoryCalls, 2, "must retry — the failed fetch must not have set paraInboxLoaded");
  assert.equal($("paraInbox").querySelectorAll(".para-row").length, 1);
});

test("PARA classify-all: every row's file-btn is disabled up front, including rows the loop hasn't reached yet", async () => {
  const { window, $ } = await boot({
    getPresets: async () => ({
      presets: [], defaultOutDir: "/tmp", hfToken: "", language: "ru",
      para: { root: "/v", folders: { projects: "Projects", areas: "Areas", resources: "Resources", archives: "Archives" } },
    }),
    listHistory: async () => [
      { name: "2026-01-01", title: "T1", note: "/n1.md", audio: null },
      { name: "2026-01-02", title: "T2", note: "/n2.md", audio: null },
    ],
    paraClassify: async () => ({ category: "projects", project: "P" }),
    paraFile: async () => ({ ok: true }),
  });
  window.document.querySelector('.topbtn[data-view="para"]').click();
  await tick(window);
  const rows = $("paraInbox").querySelectorAll(".para-row");
  assert.equal(rows.length, 2);
  $("paraClassifyAll").click();
  // Synchronous prefix disables every row's file-btn before the first await — including
  // row[1], which the loop hasn't reached yet (this is the actual race fix: a manual
  // "Разложить" on it used to be possible while only row[0] was disabled).
  assert.ok(rows[0].querySelector(".para-file-btn").disabled);
  assert.ok(rows[1].querySelector(".para-file-btn").disabled, "not-yet-processed row must be disabled too");
  rows[1].querySelector(".para-file-btn").click(); // disabled — jsdom no-ops the click
  await tick(window); await tick(window); await tick(window); await tick(window);
  assert.ok(rows[0].classList.contains("filed"));
  assert.ok(rows[1].classList.contains("filed"), "manual click while disabled never fired — the loop filed it instead");
});

test("PARA classify-all: canceling mid-batch re-enables the not-yet-reached row's file-btn (not stuck disabled)", async () => {
  const { window, $ } = await boot({
    getPresets: async () => ({
      presets: [], defaultOutDir: "/tmp", hfToken: "", language: "ru",
      para: { root: "/v", folders: { projects: "Projects", areas: "Areas", resources: "Resources", archives: "Archives" } },
    }),
    listHistory: async () => [
      { name: "2026-01-01", title: "T1", note: "/n1.md", audio: null },
      { name: "2026-01-02", title: "T2", note: "/n2.md", audio: null },
    ],
    paraClassify: async () => ({ category: "projects", project: "P" }),
    paraFile: async () => ({ ok: true }),
  });
  window.document.querySelector('.topbtn[data-view="para"]').click();
  await tick(window);
  const rows = $("paraInbox").querySelectorAll(".para-row");
  $("paraClassifyAll").click();
  assert.ok(rows[1].querySelector(".para-file-btn").disabled);
  $("paraClassifyCancel").click(); // requested before the loop reaches row 1
  await tick(window); await tick(window); await tick(window); await tick(window);
  assert.ok(rows[0].classList.contains("filed"));
  assert.ok(!rows[1].classList.contains("filed"), "row 2 was never reached — batch was canceled first");
  assert.equal(rows[1].querySelector(".para-file-btn").disabled, false, "must be re-enabled, not left disabled forever");
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

// L7 arch-audit: main.js's save-presets now reports a failed HF-token
// keychain/file write ({ok:false, error}) instead of silently succeeding —
// persistPresets must surface it, same alert(res.error) convention every other
// main-process failure in this file already uses.
test("persistPresets alerts the user when savePresets reports ok:false (failed token write)", async () => {
  const { $, window } = await boot({
    savePresets: async () => ({ ok: false, error: "Не удалось сохранить HF-токен: EACCES" }),
  });
  await tick(window);
  let alerted = null;
  window.alert = (msg) => { alerted = msg; };
  $("authorName").value = "Кто-то";
  $("authorName").dispatchEvent(new window.Event("change"));
  await tick(window);
  assert.equal(alerted, "Не удалось сохранить HF-токен: EACCES");
});
test("persistPresets does NOT alert when savePresets succeeds (plain true, the boot-mock default)", async () => {
  const { $, window } = await boot();
  await tick(window);
  let alerted = null;
  window.alert = (msg) => { alerted = msg; };
  $("authorName").value = "Кто-то ещё";
  $("authorName").dispatchEvent(new window.Event("change"));
  await tick(window);
  assert.equal(alerted, null);
});

// ── theme setting (design-sidebar B-2) ──────────────────────────────────────────

test("theme loads from presets into the settings select and applies data-theme on the document root", async () => {
  const { $, window } = await boot({
    getPresets: async () => ({
      presets: [], defaultOutDir: "/tmp", hfToken: "", language: "ru", theme: "teal",
    }),
  });
  await tick(window);
  assert.equal($("themeSelect").value, "teal");
  assert.equal(window.document.documentElement.dataset.theme, "teal");
});

test("theme defaults to 'classic' when absent from presets, and data-theme is not set on the document root", async () => {
  const { $, window } = await boot({
    getPresets: async () => ({ presets: [], defaultOutDir: "/tmp", hfToken: "", language: "ru" }),
  });
  await tick(window);
  assert.equal($("themeSelect").value, "classic");
  assert.equal(window.document.documentElement.hasAttribute("data-theme"), false);
});

test("changing the theme select applies data-theme immediately and persists it in savePresets payload", async () => {
  let saved = null;
  const { $, window } = await boot({ savePresets: async (data) => { saved = data; return true; } });
  await tick(window);
  $("themeSelect").value = "orchid";
  $("themeSelect").dispatchEvent(new window.Event("change"));
  await tick(window);
  assert.equal(window.document.documentElement.dataset.theme, "orchid", "applies immediately, not just on next boot");
  assert.ok(saved, "savePresets was not called");
  assert.equal(saved.theme, "orchid");

  // switching back to classic must remove the attribute entirely, not set it to "" —
  // see applyTheme()'s comment in renderer.js for why that distinction matters.
  $("themeSelect").value = "classic";
  $("themeSelect").dispatchEvent(new window.Event("change"));
  await tick(window);
  assert.equal(window.document.documentElement.hasAttribute("data-theme"), false);
  assert.equal(saved.theme, "classic");
});

// ── fastModel setting ──────────────────────────────────────────────────────────

test("fastModel loads from presets into state and the settings input", async () => {
  const { $, window } = await boot({
    getPresets: async () => ({
      presets: [], defaultOutDir: "/tmp", hfToken: "", language: "ru", fastModel: "google/gemma-3-4b",
    }),
  });
  await tick(window);
  assert.equal($("fastModel").value, "google/gemma-3-4b");
});

test("fastModel defaults to '' when absent from presets", async () => {
  const { $, window } = await boot({
    getPresets: async () => ({ presets: [], defaultOutDir: "/tmp", hfToken: "", language: "ru" }),
  });
  await tick(window);
  assert.equal($("fastModel").value, "");
});

test("changing fastModel input persists with fastModel in savePresets payload", async () => {
  let saved = null;
  const { $, window } = await boot({ savePresets: async (data) => { saved = data; return true; } });
  await tick(window);
  $("fastModel").value = "google/gemma-3-4b";
  $("fastModel").dispatchEvent(new window.Event("change"));
  await tick(window);
  assert.ok(saved, "savePresets was not called");
  assert.equal(saved.fastModel, "google/gemma-3-4b");
});

test("fastModel is forwarded to processAudio when running", async () => {
  let sent = null;
  const { window, $, handlers } = await boot({
    getPresets: async () => ({
      presets: [{ name: "P", prompt: "x" }], defaultOutDir: "/tmp", hfToken: "", language: "ru",
      fastModel: "google/gemma-3-4b",
    }),
    processAudio: async (opts) => { sent = opts; return { ok: true }; },
  });
  await tick(window);
  handlers.record({ event: "recorded", id: "r1", name: "Запись 1", file: "/tmp/mixed.wav", mic: "/tmp/m.wav", system: null, tracks: 1 });
  $("historyList").querySelector(".pending-play-btn").click();
  await tick(window);
  assert.ok(sent, "processAudio was not called");
  assert.equal(sent.fastModel, "google/gemma-3-4b");
});

// ── mainModel setting ────────────────────────────────────────────────────────

test("mainModel loads from presets into state and the settings input", async () => {
  const { $, window } = await boot({
    getPresets: async () => ({
      presets: [], defaultOutDir: "/tmp", hfToken: "", language: "ru", mainModel: "qwen/qwen3.5-9b",
    }),
  });
  await tick(window);
  assert.equal($("mainModel").value, "qwen/qwen3.5-9b");
});

test("mainModel defaults to '' when absent from presets", async () => {
  const { $, window } = await boot({
    getPresets: async () => ({ presets: [], defaultOutDir: "/tmp", hfToken: "", language: "ru" }),
  });
  await tick(window);
  assert.equal($("mainModel").value, "");
});

test("changing mainModel input persists with mainModel in savePresets payload", async () => {
  let saved = null;
  const { $, window } = await boot({ savePresets: async (data) => { saved = data; return true; } });
  await tick(window);
  $("mainModel").value = "qwen/qwen3.5-9b";
  $("mainModel").dispatchEvent(new window.Event("change"));
  await tick(window);
  assert.ok(saved, "savePresets was not called");
  assert.equal(saved.mainModel, "qwen/qwen3.5-9b");
});

test("mainModel is forwarded to processAudio when running", async () => {
  let sent = null;
  const { window, $, handlers } = await boot({
    getPresets: async () => ({
      presets: [{ name: "P", prompt: "x" }], defaultOutDir: "/tmp", hfToken: "", language: "ru",
      mainModel: "qwen/qwen3.5-9b",
    }),
    processAudio: async (opts) => { sent = opts; return { ok: true }; },
  });
  await tick(window);
  handlers.record({ event: "recorded", id: "r1", name: "Запись 1", file: "/tmp/mixed.wav", mic: "/tmp/m.wav", system: null, tracks: 1 });
  $("historyList").querySelector(".pending-play-btn").click();
  await tick(window);
  assert.ok(sent, "processAudio was not called");
  assert.equal(sent.mainModel, "qwen/qwen3.5-9b");
});

test("mainModel is forwarded to paraClassify during classify-all", async () => {
  let capturedArg = null;
  const { window, $ } = await boot({
    getPresets: async () => ({
      presets: [], defaultOutDir: "/tmp", hfToken: "", language: "ru", mainModel: "qwen/qwen3.5-9b",
      para: { root: "/v", folders: { projects: "Projects", areas: "Areas", resources: "Resources", archives: "Archives" } },
    }),
    listHistory: async () => [{ name: "2026-01-01", title: "T", note: "/n.md", audio: null }],
    paraClassify: async (arg) => { capturedArg = arg; return { category: "projects", project: "P" }; },
    paraFile: async () => ({ ok: true }),
  });
  window.document.querySelector('.topbtn[data-view="para"]').click();
  await tick(window);
  $("paraClassifyAll").click();
  await tick(window); await tick(window); await tick(window); await tick(window);
  assert.ok(capturedArg, "paraClassify was not called");
  assert.equal(capturedArg.mainModel, "qwen/qwen3.5-9b");
});

// ── T4-T6/T7 (ux-para-batch): kind/person/mission classification + language pin
// threaded from paraClassify through to paraFile ────────────────────────────────
test("language is forwarded to paraClassify during classify-all (T7 — project/person/mission answer in the meeting's own language)", async () => {
  let capturedArg = null;
  const { window, $ } = await boot({
    getPresets: async () => ({
      presets: [], defaultOutDir: "/tmp", hfToken: "", language: "ru",
      para: { root: "/v", folders: { projects: "Projects", areas: "Areas", resources: "Resources", archives: "Archives" } },
    }),
    listHistory: async () => [{ name: "2026-01-01", title: "T", note: "/n.md", audio: null }],
    paraClassify: async (arg) => { capturedArg = arg; return { category: "projects", project: "P" }; },
    paraFile: async () => ({ ok: true }),
  });
  window.document.querySelector('.topbtn[data-view="para"]').click();
  await tick(window);
  $("paraClassifyAll").click();
  await tick(window); await tick(window); await tick(window); await tick(window);
  assert.ok(capturedArg, "paraClassify was not called");
  assert.equal(capturedArg.language, "ru");
});

test("classify-all: kind/person/mission from paraClassify's result are threaded through to paraFile", async () => {
  let filedArg = null;
  const { window, $ } = await boot({
    getPresets: async () => ({
      presets: [], defaultOutDir: "/tmp", hfToken: "", language: "ru",
      para: { root: "/v", folders: { projects: "Projects", areas: "Areas", resources: "Resources", archives: "Archives" } },
    }),
    listHistory: async () => [{ name: "2026-01-01", title: "T", note: "/n.md", audio: null }],
    paraClassify: async () => ({ category: "projects", project: "Ильшат", kind: "one_to_one", person: "Ильшат", mission: "" }),
    paraFile: async (arg) => { filedArg = arg; return { ok: true }; },
  });
  window.document.querySelector('.topbtn[data-view="para"]').click();
  await tick(window);
  $("paraClassifyAll").click();
  await tick(window); await tick(window); await tick(window); await tick(window);
  assert.ok(filedArg, "paraFile was not called");
  assert.equal(filedArg.kind, "one_to_one");
  assert.equal(filedArg.person, "Ильшат");
});

test("single-row 'Разложить' (auto-classify branch): kind/person/mission from paraClassify are threaded through to paraFile", async () => {
  let filedArg = null;
  const { window, $ } = await boot({
    getPresets: async () => ({
      presets: [], defaultOutDir: "/tmp", hfToken: "", language: "ru",
      para: { root: "/v", folders: { projects: "Projects", areas: "Areas", resources: "Resources", archives: "Archives" } },
    }),
    listHistory: async () => [{ name: "2026-01-01", title: "T", note: "/n.md", audio: null }],
    paraClassify: async () => ({ category: "projects", project: "X", kind: "mission_daily", person: "", mission: "X" }),
    paraFile: async (arg) => { filedArg = arg; return { ok: true }; },
  });
  window.document.querySelector('.topbtn[data-view="para"]').click();
  await tick(window);
  const row = $("paraInbox").querySelector(".para-row");
  row.querySelector(".para-file-btn").click();
  await tick(window); await tick(window); await tick(window); await tick(window);
  assert.ok(filedArg, "paraFile was not called");
  assert.equal(filedArg.kind, "mission_daily");
  assert.equal(filedArg.mission, "X");
});

test("single-row 'Разложить' with a manually-picked category: paraFile gets no kind/person/mission opinion (no classify call happened)", async () => {
  let filedArg = null;
  let classifyCalled = false;
  const { window, $ } = await boot({
    getPresets: async () => ({
      presets: [], defaultOutDir: "/tmp", hfToken: "", language: "ru",
      para: { root: "/v", folders: { projects: "Projects", areas: "Areas", resources: "Resources", archives: "Archives" } },
    }),
    listHistory: async () => [{ name: "2026-01-01", title: "T", note: "/n.md", audio: null }],
    paraClassify: async () => { classifyCalled = true; return { category: "projects", project: "P" }; },
    paraFile: async (arg) => { filedArg = arg; return { ok: true }; },
  });
  window.document.querySelector('.topbtn[data-view="para"]').click();
  await tick(window);
  const row = $("paraInbox").querySelector(".para-row");
  row.querySelector(".para-cat").value = "projects";
  row.querySelector(".para-proj").value = "Ручной проект";
  row.querySelector(".para-file-btn").click();
  await tick(window); await tick(window); await tick(window); await tick(window);
  assert.equal(classifyCalled, false, "a manually-picked category must not trigger an LLM classify call");
  assert.ok(filedArg, "paraFile was not called");
  assert.equal(filedArg.kind, undefined);
  assert.equal(filedArg.project, "Ручной проект");
});

test("mainModel is forwarded to paraSearch when asking a question", async () => {
  let capturedMainModel;
  const { window, $ } = await boot({
    getPresets: async () => ({
      presets: [], defaultOutDir: "/tmp", hfToken: "", language: "ru", mainModel: "qwen/qwen3.5-9b",
      para: { root: "/v", folders: { projects: "Projects", areas: "Areas", resources: "Resources", archives: "Archives" } },
    }),
    paraSearch: async (_root, _messages, mainModel) => {
      capturedMainModel = mainModel;
      return { found: false, answer: "Не нашёл по этому вопросу записей в заметках.", citations: [] };
    },
  });
  window.document.querySelector('.topbtn[data-view="para"]').click();
  await tick(window);
  window.document.querySelector('.subbtn[data-sub="search"]').click();
  await tick(window);
  $("paraSearchQuery").value = "тест вопрос";
  $("paraSearchBtn").click(); await tick(window); await tick(window);
  assert.equal(capturedMainModel, "qwen/qwen3.5-9b");
});

// ── LM Studio model dropdowns (fastModel/mainModel datalists) ────────────────

test("opening settings populates the fastModel/mainModel datalists from the listLmModels IPC", async () => {
  const { $, window } = await boot({
    listLmModels: async () => (["google/gemma-3-4b", "qwen/qwen3.5-9b"]),
  });
  await tick(window);
  assert.equal($("fastModelOptions").children.length, 0, "datalist starts empty");
  $("settingsOpen").click();
  await tick(window);
  const fastOpts = [...$("fastModelOptions").children].map((o) => o.value);
  const mainOpts = [...$("mainModelOptions").children].map((o) => o.value);
  assert.deepEqual(fastOpts, ["google/gemma-3-4b", "qwen/qwen3.5-9b"]);
  assert.deepEqual(mainOpts, ["google/gemma-3-4b", "qwen/qwen3.5-9b"]);
});

test("listLmModels failure degrades to empty datalists — no crash, inputs stay plain-text usable", async () => {
  const { $, window } = await boot({
    listLmModels: async () => { throw new Error("LM Studio unreachable"); },
  });
  await tick(window);
  $("settingsOpen").click();
  await tick(window);
  assert.equal($("fastModelOptions").children.length, 0);
  assert.equal($("mainModelOptions").children.length, 0);
  // the input itself stays a normal usable text field regardless
  $("fastModel").value = "typed/manually";
  assert.equal($("fastModel").value, "typed/manually");
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
  handlers.record({ event: "recorded", id: "r1", name: "Запись 1", file: "/tmp/mixed.wav", mic: "/tmp/m.wav", system: null, tracks: 1 });
  $("historyList").querySelector(".pending-play-btn").click();
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

// TODO 2026-07-10: removeGlossaryTerm didn't prune glossaryCategories[low] of the
// deleted term — orphans accumulated in presets.json unboundedly (rendering was fine,
// only the persisted map grew). Lock: removing a categorized "Мои" term must drop its
// category entry too, not just leave it stranded.
test("removing a chip also prunes its glossaryCategories entry (no orphaned category left in presets.json)", async () => {
  let saved = null;
  const { $, window } = await boot({
    getPresets: async () => ({
      presets: [], defaultOutDir: "/tmp", hfToken: "", language: "ru",
      glossary: "Иван Петров, Mindbox",
      glossaryCategories: { "иван петров": "Люди", "mindbox": "Продукты и инструменты" },
    }),
    savePresets: async (data) => { saved = data; return true; },
  });
  await tick(window);
  // "Mindbox" is the 2nd rendered chip (index 1: Иван Петров, Mindbox).
  $("glossaryChips").querySelectorAll(".chip-remove")[1].click();
  await tick(window);
  assert.ok(saved, "savePresets was not called");
  assert.equal(saved.glossary, "Иван Петров");
  assert.deepEqual(saved.glossaryCategories, { "иван петров": "Люди" },
    "mindbox's category entry must be pruned, not left orphaned");
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
  // "Мои" (Mindbox, Иван Петров) render before "Стандартные" (ClickHouse — a
  // DEFAULT_GLOSSARY term) — grouped order, not raw textarea order (see V1 UX split).
  const chips = Array.from($("glossaryChips").querySelectorAll(".chip-text")).map((el) => el.textContent);
  assert.deepEqual(chips, ["Mindbox", "Иван Петров", "ClickHouse"]);
  assert.equal($("glossaryCount").textContent, "3 терминов");
});

// ── glossary: «Мои»/«Стандартные» split + live filter (V1 UX) ───────────────
test("chips split into «Мои» (custom) and «Стандартные» (DEFAULT_GLOSSARY) sections, «Стандартные» collapsed by default with a count", async () => {
  const { $, window } = await boot({
    getPresets: async () => ({
      presets: [], defaultOutDir: "/tmp", hfToken: "", language: "ru",
      glossary: "Иван Петров, ClickHouse, Kafka",
    }),
  });
  await tick(window);
  const mine = Array.from($("glossaryChipsMine").querySelectorAll(".chip-text")).map((el) => el.textContent);
  assert.deepEqual(mine, ["Иван Петров"]);
  const toggle = $("glossaryDefaultToggle");
  assert.match(toggle.textContent, /Стандартные/);
  assert.match(toggle.textContent, /2/); // ClickHouse + Kafka
  assert.ok($("glossaryChips").querySelector(".glossary-default-chips").classList.contains("hidden"),
    "Стандартные collapsed by default");
});

test("clicking the «Стандартные» toggle expands and re-collapses the default-terms section", async () => {
  const { $, window } = await boot({
    getPresets: async () => ({ presets: [], defaultOutDir: "/tmp", hfToken: "", language: "ru", glossary: "ClickHouse" }),
  });
  await tick(window);
  assert.ok($("glossaryChips").querySelector(".glossary-default-chips").classList.contains("hidden"));

  $("glossaryDefaultToggle").click();
  await tick(window);
  let defaultBox = $("glossaryChips").querySelector(".glossary-default-chips");
  assert.ok(!defaultBox.classList.contains("hidden"), "expands on click");
  const chips = Array.from(defaultBox.querySelectorAll(".chip-text")).map((el) => el.textContent);
  assert.deepEqual(chips, ["ClickHouse"]);

  $("glossaryDefaultToggle").click();
  await tick(window);
  assert.ok($("glossaryChips").querySelector(".glossary-default-chips").classList.contains("hidden"),
    "collapses again on a second click");
});

test("removing a chip inside the collapsed «Стандартные» section still works (closure-by-index scoped per section)", async () => {
  let saved = null;
  const { $, window } = await boot({
    getPresets: async () => ({ presets: [], defaultOutDir: "/tmp", hfToken: "", language: "ru", glossary: "Иван Петров, ClickHouse" }),
    savePresets: async (data) => { saved = data; return true; },
  });
  await tick(window);
  // "ClickHouse" is the only default-section chip — its remove button is scoped to
  // .glossary-default-chips, not the flat top-level index used before the split.
  $("glossaryChips").querySelector(".glossary-default-chips").querySelector(".chip-remove").click();
  await tick(window);
  const mine = Array.from($("glossaryChipsMine").querySelectorAll(".chip-text")).map((el) => el.textContent);
  assert.deepEqual(mine, ["Иван Петров"]);
  assert.equal($("glossary").value, "Иван Петров");
  assert.equal(saved.glossary, "Иван Петров");
});

test("filter input narrows chips by substring and updates the «N из M» counter live", async () => {
  const { $, window } = await boot({
    getPresets: async () => ({
      presets: [], defaultOutDir: "/tmp", hfToken: "", language: "ru",
      glossary: "Иван Петров, Анна Смирнова, ClickHouse",
    }),
  });
  await tick(window);
  $("glossaryFilter").value = "иван";
  $("glossaryFilter").dispatchEvent(new window.Event("input"));
  await tick(window);
  assert.equal($("glossaryCount").textContent, "1 из 3 терминов");
  const mine = Array.from($("glossaryChipsMine").querySelectorAll(".chip-text")).map((el) => el.textContent);
  assert.deepEqual(mine, ["Иван Петров"]);

  $("glossaryFilter").value = "";
  $("glossaryFilter").dispatchEvent(new window.Event("input"));
  await tick(window);
  assert.equal($("glossaryCount").textContent, "3 терминов");
});

test("a non-empty filter with a match auto-expands «Стандартные»; clearing it restores the manual collapsed state", async () => {
  const { $, window } = await boot({
    getPresets: async () => ({ presets: [], defaultOutDir: "/tmp", hfToken: "", language: "ru", glossary: "Иван Петров, ClickHouse" }),
  });
  await tick(window);
  assert.ok($("glossaryChips").querySelector(".glossary-default-chips").classList.contains("hidden"));

  $("glossaryFilter").value = "click";
  $("glossaryFilter").dispatchEvent(new window.Event("input"));
  await tick(window);
  assert.ok(!$("glossaryChips").querySelector(".glossary-default-chips").classList.contains("hidden"),
    "filter with a match auto-expands the default section");

  $("glossaryFilter").value = "";
  $("glossaryFilter").dispatchEvent(new window.Event("input"));
  await tick(window);
  assert.ok($("glossaryChips").querySelector(".glossary-default-chips").classList.contains("hidden"),
    "clearing the filter restores the collapsed state — the manual toggle itself was never touched");
});

test("filter with no matches shows a hint instead of two empty sections", async () => {
  const { $, window } = await boot({
    getPresets: async () => ({ presets: [], defaultOutDir: "/tmp", hfToken: "", language: "ru", glossary: "Иван Петров, ClickHouse" }),
  });
  await tick(window);
  $("glossaryFilter").value = "zzz-no-such-term";
  $("glossaryFilter").dispatchEvent(new window.Event("input"));
  await tick(window);
  assert.match($("glossaryChips").textContent, /Ничего не найдено/);
  assert.equal($("glossaryCount").textContent, "0 из 2 терминов");
});

test("«Импорт/экспорт текстом» accepts a newline-separated paste and normalizes it to comma-joined on apply", async () => {
  let saved = null;
  const { $, window } = await boot({
    getPresets: async () => ({ presets: [], defaultOutDir: "/tmp", hfToken: "", language: "ru", glossary: "Mindbox" }),
    savePresets: async (data) => { saved = data; return true; },
  });
  await tick(window);
  $("glossary").value = "Mindbox\nИван Петров\n\nClickHouse";
  $("glossary").dispatchEvent(new window.Event("change"));
  await tick(window);
  assert.equal($("glossary").value, "Mindbox, Иван Петров, ClickHouse", "normalized to comma-joined on apply");
  assert.equal(saved.glossary, "Mindbox, Иван Петров, ClickHouse");
  const chips = Array.from($("glossaryChips").querySelectorAll(".chip-text")).map((el) => el.textContent);
  assert.deepEqual(chips, ["Mindbox", "Иван Петров", "ClickHouse"]);
});

// ── glossary: usage badges + cumulative persistence ─────────────────────────
test("a chip shows a usage badge («N×») when state.glossaryUsage has a count for it, and none when it doesn't", async () => {
  const { $, window } = await boot({
    getPresets: async () => ({
      presets: [], defaultOutDir: "/tmp", hfToken: "", language: "ru",
      glossary: "Иван Петров, Mindbox",
      glossaryUsage: { "иван петров": 12 },
    }),
  });
  await tick(window);
  const chips = Array.from($("glossaryChipsMine").querySelectorAll(".chip-text")).map((el) => el.textContent);
  assert.ok(chips.includes("Иван Петров 12×"), `expected a usage badge, got: ${chips}`);
  assert.ok(chips.includes("Mindbox"), "a term with no usage count has no badge");
});

test("a 'done' event's glossary_usage merges additively into state.glossaryUsage, re-renders badges, and persists", async () => {
  let saved = null;
  const { $, window, handlers } = await boot({
    getPresets: async () => ({
      presets: [], defaultOutDir: "/tmp", hfToken: "", language: "ru", glossary: "Иван Петров",
      glossaryUsage: { "иван петров": 3 },
    }),
    savePresets: async (data) => { saved = data; return true; },
  });
  await tick(window);
  handlers.process({
    event: "done", note: "/n.md", audio: "/a.wav", transcript: "t", summary: "s",
    glossary_usage: { "иван петров": 2 },
  });
  await tick(window);
  assert.deepEqual(saved.glossaryUsage, { "иван петров": 5 }, "merges additively, not overwrites");
  const chips = Array.from($("glossaryChipsMine").querySelectorAll(".chip-text")).map((el) => el.textContent);
  assert.deepEqual(chips, ["Иван Петров 5×"]);
});

test("glossaryUsage is forwarded to processAudio when running", async () => {
  let sent = null;
  const { window, $, handlers } = await boot({
    getPresets: async () => ({
      presets: [{ name: "P", prompt: "x" }], defaultOutDir: "/tmp", hfToken: "", language: "ru",
      glossary: "Иван Петров", glossaryUsage: { "иван петров": 7 },
    }),
    processAudio: async (opts) => { sent = opts; return { ok: true }; },
  });
  await tick(window);
  handlers.record({ event: "recorded", id: "r1", name: "Запись 1", file: "/tmp/mixed.wav", mic: "/tmp/m.wav", system: null, tracks: 1 });
  $("historyList").querySelector(".pending-play-btn").click();
  await tick(window);
  assert.ok(sent, "processAudio was not called");
  assert.deepEqual(sent.glossaryUsage, { "иван петров": 7 });
});

// ── glossary: "Мои" categories (V2 — «разбить по папочкам») ────────────────
// NB: test terms deliberately avoid every word in DEFAULT_GLOSSARY (e.g. Kafka,
// ClickHouse, GitLab, Notion are ALL default terms and would land in «Стандартные»,
// not «Мои») — "Иван Петров"/"Mindbox"/"Плов"/"Asana"/"Trello" are all custom.
test("«Мои» terms group into fixed category subheaders (name + count); a term with no assigned category lands under «Другое»", async () => {
  const { $, window } = await boot({
    getPresets: async () => ({
      presets: [], defaultOutDir: "/tmp", hfToken: "", language: "ru",
      glossary: "Иван Петров, Mindbox, Плов",
      glossaryCategories: { "иван петров": "Люди", "mindbox": "Продукты и инструменты" },
    }),
  });
  await tick(window);
  const mine = $("glossaryChipsMine");
  const headers = Array.from(mine.querySelectorAll(".glossary-category-header")).map((el) => el.textContent.trim());
  assert.deepEqual(headers, ["▾ Люди 1", "▾ Продукты и инструменты 1", "▾ Другое 1"],
    "only categories with ≥1 shown term render a subheader, in the fixed GLOSSARY_CATEGORIES order; " +
    "▾ = expanded by default (Task 4: «Мои» folders start open, unlike «Стандартные»)");
  const chips = Array.from(mine.querySelectorAll(".chip-text")).map((el) => el.textContent);
  assert.deepEqual(chips, ["Иван Петров", "Mindbox", "Плов"], "«Плов» has no glossaryCategories entry → falls into «Другое»");
});

test("an unrecognized/stale category value in glossaryCategories still resolves to «Другое» rather than rejecting the term", async () => {
  const { $, window } = await boot({
    getPresets: async () => ({
      presets: [], defaultOutDir: "/tmp", hfToken: "", language: "ru",
      glossary: "Mindbox",
      glossaryCategories: { "mindbox": "Кулинария" }, // not one of the fixed buckets
    }),
  });
  await tick(window);
  const headers = Array.from($("glossaryChipsMine").querySelectorAll(".glossary-category-header")).map((el) => el.textContent.trim());
  assert.deepEqual(headers, ["▾ Другое 1"]);
});

// ── glossary: "Мои" category folders collapse individually (Task 4) ────────────
test("«Мои» category folders start expanded and each collapses/expands independently on click", async () => {
  const { $, window } = await boot({
    getPresets: async () => ({
      presets: [], defaultOutDir: "/tmp", hfToken: "", language: "ru",
      glossary: "Иван Петров, Mindbox",
      glossaryCategories: { "иван петров": "Люди", "mindbox": "Продукты и инструменты" },
    }),
  });
  await tick(window);
  const mine = $("glossaryChipsMine");
  let groups = mine.querySelectorAll(".glossary-category-group");
  assert.equal(groups.length, 2);
  // expanded by default — unlike «Стандартные» — so the user's own terms stay discoverable
  groups.forEach((g) => assert.ok(!g.querySelector(".chip-list").classList.contains("hidden")));
  const peopleHeader = Array.from(mine.querySelectorAll(".glossary-category-header"))
    .find((el) => el.textContent.includes("Люди"));
  assert.equal(peopleHeader.querySelector(".glossary-caret").textContent, "▾");

  peopleHeader.click();
  await tick(window);
  groups = $("glossaryChipsMine").querySelectorAll(".glossary-category-group");
  const peopleGroup = Array.from(groups).find((g) => g.querySelector(".glossary-category-header").textContent.includes("Люди"));
  const toolsGroup = Array.from(groups).find((g) => g.querySelector(".glossary-category-header").textContent.includes("Продукты"));
  assert.ok(peopleGroup.querySelector(".chip-list").classList.contains("hidden"), "clicked category collapses");
  assert.equal(peopleGroup.querySelector(".glossary-caret").textContent, "▸");
  assert.ok(!toolsGroup.querySelector(".chip-list").classList.contains("hidden"), "the OTHER category is untouched");

  peopleGroup.querySelector(".glossary-category-header").click();
  await tick(window);
  const peopleGroupAgain = Array.from($("glossaryChipsMine").querySelectorAll(".glossary-category-group"))
    .find((g) => g.querySelector(".glossary-category-header").textContent.includes("Люди"));
  assert.ok(!peopleGroupAgain.querySelector(".chip-list").classList.contains("hidden"), "re-expands on a second click");
});

test("the live filter narrows terms within every «Мои» category group, and each subheader's count follows the filter", async () => {
  const { $, window } = await boot({
    getPresets: async () => ({
      presets: [], defaultOutDir: "/tmp", hfToken: "", language: "ru",
      glossary: "Иван Петров, Анна Смирнова, Asana, Trello",
      glossaryCategories: {
        "иван петров": "Люди", "анна смирнова": "Люди",
        "asana": "Продукты и инструменты", "trello": "Продукты и инструменты",
      },
    }),
  });
  await tick(window);
  $("glossaryFilter").value = "иван";
  $("glossaryFilter").dispatchEvent(new window.Event("input"));
  await tick(window);
  const mine = $("glossaryChipsMine");
  const headers = Array.from(mine.querySelectorAll(".glossary-category-header")).map((el) => el.textContent.trim());
  assert.deepEqual(headers, ["▾ Люди 1"], "«Продукты и инструменты» has zero matches under the filter → subheader hidden entirely");
  const chips = Array.from(mine.querySelectorAll(".chip-text")).map((el) => el.textContent);
  assert.deepEqual(chips, ["Иван Петров"]);
});

test("changing a chip's category via its per-chip select re-groups it under the new subheader and persists glossaryCategories", async () => {
  let saved = null;
  const { $, window } = await boot({
    getPresets: async () => ({ presets: [], defaultOutDir: "/tmp", hfToken: "", language: "ru", glossary: "Плов" }),
    savePresets: async (data) => { saved = data; return true; },
  });
  await tick(window);
  let headers = Array.from($("glossaryChipsMine").querySelectorAll(".glossary-category-header")).map((el) => el.textContent.trim());
  assert.deepEqual(headers, ["▾ Другое 1"], "starts uncategorized");
  const select = $("glossaryChipsMine").querySelector(".chip-category");
  select.value = "Термины";
  select.dispatchEvent(new window.Event("change"));
  await tick(window);
  headers = Array.from($("glossaryChipsMine").querySelectorAll(".glossary-category-header")).map((el) => el.textContent.trim());
  assert.deepEqual(headers, ["▾ Термины 1"]);
  assert.deepEqual(saved.glossaryCategories, { "плов": "Термины" });
});

test("«Стандартные» chips never render a per-chip category select (V1 flat behaviour unchanged)", async () => {
  const { $, window } = await boot({
    getPresets: async () => ({ presets: [], defaultOutDir: "/tmp", hfToken: "", language: "ru", glossary: "Mindbox, ClickHouse" }),
  });
  await tick(window);
  $("glossaryDefaultToggle").click();
  await tick(window);
  const defaultBox = $("glossaryChips").querySelector(".glossary-default-chips");
  assert.equal(defaultBox.querySelectorAll(".chip-category").length, 0);
  assert.equal($("glossaryChipsMine").querySelectorAll(".chip-category").length, 1, "only the «Мои» chip (Mindbox) gets one");
});

test("terms added via «Импорт/экспорт текстом» paste have no glossaryCategories entry and render under «Другое»", async () => {
  const { $, window } = await boot({
    getPresets: async () => ({ presets: [], defaultOutDir: "/tmp", hfToken: "", language: "ru", glossary: "" }),
  });
  await tick(window);
  $("glossaryToggleText").click();
  $("glossary").value = "Иван Петров, Mindbox";
  $("glossary").dispatchEvent(new window.Event("change"));
  await tick(window);
  const headers = Array.from($("glossaryChipsMine").querySelectorAll(".glossary-category-header")).map((el) => el.textContent.trim());
  assert.deepEqual(headers, ["▾ Другое 2"]);
});

// ── glossary: "Разложить по категориям" (auto-classify via backend LLM call) ─
test("«Разложить по категориям» sends only «Мои» terms, merges the validated result, and persists", async () => {
  let sentTerms = null;
  let saved = null;
  const { $, window } = await boot({
    getPresets: async () => ({
      // "деплой" is a DEFAULT_GLOSSARY term → «Стандартные» — must NOT be sent to classify.
      presets: [], defaultOutDir: "/tmp", hfToken: "", language: "ru", glossary: "Иван Петров, Mindbox, деплой",
    }),
    savePresets: async (data) => { saved = data; return true; },
    classifyGlossaryTerms: async (terms) => {
      sentTerms = terms;
      return { categories: { "иван петров": "Люди", "mindbox": "Продукты и инструменты", "выдуманный": "Люди" } };
    },
  });
  await tick(window);
  $("glossaryClassifyBtn").click();
  await tick(window);
  assert.deepEqual(sentTerms, ["Иван Петров", "Mindbox"], "only «Мои» terms are sent — «Стандартные» stays out of the batch");
  const headers = Array.from($("glossaryChipsMine").querySelectorAll(".glossary-category-header")).map((el) => el.textContent.trim());
  assert.deepEqual(headers, ["▾ Люди 1", "▾ Продукты и инструменты 1"],
    "«выдуманный» wasn't part of the batch (invention) — the renderer's own gate must drop it too");
  assert.deepEqual(saved.glossaryCategories, { "иван петров": "Люди", "mindbox": "Продукты и инструменты" });
});

test("«Разложить по категориям» coerces an out-of-set category from the backend to «Другое» instead of trusting it verbatim", async () => {
  const { $, window } = await boot({
    getPresets: async () => ({ presets: [], defaultOutDir: "/tmp", hfToken: "", language: "ru", glossary: "Mindbox" }),
    classifyGlossaryTerms: async () => ({ categories: { "mindbox": "Кулинария" } }),
  });
  await tick(window);
  $("glossaryClassifyBtn").click();
  await tick(window);
  const headers = Array.from($("glossaryChipsMine").querySelectorAll(".glossary-category-header")).map((el) => el.textContent.trim());
  assert.deepEqual(headers, ["▾ Другое 1"]);
});

test("«Разложить по категориям» degrades to an honest hint (no crash, no mutation) when the backend reports an error", async () => {
  const { $, window } = await boot({
    getPresets: async () => ({ presets: [], defaultOutDir: "/tmp", hfToken: "", language: "ru", glossary: "Mindbox" }),
    classifyGlossaryTerms: async () => ({ error: "LM Studio HTTP 503 — разбор по категориям недоступен" }),
  });
  await tick(window);
  $("glossaryClassifyBtn").click();
  await tick(window);
  assert.match($("glossaryHint").textContent, /Не удалось разложить по категориям/);
  const headers = Array.from($("glossaryChipsMine").querySelectorAll(".glossary-category-header")).map((el) => el.textContent.trim());
  assert.deepEqual(headers, ["▾ Другое 1"], "stays uncategorized — no partial/garbage mutation on failure");
});

test("«Разложить по категориям» is a no-op with a hint (not a crash) when there are no «Мои» terms to classify", async () => {
  let called = false;
  const { $, window } = await boot({
    getPresets: async () => ({ presets: [], defaultOutDir: "/tmp", hfToken: "", language: "ru", glossary: "деплой" }), // «Стандартные» only
    classifyGlossaryTerms: async () => { called = true; return { categories: {} }; },
  });
  await tick(window);
  $("glossaryClassifyBtn").click();
  await tick(window);
  assert.equal(called, false, "backend must not be called with an empty batch");
  assert.match($("glossaryHint").textContent, /Нет своих терминов/);
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

test("suggestion inbox at cap: newest terms survive, oldest pending entries are evicted (not the reverse)", async () => {
  const { $, window, handlers } = await boot({
    getPresets: async () => ({ presets: [], defaultOutDir: "/tmp", hfToken: "", language: "ru", glossary: "Mindbox" }),
  });
  await tick(window);
  const oldTerms = Array.from({ length: 100 }, (_, i) => `old-${i}`);
  handlers.process({ event: "done", note: "/n.md", audio: "/a.wav", transcript: "t", summary: "s",
    suggestions: oldTerms });
  await tick(window);
  let pending = Array.from($("glossarySuggestChips").querySelectorAll(".chip-text")).map((el) => el.textContent);
  assert.equal(pending.length, 100);
  assert.equal(pending[0], "old-0");

  // One more "done" brings 3 brand-new terms in — at 103 total, the cap must evict
  // the 3 oldest pending entries, not silently drop the new arrivals.
  handlers.process({ event: "done", note: "/n2.md", audio: "/a2.wav", transcript: "t2", summary: "s2",
    suggestions: ["new-1", "new-2", "new-3"] });
  await tick(window);
  pending = Array.from($("glossarySuggestChips").querySelectorAll(".chip-text")).map((el) => el.textContent);
  assert.equal(pending.length, 100);
  assert.ok(!pending.includes("old-0"), "oldest pending entry must be evicted");
  assert.ok(!pending.includes("old-1"));
  assert.ok(!pending.includes("old-2"));
  assert.ok(pending.includes("old-3"), "old-3..old-99 survive");
  assert.deepEqual(pending.slice(-3), ["new-1", "new-2", "new-3"], "new terms survive at the tail");
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
  handlers.record({ event: "recorded", id: "r1", name: "Запись 1", file: "/tmp/mixed.wav", mic: "/tmp/m.wav", system: "/tmp/s.wav", tracks: 2 });
  $("historyList").querySelector(".pending-play-btn").click();
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
  $("noteView").querySelector("#nvReprocess").click(); await tick(window); // opens the template picker
  $("noteView").querySelector("#reprocessConfirm").click(); await tick(window); // confirm → run
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
  handlers.record({ event: "recorded", id: "r1", name: "Запись 1", file: "/tmp/mixed.wav", mic: "/tmp/m.wav", system: null, tracks: 1 });
  $("historyList").querySelector(".pending-play-btn").click(); await tick(window);
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

test("История note view exposes a speaker editor; apply calls renameSpeakers and refreshes the note", async () => {
  let readCount = 0;
  let renamed = false; // content-keyed, not call-count-keyed — auto-open now reads the note once extra on entry
  let renamedArg = null;
  const { window, $ } = await boot({
    listHistory: async () => [{ name: "2026-01-01", base_stamp: "2026-01-01", title: "Синк", note: "/o/meeting-x.md", audio: "/o/meeting-x.wav" }],
    readNote: async () => {
      readCount++;
      return renamed
        ? '---\ntitle: "T"\n---\n\n**[Алёна]**: привет\n\n**[Спикер 2]**: пока'
        : '---\ntitle: "T"\n---\n\n**[Спикер 1]**: привет\n\n**[Спикер 2]**: пока';
    },
    renameSpeakers: async (notePath, map) => { renamedArg = { notePath, map }; renamed = true; return { ok: true }; },
  });
  window.document.querySelector('.topbtn[data-view="history"]').click(); await tick(window);
  $("historyList").querySelector(".rail-item").click(); await tick(window);
  assert.notEqual($("nvSpeakerMap").style.display, "none");
  const box = $("nvSpeakerInputs");
  const inputs = box.querySelectorAll("input");
  assert.equal(inputs.length, 2, "expected one input per detected speaker label");
  const readsBeforeRename = readCount;
  inputs[0].value = "Алёна";
  $("nvApplySpeakers").click();
  await tick(window); await tick(window);
  assert.ok(renamedArg, "renameSpeakers was not called");
  assert.equal(renamedArg.notePath, "/o/meeting-x.md");
  assert.equal(renamedArg.map["Спикер 1"], "Алёна");
  assert.equal(readCount, readsBeforeRename + 1, "note must be re-read after rename to refresh the view");
  assert.ok($("noteView").textContent.includes("Алёна"), "refreshed note view should show the new label");
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

// ── M4 arch-audit reverse cross-lock (critic-minor, PR #30) ─────────────────
// tests/test_backend.py's own cross-lock test checks ONE direction: every EVENTS.*
// constant main.js's dispatch references resolves to a name in events.json. The
// runtime assert inside backend.py's own emit() (backend.py:87-91) checks the other
// side, but only for code paths some test actually EXECUTES — an emit("typo", ...)
// call site on a branch nothing exercises would ship silently, contract violation
// and all. This closes that gap statically (no Python runtime, no code-path
// coverage needed): every literal event-name argument passed to emit() anywhere in
// backend.py's source is collected by regex and checked against events.json's
// contract directly, mirroring the mainutil "source-text" test idiom above but
// reading backend.py instead of main.js.
test("backend.py: every emit() call-site's literal event name is a member of events.json's contract (M4 reverse cross-lock)", () => {
  const backendSrc = fs.readFileSync(path.join(__dirname, "../backend.py"), "utf8");
  const contract = new Set(JSON.parse(fs.readFileSync(path.join(__dirname, "../events.json"), "utf8")).events);

  const calls = [...backendSrc.matchAll(/\bemit\("([a-z_-]+)"/g)].map((m) => m[1]);
  assert.ok(calls.length > 0, "sanity check: backend.py should have at least one emit() call site");

  const unknown = [...new Set(calls.filter((name) => !contract.has(name)))];
  assert.deepEqual(unknown, [],
    `backend.py's emit() calls a name outside events.json's contract: ${JSON.stringify(unknown)}`);
});

// ── settings "Бэкенд" section (installs the Python/ffmpeg env, see main.js) ──
test("Бэкенд: not-installed status renders a bad dot and the install button's default label", async () => {
  const { window, $ } = await boot({
    backendStatus: async () => ({ installed: false, pythonVersion: null, stale: false }),
  });
  $("settingsOpen").click();
  await tick(window);
  const row = $("backendStatusRow");
  assert.ok(row.querySelector(".pf-dot").classList.contains("bad"));
  assert.match(row.querySelector(".pf-detail").textContent, /не установлен/);
  assert.match($("backendInstallBtn").textContent, /Установить бэкенд/);
});

test("Бэкенд: installed + fresh status renders an ok dot with the python version, button relabels to reinstall", async () => {
  const { window, $ } = await boot({
    backendStatus: async () => ({ installed: true, pythonVersion: "3.11.15", stale: false }),
  });
  $("settingsOpen").click();
  await tick(window);
  const row = $("backendStatusRow");
  assert.ok(row.querySelector(".pf-dot").classList.contains("ok"));
  assert.match(row.querySelector(".pf-detail").textContent, /3\.11\.15/);
  assert.match($("backendInstallBtn").textContent, /Переустановить/);
});

test("Бэкенд: installed but stale (requirements.txt changed since install) renders a warn dot", async () => {
  const { window, $ } = await boot({
    backendStatus: async () => ({ installed: true, pythonVersion: "3.11.15", stale: true }),
  });
  $("settingsOpen").click();
  await tick(window);
  const row = $("backendStatusRow");
  assert.ok(row.querySelector(".pf-dot").classList.contains("warn"));
  assert.match(row.querySelector(".pf-detail").textContent, /требования изменились/);
});

// ── richer "показать КАКОЙ именно бэкенд" detail (ffmpeg version + env path) ──
test("Бэкенд: installed status shows the ffmpeg version alongside the python version", async () => {
  const { window, $ } = await boot({
    backendStatus: async () => ({
      installed: true, pythonVersion: "3.11.15", stale: false,
      envPath: "/Users/x/Library/Application Support/MeetingRecorder/backend-env", ffmpegVersion: "8.1",
    }),
  });
  $("settingsOpen").click();
  await tick(window);
  assert.match($("backendStatusRow").querySelector(".pf-detail").textContent, /ffmpeg 8\.1/);
  assert.match($("backendStatusDetail").textContent, /backend-env/, "env path must be shown somewhere in the section");
});

test("Бэкенд: ffmpegVersion null (binary missing) reads honestly instead of showing a blank/undefined", async () => {
  const { window, $ } = await boot({
    backendStatus: async () => ({
      installed: true, pythonVersion: "3.11.15", stale: false,
      envPath: "/Users/x/backend-env", ffmpegVersion: null,
    }),
  });
  $("settingsOpen").click();
  await tick(window);
  assert.match($("backendStatusRow").querySelector(".pf-detail").textContent, /не найден/);
});

test("Бэкенд: reinstall button is honestly labeled 'целиком' — the install is monolithic, no per-component reinstall exists", async () => {
  const { window, $ } = await boot({
    backendStatus: async () => ({ installed: true, pythonVersion: "3.11.15", stale: false, envPath: "/x", ffmpegVersion: "8.1" }),
  });
  $("settingsOpen").click();
  await tick(window);
  assert.match($("backendInstallBtn").textContent, /целиком/);
});

test("Бэкенд: clicking «Проверить» on an already-green, unchanged status still shows a fresh 'проверено HH:MM:SS' — not a no-op", async () => {
  const { window, $ } = await boot({
    backendStatus: async () => ({ installed: true, pythonVersion: "3.11.15", stale: false, envPath: "/x", ffmpegVersion: "8.1" }),
  });
  $("settingsOpen").click();
  await tick(window);
  const before = $("backendStatusDetail").textContent;
  assert.match(before, /проверено \d{1,2}:\d{2}:\d{2}/);
  $("backendRefresh").click();
  await tick(window);
  assert.match($("backendStatusDetail").textContent, /проверено \d{1,2}:\d{2}:\d{2}/, "must still show a checked-at marker after a repeat check");
});

test("Бэкенд: install button click calls installBackend and disables refresh/install until install-closed", async () => {
  let called = false;
  const { window, $, handlers } = await boot({
    installBackend: async () => { called = true; return { ok: true }; },
  });
  $("settingsOpen").click();
  await tick(window);
  $("backendInstallBtn").click();
  await tick(window);
  assert.equal(called, true);
  assert.equal($("backendRefresh").disabled, true);
  assert.equal($("backendInstallBtn").disabled, true);
  assert.ok(!$("backendCancelBtn").classList.contains("hidden"));

  handlers.installBackend({ event: "install-closed", code: 0, canceled: false });
  await tick(window);
  assert.equal($("backendRefresh").disabled, false);
  assert.equal($("backendInstallBtn").disabled, false);
  assert.ok($("backendCancelBtn").classList.contains("hidden"));
});

test("Бэкенд: cancel button calls cancelInstallBackend while a run is in flight", async () => {
  let canceled = false;
  const { window, $ } = await boot({
    installBackend: async () => new Promise(() => {}), // never resolves — simulates an in-flight install
    cancelInstallBackend: async () => { canceled = true; return { ok: true }; },
  });
  $("settingsOpen").click();
  await tick(window);
  $("backendInstallBtn").click();
  await tick(window);
  $("backendCancelBtn").click();
  await tick(window);
  assert.equal(canceled, true);
});

test("Бэкенд: stage/stage_end/log events populate the scrolling log and live status text", async () => {
  const { window, $, handlers } = await boot();
  $("settingsOpen").click();
  await tick(window);
  $("backendInstallBtn").click();
  await tick(window);
  handlers.installBackend({ event: "stage", stage: "python", msg: "Скачиваю Python…" });
  assert.equal($("backendInstallStatus").textContent, "Скачиваю Python…");
  assert.match($("backendInstallLog").textContent, /Скачиваю Python…/);

  handlers.installBackend({ event: "download-progress", stage: "python", pct: 42 });
  assert.equal($("backendInstallStatus").textContent, "python: 42%");

  handlers.installBackend({ event: "stage_end", stage: "python", status: "ok", msg: "готово" });
  assert.match($("backendInstallLog").textContent, /✅ готово/);

  handlers.installBackend({ event: "log", msg: "Collecting torch==2.11.0" });
  assert.match($("backendInstallLog").textContent, /Collecting torch==2\.11\.0/);
});

test("Бэкенд: install-closed re-checks status and preflight (backendInstalled feeds the readiness verdict)", async () => {
  let statusCalls = 0;
  let preflightCalls = 0;
  const { window, $, handlers } = await boot({
    backendStatus: async () => { statusCalls++; return { installed: true, pythonVersion: "3.11.15", stale: false }; },
    preflight: async () => { preflightCalls++; return { lmStudio: true, mic: "granted", screen: "granted", ffmpeg: true, whisperCached: true, hfToken: true, embedModel: true, backendInstalled: true }; },
  });
  $("settingsOpen").click();
  await tick(window);
  const before = statusCalls;
  const beforePf = preflightCalls;
  handlers.installBackend({ event: "install-closed", code: 0, canceled: false });
  await tick(window);
  assert.ok(statusCalls > before, "backendStatus must be re-queried after install-closed");
  assert.ok(preflightCalls > beforePf, "preflight must be re-queried after install-closed (feeds the readiness verdict)");
});

test("Бэкенд: a failed installBackend() call surfaces the error and re-enables buttons", async () => {
  const { window, $ } = await boot({
    installBackend: async () => ({ ok: false, error: "Мало места на диске" }),
  });
  let alerted = null;
  window.alert = (msg) => { alerted = msg; };
  $("settingsOpen").click();
  await tick(window);
  $("backendInstallBtn").click();
  await tick(window);
  assert.equal(alerted, "Мало места на диске");
  assert.equal($("backendInstallBtn").disabled, false);
});

test("Бэкенд: disk-warning event alerts the message", async () => {
  const { window, $, handlers } = await boot();
  let alerted = null;
  window.alert = (msg) => { alerted = msg; };
  $("settingsOpen").click();
  await tick(window);
  handlers.installBackend({ event: "disk-warning", msg: "⚠️ Мало места на диске (свободно 4.2 ГБ)" });
  assert.equal(alerted, "⚠️ Мало места на диске (свободно 4.2 ГБ)");
});

// ── main.js backend-installer wiring (source-text checks — see the model-download
// block above for why: main.js requires("electron") and can't load headless) ──
test("main.js: install-backend refuses while recording/processing/model-download/another install is active", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const installBackend = mainSrc.match(/ipcMain\.handle\("install-backend"[\s\S]*?\n\}\);/)[0];
  assert.match(installBackend, /\[!!installBackendProc, "Установка уже идёт"\]/);
  assert.match(installBackend, /\[!!\(recordProc \|\| tee\), "Дождитесь окончания записи"\]/);
  assert.match(installBackend, /\[!!procProc, "Дождитесь окончания обработки"\]/);
  assert.match(installBackend, /\[!!modelDlProc, "Дождитесь окончания скачивания моделей"\]/);
});

test("main.js: cancel-install-backend sets installBackendCanceled and kills the tracked step", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const cancel = mainSrc.match(/ipcMain\.handle\("cancel-install-backend"[\s\S]*?\n\}\);/)[0];
  assert.match(cancel, /installBackendCanceled = true/);
  assert.match(cancel, /installBackendProc\.kill\(\)/);
});

test("main.js: backend-status and uninstall-backend handlers exist", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  assert.match(mainSrc, /ipcMain\.handle\("backend-status"/);
  assert.match(mainSrc, /ipcMain\.handle\("uninstall-backend"/);
});

// ── richer backend-status payload (settings "Бэкенд" — "показать КАКОЙ именно
// бэкенд"): env path + real ffmpeg version, both only once actually installed ──
test("main.js: backend-status reports envPath/ffmpegVersion only when installed, null otherwise", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const handler = mainSrc.match(/ipcMain\.handle\("backend-status"[\s\S]*?\n\}\);/)[0];
  assert.match(handler, /if \(!status\.installed\) return \{ \.\.\.status, envPath: null, ffmpegVersion: null \}/);
  assert.match(handler, /envPath: BACKEND_ENV/);
  assert.match(handler, /ffmpegVersion: await getFfmpegVersion\(INSTALLED_FFMPEG\)/);
});

test("main.js: getFfmpegVersion parses stdout via the shared parseFfmpegVersion helper and never throws on a missing binary", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const fn = mainSrc.match(/function getFfmpegVersion\([\s\S]*?\n\}/)[0];
  assert.match(fn, /parseFfmpegVersion\(out\)/);
  assert.match(fn, /proc\.on\("error", \(\) => resolve\(null\)\)/);
});

// ── per-model on-disk size (settings "Модели" — "добавить размер на диске") ──
test("main.js: models handler augments each item with sizeBytes computed via modelCacheDirsFor/dirSizeBytes, 0 when not cached", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const handler = mainSrc.match(/ipcMain\.handle\("models"[\s\S]*?\n\}\);/)[0];
  assert.match(handler, /modelCacheDirsFor\(home, item\.id\)/);
  assert.match(handler, /dirSizeBytes\(dir\)/);
  assert.match(handler, /sizeBytes: item\.cached\s*\n?\s*\?/, "sizeBytes must be gated on item.cached — 0 (not a wasted fs walk) otherwise");
});

// ── per-model forced reinstall (settings "Модели" — per-model "↻ Скачать заново") ──
test("main.js: redownload-model wipes the model's cache via cleanupPartialModelCache BEFORE the batch actually spawns, never on a refused call", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const handler = mainSrc.match(/ipcMain\.handle\("redownload-model"[\s\S]*?\n\}\);/)[0];
  assert.match(handler, /cleanupPartialModelCache\(os\.homedir\(\), modelId\)/);
  assert.match(handler, /runModelDownloadBatch\(\[modelId\], /,
    "the wipe must be passed as runModelDownloadBatch's beforeStart hook, not run unconditionally before the guard checks");
  // The wipe callback must live INSIDE runModelDownloadBatch's own guarded body
  // (via beforeStart), not fire directly in this thin handler — otherwise a
  // busy/low-disk refusal would still wipe a working cache with nothing to
  // replace it (see runModelDownloadBatch's own beforeStart comment in main.js).
  assert.ok(!/cleanupPartialModelCache\(os\.homedir\(\), modelId\);\s*\n\s*return runModelDownloadBatch/.test(handler),
    "cleanup must not run unconditionally before the guarded batch call");
});

test("main.js: runModelDownloadBatch's beforeStart hook fires only after every busy guard and the disk check have passed", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const fn = mainSrc.match(/async function runModelDownloadBatch\([\s\S]*?\n\}/)[0];
  const guardIdx = fn.lastIndexOf('if (diskVerdict.action === "refuse")');
  const beforeStartIdx = fn.indexOf("if (beforeStart) beforeStart();");
  assert.ok(guardIdx >= 0 && beforeStartIdx > guardIdx,
    "beforeStart() must run after the disk-refuse check, not before it");
});

test("main.js: process-audio refuses when no backend interpreter is available, and while an install is in flight", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const processAudio = mainSrc.match(/ipcMain\.handle\("process-audio"[\s\S]*?\n\}\);/)[0];
  assert.match(processAudio, /\[!!installBackendProc, "Дождитесь окончания установки бэкенда"\]/);
  assert.match(processAudio, /if \(!backendAvailable\(\)\) return/);
});

// ── H3a arch-audit: file-stability gate (TODO.md incident — mixed.wav still being
// written when process-audio's own mono-conversion cache snapshotted it mid-write) ──
test("main.js: process-audio refuses when audioFile IS the currently-in-flight mix's target (mixInFlight + session.mixedPath match)", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const processAudio = mainSrc.match(/ipcMain\.handle\("process-audio"[\s\S]*?\n\}\);/)[0];
  assert.match(processAudio, /if \(mixInFlight && session && audioFile === session\.mixedPath\) \{/);
});
test("main.js: process-audio refuses when the input file's size is still changing (isFileStable gate), even when it's not this app's own in-flight mix", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const processAudio = mainSrc.match(/ipcMain\.handle\("process-audio"[\s\S]*?\n\}\);/)[0];
  assert.match(processAudio, /isFileStable\(\s*\n\s*audioFile, FILE_STABILITY_WAIT_MS,/);
  assert.match(processAudio, /if \(!stable\) return \{ ok: false, error: "Файл ещё дописывается — подождите и повторите" \};/);
});

// ── H3b arch-audit: cache key folds in a content fingerprint, not just path:size:mtime ──
test("main.js: cacheDirFor's tag includes contentFingerprint(audioFile), not just path:size:mtime", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const cacheDirFor = mainSrc.match(/function cacheDirFor\([\s\S]*?\n\}/)[0];
  assert.match(cacheDirFor, /contentFingerprint\(audioFile\)/);
});

test("main.js: process-audio forwards --fast-model to the backend spawn only when fastModel is non-empty", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const processAudio = mainSrc.match(/ipcMain\.handle\("process-audio"[\s\S]*?\n\}\);/)[0];
  assert.match(processAudio, /if \(fastModel\) args\.push\("--fast-model", fastModel\)/);
});

test("main.js: process-audio forwards --main-model to the backend spawn only when mainModel is non-empty", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const processAudio = mainSrc.match(/ipcMain\.handle\("process-audio"[\s\S]*?\n\}\);/)[0];
  assert.match(processAudio, /if \(mainModel\) args\.push\("--main-model", mainModel\)/);
});

test("main.js: para-classify forwards --main-model to the backend spawn only when mainModel is non-empty", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const paraClassify = mainSrc.match(/ipcMain\.handle\("para-classify"[\s\S]*?\n\}\);/)[0];
  assert.match(paraClassify, /if \(mainModel\) args\.push\("--main-model", mainModel\)/);
});

// ── critic-minor, PR #30: para-classify read root/folders without containment ──
test("main.js: para-classify validates root against readParaRoot() before it ever drives a readdirSync (critic-minor, PR #30)", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const paraClassify = mainSrc.match(/ipcMain\.handle\("para-classify"[\s\S]*?\n\}\);/)[0];
  assert.match(paraClassify, /isPathInsideRoots\(resolvedRoot, \[readParaRoot\(\)\]\.filter\(Boolean\)\)/,
    "root must be checked against the server's OWN configured PARA vault, not trusted as sent by the renderer");
  assert.match(paraClassify, /isPathInsideRoots\(dir, \[resolvedRoot\]\)/,
    "the per-category dir (root + folders[cat]) must be re-checked too — folders[cat] can carry a '../' segment");
});

test("main.js: para-search forwards --main-model to the backend spawn only when mainModel is non-empty", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const paraSearch = mainSrc.match(/ipcMain\.handle\("para-search"[\s\S]*?\n\}\);/)[0];
  assert.match(paraSearch, /if \(mainModel\) args\.push\("--main-model", mainModel\)/);
});

// ── H1 arch-audit: PARA handlers that spawn runBackend() (pythonBin()) but had NO
// busy guard at all before — vulnerable to the interpreter-overwrite-during-install
// race (see busyVerdict's comment in lib/mainutil.js). para-file spawns no backend
// process at all (pure fs), so it's guarded against procProc instead (a concurrent
// reprocess rewriting the same note/audio path), mirroring delete-history-note/
// delete-history-recording's own procProc guard.
test("main.js: para-classify refuses while a backend install is in flight (spawns runBackend())", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const paraClassify = mainSrc.match(/ipcMain\.handle\("para-classify"[\s\S]*?\n\}\);/)[0];
  assert.match(paraClassify, /\[!!installBackendProc, "Дождитесь окончания установки бэкенда"\]/);
});
test("main.js: para-extract handler is fully removed (extract retired with the accumulator scheme)", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  assert.doesNotMatch(mainSrc, /ipcMain\.handle\("para-extract"/);
});
test("main.js: classify-glossary-terms refuses while a backend install is in flight (spawns runBackend())", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const handler = mainSrc.match(/ipcMain\.handle\("classify-glossary-terms"[\s\S]*?\n\}\);/)[0];
  assert.match(handler, /\[!!installBackendProc, "Дождитесь окончания установки бэкенда"\]/);
});
test("main.js: para-file refuses while a reprocess (procProc) is active — it never spawns runBackend() itself, but moves the same note/audio path a reprocess may be writing", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const paraFile = mainSrc.match(/ipcMain\.handle\("para-file"[\s\S]*?\n\}\);/)[0];
  assert.match(paraFile, /\[!!procProc, "Дождитесь окончания обработки"\]/);
});

// ── H2 arch-audit: general path containment (isPathInsideRoots) applied to every
// renderer-supplied-path handler that reads/writes/reveals a file, not just the
// delete handlers (which already had isNoteDeletable/isAudioDeletable) ──────────
test("main.js: read-note validates notePath via isPathInsideRoots before reading, fails closed to null", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const readNote = mainSrc.match(/ipcMain\.handle\("read-note"[\s\S]*?\n\}\);/)[0];
  assert.match(readNote, /isPathInsideRoots\(resolved, roots\)/);
  assert.match(readNote, /if \(!isPathInsideRoots\(resolved, roots\)\) return null;/);
});
test("main.js: rename-speakers validates notePath via isPathInsideRoots before reading/writing", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const renameSpeakers = mainSrc.match(/ipcMain\.handle\("rename-speakers"[\s\S]*?\n\}\);/)[0];
  assert.match(renameSpeakers, /isPathInsideRoots\(resolved, roots\)/);
});
test("main.js: reveal validates the path via isPathInsideRoots before shell.showItemInFolder", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const reveal = mainSrc.match(/ipcMain\.handle\("reveal"[\s\S]*?\n\}\);/)[0];
  assert.match(reveal, /isPathInsideRoots\(resolved, roots\)/);
  assert.match(reveal, /shell\.showItemInFolder\(resolved\)/);
});
test("main.js: para-classify validates its --note arg via isPathInsideRoots before spawning the backend", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const paraClassify = mainSrc.match(/ipcMain\.handle\("para-classify"[\s\S]*?\n\}\);/)[0];
  assert.match(paraClassify, /isPathInsideRoots\(resolvedNote, roots\)/);
  assert.match(paraClassify, /"classify", "--note", resolvedNote/);
});
test("main.js: para-file validates root against the server's OWN configured PARA vault root (readParaRoot()), and note/audio against out_dir/vault roots", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const paraFile = mainSrc.match(/ipcMain\.handle\("para-file"[\s\S]*?\n\}\);/)[0];
  assert.match(paraFile, /const configuredVaultRoot = readParaRoot\(\);/);
  assert.match(paraFile, /isPathInsideRoots\(resolvedRoot, \[configuredVaultRoot\]\.filter\(Boolean\)\)/);
  assert.match(paraFile, /isPathInsideRoots\(resolvedSrc, srcRoots\)/);
  // write destination must be built off the VALIDATED resolvedRoot, not the raw arg
  // (T4-T6, ux-para-batch: folder-hierarchy builder replaces the old flat accum path),
  // and the FINAL computed destDir gets its own containment re-check before mkdirSync.
  assert.match(paraFile, /paraDestinationDir\(\{ category, folders, project, kind, person, mission, stamp: stamp \|\| note \}\)/);
  assert.match(paraFile, /path\.join\(resolvedRoot, \.\.\.destSegments\)/);
  assert.match(paraFile, /if \(!isPathInsideRoots\(destDir, \[resolvedRoot\]\)\)/);
});

test("main.js: list-lm-models IPC GETs LM Studio's /api/v0/models with a 3s timeout, filters out embeddings, and degrades to [] on failure", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const handler = mainSrc.match(/ipcMain\.handle\("list-lm-models"[\s\S]*?\n\}\);/)[0];
  assert.match(handler, /localhost:1234\/api\/v0\/models/);
  assert.match(handler, /setTimeout\(\(\) => ctrl\.abort\(\), 3000\)/);
  assert.match(handler, /m\.type !== "embeddings"/);
  assert.match(handler, /catch \{\s*\n\s*return \[\];\s*\n\s*\}/);
});

// ── setup gate (hard wall) ───────────────────────────────────────────────────
test("main.js: process-audio refuses diarize when pyannote models aren't cached (per-run gate, separate from the setup wall)", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const processAudio = mainSrc.match(/ipcMain\.handle\("process-audio"[\s\S]*?\n\}\);/)[0];
  assert.match(processAudio, /if \(diarize && !diarizationCached\(\)\) \{\s*\n\s*return \{ ok: false/);
});

test("main.js: app-readiness IPC exists and derives its verdict from appReadinessStatus(backendAvailable(), whisperCached(), vadCached())", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const handler = mainSrc.match(/ipcMain\.handle\("app-readiness"[\s\S]*?\n\}\);/);
  assert.ok(handler, "app-readiness handler not found");
  assert.match(handler[0], /appReadinessStatus\(backendAvailable\(\), whisperCached\(\), vadCached\(\)\)/);
});

test("main.js: start-recording and download-models also refuse while a backend install is in flight (both spawn pythonBin())", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const startRecording = mainSrc.match(/ipcMain\.handle\("start-recording"[\s\S]*?\n  const micDevice/)[0];
  const downloadModels = mainSrc.match(/async function runModelDownloadBatch\([\s\S]*?\n\}/)[0];
  assert.match(startRecording, /\[!!installBackendProc, "Дождитесь окончания установки бэкенда"\]/);
  assert.match(downloadModels, /\[!!installBackendProc, "Дождитесь окончания установки бэкенда"\]/);
});

test("main.js: installBackendProc is killed in before-quit alongside the other tracked children", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const beforeQuit = mainSrc.match(/app\.on\("before-quit"[\s\S]*?\n\}\);/)[0];
  assert.match(beforeQuit, /installBackendProc/);
});

test("main.js: pythonBin/ffmpegBin resolve through the installed userData backend env before falling back", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  assert.match(mainSrc, /function pythonBin\(\) \{\s*\n\s*return resolvePythonBin\(/);
  assert.match(mainSrc, /function ffmpegBin\(\) \{\s*\n\s*return resolveFfmpegBin\(INSTALLED_FFMPEG,/);
  assert.match(mainSrc, /const BACKEND_ENV = path\.join\(app\.getPath\("userData"\), "backend-env"\)/);
});

// ── regression lock: partial/cancelled install must never read as "installed"
// or shadow the dev venv (critic-flagged blocker) ───────────────────────────
test("main.js: pythonBin() gates the installed interpreter on BACKEND_MARKER too, not existence alone", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const pythonBinFn = mainSrc.match(/function pythonBin\(\) \{[\s\S]*?\n\}/)[0];
  assert.match(pythonBinFn, /fs\.existsSync\(INSTALLED_PYTHON\)/);
  assert.match(pythonBinFn, /fs\.existsSync\(BACKEND_MARKER\)/);
});

test("main.js: backendAvailable() requires BOTH the installed interpreter and the marker for the userData path (agrees with backend-status)", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const fn = mainSrc.match(/function backendAvailable\(\) \{[\s\S]*?\n\}/)[0];
  assert.match(fn, /fs\.existsSync\(INSTALLED_PYTHON\)\s*&&\s*fs\.existsSync\(BACKEND_MARKER\)/);
  assert.match(fn, /fs\.existsSync\(VENV_PYTHON\)/, "dev-venv fallback must still work");
});

test("main.js: install-backend stages into a sibling dir and only atomic-renames onto BACKEND_ENV after the marker is written — a partial install never lands at the resolved path", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const runInstall = mainSrc.match(/async function runInstallBackend\(\) \{[\s\S]*?\n\}\n/)[0];
  assert.match(runInstall, /BACKEND_ENV_STAGING/, "must stage into a separate dir, not write BACKEND_ENV directly");
  // marker written before the rename, rename happens after
  const markerIdx = runInstall.indexOf("writeJsonAtomic(stagingMarker");
  const renameIdx = runInstall.indexOf("fs.renameSync(BACKEND_ENV_STAGING, BACKEND_ENV)");
  assert.ok(markerIdx > 0, "marker must be written into staging");
  assert.ok(renameIdx > markerIdx, "the swap-in rename must happen AFTER the marker is written, not before");
});

test("main.js: a failed/cancelled install cleans up the staging dir (no partial env survives)", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const runInstall = mainSrc.match(/async function runInstallBackend\(\) \{[\s\S]*?\n\}\n/)[0];
  const finallyBlock = runInstall.match(/\} finally \{[\s\S]*?\n  \}/)[0];
  assert.match(finallyBlock, /fs\.rmSync\(BACKEND_ENV_STAGING,/);
});

test("main.js: mkdtempSync lives inside runInstallBackend's own try (a throw there must still clear installBackendProc/Canceled)", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const runInstall = mainSrc.match(/async function runInstallBackend\(\) \{[\s\S]*?\n\}\n/)[0];
  const tryIdx = runInstall.indexOf("try {");
  const mkdtempIdx = runInstall.indexOf("fs.mkdtempSync(");
  assert.ok(tryIdx >= 0 && mkdtempIdx > tryIdx, "mkdtempSync must appear after the try { so a throw there is still caught");
});

test("main.js: install-backend's fire-and-forget runInstallBackend() call has a .catch() safety net", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const handler = mainSrc.match(/ipcMain\.handle\("install-backend"[\s\S]*?\n\}\);/)[0];
  assert.match(handler, /runInstallBackend\(\)\s*\n?\s*\.catch\(/);
});

test("main.js: runBackend prepends the resolved ffmpeg's dir to PATH so backend.py's shutil.which finds it", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const runBackend = mainSrc.match(/function runBackend\([\s\S]*?\n\}/)[0];
  assert.match(runBackend, /ffmpegBin\(\)/);
  assert.match(runBackend, /env\.PATH = /);
});

test("main.js: preflight reports backendInstalled via backendAvailable()", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const preflight = mainSrc.match(/ipcMain\.handle\("preflight"[\s\S]*?\n\}\);/)[0];
  assert.match(preflight, /backendInstalled: backendAvailable\(\)/);
});

test("main.js: request-mic-access triggers the native TCC prompt via askForMediaAccess", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const handler = mainSrc.match(/ipcMain\.handle\("request-mic-access"[\s\S]*?\n\}\);/)[0];
  assert.match(handler, /systemPreferences\.askForMediaAccess\("microphone"\)/);
});

test("main.js: open-privacy-settings deep-links to the microphone and screen-capture panes", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const handler = mainSrc.match(/ipcMain\.handle\("open-privacy-settings"[\s\S]*?\n\}\);/)[0];
  assert.match(handler, /x-apple\.systempreferences:com\.apple\.preference\.security\?Privacy_Microphone/);
  assert.match(handler, /x-apple\.systempreferences:com\.apple\.preference\.security\?Privacy_ScreenCapture/);
  assert.match(handler, /shell\.openExternal\(url\)/);
});

// ── keychain double-prompt fix (loadToken/isEncryptionAvailable caching) ────
// main.js requires("electron") and can't be loaded headless (same reason as the
// other "main.js: ..." source-text checks above) — safeStorage itself can't be
// exercised without a real keychain either, so these assert on the guard/cache
// structure directly rather than behavior through a mock.
test("main.js: loadToken() short-circuits before touching safeStorage when SECRET_FILE is absent", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const loadToken = mainSrc.match(/function loadToken\(\)[\s\S]*?\n\}/)[0];
  const guardIdx = loadToken.indexOf("if (!fs.existsSync(SECRET_FILE))");
  const safeStorageIdx = loadToken.indexOf("safeStorage.");  // "." excludes the mention in the guard's own comment
  assert.ok(guardIdx >= 0, "loadToken must guard on fs.existsSync(SECRET_FILE)");
  assert.ok(safeStorageIdx > guardIdx, "the existsSync guard must precede any safeStorage access");
});

test("main.js: loadToken()/isEncryptionAvailable() are cached module-level so each launch touches the keychain at most once", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  assert.match(mainSrc, /let _tokenCache = null/);
  assert.match(mainSrc, /let _encAvailableCache = null/);
  const loadToken = mainSrc.match(/function loadToken\(\)[\s\S]*?\n\}/)[0];
  assert.match(loadToken, /if \(_tokenCache !== null\) return _tokenCache;/);
  const encAvail = mainSrc.match(/function encryptionAvailable\(\)[\s\S]*?\n\}/)[0];
  assert.match(encAvail, /if \(_encAvailableCache === null\) _encAvailableCache = safeStorage\.isEncryptionAvailable\(\);/);
});

test("main.js: saveToken() invalidates the token cache so a changed/cleared secret is re-read next time", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const saveToken = mainSrc.match(/function saveToken\(token\)[\s\S]*?\n\}/)[0];
  assert.match(saveToken, /_tokenCache = null/);
});

// L7 arch-audit: saveToken()'s catch used to swallow a failed keychain/file
// write with no way for the caller to learn about it — it must now return the
// error string (not throw, not silently return undefined for a real failure),
// and save-presets must surface that as {ok:false, error} instead of bare true.
test("main.js: saveToken() returns the error string on a failed write instead of silently swallowing it", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const saveToken = mainSrc.match(/function saveToken\(token\)[\s\S]*?\n\}/)[0];
  assert.match(saveToken, /\} catch \(e\) \{\s*\n\s*return String\(\(e && e\.message\) \|\| e\);\s*\n\s*\}/);
  assert.doesNotMatch(saveToken, /\} catch \{\}\s*\n\}/, "the outer catch must no longer be an empty swallow");
});
test("main.js: save-presets returns {ok:false, error} when saveToken fails, {ok:true} otherwise — not bare `true`", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const handler = mainSrc.match(/ipcMain\.handle\("save-presets"[\s\S]*?\n\}\);/)[0];
  assert.match(handler, /const tokenError = saveToken\(hfToken \|\| ""\);/);
  assert.match(handler, /if \(tokenError\) return \{ ok: false, error: /);
  assert.match(handler, /return \{ ok: true \};/);
});

test("main.js: every safeStorage.* call site is funneled through encryptionAvailable()/saveToken()/loadToken() — no stray direct calls", () => {
  // A regression guard: a new direct safeStorage call added elsewhere (e.g. in a
  // future handler) would reintroduce the double keychain-prompt bug this fixes.
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const callSites = mainSrc.match(/safeStorage\.\w+\(/g) || [];
  assert.equal(callSites.length, 3, `expected exactly 3 safeStorage.* call sites (inside encryptionAvailable/saveToken/loadToken), found ${callSites.length}`);
});

test("main.js: preflight and get-presets read the token/encryption-availability via the cached helpers, not raw safeStorage", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const preflight = mainSrc.match(/ipcMain\.handle\("preflight"[\s\S]*?\n\}\);/)[0];
  assert.match(preflight, /loadToken\(\)/);
  assert.ok(!/safeStorage\./.test(preflight), "preflight must not call safeStorage directly");
  const loadPresetsData = mainSrc.match(/function loadPresetsData\(\)[\s\S]*?\n\}/)[0];
  assert.match(loadPresetsData, /loadToken\(\)/);
  assert.match(loadPresetsData, /encryptionAvailable\(\)/);
  assert.ok(!/safeStorage\./.test(loadPresetsData), "loadPresetsData must not call safeStorage directly");
});

// ── keychain prompt on EVERY launch even with no HF token ever set (regression:
// encryptionAvailable() used to be called unconditionally from loadPresetsData(),
// so isEncryptionAvailable() — a keychain touch — fired on a fresh install with no
// .secret file at all, on every single launch) ─────────────────────────────────
test("main.js: loadPresetsData() gates every encryptionAvailable() call on token truthiness — no bare/unconditional call survives on either return path", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const loadPresetsData = mainSrc.match(/function loadPresetsData\(\)[\s\S]*?\n\}/)[0];

  // Every mention of encryptionAvailable() in the function must be the token-gated
  // ternary form — a bare `encryptionAvailable()` (unconditional call) would mean a
  // no-token launch still touches safeStorage.isEncryptionAvailable().
  const allCalls = loadPresetsData.match(/[\w.]*encryptionAvailable\(\)/g) || [];
  const gatedCalls = loadPresetsData.match(/token \? encryptionAvailable\(\) : false/g) || [];
  assert.ok(allCalls.length >= 2, "expected encryptionAvailable() on both the fallback and normal-load return paths");
  assert.equal(allCalls.length, gatedCalls.length,
    `found ${allCalls.length} encryptionAvailable() mention(s) but only ${gatedCalls.length} are token-gated — a bare call would keychain-prompt on every launch even with no token`);

  // The missing-presets-file fallback path resolves `token` via loadToken() before
  // returning, so the ternary above actually has a `token` binding to gate on.
  const fallbackBranch = loadPresetsData.match(/catch \{\s*const token = loadToken\(\);\s*\n[\s\S]*?\n\s*\}\s*\n\s*\}/);
  assert.ok(fallbackBranch, "expected `const token = loadToken()` bound before the fallback's gated return");
});

// ── stable per-preset ids (prompts-tab / reprocess-picker feature) ──────────
test("main.js: loadPresetsData() backfills crypto.randomUUID() ids onto presets missing one, and persists the backfill", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const loadPresetsData = mainSrc.match(/function loadPresetsData\(\)[\s\S]*?\n\}/)[0];
  assert.match(loadPresetsData, /!p\.id/, "expected a check for presets missing an id");
  assert.match(loadPresetsData, /crypto\.randomUUID\(\)/, "expected the backfill to mint a crypto.randomUUID()");
  assert.match(loadPresetsData, /writeJsonAtomic\(PRESETS_FILE/, "backfill must be persisted, not just held in memory");
  assert.ok(!/safeStorage\./.test(loadPresetsData), "the backfill must not touch safeStorage");
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

test("Модели: per-row action button — «⬇» for needed, «↻» scoped reinstall for cached, none for locked", async () => {
  const { window, $ } = await boot();
  $("settingsOpen").click();
  await tick(window);
  assert.equal($("model-row-diarization").querySelector(".pf-retry"), null, "locked row must not offer any action button");
  assert.equal($("model-row-whisper").querySelector(".pf-retry").textContent, "↻",
    "cached row offers a scoped reinstall, not the missing-model download button");
  assert.equal($("model-row-vad").querySelector(".pf-retry").textContent, "⬇", "needed row keeps the download button");
});

test("Модели: cached row's «↻» calls redownloadModel(modelId), not downloadModels", async () => {
  let redownloadCalled = null;
  let downloadCalled = null;
  const { window, $ } = await boot({
    redownloadModel: async (modelId) => { redownloadCalled = modelId; return { ok: true }; },
    downloadModels: async (opts) => { downloadCalled = opts; return { ok: true }; },
  });
  $("settingsOpen").click();
  await tick(window);
  $("model-row-whisper").querySelector(".pf-retry").click();
  await tick(window);
  assert.equal(redownloadCalled, "whisper");
  assert.equal(downloadCalled, null, "a cached-row reinstall must not go through the ordinary downloadModels path");
});

test("Модели: cached row's size on disk renders when the main process reports sizeBytes", async () => {
  const { window, $ } = await boot({
    getModels: async () => ([
      { id: "whisper", label: "MLX Whisper (large-v3-turbo)", size_mb: 1500, needs_token: false, cached: true, locked: false, sizeBytes: 1610612736 },
      { id: "vad", label: "Silero VAD", size_mb: 35, needs_token: false, cached: true, locked: false, sizeBytes: 36700160 },
    ]),
  });
  $("settingsOpen").click();
  await tick(window);
  assert.match($("model-row-whisper").querySelector(".pf-detail").textContent, /1\.5 ГБ/);
  assert.match($("model-row-vad").querySelector(".pf-detail").textContent, /35 МБ/);
});

test("Модели: cached row with no sizeBytes (e.g. an older main.js) still renders 'скачано' without a bogus size", async () => {
  const { window, $ } = await boot({
    getModels: async () => ([
      { id: "whisper", label: "MLX Whisper (large-v3-turbo)", size_mb: 1500, needs_token: false, cached: true, locked: false },
    ]),
  });
  $("settingsOpen").click();
  await tick(window);
  assert.equal($("model-row-whisper").querySelector(".pf-detail").textContent, "скачано");
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

// ── byte-level "model-progress" events (whisper is 1.5GB — needs a live indicator) ──
test("Модели: model-progress event shows percent + MB in the row detail", async () => {
  const { window, $, handlers } = await boot();
  $("settingsOpen").click();
  await tick(window);
  handlers.modelDownload({ event: "model-progress", id: "vad", downloaded: 10 * 1024 * 1024, total: 35 * 1024 * 1024 });
  const detail = $("model-row-vad").querySelector(".pf-detail").textContent;
  assert.match(detail, /29%/);
  assert.match(detail, /10 \/ 35 МБ/);
});

test("Модели: model-progress with total 0 falls back to a live byte count instead of dividing by zero", async () => {
  const { window, $, handlers } = await boot();
  $("settingsOpen").click();
  await tick(window);
  handlers.modelDownload({ event: "model-progress", id: "vad", downloaded: 500 * 1024, total: 0 });
  const detail = $("model-row-vad").querySelector(".pf-detail").textContent;
  assert.doesNotMatch(detail, /%/);
  assert.match(detail, /скачивается/);
});

test("Модели: model-progress for whisper/vad also updates the setup gate's combined row", async () => {
  const { window, $, handlers } = await boot({
    appReadiness: async () => ({ backend: true, whisper: false, vad: false, models: false }),
  });
  await tick(window);
  handlers.modelDownload({ event: "model-progress", id: "whisper", downloaded: 750 * 1024 * 1024, total: 1500 * 1024 * 1024 });
  assert.match($("gateModelsStatusRow").querySelector(".pf-detail").textContent, /50%/);
});

test("Модели: model-progress for diarization does not touch the gate row (not part of the wall)", async () => {
  const { window, $, handlers } = await boot({
    appReadiness: async () => ({ backend: true, whisper: false, vad: false, models: false }),
  });
  await tick(window);
  const before = $("gateModelsStatusRow").querySelector(".pf-detail").textContent;
  handlers.modelDownload({ event: "model-progress", id: "diarization", downloaded: 1024, total: 31 * 1024 * 1024 });
  assert.equal($("gateModelsStatusRow").querySelector(".pf-detail").textContent, before);
});

// ── cancel button (settings "Модели" + setup-gate step 2) ──────────────────
test("Модели: cancel button is hidden by default, shows during a download, and calls cancelModelDownload", async () => {
  let canceled = false;
  const { window, $, handlers } = await boot({
    downloadModels: async () => new Promise(() => {}), // never resolves — simulates an in-flight download
    cancelModelDownload: async () => { canceled = true; return { ok: true }; },
  });
  $("settingsOpen").click();
  await tick(window);
  assert.ok($("modelsCancelBtn").classList.contains("hidden"), "no download running yet");

  $("modelsDownloadMissing").click();
  await tick(window);
  assert.ok(!$("modelsCancelBtn").classList.contains("hidden"), "download running — cancel must be offered");

  $("modelsCancelBtn").click();
  await tick(window);
  assert.ok(canceled, "cancel button must call window.api.cancelModelDownload()");

  handlers.modelDownload({ event: "download-closed", code: 0, canceled: true });
  await tick(window);
  assert.ok($("modelsCancelBtn").classList.contains("hidden"), "must hide again once the download ends");
});

test("setup gate: step 2 cancel button shows during a download and calls cancelModelDownload", async () => {
  let canceled = false;
  const { window, $ } = await boot({
    appReadiness: async () => ({ backend: true, whisper: false, vad: false, models: false }),
    downloadModels: async () => new Promise(() => {}),
    cancelModelDownload: async () => { canceled = true; return { ok: true }; },
  });
  await tick(window);
  assert.ok($("gateModelsCancelBtn").classList.contains("hidden"));
  $("gateModelsDownloadBtn").click();
  await tick(window);
  assert.ok(!$("gateModelsCancelBtn").classList.contains("hidden"));
  $("gateModelsCancelBtn").click();
  await tick(window);
  assert.ok(canceled);
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

// A cancel/failure now wipes the interrupted model's partial cache dir (see the
// parent-side cleanup tests below) — a resumable-blob-cache claim here would be
// actively wrong: there's nothing left on disk for HF hub to resume from.
test("main.js: cancel-model-download's comment no longer claims a re-click resumes where it left off, and states the real wipe+refetch behavior", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const cancelModelDl = mainSrc.match(/\/\/[^\n]*\n(\/\/[^\n]*\n)*ipcMain\.handle\("cancel-model-download"/)[0];
  assert.doesNotMatch(cancelModelDl, /picks up where (this|it) left off/, "cleanup now wipes the partial dir — nothing is left to resume");
  assert.match(cancelModelDl, /from scratch/, "the comment must state the corrected (wipe+refetch) behavior");
});

// ── main.js: parent-side partial-download cleanup (race-free counterpart to
// backend.py's own best-effort SIGTERM handler — see lib/mainutil's
// cleanupPartialModelCache tests for the actual fs-level behavior) ──────────
test("main.js: download-models tracks the in-flight model via stage/stage_end before forwarding each event", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const handler = mainSrc.match(/async function runModelDownloadBatch\([\s\S]*?\n\}/)[0];
  assert.match(handler, /let inFlightModelId = null/);
  assert.match(handler, /if \(ev\.event === EVENTS\.STAGE\) inFlightModelId = /);
  assert.match(handler, /else if \(ev\.event === EVENTS\.STAGE_END\) inFlightModelId = null/);
});

test("main.js: download-models' close handler cleans up ONLY when canceled or non-zero exit, and ONLY the in-flight model", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const handler = mainSrc.match(/async function runModelDownloadBatch\([\s\S]*?\n\}/)[0];
  assert.match(handler, /if \(\(canceled \|\| code !== 0\) && inFlightModelId\) cleanupPartialModelCache\(os\.homedir\(\), inFlightModelId\)/);
  // must run BEFORE the child's stdout/stderr are discarded (send() + modelDlProc = null),
  // i.e. still inside the same close callback, after the child has already exited.
  const cleanupIdx = handler.indexOf("cleanupPartialModelCache(");
  const nullOutIdx = handler.indexOf("modelDlProc = null");
  assert.ok(cleanupIdx >= 0 && nullOutIdx > cleanupIdx);
});

test("main.js: cleanupPartialModelCache is imported from lib/mainutil (single-sourced paths, not a local re-implementation)", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const req = mainSrc.match(/const \{[\s\S]*?\} = require\("\.\/lib\/mainutil"\);/)[0];
  assert.match(req, /cleanupPartialModelCache/);
});

test("main.js: download-models and process-audio refuse to run while the other is active", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const downloadModels = mainSrc.match(/async function runModelDownloadBatch\([\s\S]*?\n\}/)[0];
  const processAudio = mainSrc.match(/ipcMain\.handle\("process-audio"[\s\S]*?\n\}\);/)[0];
  assert.match(downloadModels, /\[!!procProc, "Дождитесь окончания обработки"\]/);
  assert.match(processAudio, /\[!!modelDlProc, "Дождитесь окончания скачивания моделей"\]/);
});

test("main.js: download-models also refuses while a recording is active (recordProc or tee) — CPU/network contention with live capture", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const downloadModels = mainSrc.match(/async function runModelDownloadBatch\([\s\S]*?\n\}/)[0];
  assert.match(downloadModels, /\[!!\(recordProc \|\| tee\), "Дождитесь окончания записи"\]/,
    "download-models must refuse while recordProc/tee are set, same as reset-app's busy guard");
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

// #processLatestBtn and .run-row are co-located in .record-action-bar (design-layout
// commit "Запись: two-column layout + sticky action bar") — #processLatestBtn no longer
// sits inside #pane-record, so it no longer gets hidden "for free" by that tabpane's own
// toggle; the tab-click handler now toggles it explicitly, inverted from .run-row.
test("record-action-bar: switching tabs shows exactly one of #processLatestBtn / .run-row at a time", async () => {
  const { window, $ } = await boot();
  assert.equal($("processLatestBtn").classList.contains("hidden"), false, "record tab (default): visible");
  assert.equal(window.document.querySelector(".run-row").classList.contains("hidden"), true, "record tab (default): hidden");
  goImportTab(window);
  assert.equal($("processLatestBtn").classList.contains("hidden"), true, "import tab: hidden");
  assert.equal(window.document.querySelector(".run-row").classList.contains("hidden"), false, "import tab: visible");
  window.document.querySelector('.tab[data-tab="record"]').click();
  assert.equal($("processLatestBtn").classList.contains("hidden"), false, "back to record tab: visible again");
  assert.equal(window.document.querySelector(".run-row").classList.contains("hidden"), true, "back to record tab: hidden again");
});

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

test("batch import: retrying a failed middle element after the batch finishes reprocesses only that element", async () => {
  const calls = [];
  const { window, $, handlers } = await boot({
    pickAudio: async () => ["/tmp/a.wav", "/tmp/b.wav", "/tmp/c.wav"],
    processAudio: async (opts) => { calls.push({ file: opts.audioFile, fresh: opts.fresh }); return { ok: true }; },
  });
  goImportTab(window);
  $("pickBtn").click(); await tick(window);
  $("runBtn").click(); await tick(window); // item 1 (a) running
  handlers.process({ event: "done", note: "/n1.md", audio: "/tmp/a.wav", transcript: "t1", summary: "s1" });
  await tick(window); // item 2 (b) auto-started
  handlers.process({ event: "error", msg: "boom" });
  await tick(window); // item 2 (b) failed, item 3 (c) auto-started
  handlers.process({ event: "done", note: "/n3.md", audio: "/tmp/c.wav", transcript: "t3", summary: "s3" });
  await tick(window); // batch finished: a=done, b=failed, c=done

  assert.deepEqual(calls.map((c) => c.file), ["/tmp/a.wav", "/tmp/b.wav", "/tmp/c.wav"]);
  let rows = $("importQueue").querySelectorAll(".queue-item");
  assert.ok(rows[0].classList.contains("queue-done"));
  assert.ok(rows[1].classList.contains("queue-failed"));
  assert.ok(rows[2].classList.contains("queue-done"));
  assert.ok(!rows[0].querySelector(".queue-retry-btn"), "done rows get no retry button");
  const retryBtn = rows[1].querySelector(".queue-retry-btn");
  assert.ok(retryBtn, "the failed middle row must expose a retry button");
  assert.ok(!rows[2].querySelector(".queue-retry-btn"), "done rows get no retry button");

  retryBtn.click(); await tick(window);
  assert.deepEqual(calls.map((c) => c.file), ["/tmp/a.wav", "/tmp/b.wav", "/tmp/c.wav", "/tmp/b.wav"],
    "only the retried middle item reprocesses");
  assert.equal(calls[3].fresh, false, "row retry resumes from cache (↻), it does not force a fresh recompute");
  rows = $("importQueue").querySelectorAll(".queue-item");
  assert.ok(rows[1].classList.contains("queue-running"), "retried row goes back to running while in flight");

  handlers.process({ event: "done", note: "/n2.md", audio: "/tmp/b.wav", transcript: "t2", summary: "s2" });
  await tick(window);
  assert.deepEqual(calls.map((c) => c.file), ["/tmp/a.wav", "/tmp/b.wav", "/tmp/c.wav", "/tmp/b.wav"],
    "completing the retry must not cascade into item 3, which already has a terminal status");
  rows = $("importQueue").querySelectorAll(".queue-item");
  assert.ok(rows[1].classList.contains("queue-done"), "retried row reflects its own new outcome");
  assert.ok(rows[2].classList.contains("queue-done"), "item 3 keeps its original status, untouched by the retry");
});

test("batch import: per-row retry is blocked while another item in the batch is still processing", async () => {
  const calls = [];
  const { window, $, handlers } = await boot({
    pickAudio: async () => ["/tmp/a.wav", "/tmp/b.wav"],
    processAudio: async (opts) => { calls.push(opts.audioFile); return { ok: true }; },
  });
  goImportTab(window);
  $("pickBtn").click(); await tick(window);
  $("runBtn").click(); await tick(window); // item 1 (a) running
  handlers.process({ event: "error", msg: "boom" });
  await tick(window); // item 1 (a) failed, item 2 (b) auto-started — still processing

  assert.deepEqual(calls, ["/tmp/a.wav", "/tmp/b.wav"]);
  const rows = $("importQueue").querySelectorAll(".queue-item");
  assert.ok(rows[0].classList.contains("queue-failed"));
  assert.ok(rows[1].classList.contains("queue-running"));
  const retryBtn = rows[0].querySelector(".queue-retry-btn");
  assert.ok(retryBtn, "failed row still exposes a retry button while the rest of the batch continues");

  retryBtn.click(); await tick(window); // must no-op — item 2 is still in flight
  assert.deepEqual(calls, ["/tmp/a.wav", "/tmp/b.wav"], "retry must not start while another item is processing");
  assert.ok(rows[0].classList.contains("queue-failed"), "the blocked row's status must stay untouched");
});

test("reprocessHistory() still triggers a single run once confirmed in the picker (queue-of-1 regression guard)", async () => {
  let calls = 0;
  const { window, $ } = await boot({ processAudio: async () => { calls++; return { ok: true }; } });
  window.document.querySelector('.topbtn[data-view="history"]').click(); await tick(window);
  $("historyList").querySelector(".rail-item").click(); await tick(window);
  $("noteView").querySelector("#nvReprocess").click(); await tick(window); // opens the template picker
  $("noteView").querySelector("#reprocessConfirm").click(); await tick(window); // confirm → run
  assert.equal(calls, 1);
  const rows = $("importQueue").querySelectorAll(".queue-item");
  assert.equal(rows.length, 1);
});

// ── История reprocess renders its own progress/logs panel in place (Task 2) ────────
test("reprocess from История stays on the История view and drives its own #histStages/#histLogs panel (not #stages/#logs)", async () => {
  const { window, $, handlers } = await boot({ processAudio: async () => ({ ok: true }) });
  window.document.querySelector('.topbtn[data-view="history"]').click(); await tick(window);
  $("historyList").querySelector(".rail-item:not(.pending)").click(); await tick(window);
  $("noteView").querySelector("#nvReprocess").click(); await tick(window); // opens the template picker
  $("noteView").querySelector("#reprocessConfirm").click(); await tick(window); // confirm → run

  // still looking at История — no view-jump to Запись (the old switchView("record") bug)
  assert.ok(!$("view-history").classList.contains("hidden"), "must stay on История");
  assert.ok($("view-record").classList.contains("hidden"), "must NOT jump to Запись");

  handlers.process({ event: "stage", stage: "transcribe", msg: "Транскрибация" });
  handlers.process({ event: "log", stage: "transcribe", msg: "строка лога" });
  await tick(window);

  const histStage = $("noteView").querySelector("#histStage-transcribe");
  assert.ok(histStage, "the История panel must render its own stage pills");
  assert.ok(histStage.classList.contains("active"));
  assert.ok($("noteView").querySelector("#histLogs").textContent.includes("строка лога"));

  // the Запись tab's own progress elements must stay untouched by a История run
  assert.equal($("stages").children.length, 0, "#stages must not be populated by a История reprocess run");
  assert.equal($("logs").textContent, "");
});

// Regression guard for the ~1817 cross-panel leak: a cached stage_end during a
// История reprocess must mark the VISIBLE #histStage-<key>, never the (possibly
// stale, hidden) Запись-tab #stage-<key> — reprocess runs are fresh=false, so a
// cache-hit stage_end is the common case, not an edge case.
test("stage_end cached flag lands on #histStage-<key> during a История reprocess, never on a stale #stage-<key> Запись node", async () => {
  const { window, $, handlers } = await boot({ processAudio: async () => ({ ok: true }) });

  // A prior normal Запись-tab run leaves its own #stage-transcribe pill behind in the
  // (now hidden) record view — buildStages() only clears/repopulates #stages at the
  // START of a Запись-tab run, so this stale node survives into the История run below.
  handlers.record({ event: "recorded", id: "r1", name: "Запись 1", file: "/tmp/mixed.wav", mic: "/tmp/m.wav", system: null, tracks: 1 });
  $("historyList").querySelector(".pending-play-btn").click(); await tick(window);
  handlers.process({ event: "done", note: "/n1.md", audio: "/a1.wav", transcript: "t", summary: "s" });
  await tick(window);
  assert.ok($("stage-transcribe"), "sanity: a prior Запись-tab run left its stage pill in the DOM");
  assert.ok(!$("stage-transcribe").classList.contains("cached"));

  // Now reprocess the (single, default-mocked) history note — this run must target
  // #histStage-*, not the stale #stage-transcribe above.
  window.document.querySelector('.topbtn[data-view="history"]').click(); await tick(window);
  $("historyList").querySelector(".rail-item:not(.pending)").click(); await tick(window);
  $("noteView").querySelector("#nvReprocess").click(); await tick(window);
  $("noteView").querySelector("#reprocessConfirm").click(); await tick(window);

  handlers.process({ event: "stage", stage: "transcribe", msg: "Транскрибация" });
  handlers.process({ event: "stage_end", stage: "transcribe", status: "ok", msg: "12 сегм. (из кеша)" });
  await tick(window);

  const histStage = $("noteView").querySelector("#histStage-transcribe");
  assert.ok(histStage, "История panel must render its own stage pill");
  assert.ok(histStage.classList.contains("cached"), "cached class must land on the visible История pill");
  assert.ok(!$("stage-transcribe").classList.contains("cached"),
    "cached class must NOT leak onto the stale, hidden Запись-tab pill");
});

// Regression guard for the commit-0a79d98 gate being deliberately reverted (owner
// decision, see main task spec): a batch/processing run must no longer block a new
// recording — finished recordings now pile up in the persistent pending queue
// instead of being lost, so there's nothing left to protect by refusing to record.
test("recording is allowed while a batch import is running (0a79d98 gate reverted)", async () => {
  let startCalls = 0;
  const { window, $, handlers } = await boot({
    pickAudio: async () => ["/tmp/a.wav", "/tmp/b.wav"],
    processAudio: async () => ({ ok: true }),
    startRecording: async () => { startCalls++; return { ok: true }; },
  });
  goImportTab(window);
  $("pickBtn").click(); await tick(window);
  $("runBtn").click(); await tick(window); // item 1 running
  assert.equal($("recBtn").disabled, false, "recBtn must not be disabled by processing alone");
  $("recBtn").click(); await tick(window);
  assert.equal(startCalls, 1, "clicking Record must start a recording even mid-batch");
  assert.ok(!$("recIndicator").classList.contains("hidden"));

  // The tray menu item calls toggleRecording() directly, bypassing the DOM — the
  // state.processing early-return that used to block it here is gone.
  $("recBtn").click(); await tick(window); // stop the just-started recording
  handlers.trayRecordToggle(); await tick(window); // start again via tray, still mid-batch
  assert.equal(startCalls, 2, "the tray toggle must also be able to start a recording mid-batch");

  handlers.process({ event: "done", note: "/n1.md", audio: "/tmp/a.wav", transcript: "t1", summary: "s1" });
  await tick(window); // item 2 auto-started, batch still running
  assert.equal($("recBtn").disabled, false, "recBtn stays enabled through the rest of the batch too");
});

// ── recording indicator (sidebar rec-status block, visible from any tab) ────
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

// Design-sidebar (PR-1): #recIndicator is no longer a tiny dot inside the old
// topnav "🎙 Запись" button — it's the whole sidebar rec-status block (dot +
// label + its own timer readout), pinned to #sidebar so it stays put while the
// content column switches views.
test("sidebar rec-status block: lives in #sidebar, fully hidden when idle, shows dot+label+timer while recording", async () => {
  const { window, $, handlers } = await boot();
  const block = $("recIndicator");
  assert.equal(block.closest("#sidebar"), $("sidebar"), "the rec-status block must be inside #sidebar, not the content column");
  assert.ok(block.classList.contains("hidden"), "hidden entirely when not recording");
  assert.ok(block.querySelector(".rec-dot"), "pulsing dot present");
  assert.equal(block.querySelector(".sidebar-rec-label").textContent, "Идёт запись");

  $("recBtn").click(); await tick(window); // start recording
  assert.ok(!block.classList.contains("hidden"));
  assert.equal($("sidebarTimer").textContent, "00:00");

  handlers.record({ event: "elapsed", seconds: 65 });
  await tick(window);
  // both readouts (action-bar #timer and sidebar #sidebarTimer) must move together —
  // they share the .timer class broadcast in renderer.js's onRecordEvent handler.
  assert.equal($("sidebarTimer").textContent, "01:05");
  assert.equal($("timer").textContent, "01:05");

  window.document.querySelector('.topbtn[data-view="para"]').click(); await tick(window);
  assert.ok(!block.classList.contains("hidden"), "stays visible across a view switch");

  window.document.querySelector('.topbtn[data-view="record"]').click(); await tick(window);
  $("recBtn").click(); await tick(window); // stop
  assert.ok(block.classList.contains("hidden"));
});

// ── tray record-state sync (menu-bar icon, all 3 state.recording sites) ─────
test("start recording pushes notifyRecordingState(true)", async () => {
  const calls = [];
  const { window, $ } = await boot({ notifyRecordingState: (r) => calls.push(r) });
  $("recBtn").click(); await tick(window);
  assert.deepEqual(calls, [true]);
});

test("stop recording (record button) pushes notifyRecordingState(false)", async () => {
  const calls = [];
  const { window, $ } = await boot({ notifyRecordingState: (r) => calls.push(r) });
  $("recBtn").click(); await tick(window); // start
  $("recBtn").click(); await tick(window); // stop
  assert.deepEqual(calls, [true, false]);
});

test("mic-error path pushes notifyRecordingState(false)", async () => {
  const calls = [];
  const { window, $, handlers } = await boot({ notifyRecordingState: (r) => calls.push(r) });
  $("recBtn").click(); await tick(window); // start
  handlers.record({ event: "error", msg: "mic disconnected" });
  await tick(window);
  assert.deepEqual(calls, [true, false]);
});

test("tray-record-toggle subscription drives the exact same flow as clicking the record button", async () => {
  let startCalls = 0;
  const { window, $, handlers } = await boot({
    startRecording: async () => { startCalls++; return { ok: true }; },
  });
  handlers.trayRecordToggle(); await tick(window); // start, via tray
  assert.equal(startCalls, 1);
  assert.ok(!$("recIndicator").classList.contains("hidden"));
  assert.equal($("recBtn").textContent, "■ Остановить");
  handlers.trayRecordToggle(); await tick(window); // stop, via tray
  assert.ok($("recIndicator").classList.contains("hidden"));
  assert.equal($("recBtn").textContent, "● Начать запись");
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

test("main.js: reset-app writes the fresh presets before clearing the token (a presets-write failure must not wipe the token)", () => {
  // writeJsonAtomic can throw (disk full, permissions) — if saveToken("") ran first,
  // a throw here would leave the token wiped while the stale presets survive on disk.
  // Ordering must be: write fresh presets, THEN clear the token.
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const resetApp = mainSrc.match(/ipcMain\.handle\("reset-app"[\s\S]*?\n\}\);/)[0];
  const writeIdx = resetApp.indexOf("writeJsonAtomic(PRESETS_FILE,");
  const tokenIdx = resetApp.indexOf('saveToken("")');
  assert.ok(writeIdx > -1, "writeJsonAtomic(PRESETS_FILE, ...) not found in reset-app");
  assert.ok(tokenIdx > -1, 'saveToken("") not found in reset-app');
  assert.ok(writeIdx < tokenIdx,
    "writeJsonAtomic must run before saveToken(\"\") so a presets-write failure aborts before the token is cleared");
});

// ── persistent pending-recordings queue ─────────────────────────────────────
// main.js requires("electron") and can't be loaded headless under plain node --test
// (same reason as the other main.js checks above) — source-text assertions cover the
// main-process handlers a jsdom renderer test can't reach.
test("main.js: start-recording creates the permanent session dir under RECORDINGS_DIR, not TMP_DIR", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const startRecording = mainSrc.match(/ipcMain\.handle\("start-recording"[\s\S]*?\n\}\);/)[0];
  assert.match(startRecording, /path\.join\(RECORDINGS_DIR, `rec-\$\{stamp\}`\)/);
  assert.doesNotMatch(startRecording, /path\.join\(TMP_DIR, `rec-/,
    "recording session dirs must no longer land in the swept TMP_DIR");
});

test("main.js: start-recording's disk guard checks RECORDINGS_DIR, not TMP_DIR", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const startRecording = mainSrc.match(/ipcMain\.handle\("start-recording"[\s\S]*?\n\}\);/)[0];
  assert.match(startRecording, /fs\.statfsSync\(RECORDINGS_DIR\)/);
});

// Regression lock: a bare second-resolution ISO timestamp collides for two
// recordings started within the same wall-clock second — same session `dir`
// (silently overwrites the first recording's WAVs) and a duplicate manifest `id`
// (remove-pending-recording's findIndex would only ever hit the first match).
test("main.js: start-recording's stamp carries a uniqueness suffix beyond second-resolution, shared by dir and id", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const startRecording = mainSrc.match(/ipcMain\.handle\("start-recording"[\s\S]*?\n\}\);/)[0];
  assert.match(startRecording, /const stamp = `\$\{displayStamp\}-\$\{[^}]+\}`/,
    "stamp must append a suffix to displayStamp so two recordings in the same second don't collide");
  assert.match(startRecording, /path\.join\(RECORDINGS_DIR, `rec-\$\{stamp\}`\)/,
    "the session dir must be named from the SUFFIXED stamp, not the bare displayStamp");
});

test("main.js: stop-recording persists a pending-recordings manifest entry and includes id/name in the recorded IPC event", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const stopRecording = mainSrc.match(/ipcMain\.handle\("stop-recording"[\s\S]*?\n\}\);/)[0];
  assert.match(stopRecording, /loadPendingManifest\(\)/);
  // Upsert-by-id, not a blind push — see the manifest cross-link/duplicate regression
  // lock below for why (upsertById replaces same-id instead of duplicating).
  assert.match(stopRecording, /upsertById\(loadPendingManifest\(\),/);
  assert.match(stopRecording, /savePendingManifest\(manifest\)/);
  assert.match(stopRecording, /event: "recorded",\s*\n\s*id, name,/,
    "the recorded IPC event must carry id/name for the renderer's pending queue");
});

// Regression lock for the recording-manifest cross-link/duplicate bug: a double-start
// (stop-recording A's mix still running in the background when B starts) used to let
// A's mix-completion closure read the module-level `session` LIVE — by the time it
// fired, `session` had been reassigned to B, so A's manifest entry got B's id/dir/mic
// while `mixed` still pointed at A's own file. main.js can't be exercised directly
// under `node --test` (it requires "electron") — these lock the fix at the source
// level, the same convention as the stop-recording tests above.
test("main.js: stop-recording snapshots session into a local BEFORE the async mix, so the mix closure never reads the live (possibly-reassigned) session", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const stopRecording = mainSrc.match(/ipcMain\.handle\("stop-recording"[\s\S]*?\n\}\);/)[0];
  const snapshotIdx = stopRecording.search(/const sess = session;/);
  const runBackendIdx = stopRecording.search(/runBackend\(\s*\n\s*args,/);
  assert.ok(snapshotIdx >= 0, "must snapshot `session` into a local (e.g. `const sess = session;`)");
  assert.ok(runBackendIdx >= 0, "must find the mix's runBackend(args, ...) call");
  assert.ok(snapshotIdx < runBackendIdx, "the snapshot must happen BEFORE the mix's runBackend call, not after");

  const mixCallback = stopRecording.slice(runBackendIdx, stopRecording.indexOf("() => { mixInFlight = false; }"));
  for (const field of ["stamp", "dir", "micPath", "sysPath", "displayStamp"]) {
    assert.doesNotMatch(mixCallback, new RegExp(`session\\.${field}\\b`),
      `the mix closure must never read session.${field} live — only sess.${field}`);
    assert.match(mixCallback, new RegExp(`sess\\.${field}\\b`),
      `the mix closure must read sess.${field} (the snapshot), not the live session`);
  }
});

// Regression lock for the start-guard half of the same fix: without this, a new
// recording could start (and reassign `session`) while a previous recording's mix is
// still running — the exact window the cross-link bug above needed.
test("main.js: start-recording refuses to start while a previous recording's mix is still in flight, and stop-recording sets/clears the flag around the mix", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const startRecording = mainSrc.match(/ipcMain\.handle\("start-recording"[\s\S]*?\n\}\);/)[0];
  assert.match(startRecording, /\[mixInFlight, "Дождитесь завершения обработки предыдущей записи"\]/,
    "start-recording must refuse while mixInFlight is true");

  const stopRecording = mainSrc.match(/ipcMain\.handle\("stop-recording"[\s\S]*?\n\}\);/)[0];
  const setIdx = stopRecording.search(/mixInFlight = true;/);
  const runBackendIdx = stopRecording.search(/runBackend\(\s*\n\s*args,/);
  assert.ok(setIdx >= 0 && setIdx < runBackendIdx, "mixInFlight must be set true before the mix's runBackend call");
  assert.match(stopRecording, /\(\) => \{ mixInFlight = false; \}/,
    "mixInFlight must be cleared in the mix's onClose — fires on success, backend error, AND spawn failure, so a failed mix can never wedge recording");
});

test("main.js: list-pending-recordings drops (and persists dropping) manifest entries whose mixed file no longer exists", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const listPending = mainSrc.match(/ipcMain\.handle\("list-pending-recordings"[\s\S]*?\n\}\);/)[0];
  assert.match(listPending, /fs\.existsSync\(r\.mixed\)/);
  assert.match(listPending, /savePendingManifest\(surviving\)/);
});

test("main.js: remove-pending-recording deletes the session dir and drops the manifest entry", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const removePending = mainSrc.match(/ipcMain\.handle\("remove-pending-recording"[\s\S]*?\n\}\);/)[0];
  assert.match(removePending, /fs\.rmSync\(entry\.dir, \{ recursive: true, force: true \}\)/);
  assert.match(removePending, /manifest\.splice\(idx, 1\)/);
  assert.match(removePending, /savePendingManifest\(manifest\)/);
});

// M6 arch-audit: mirrors delete-history-note/delete-history-recording's own procProc
// guard — a reprocess run may be actively reading THIS entry's mixed.wav (--in) when
// the user clicks remove; rmSync'ing entry.dir out from under it must be refused, not
// silently allowed to race (main.js:900-908 previously had no guard at all here).
test("main.js: remove-pending-recording refuses while a reprocess (procProc) is active", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const removePending = mainSrc.match(/ipcMain\.handle\("remove-pending-recording"[\s\S]*?\n\}\);/)[0];
  assert.match(removePending, /\[!!procProc, "Дождитесь окончания обработки"\]/);
});

// L7 arch-audit: a failed rmSync used to vanish into an empty catch while this
// handler still unconditionally returned {ok:true} — a state-mutating failure
// (files may still be on disk) reported as a clean success.
test("main.js: remove-pending-recording reports {ok:false, error} when rmSync actually fails, instead of a false ok:true", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const removePending = mainSrc.match(/ipcMain\.handle\("remove-pending-recording"[\s\S]*?\n\}\);/)[0];
  assert.match(removePending, /\} catch \(e\) \{\s*\n\s*rmError = String\(\(e && e\.message\) \|\| e\);\s*\n\s*\}/);
  assert.match(removePending, /if \(rmError\) \{\s*\n\s*return \{ ok: false, error: /);
  // the manifest entry must still be dropped either way (a resurrected row would
  // surprise the user who already saw it vanish) — savePendingManifest runs
  // BEFORE the rmError check, not conditionally on success.
  const saveIdx = removePending.indexOf("savePendingManifest(manifest)");
  const rmErrorCheckIdx = removePending.indexOf("if (rmError)");
  assert.ok(saveIdx >= 0 && saveIdx < rmErrorCheckIdx, "savePendingManifest must run unconditionally, before the rmError check");
});

test("pending recordings: delete (✕) alerts the user when removePendingRecording reports ok:false (files may still be on disk)", async () => {
  const { $, window, handlers } = await boot({
    removePendingRecording: async () => ({ ok: false, error: "Запись убрана из очереди, но файлы на диске не удалены: EACCES" }),
  });
  handlers.record({ event: "recorded", id: "r1", name: "Запись 1", file: "/rec/r1/mixed.wav", mic: null, system: null, tracks: 1 });
  await tick(window);
  let alerted = null;
  window.alert = (msg) => { alerted = msg; };
  $("historyList").querySelector(".pending-del-btn").click();
  await tick(window);
  await tick(window); // one extra tick for the removePendingRecording().then() microtask
  assert.equal(alerted, "Запись убрана из очереди, но файлы на диске не удалены: EACCES");
});
test("pending recordings: delete (✕) does NOT alert when removePendingRecording succeeds", async () => {
  const { $, window, handlers } = await boot({
    removePendingRecording: async () => ({ ok: true }),
  });
  handlers.record({ event: "recorded", id: "r1", name: "Запись 1", file: "/rec/r1/mixed.wav", mic: null, system: null, tracks: 1 });
  await tick(window);
  let alerted = null;
  window.alert = (msg) => { alerted = msg; };
  $("historyList").querySelector(".pending-del-btn").click();
  await tick(window);
  await tick(window);
  assert.equal(alerted, null);
});

test("main.js: pruneTemp's sweep() calls never target RECORDINGS_DIR — recordings are permanent, not swept", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const pruneTemp = mainSrc.match(/function pruneTemp\([\s\S]*?\n\}/)[0];
  assert.doesNotMatch(pruneTemp, /sweep\(\s*RECORDINGS_DIR/,
    "a sweep() call targeting RECORDINGS_DIR would delete pending recordings on a schedule — a restart must still find every one of them");
});

// ── renderer: pending-recordings queue UI ───────────────────────────────────
test("pending recordings: a recorded event appends a row; a second appends a second (no single-slot overwrite)", async () => {
  const { window, $, handlers } = await boot();
  handlers.record({
    event: "recorded", id: "r1", name: "Запись 1",
    file: "/rec/r1/mixed.wav", mic: "/rec/r1/mic.wav", system: null, tracks: 1,
  });
  await tick(window);
  let rows = $("historyList").querySelectorAll(".queue-item");
  assert.equal(rows.length, 1);

  handlers.record({
    event: "recorded", id: "r2", name: "Запись 2",
    file: "/rec/r2/mixed.wav", mic: null, system: "/rec/r2/system.wav", tracks: 1,
  });
  await tick(window);
  rows = $("historyList").querySelectorAll(".queue-item");
  assert.equal(rows.length, 2, "second recording must append, not overwrite the first");
});

// Regression lock (renderer half of the manifest cross-link/duplicate fix): a
// "recorded" IPC event delivered twice for the SAME id (e.g. a race on the
// main-process side) must replace the existing pending row, never add a duplicate.
test("pending recordings: a second recorded event for the SAME id replaces the row, not duplicates it", async () => {
  const { window, $, handlers } = await boot();
  handlers.record({
    event: "recorded", id: "r1", name: "Запись 1",
    file: "/rec/r1/mixed.wav", mic: "/rec/r1/mic.wav", system: null, tracks: 1,
  });
  await tick(window);
  assert.equal($("historyList").querySelectorAll(".queue-item").length, 1);

  // Same id, corrected/updated payload (mirrors what a real re-delivery would carry).
  handlers.record({
    event: "recorded", id: "r1", name: "Запись 1",
    file: "/rec/r1/mixed-corrected.wav", mic: "/rec/r1/mic.wav", system: "/rec/r1/system.wav", tracks: 2,
  });
  await tick(window);
  const rows = $("historyList").querySelectorAll(".queue-item");
  assert.equal(rows.length, 1, "same id must replace the existing row, not add a second one");
});

// Regression lock for the critic-rejected dual-path: the old single-slot
// (state.recordedFile/recordedId reconciled via activePendingId) let a SECOND
// recording's "recorded" event tear down a still-running FIRST recording's UI
// (unconditional setProcessingUI(false)) and, worse, silently reassign
// activePendingId to the wrong id on a stray re-click, causing the eventual "done"
// for the real run to delete the WRONG (unprocessed) recording. Now there is no
// single slot: "recorded" only ever appends to the pending queue.
test("BLOCKER LOCK: a recording finishing during an active processing run must not disturb that run", async () => {
  const calls = [];
  const removed = [];
  const { window, $, handlers } = await boot({
    processAudio: async (opts) => { calls.push(opts.audioFile); return { ok: true }; },
    removePendingRecording: async (id) => { removed.push(id); return { ok: true }; },
  });
  // r1 finishes and starts processing.
  handlers.record({ event: "recorded", id: "r1", name: "Запись 1", file: "/rec/r1/mixed.wav", mic: null, system: null, tracks: 1 });
  await tick(window);
  $("historyList").querySelector(".pending-play-btn").click(); await tick(window);
  assert.deepEqual(calls, ["/rec/r1/mixed.wav"]);
  assert.equal($("stopBtn").style.display, "", "Stop must be visible while r1 processes");
  assert.equal($("runBtn").style.display, "none", "Run must be hidden while r1 processes");

  // r2 finishes recording WHILE r1 is still processing (recording-during-processing
  // is allowed) — this must NOT tear down r1's live run UI/state.
  handlers.record({ event: "recorded", id: "r2", name: "Запись 2", file: "/rec/r2/mixed.wav", mic: null, system: null, tracks: 1 });
  await tick(window);
  assert.equal($("stopBtn").style.display, "", "Stop must stay visible — r1's run is still in flight");
  assert.equal($("runBtn").style.display, "none", "Run must stay hidden — recorded must never call setProcessingUI(false)");
  assert.deepEqual(calls, ["/rec/r1/mixed.wav"], "r2 finishing must not trigger any processing on its own");

  // r1's run finishes for real — must remove r1 (the one ACTUALLY processed), never r2.
  handlers.process({ event: "done", note: "/n1.md", audio: "/rec/r1/mixed.wav", transcript: "t1", summary: "s1" });
  await tick(window);
  assert.deepEqual(removed, ["r1"], "must remove the recording that was actually processed (r1), never r2");
  const rows = $("historyList").querySelectorAll(".queue-item");
  assert.equal(rows.length, 1, "r2 must still be waiting — it was never processed");
  assert.equal(rows[0].querySelector(".queue-name").textContent, "Запись 2");
});

test("pending recordings: per-row ▶ success removes the row and calls removePendingRecording(id)", async () => {
  const removed = [];
  const { window, $, handlers } = await boot({
    processAudio: async () => ({ ok: true }),
    removePendingRecording: async (id) => { removed.push(id); return { ok: true }; },
  });
  handlers.record({
    event: "recorded", id: "r1", name: "Запись 1",
    file: "/rec/r1/mixed.wav", mic: "/rec/r1/mic.wav", system: null, tracks: 1,
  });
  await tick(window);
  const playBtn = $("historyList").querySelector(".pending-play-btn");
  assert.ok(playBtn, "a pending row must expose a ▶ button");
  playBtn.click(); await tick(window);
  handlers.process({ event: "done", note: "/n.md", audio: "/rec/r1/mixed.wav", transcript: "t", summary: "s" });
  await tick(window);
  assert.deepEqual(removed, ["r1"]);
  assert.equal($("historyList").querySelectorAll(".queue-item").length, 0);
});

test("pending recordings: a failed run leaves the row with status failed and keeps it (retry via ▶ stays available)", async () => {
  const removed = [];
  const { window, $, handlers } = await boot({
    removePendingRecording: async (id) => { removed.push(id); return { ok: true }; },
  });
  handlers.record({
    event: "recorded", id: "r1", name: "Запись 1",
    file: "/rec/r1/mixed.wav", mic: "/rec/r1/mic.wav", system: null, tracks: 1,
  });
  await tick(window);
  $("historyList").querySelector(".pending-play-btn").click(); await tick(window);
  handlers.process({ event: "error", msg: "boom" });
  await tick(window);
  const rows = $("historyList").querySelectorAll(".queue-item");
  assert.equal(rows.length, 1, "a failed row must stay in the queue, not vanish");
  assert.ok(rows[0].classList.contains("queue-failed"));
  assert.ok(rows[0].querySelector(".pending-play-btn"), "failed row still offers a retry ▶");
  assert.deepEqual(removed, [], "a failed run must not call removePendingRecording");
});

test("pending recordings: «Обработать все» processes rows sequentially, removing each on success", async () => {
  const calls = [];
  const { window, $, handlers } = await boot({
    processAudio: async (opts) => { calls.push(opts.audioFile); return { ok: true }; },
  });
  handlers.record({ event: "recorded", id: "r1", name: "Запись 1", file: "/rec/r1/mixed.wav", mic: null, system: null, tracks: 1 });
  handlers.record({ event: "recorded", id: "r2", name: "Запись 2", file: "/rec/r2/mixed.wav", mic: null, system: null, tracks: 1 });
  await tick(window);
  const allBtn = $("pendingProcessAll");
  assert.ok(!allBtn.classList.contains("hidden"));
  allBtn.click(); await tick(window);
  assert.deepEqual(calls, ["/rec/r1/mixed.wav"], "batch starts with the first pending row");

  handlers.process({ event: "done", note: "/n1.md", audio: "/rec/r1/mixed.wav", transcript: "t1", summary: "s1" });
  await tick(window);
  assert.deepEqual(calls, ["/rec/r1/mixed.wav", "/rec/r2/mixed.wav"], "batch auto-advances to the next pending row");

  handlers.process({ event: "done", note: "/n2.md", audio: "/rec/r2/mixed.wav", transcript: "t2", summary: "s2" });
  await tick(window);
  assert.equal($("historyList").querySelectorAll(".queue-item").length, 0);
  assert.ok(allBtn.classList.contains("hidden"), "nothing left to process — bulk button hides");
});

test("pending recordings: delete (✕) removes the row and calls removePendingRecording(id) without processing it", async () => {
  const removed = [];
  const calls = [];
  const { window, $, handlers } = await boot({
    processAudio: async (opts) => { calls.push(opts.audioFile); return { ok: true }; },
    removePendingRecording: async (id) => { removed.push(id); return { ok: true }; },
  });
  handlers.record({ event: "recorded", id: "r1", name: "Запись 1", file: "/rec/r1/mixed.wav", mic: null, system: null, tracks: 1 });
  await tick(window);
  $("historyList").querySelector(".pending-del-btn").click(); await tick(window);
  assert.deepEqual(removed, ["r1"]);
  assert.deepEqual(calls, [], "deleting a pending row must never trigger processing");
  assert.equal($("historyList").querySelectorAll(".queue-item").length, 0);
});

test("init() restores the persistent pending queue from disk (survives an app restart)", async () => {
  const { window, $ } = await boot({
    listPendingRecordings: async () => ([
      { id: "r1", name: "Запись 1", mixed: "/rec/r1/mixed.wav", mic: "/rec/r1/mic.wav", system: null, tracks: 1 },
      { id: "r2", name: "Запись 2", mixed: "/rec/r2/mixed.wav", mic: null, system: "/rec/r2/system.wav", tracks: 1 },
    ]),
  });
  await tick(window);
  const rows = $("historyList").querySelectorAll(".queue-item");
  assert.equal(rows.length, 2);
});

// ── recording-during-processing gate (owner-approved revert of commit 0a79d98) ──
test("recording is allowed while record-mode processing is running (gate relaxed)", async () => {
  let startCalls = 0;
  const { window, $, handlers } = await boot({
    startRecording: async () => { startCalls++; return { ok: true }; },
  });
  handlers.record({ event: "recorded", id: "r1", name: "Запись 1", file: "/tmp/mixed.wav", mic: "/tmp/m.wav", system: null, tracks: 1 });
  $("historyList").querySelector(".pending-play-btn").click(); await tick(window); // pending-item processing starts
  assert.equal($("recBtn").disabled, false, "recBtn must not be disabled by processing alone");
  $("recBtn").click(); await tick(window);
  assert.equal(startCalls, 1, "a new recording must be able to start while processing runs");
});

// ── setup gate (hard wall) ───────────────────────────────────────────────────
test("setup gate: visible when backend/models aren't ready", async () => {
  const { window, $ } = await boot({
    appReadiness: async () => ({ backend: false, whisper: false, vad: false, models: false }),
  });
  await tick(window);
  assert.equal($("setupGate").classList.contains("hidden"), false);
});

test("setup gate: hidden once appReadiness reports backend+models ready (default boot state)", async () => {
  const { window, $ } = await boot();
  await tick(window);
  assert.equal($("setupGate").classList.contains("hidden"), true);
});

test("HF token help link opens the huggingface tokens page via openExternal", async () => {
  const { window, $ } = await boot();
  await tick(window);
  let opened = null;
  window.api.openExternal = async (url) => { opened = url; };
  $("hfHelpLink").click();
  await tick(window);
  assert.equal(opened, "https://huggingface.co/settings/tokens");
});

test("main.js: open-external IPC opens only https urls (rejects other schemes)", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const handler = mainSrc.match(/ipcMain\.handle\("open-external"[\s\S]*?\n\}\);/)[0];
  assert.match(handler, /\/\^https:\\\/\\\/\/i/, "must guard on an https-only regex before openExternal");
  assert.match(handler, /shell\.openExternal\(url\)/);
});

test("setup gate: fails CLOSED — an appReadiness IPC error keeps the wall up, never exposes the app", async () => {
  const { window, $ } = await boot({
    appReadiness: async () => { throw new Error("ipc boom"); },
  });
  await tick(window);
  assert.equal($("setupGate").classList.contains("hidden"), false);
});

test("setup gate: step 2 (models) stays disabled until backend is ready — backend-first ordering", async () => {
  const { window, $ } = await boot({
    appReadiness: async () => ({ backend: false, whisper: false, vad: false, models: false }),
  });
  await tick(window);
  assert.ok($("gateModelsDownloadBtn").disabled, "download-models spawns pythonBin(), which lacks deps until the backend is installed");
  assert.ok(!$("gateBackendInstallBtn").disabled);
});

test("setup gate: step 2 unlocks once backend is ready but models are still missing", async () => {
  const { window, $ } = await boot({
    appReadiness: async () => ({ backend: true, whisper: false, vad: false, models: false }),
  });
  await tick(window);
  assert.ok(!$("gateModelsDownloadBtn").disabled);
  assert.ok($("gateBackendInstallBtn").disabled, "nothing to install once backend is already ready");
});

test("setup gate: re-checks readiness after install-backend completes, hiding the wall once ready", async () => {
  let ready = false;
  const { window, $, handlers } = await boot({
    appReadiness: async () => (ready
      ? { backend: true, whisper: true, vad: true, models: true }
      : { backend: false, whisper: false, vad: false, models: false }),
  });
  await tick(window);
  assert.equal($("setupGate").classList.contains("hidden"), false);
  ready = true;
  handlers.installBackend({ event: "install-closed", code: 0, canceled: false });
  await tick(window);
  assert.equal($("setupGate").classList.contains("hidden"), true);
});

test("setup gate: re-checks readiness after download-models completes, hiding the wall once ready", async () => {
  let ready = false;
  const { window, $, handlers } = await boot({
    appReadiness: async () => (ready
      ? { backend: true, whisper: true, vad: true, models: true }
      : { backend: true, whisper: false, vad: false, models: false }),
  });
  await tick(window);
  assert.equal($("setupGate").classList.contains("hidden"), false);
  ready = true;
  handlers.modelDownload({ event: "download-closed", code: 0, canceled: false });
  await tick(window);
  assert.equal($("setupGate").classList.contains("hidden"), true);
});

test("setup gate: window focus re-checks readiness", async () => {
  let calls = 0;
  const { window, $ } = await boot({
    appReadiness: async () => {
      calls++;
      return calls > 1
        ? { backend: true, whisper: true, vad: true, models: true }
        : { backend: false, whisper: false, vad: false, models: false };
    },
  });
  await tick(window);
  assert.equal($("setupGate").classList.contains("hidden"), false);
  window.dispatchEvent(new window.Event("focus"));
  await tick(window);
  assert.equal($("setupGate").classList.contains("hidden"), true);
});

test("setup gate: clicking step 1 install button triggers installBackend (shared with settings' button)", async () => {
  let installCalls = 0;
  const { window, $ } = await boot({
    appReadiness: async () => ({ backend: false, whisper: false, vad: false, models: false }),
    installBackend: async () => { installCalls++; return { ok: true }; },
  });
  await tick(window);
  $("gateBackendInstallBtn").click();
  await tick(window);
  assert.equal(installCalls, 1);
});

test("setup gate: clicking step 2 download button requests only whisper+vad (never the full missing batch)", async () => {
  let downloadOpts = null;
  const { window, $ } = await boot({
    appReadiness: async () => ({ backend: true, whisper: false, vad: false, models: false }),
    downloadModels: async (opts) => { downloadOpts = opts; return { ok: true }; },
  });
  await tick(window);
  $("gateModelsDownloadBtn").click();
  await tick(window);
  assert.deepEqual(downloadOpts, { only: ["whisper", "vad"] });
});

// ── in-app updater (settings "Обновления" section) ──────────────────────────
test("Обновления: check button calls checkAppUpdate and renders 'актуальная' when no update is available", async () => {
  let calls = 0;
  const { window, $ } = await boot({
    checkAppUpdate: async () => { calls++; return { ok: true, current: "1.0.0", latest: "1.0.0", hasUpdate: false, assetUrl: null, releaseNotes: null, isPackaged: true }; },
  });
  $("settingsOpen").click();
  await tick(window);
  calls = 0; // settingsOpen already auto-triggered one check (see dedicated test below) —
             // reset so this test isolates the manual button's own call.
  $("updateCheckBtn").click();
  await tick(window);
  assert.equal(calls, 1);
  assert.match($("updateStatusRow").querySelector(".pf-detail").textContent, /актуальная/);
  assert.equal($("updateInstallBtn").classList.contains("hidden"), true);
});

test("Обновления: opening settings automatically triggers exactly one check-app-update call", async () => {
  let calls = 0;
  const { window, $ } = await boot({
    checkAppUpdate: async () => { calls++; return { ok: true, current: "1.0.0", latest: "1.0.0", hasUpdate: false, assetUrl: null, releaseNotes: null, isPackaged: true }; },
  });
  $("settingsOpen").click();
  await tick(window);
  assert.equal(calls, 1);
  assert.match($("updateStatusRow").querySelector(".pf-detail").textContent, /актуальная/);
});

test("Обновления: a manual click while the settings-open auto-check is still in flight is ignored (no stacking)", async () => {
  let calls = 0;
  let resolvers = [];
  const { window, $ } = await boot({
    checkAppUpdate: () => new Promise((resolve) => { calls++; resolvers.push(resolve); }),
  });
  $("settingsOpen").click();   // fires the auto-check, left pending
  $("updateCheckBtn").click(); // must be ignored — one check already in flight
  assert.equal(calls, 1, "concurrent check must be ignored while one is in flight");
  resolvers.forEach((r) => r({ ok: true, current: "1.0.0", latest: "1.0.0", hasUpdate: false, assetUrl: null, releaseNotes: null, isPackaged: true }));
  await tick(window);
  assert.equal(calls, 1);
});

test("Обновления: closing and reopening settings re-runs the auto-check (guard doesn't block forever)", async () => {
  let calls = 0;
  const { window, $ } = await boot({
    checkAppUpdate: async () => { calls++; return { ok: true, current: "1.0.0", latest: "1.0.0", hasUpdate: false, assetUrl: null, releaseNotes: null, isPackaged: true }; },
  });
  $("settingsOpen").click();
  await tick(window);
  $("settingsClose").click();
  $("settingsOpen").click();
  await tick(window);
  assert.equal(calls, 2);
});

test("settings overlay: «Обновления» section is the first section, above «Перед началом работы»", async () => {
  const { window } = await boot();
  const sections = window.document.querySelectorAll("#settingsOverlay .modal-sec");
  assert.match(sections[0].querySelector("h3").textContent, /^Обновления/);
});

test("Обновления: install button appears (enabled) only once hasUpdate is true in a packaged app", async () => {
  const { window, $ } = await boot({
    checkAppUpdate: async () => ({
      ok: true, current: "1.0.0", latest: "1.1.0", hasUpdate: true, assetUrl: "https://x/zip",
      releaseNotes: "Фикс трея", isPackaged: true,
    }),
  });
  $("settingsOpen").click();
  await tick(window);
  $("updateCheckBtn").click();
  await tick(window);
  assert.equal($("updateInstallBtn").classList.contains("hidden"), false);
  assert.equal($("updateInstallBtn").disabled, false);
  assert.equal($("updateDevHint").classList.contains("hidden"), true);
  assert.match($("updateStatusRow").querySelector(".pf-detail").textContent, /1\.1\.0/);
  assert.match($("updateStatusRow").querySelector(".pf-detail").textContent, /Фикс трея/);
});

test("Обновления: dev-mode (isPackaged:false) shows the update but disables install and shows the dev hint", async () => {
  const { window, $ } = await boot({
    checkAppUpdate: async () => ({
      ok: true, current: "1.0.0", latest: "1.1.0", hasUpdate: true, assetUrl: "https://x/zip", releaseNotes: null, isPackaged: false,
    }),
  });
  $("settingsOpen").click();
  await tick(window);
  $("updateCheckBtn").click();
  await tick(window);
  assert.equal($("updateInstallBtn").classList.contains("hidden"), false);
  assert.equal($("updateInstallBtn").disabled, true);
  assert.equal($("updateDevHint").classList.contains("hidden"), false);
});

test("Обновления: a check-app-update error renders the error text and never throws", async () => {
  const { window, $ } = await boot({
    checkAppUpdate: async () => ({
      ok: false, current: "1.0.0", latest: null, hasUpdate: false, assetUrl: null, releaseNotes: null,
      isPackaged: true, error: "не в сети",
    }),
  });
  $("settingsOpen").click();
  await tick(window);
  $("updateCheckBtn").click();
  await tick(window);
  assert.match($("updateStatusRow").querySelector(".pf-detail").textContent, /не в сети/);
  assert.equal($("updateInstallBtn").classList.contains("hidden"), true);
});

test("Обновления: install button click calls downloadAndInstallUpdate and shows progress from app-update-event", async () => {
  let installCalls = 0;
  const { window, $, handlers } = await boot({
    checkAppUpdate: async () => ({
      ok: true, current: "1.0.0", latest: "1.1.0", hasUpdate: true, assetUrl: "https://x/zip", releaseNotes: null, isPackaged: true,
    }),
    downloadAndInstallUpdate: async () => { installCalls++; return { ok: true }; },
  });
  $("settingsOpen").click();
  await tick(window);
  $("updateCheckBtn").click();
  await tick(window);
  $("updateInstallBtn").click();
  await tick(window);
  assert.equal(installCalls, 1);
  assert.equal($("updateCancelBtn").classList.contains("hidden"), false);
  handlers.appUpdate({ event: "download-progress", pct: 42 });
  assert.match($("updateInstallStatus").textContent, /42%/);
});

test("Обновления: a failed downloadAndInstallUpdate() call surfaces the error and re-enables the check button", async () => {
  const { window, $ } = await boot({
    checkAppUpdate: async () => ({
      ok: true, current: "1.0.0", latest: "1.1.0", hasUpdate: true, assetUrl: "https://x/zip", releaseNotes: null, isPackaged: true,
    }),
    downloadAndInstallUpdate: async () => ({ ok: false, error: "только в собранном приложении" }),
  });
  let alerted = null;
  window.alert = (msg) => { alerted = msg; };
  $("settingsOpen").click();
  await tick(window);
  $("updateCheckBtn").click();
  await tick(window);
  $("updateInstallBtn").click();
  await tick(window);
  assert.equal(alerted, "только в собранном приложении");
  assert.equal($("updateCheckBtn").disabled, false);
});

test("Обновления: cancel button calls cancelAppUpdate", async () => {
  let cancelCalls = 0;
  const { window, $ } = await boot({
    checkAppUpdate: async () => ({
      ok: true, current: "1.0.0", latest: "1.1.0", hasUpdate: true, assetUrl: "https://x/zip", releaseNotes: null, isPackaged: true,
    }),
    downloadAndInstallUpdate: async () => new Promise(() => {}), // never resolves — mirrors a real in-flight download
    cancelAppUpdate: async () => { cancelCalls++; return { ok: true }; },
  });
  $("settingsOpen").click();
  await tick(window);
  $("updateCheckBtn").click();
  await tick(window);
  $("updateInstallBtn").click();
  await tick(window);
  $("updateCancelBtn").click();
  await tick(window);
  assert.equal(cancelCalls, 1);
});

// ── main.js in-app updater wiring (source-text checks — see the Бэкенд block
// above for why: main.js requires("electron") and can't load headless) ──────
test("main.js: download-and-install-update refuses outside a packaged app, while busy, and while recording/processing/model-download/backend-install is active", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const handler = mainSrc.match(/ipcMain\.handle\("download-and-install-update"[\s\S]*?\n\}\);/)[0];
  assert.match(handler, /if \(!app\.isPackaged\) return/);
  assert.match(handler, /\[!!updateProc, "Обновление уже идёт"\]/);
  assert.match(handler, /\[!!\(recordProc \|\| tee\), "Дождитесь окончания записи"\]/);
  assert.match(handler, /\[!!procProc, "Дождитесь окончания обработки"\]/);
  assert.match(handler, /\[!!modelDlProc, "Дождитесь окончания скачивания моделей"\]/);
  assert.match(handler, /\[!!installBackendProc, "Дождитесь окончания установки бэкенда"\]/);
});

test("main.js: cancel-app-update sets updateCanceled and kills the tracked step", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const cancel = mainSrc.match(/ipcMain\.handle\("cancel-app-update"[\s\S]*?\n\}\);/)[0];
  assert.match(cancel, /updateCanceled = true/);
  assert.match(cancel, /updateProc\.kill\(\)/);
});

test("main.js: check-app-update handler exists and derives hasUpdate from compareVersions + pickUpdateAsset", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const handler = mainSrc.match(/ipcMain\.handle\("check-app-update"[\s\S]*?\n\}\);/);
  assert.ok(handler, "check-app-update handler not found");
  assert.match(handler[0], /compareVersions\(latest, current\)/);
  assert.match(handler[0], /pickUpdateAsset\(release\.assets \|\| \[\]\)/);
});

test("main.js: runUpdateInstall rolls back the swap (.old -> original name) if renaming the new bundle into place fails", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const runUpdate = mainSrc.match(/async function runUpdateInstall\(\) \{[\s\S]*?\n\}\n/)[0];
  const renameIdx = runUpdate.indexOf("fs.renameSync(currentAppPath, oldAppPath)");
  const catchIdx = runUpdate.indexOf("fs.renameSync(oldAppPath, currentAppPath)");
  assert.ok(renameIdx > 0, "must move the current bundle aside before swapping in the new one");
  assert.ok(catchIdx > renameIdx, "must roll back onto the original name if the swap-in rename throws");
});

test("main.js: runUpdateInstall relaunches and exits only after the install-closed event, never before the swap", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const runUpdate = mainSrc.match(/async function runUpdateInstall\(\) \{[\s\S]*?\n\}\n/)[0];
  const closedIdx = runUpdate.indexOf('event: "install-closed", code: 0');
  const relaunchIdx = runUpdate.indexOf("app.relaunch()");
  const exitIdx = runUpdate.indexOf("app.exit(0)");
  assert.ok(closedIdx > 0 && relaunchIdx > closedIdx && exitIdx > relaunchIdx);
});

test("main.js: a failed/cancelled update cleans up the downloaded zip and extract dir (no partial update survives)", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const runUpdate = mainSrc.match(/async function runUpdateInstall\(\) \{[\s\S]*?\n\}\n/)[0];
  const finallyBlock = runUpdate.match(/\} finally \{[\s\S]*?\n  \}/)[0];
  assert.match(finallyBlock, /fs\.rmSync\(zipPath,/);
  // extractDir may hold a previously-unpacked .app — must go through the
  // noAsar-wrapped helper, not a bare fs.rmSync (see rmNoAsar/ENOTDIR below).
  assert.match(finallyBlock, /rmNoAsar\(extractDir,/);
  assert.match(finallyBlock, /updateProc = null/);
  assert.match(finallyBlock, /updateCanceled = false/);
});

// ── rmNoAsar: fixes the live "Скачать и установить" ENOTDIR ─────────────────
// Electron's fs patches make an extracted .app's Contents/Resources/app.asar
// LOOK like a directory; fs.rmSync's recursive walk then calls rmdir(2) on
// what's really a file and throws ENOTDIR. process.noAsar must be set for the
// duration of the rmSync call and unconditionally restored afterwards (even
// if rmSync itself throws), or every subsequent asar-aware fs call in the
// process would silently stay in "no asar" mode.
test("main.js: rmNoAsar saves/sets/restores process.noAsar around fs.rmSync, restoring even if rmSync throws", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const fn = mainSrc.match(/function rmNoAsar\(p, opts\) \{[\s\S]*?\n\}\n/);
  assert.ok(fn, "rmNoAsar helper not found");
  const body = fn[0];
  assert.match(body, /const prevNoAsar = process\.noAsar;/);
  assert.match(body, /process\.noAsar = true;/);
  // restore must live in `finally` (not after the try) so it runs even on throw
  const tryFinally = body.match(/try \{[\s\S]*?\} finally \{[\s\S]*?\}/);
  assert.ok(tryFinally, "rmSync call must be wrapped in try/finally");
  assert.match(tryFinally[0], /fs\.rmSync\(p, opts\);/);
  assert.match(tryFinally[0], /process\.noAsar = prevNoAsar;/);
});

test("main.js: updater call sites that may hit an extracted/installed .app use rmNoAsar (extract wipe, .old removal, cleanup sweep) — the downloaded zip stays plain fs.rmSync (single file, never a bundle)", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const runUpdate = mainSrc.match(/async function runUpdateInstall\(\) \{[\s\S]*?\n\}\n/)[0];
  // top-of-function stale-extract wipe
  assert.match(runUpdate, /rmNoAsar\(extractDir, \{ recursive: true, force: true \}\);/);
  // swap-step "очистка старой копии" (oldAppPath)
  assert.match(runUpdate, /rmNoAsar\(oldAppPath, \{ recursive: true, force: true \}\);/);
  // the zip itself is always a single file — never routed through rmNoAsar
  assert.match(runUpdate, /fs\.rmSync\(zipPath, \{ force: true \}\);/);

  const cleanup = mainSrc.match(/function cleanupUpdateLeftovers\(\) \{[\s\S]*?\n\}\n/)[0];
  assert.match(cleanup, /rmNoAsar\(appPath \+ "\.old", \{ recursive: true, force: true \}\);/);
  assert.match(cleanup, /rmNoAsar\(UPDATES_DIR, \{ recursive: true, force: true \}\);/);
});

// ── swap-step attribution: today's mystery 1.4MB partial .app.old stub makes
// naming the exact broken step load-bearing for the next incident ──────────
test("main.js: each swap step (cleanup/move/install/rollback) names itself on failure, and the EXDEV message + rollback control-flow are unchanged", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const runUpdate = mainSrc.match(/async function runUpdateInstall\(\) \{[\s\S]*?\n\}\n/)[0];
  assert.match(runUpdate, /«очистка старой копии»/);
  assert.match(runUpdate, /«перенос текущей версии»/);
  assert.match(runUpdate, /«установка новой версии»/);
  assert.match(runUpdate, /«откат»/);
  // rollback still fires unconditionally, immediately, before the EXDEV check —
  // same control-flow as before, just now also named if IT throws.
  const rollbackIdx = runUpdate.indexOf("fs.renameSync(oldAppPath, currentAppPath)");
  const exdevIdx = runUpdate.indexOf('e.code === "EXDEV"');
  assert.ok(rollbackIdx > 0 && exdevIdx > rollbackIdx, "rollback must still happen before the EXDEV check");
  assert.match(runUpdate, /Обновление не поддерживается, когда приложение установлено на другом томе/);
});

test("main.js: updateProc is killed in before-quit alongside the other tracked children", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const beforeQuit = mainSrc.match(/app\.on\("before-quit"[\s\S]*?\n\}\);/)[0];
  assert.match(beforeQuit, /updateProc/);
});

test("main.js: cleanupUpdateLeftovers is wired into app.whenReady alongside pruneTemp", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const whenReady = mainSrc.match(/app\.whenReady\(\)\.then\(\(\) => \{[\s\S]*?\n\}\);/)[0];
  assert.match(whenReady, /cleanupUpdateLeftovers\(\)/);
});

// ── reverse guards: an in-flight update must block recording/processing/
// model-download/backend-install too, not just the other way around — a
// swap that lands mid-recording skips before-quit's graceful mic-finalize
// wait (app.exit(0) bypasses it entirely), leaving an unplayable WAV ──────
test("main.js: start-recording refuses while an update is in flight (updateProc)", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const startRecording = mainSrc.match(/ipcMain\.handle\("start-recording"[\s\S]*?\n  const micDevice/)[0];
  assert.match(startRecording, /\[!!updateProc, "Идёт обновление приложения — дождитесь завершения"\]/);
});

test("main.js: process-audio refuses while an update is in flight (updateProc)", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const processAudio = mainSrc.match(/ipcMain\.handle\("process-audio"[\s\S]*?\n\}\);/)[0];
  assert.match(processAudio, /\[!!updateProc, "Идёт обновление приложения — дождитесь завершения"\]/);
});

test("main.js: process-audio writes glossaryUsage to a temp JSON file and passes --glossary-usage-file, only when usage data exists", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const processAudio = mainSrc.match(/ipcMain\.handle\("process-audio"[\s\S]*?\n\}\);/)[0];
  assert.match(processAudio, /glossaryUsage/);
  assert.match(processAudio, /if \(glossaryUsage && Object\.keys\(glossaryUsage\)\.length\)/);
  assert.match(processAudio, /--glossary-usage-file/);
  // cleaned up on close, mirroring promptFile's own unlink right above it.
  assert.match(processAudio, /if \(glossaryUsageFile\) \{ try \{ fs\.unlinkSync\(glossaryUsageFile\); \} catch \{\} \}/);
});

test("main.js: classify-glossary-terms writes the batch to a temp JSON file, calls backend's classify-terms subcommand, forwards --fast-model, and cleans up on close", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const handler = mainSrc.match(/ipcMain\.handle\("classify-glossary-terms"[\s\S]*?\n\}\);/)[0];
  assert.match(handler, /"classify-terms", "--terms-file", termsFile/);
  assert.match(handler, /if \(fastModel\) args\.push\("--fast-model", fastModel\)/);
  assert.match(handler, /ev\.event === EVENTS\.CLASSIFIED_TERMS/);
  assert.match(handler, /try \{ fs\.unlinkSync\(termsFile\); \} catch \{\}/);
});

test("main.js: download-models refuses while an update is in flight (updateProc)", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const downloadModels = mainSrc.match(/async function runModelDownloadBatch\([\s\S]*?\n\}/)[0];
  assert.match(downloadModels, /\[!!updateProc, "Идёт обновление приложения — дождитесь завершения"\]/);
});

test("main.js: install-backend refuses while an update is in flight (updateProc) — wasn't mutually exclusive before", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const installBackend = mainSrc.match(/ipcMain\.handle\("install-backend"[\s\S]*?\n\}\);/)[0];
  assert.match(installBackend, /\[!!updateProc, "Идёт обновление приложения — дождитесь завершения"\]/);
});

// ── pre-swap recheck: belt-and-suspenders against the reverse guards above —
// closes the race where a conflicting op starts during the multi-minute
// download/unpack window despite the front-door guard already having passed ──
test("main.js: runUpdateInstall rechecks recordProc/tee/procProc/modelDlProc/installBackendProc immediately before the swap and aborts without renaming if any are active", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const runUpdate = mainSrc.match(/async function runUpdateInstall\(\) \{[\s\S]*?\n\}\n/)[0];
  const recheckIdx = runUpdate.indexOf("if (recordProc || tee || procProc || modelDlProc || installBackendProc)");
  const swapRenameIdx = runUpdate.indexOf("fs.renameSync(currentAppPath, oldAppPath)");
  assert.ok(recheckIdx > 0, "pre-swap recheck condition not found");
  assert.ok(swapRenameIdx > recheckIdx, "the recheck must happen strictly before the bundle is renamed aside");
  assert.match(runUpdate, /deferredBusy = true/);
  assert.match(runUpdate, /Обновление отложено: идёт запись\/обработка/);
});

test("main.js: a deferredBusy abort skips the zip/extractDir cleanup (keeps the downloaded zip, per the abort contract)", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const runUpdate = mainSrc.match(/async function runUpdateInstall\(\) \{[\s\S]*?\n\}\n/)[0];
  const finallyBlock = runUpdate.match(/\} finally \{[\s\S]*?\n  \}/)[0];
  assert.match(finallyBlock, /if \(!deferredBusy\) \{/);
});

// ── EXDEV: known limitation when userData and the .app live on different
// volumes (e.g. external-drive install) — must surface an honest message,
// not a raw ENOENT/EXDEV rename error ────────────────────────────────────
test("main.js: runUpdateInstall detects EXDEV on the swap-in rename and reports the cross-volume limitation honestly", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const runUpdate = mainSrc.match(/async function runUpdateInstall\(\) \{[\s\S]*?\n\}\n/)[0];
  assert.match(runUpdate, /e\.code === "EXDEV"/);
  assert.match(runUpdate, /Обновление не поддерживается, когда приложение установлено на другом томе/);
});

// ── «Промпты» tab: template CRUD relocated off the record card ─────────────
test("Промпты tab: renders one rail item per preset, and switching to it doesn't disturb the record-card compact select", async () => {
  const { window, $ } = await boot({
    getPresets: async () => ({
      presets: [{ id: "p1", name: "A", prompt: "prompt A" }, { id: "p2", name: "B", prompt: "prompt B" }],
      defaultOutDir: "/tmp", hfToken: "", language: "ru",
    }),
  });
  await tick(window);
  window.document.querySelector('.topbtn[data-view="prompts"]').click();
  await tick(window);
  const rows = $("promptsList").querySelectorAll(".rail-item");
  assert.equal(rows.length, 2);
  assert.deepEqual(Array.from(rows).map((r) => r.textContent), ["A", "B"]);
  assert.ok(rows[0].classList.contains("active"), "first preset is selected by default (selectPreset(0) on boot)");
  assert.equal($("presetSelect").value, "0", "record-card compact select is unaffected by viewing the tab");
});

test("Промпты tab: clicking a rail item loads it into the editor and syncs the compact record-card select", async () => {
  const { window, $ } = await boot({
    getPresets: async () => ({
      presets: [{ id: "p1", name: "A", prompt: "prompt A" }, { id: "p2", name: "B", prompt: "prompt B" }],
      defaultOutDir: "/tmp", hfToken: "", language: "ru",
    }),
  });
  await tick(window);
  window.document.querySelector('.topbtn[data-view="prompts"]').click();
  await tick(window);
  $("promptsList").querySelectorAll(".rail-item")[1].click();
  await tick(window);
  assert.equal($("promptsName").value, "B");
  assert.equal($("promptsPrompt").value, "prompt B");
  assert.equal($("presetSelect").value, "1", "compact select follows the tab's selection");
  const rows = $("promptsList").querySelectorAll(".rail-item");
  assert.ok(rows[1].classList.contains("active"));
  assert.ok(!rows[0].classList.contains("active"));
});

test("record-card compact select drives state.currentPreset and the prompt/template actually sent to processAudio", async () => {
  let sent = null;
  const { window, $ } = await boot({
    getPresets: async () => ({
      presets: [{ id: "p1", name: "A", prompt: "prompt A" }, { id: "p2", name: "B", prompt: "prompt B" }],
      defaultOutDir: "/tmp", hfToken: "", language: "ru",
    }),
    pickAudio: async () => ["/tmp/a.wav"],
    processAudio: async (opts) => { sent = opts; return { ok: true }; },
  });
  await tick(window);
  $("presetSelect").value = "1";
  $("presetSelect").dispatchEvent(new window.Event("change"));
  await tick(window);
  goImportTab(window);
  $("pickBtn").click(); await tick(window);
  $("runBtn").click(); await tick(window);
  assert.ok(sent, "processAudio was not called");
  assert.equal(sent.prompt, "prompt B");
  assert.equal(sent.template, "B");
});

test("Промпты tab: adding a template appends a preset with a generated id and persists it", async () => {
  let saved = null;
  const { window, $ } = await boot({
    getPresets: async () => ({ presets: [{ id: "p1", name: "A", prompt: "prompt A" }], defaultOutDir: "/tmp", hfToken: "", language: "ru" }),
    savePresets: async (data) => { saved = data; return true; },
  });
  await tick(window);
  window.document.querySelector('.topbtn[data-view="prompts"]').click();
  await tick(window);
  $("promptsNewBtn").click();
  await tick(window);
  assert.ok(saved, "savePresets was not called");
  assert.equal(saved.presets.length, 2);
  assert.equal(saved.presets[1].name, "Новый пресет");
  assert.ok(saved.presets[1].id, "the new preset must carry a generated id");
  assert.notEqual(saved.presets[1].id, "p1");
  const rows = $("promptsList").querySelectorAll(".rail-item");
  assert.equal(rows.length, 2);
});

test("Промпты tab: renaming the selected template persists the new name under the same id", async () => {
  let saved = null;
  const { window, $ } = await boot({
    getPresets: async () => ({ presets: [{ id: "p1", name: "A", prompt: "prompt A" }], defaultOutDir: "/tmp", hfToken: "", language: "ru" }),
    savePresets: async (data) => { saved = data; return true; },
  });
  await tick(window);
  window.document.querySelector('.topbtn[data-view="prompts"]').click();
  await tick(window);
  $("promptsName").value = "Renamed";
  $("promptsName").dispatchEvent(new window.Event("change"));
  await tick(window);
  assert.ok(saved, "savePresets was not called");
  assert.equal(saved.presets[0].id, "p1");
  assert.equal(saved.presets[0].name, "Renamed");
  assert.equal($("presetSelect").selectedOptions[0].textContent, "Renamed", "compact record-card select reflects the rename");
});

test("Промпты tab: deleting the selected template removes it and persists", async () => {
  let saved = null;
  const { window, $ } = await boot({
    getPresets: async () => ({
      presets: [{ id: "p1", name: "A", prompt: "a" }, { id: "p2", name: "B", prompt: "b" }],
      defaultOutDir: "/tmp", hfToken: "", language: "ru",
    }),
    savePresets: async (data) => { saved = data; return true; },
  });
  await tick(window);
  window.document.querySelector('.topbtn[data-view="prompts"]').click();
  await tick(window);
  $("promptsDelBtn").click();
  await tick(window);
  assert.ok(saved, "savePresets was not called");
  assert.equal(saved.presets.length, 1);
  assert.equal(saved.presets[0].id, "p2");
});

// ── История reprocess picker (owner decision: no more silent reuse of whatever the
// record card last held) ────────────────────────────────────────────────────
test("reprocess picker pre-selects the note's own template when a matching preset still exists", async () => {
  const { window, $ } = await boot({
    getPresets: async () => ({
      presets: [{ id: "p1", name: "Митинг", prompt: "prompt M" }, { id: "p2", name: "Интервью", prompt: "prompt I" }],
      defaultOutDir: "/tmp", hfToken: "", language: "ru",
    }),
    listHistory: async () => [{ name: "2026-01-01", title: "Синк", template: "Интервью", note: "/o/x.md", audio: "/o/x.wav" }],
  });
  await tick(window);
  window.document.querySelector('.topbtn[data-view="history"]').click(); await tick(window);
  $("historyList").querySelector(".rail-item:not(.pending)").click(); await tick(window);
  $("noteView").querySelector("#nvReprocess").click(); await tick(window);
  const sel = $("noteView").querySelector("#reprocessPresetSelect");
  assert.ok(sel, "picker select must be rendered");
  assert.equal(sel.value, "p2", "pre-selected to the note's own template (Интервью)");
});

test("reprocess picker falls back to the current global template when the note's template no longer exists", async () => {
  const { window, $ } = await boot({
    getPresets: async () => ({
      presets: [{ id: "p1", name: "Митинг", prompt: "prompt M" }, { id: "p2", name: "Интервью", prompt: "prompt I" }],
      defaultOutDir: "/tmp", hfToken: "", language: "ru",
    }),
    listHistory: async () => [{ name: "2026-01-01", title: "Синк", template: "Удалённый шаблон", note: "/o/x.md", audio: "/o/x.wav" }],
  });
  await tick(window);
  window.document.querySelector('.topbtn[data-view="history"]').click(); await tick(window);
  $("historyList").querySelector(".rail-item:not(.pending)").click(); await tick(window);
  $("noteView").querySelector("#nvReprocess").click(); await tick(window);
  const sel = $("noteView").querySelector("#reprocessPresetSelect");
  assert.equal(sel.value, "p1", "falls back to state.currentPreset (index 0 by default)");
});

test("reprocess picker: confirming sends the CHOSEN preset's prompt/template to processAudio, not the current global preset", async () => {
  let sent = null;
  const { window, $ } = await boot({
    getPresets: async () => ({
      presets: [{ id: "p1", name: "Митинг", prompt: "prompt M" }, { id: "p2", name: "Интервью", prompt: "prompt I" }],
      defaultOutDir: "/tmp", hfToken: "", language: "ru",
    }),
    listHistory: async () => [{ name: "2026-01-01", title: "Синк", template: "Интервью", note: "/o/x.md", audio: "/o/x.wav" }],
    processAudio: async (opts) => { sent = opts; return { ok: true }; },
  });
  await tick(window);
  // state.currentPreset defaults to 0 ("Митинг") on boot — the picker must still send
  // the explicitly chosen "Интервью" preset, not the global default.
  window.document.querySelector('.topbtn[data-view="history"]').click(); await tick(window);
  $("historyList").querySelector(".rail-item:not(.pending)").click(); await tick(window);
  $("noteView").querySelector("#nvReprocess").click(); await tick(window);
  $("noteView").querySelector("#reprocessConfirm").click(); await tick(window);
  assert.ok(sent, "processAudio was not called");
  assert.equal(sent.prompt, "prompt I");
  assert.equal(sent.template, "Интервью");
});

test("reprocess picker: cancel closes the panel and runs nothing", async () => {
  let calls = 0;
  const { window, $ } = await boot({
    getPresets: async () => ({
      presets: [{ id: "p1", name: "Митинг", prompt: "prompt M" }], defaultOutDir: "/tmp", hfToken: "", language: "ru",
    }),
    listHistory: async () => [{ name: "2026-01-01", title: "Синк", template: "Митинг", note: "/o/x.md", audio: "/o/x.wav" }],
    processAudio: async () => { calls++; return { ok: true }; },
  });
  await tick(window);
  window.document.querySelector('.topbtn[data-view="history"]').click(); await tick(window);
  $("historyList").querySelector(".rail-item:not(.pending)").click(); await tick(window);
  $("noteView").querySelector("#nvReprocess").click(); await tick(window);
  assert.ok($("noteView").querySelector("#reprocessPresetSelect"), "picker must be open before cancel");
  $("noteView").querySelector("#reprocessCancel").click(); await tick(window);
  assert.equal(calls, 0, "cancel must not trigger a run");
  assert.ok(!$("noteView").querySelector("#reprocessPresetSelect"), "panel must be removed on cancel");
});

// ── note versioning by template on reprocess (История "Переобработать") ──────────
test("reprocess picker computes the next per-template version (max existing +1) and sends it to processAudio", async () => {
  let sent = null;
  const { window, $ } = await boot({
    getPresets: async () => ({
      presets: [{ id: "p1", name: "Митинг", prompt: "prompt M" }], defaultOutDir: "/tmp", hfToken: "", language: "ru",
    }),
    // two existing notes already share the base stamp "2026-01-01-100000" under
    // template "Митинг" — one legacy (no version key → defaults to 1), one v2.
    listHistory: async () => [
      { name: "2026-01-01-100000", title: "Синк", template: "Митинг", note: "/o/a.md", audio: "/o/a.wav" },
      { name: "2026-01-01-100000-r1", title: "Синк", template: "Митинг", version: 2, note: "/o/b.md", audio: "/o/a.wav" },
    ],
    processAudio: async (opts) => { sent = opts; return { ok: true }; },
  });
  window.document.querySelector('.topbtn[data-view="history"]').click(); await tick(window);
  $("historyList").querySelector(".rail-item:not(.pending)").click(); await tick(window);
  $("noteView").querySelector("#nvReprocess").click(); await tick(window);
  $("noteView").querySelector("#reprocessConfirm").click(); await tick(window);
  assert.ok(sent, "processAudio was not called");
  assert.equal(sent.version, 3, "max existing version for this template (2, legacy note counts as 1) + 1");
});

test("reprocess picker: a template never used for this recording still computes version 1 (not None) — the filename branch relies on this being sent", async () => {
  let sent = null;
  const { window, $ } = await boot({
    getPresets: async () => ({
      presets: [{ id: "p1", name: "Митинг", prompt: "prompt M" }, { id: "p2", name: "Новый шаблон", prompt: "prompt N" }],
      defaultOutDir: "/tmp", hfToken: "", language: "ru",
    }),
    listHistory: async () => [{ name: "2026-01-01-100000", title: "Синк", template: "Митинг", note: "/o/a.md", audio: "/o/a.wav" }],
    processAudio: async (opts) => { sent = opts; return { ok: true }; },
  });
  window.document.querySelector('.topbtn[data-view="history"]').click(); await tick(window);
  $("historyList").querySelector(".rail-item:not(.pending)").click(); await tick(window);
  $("noteView").querySelector("#nvReprocess").click(); await tick(window);
  $("noteView").querySelector("#reprocessPresetSelect").value = "p2"; // pick the never-used template
  $("noteView").querySelector("#reprocessConfirm").click(); await tick(window);
  assert.equal(sent.template, "Новый шаблон");
  assert.equal(sent.version, 1, "no existing note under this template — still version 1, and still SENT (not omitted)");
});

test("retryBtn/freshBtn on an import-mode run never send a version field (regression lock — versioning is История-reprocess-only)", async () => {
  const calls = [];
  const { window, $, handlers } = await boot({
    pickAudio: async () => ["/tmp/a.wav"],
    processAudio: async (opts) => { calls.push(opts); return { ok: true }; },
  });
  goImportTab(window);
  $("pickBtn").click(); await tick(window);
  $("runBtn").click(); await tick(window);
  handlers.process({ event: "error", msg: "boom" });
  await tick(window);
  assert.ok(!("version" in calls[0]));
  $("retryBtn").click(); await tick(window);
  assert.equal(calls.length, 2);
  assert.ok(!("version" in calls[1]), "retry must not carry a version — only a История reprocess computes one");
});

test("История groups a multi-version recording into a collapsible block: descending per-template versions, no '(latest)' marker, collapses/expands", async () => {
  const { window, $ } = await boot({
    listHistory: async () => [
      { name: "2026-07-11-100000", title: "Планёрка", template: "Митинг", version: 1, note: "/o/a.md", audio: "/o/a.wav" },
      { name: "2026-07-11-100000-r1", title: "Планёрка", template: "Митинг", version: 2, note: "/o/b.md", audio: "/o/a.wav" },
      { name: "2026-07-11-100000-r2", title: "Планёрка", template: "Интервью", version: 1, note: "/o/c.md", audio: "/o/a.wav" },
    ],
  });
  window.document.querySelector('.topbtn[data-view="history"]').click(); await tick(window);
  const group = $("historyList").querySelector(".rail-group");
  assert.ok(group, "a recording with >1 note must render as a collapsible group, not flat rows");
  assert.equal($("historyList").querySelectorAll(".rail-group").length, 1);
  const header = group.querySelector(".rail-group-header");
  assert.match(header.textContent, /Планёрка/);
  assert.equal(header.querySelector(".glossary-caret").textContent, "▾", "expanded by default");
  // .rail-title only — the row itself now also carries a 🗑 delete button whose own text
  // would otherwise pollute a whole-row textContent match.
  const labels = Array.from(group.querySelectorAll(".rail-version-row .rail-title")).map((r) => r.textContent.trim());
  assert.deepEqual(labels, ["Митинг · v2", "Митинг · v1", "Интервью"],
    "template stable order (first-seen), versions descending within a template; a template " +
    "with ≥2 versions shows '· vN' on every row (Вариант B drops '(latest)'), a template " +
    "with exactly 1 version (Интервью) shows just its name — no '· v1'");
  // 3 обработки total (≥2) — the header must carry the count-pill.
  assert.match($("historyList").querySelector(".rail-group-header .rail-rec-badge.count").textContent, /^3 обработки$/);

  $("historyList").querySelector(".rail-group-header").click();
  await tick(window);
  assert.ok($("historyList").querySelector(".rail-group-versions").classList.contains("hidden"), "collapses on click");
  assert.equal($("historyList").querySelector(".rail-group-header .glossary-caret").textContent, "▸");

  $("historyList").querySelector(".rail-group-header").click();
  await tick(window);
  assert.ok(!$("historyList").querySelector(".rail-group-versions").classList.contains("hidden"), "re-expands on a second click");
});

// Regression guard (critic nit on ccad5ba): the recording group's обработка rows
// (buildNotesRecordingRow, formerly buildHistoryVersionGroup) are built via innerHTML +
// closure-wired click handlers, and originally never got a dataset.idx — selectNote's
// `+e.dataset.idx === idx` highlight match silently never fired for them (NaN !== idx),
// so a clicked version row opened the note but never showed selected.
test("clicking a version row inside a История group highlights it with .active (and only that row)", async () => {
  const { window, $ } = await boot({
    listHistory: async () => [
      { name: "2026-07-11-100000", title: "Планёрка", template: "Митинг", version: 1, note: "/o/a.md", audio: "/o/a.wav" },
      { name: "2026-07-11-100000-r1", title: "Планёрка", template: "Митинг", version: 2, note: "/o/b.md", audio: "/o/a.wav" },
    ],
  });
  window.document.querySelector('.topbtn[data-view="history"]').click(); await tick(window);
  const rows = Array.from($("historyList").querySelectorAll(".rail-version-row"));
  assert.equal(rows.length, 2);
  // История auto-opens the topmost rendered note on entry (see the auto-open/empty-state
  // commit) — that's rows[0] ("Митинг · v2", rendered first, version-descending), already active.
  assert.ok(rows[0].classList.contains("active"), "auto-open marks the topmost (highest-version) row active");
  assert.ok(!rows[1].classList.contains("active"));

  rows[1].click(); // "Митинг · v1"
  await tick(window);
  assert.ok(!rows[0].classList.contains("active"), "active must move off the previously-selected row");
  assert.ok(rows[1].classList.contains("active"), "clicking a different version row selects it instead");

  rows[0].click(); // back to "Митинг · v2"
  await tick(window);
  assert.ok(rows[0].classList.contains("active"), "clicking a different version row selects it instead");
  assert.ok(!rows[1].classList.contains("active"), "only the clicked row is active");
});

// Audio-first rail redesign: EVERY notes-bearing recording is now a collapsible group,
// including a solitary (single-обработка) one — there's no more special-cased flat row
// (the old buildHistoryRow is retired). Вариант B (history-compact-b.html): a lone
// обработка must NOT also show a "1 обработка" count-pill next to its own single row —
// that duplication was the bug being fixed — and its row is just the template name,
// with no "· v1" (nothing to disambiguate with only one version).
test("История: a single-обработка recording renders as a collapsible group with NO count-pill and a plain template-name row", async () => {
  const { window, $ } = await boot({
    listHistory: async () => [{ name: "2026-01-01-100000", title: "Синк", template: "Митинг", note: "/o/a.md", audio: "/o/a.wav" }],
  });
  window.document.querySelector('.topbtn[data-view="history"]').click(); await tick(window);
  assert.equal($("historyList").querySelectorAll(".rail-group").length, 1);
  assert.ok($("historyList").querySelector(".rail-version-row"), "the note itself is the group's one обработка row");
  assert.ok(!$("historyList").querySelector(".rail-rec-badge.count"), "a lone обработка must not duplicate a count-pill next to its own single row");
  assert.equal($("historyList").querySelector(".rail-version-row .rail-title").textContent.trim(), "Митинг",
    "single note in a single template — just the template name, no version suffix");
});

// ── audio-first История rail (design "Вариант A" — recording is the top level,
// обработки the second; see buildRecordings/buildRecordingRow in renderer.js) ───────
test("audio-first rail: groups note rows purely by the backend-provided base_stamp field, even when the note stamps themselves differ", async () => {
  const { window, $ } = await boot({
    listHistory: async () => [
      { name: "2026-07-11-100000", base_stamp: "2026-07-11-100000", title: "Планёрка", template: "Митинг", version: 1, note: "/o/a.md", audio: "/o/a.wav" },
      // a completely different `name` stamp — grouping must key off base_stamp alone,
      // not re-derive identity from the note's own filename stamp.
      { name: "2026-07-11-999999", base_stamp: "2026-07-11-100000", title: "Планёрка", template: "Интервью", version: 1, note: "/o/b.md", audio: "/o/a.wav" },
    ],
  });
  window.document.querySelector('.topbtn[data-view="history"]').click(); await tick(window);
  assert.equal($("historyList").querySelectorAll(".rail-group").length, 1, "same base_stamp field — one group despite different name stamps");
  assert.equal($("historyList").querySelectorAll(".rail-version-row").length, 2);
});

test("audio-first rail: an audios[] entry with no matching note renders as a one-line orphan row (filename · duration + ▶ Обработать)", async () => {
  const { window, $ } = await boot({
    listHistory: async () => Object.assign(
      [{ name: "2026-07-08-190000", base_stamp: "2026-07-08-190000", title: "C", note: "/c.md", audio: "/c.wav" }],
      {
        audios: [
          { base_stamp: "2026-07-08-190000", path: "/out/meeting-2026-07-08-190000.wav", size: 1000, mtime: 1, duration_s: 600 },
          { base_stamp: "2026-07-14-140300", path: "/out/meeting-2026-07-14-140300.wav", size: 2000, mtime: 2, duration_s: 2460 },
        ],
      }
    ),
  });
  window.document.querySelector('.topbtn[data-view="history"]').click(); await tick(window);
  const orphan = $("historyList").querySelector(".rail-item.orphan");
  assert.ok(orphan, "the unpaired audio entry must render as its own orphan row");
  assert.match(orphan.textContent, /meeting-2026-07-14-140300\.wav/);
  assert.match(orphan.textContent, /41 мин/, "duration (2460s) is shown inline next to the filename");
  // Вариант B drops the separate «без обработок» status badge/meta floor entirely.
  assert.ok(!orphan.querySelector(".rail-rec-badge"), "no status badge — the meta floor is retired");
  assert.match(orphan.querySelector(".btn.primary").textContent, /▶ Обработать/);
  assert.equal($("historyList").querySelectorAll(".rail-group").length, 1, "the PAIRED audio entry must not also render as an orphan");
});

test("audio-first rail: an orphan row's ▶ Обработать opens the reprocess picker and sends THAT audio's path", async () => {
  let sentAudioFile = null;
  const { window, $ } = await boot({
    getPresets: async () => ({
      presets: [{ id: "p1", name: "Митинг", prompt: "prompt M" }], defaultOutDir: "/tmp", hfToken: "", language: "ru",
    }),
    listHistory: async () => Object.assign(
      [],
      { audios: [{ base_stamp: "2026-07-14-140300", path: "/out/meeting-2026-07-14-140300.wav", size: 100, mtime: 1, duration_s: 120 }] }
    ),
    processAudio: async (opts) => { sentAudioFile = opts.audioFile; return { ok: true }; },
  });
  window.document.querySelector('.topbtn[data-view="history"]').click(); await tick(window);
  const orphan = $("historyList").querySelector(".rail-item.orphan");
  orphan.querySelector(".btn.primary").click(); await tick(window);
  assert.ok($("noteView").querySelector("#reprocessPresetSelect"), "picker must open (reuses the same entry point a note's own ▶ uses)");
  $("noteView").querySelector("#reprocessConfirm").click(); await tick(window);
  assert.equal(sentAudioFile, "/out/meeting-2026-07-14-140300.wav", "reprocesses THIS orphan's own audio, not item.audio/currentAudio() leftovers");
});

test("audio-first rail: a pending recording (status 'pending') shows the «ждёт обработки» badge", async () => {
  const { window, $, handlers } = await boot({ listHistory: async () => [] });
  window.document.querySelector('.topbtn[data-view="history"]').click(); await tick(window);
  handlers.record({
    event: "recorded", id: "2026-07-09T10-00-00-a1b2", name: "Запись 1",
    file: "/tmp/mixed.wav", mic: "/tmp/m.wav", system: null, tracks: 1,
  });
  await tick(window);
  const row = $("historyList").querySelector(".rail-item.pending");
  assert.ok(row);
  assert.match(row.querySelector(".rail-rec-badge.wait").textContent, /ждёт обработки/);
});

test("audio-first rail: text search hides a non-matching notes-recording but keeps an orphan (audio-only) recording visible", async () => {
  const { window, $ } = await boot({
    listHistory: async () => Object.assign(
      [{ name: "2026-07-08-190000", base_stamp: "2026-07-08-190000", title: "Планирование спринта", note: "/c.md", audio: null }],
      { audios: [{ base_stamp: "2026-07-14-140300", path: "/out/meeting-2026-07-14-140300.wav", size: 100, mtime: 1, duration_s: 60 }] }
    ),
  });
  window.document.querySelector('.topbtn[data-view="history"]').click(); await tick(window);
  assert.equal($("historyList").querySelectorAll(".rail-group").length, 1);
  assert.ok($("historyList").querySelector(".rail-item.orphan"));
  $("historySearch").value = "интервью"; // matches neither the note's title nor an orphan (no title to match)
  $("historySearch").dispatchEvent(new window.Event("input"));
  assert.equal($("historyList").querySelectorAll(".rail-group").length, 0, "the non-matching notes-recording is hidden");
  assert.ok($("historyList").querySelector(".rail-item.orphan"), "the orphan recording always passes text/lang/template filters");
});

test("history rail: date-group headers count RECORDINGS, not обработки — a multi-обработка recording counts once", async () => {
  const { window, $ } = await boot({
    listHistory: async () => [
      { name: "2026-07-11-100000", base_stamp: "2026-07-11-100000", title: "Планёрка", template: "Митинг", version: 1, note: "/o/a.md", audio: "/o/a.wav" },
      { name: "2026-07-11-100000-r1", base_stamp: "2026-07-11-100000", title: "Планёрка", template: "Митинг", version: 2, note: "/o/b.md", audio: "/o/a.wav" },
      { name: "2026-07-11-150000", base_stamp: "2026-07-11-150000", title: "Отдельная", template: "Митинг", note: "/o/c.md", audio: "/o/c.wav" },
    ],
  });
  window.document.querySelector('.topbtn[data-view="history"]').click(); await tick(window);
  const header = $("historyList").querySelector(".rail-date-header");
  assert.equal(header.textContent, "11 июля · 2", "3 обработки total, but only 2 RECORDINGS (one multi-обработка group + one solitary)");
});

test("История note delete: after deleting the recording's last note, it stays visible as an orphan row (audio inventory keeps it alive)", async () => {
  let notes = [{ name: "2026-07-08-190000", base_stamp: "2026-07-08-190000", title: "Синк", note: "/o/meeting-x.md", audio: "/o/meeting-x.wav" }];
  const audios = [{ base_stamp: "2026-07-08-190000", path: "/o/meeting-x.wav", size: 1000, mtime: 1, duration_s: 900 }];
  const { window, $ } = await boot({
    listHistory: async () => Object.assign([...notes], { audios }),
    deleteHistoryNote: async (notePath) => {
      notes = notes.filter((n) => n.note !== notePath);
      return { ok: true };
    },
  });
  window.confirm = () => true;
  window.document.querySelector('.topbtn[data-view="history"]').click(); await tick(window);
  assert.equal($("historyList").querySelectorAll(".rail-group").length, 1);
  $("historyList").querySelector(".rail-version-row").click(); await tick(window);
  $("noteView").querySelector("#nvDelete").click();
  await tick(window); await tick(window);
  assert.equal($("historyList").querySelectorAll(".rail-group").length, 0, "no notes left — no more group");
  const orphan = $("historyList").querySelector(".rail-item.orphan");
  assert.ok(orphan, "the audio inventory entry keeps the recording visible after its last note is trashed");
  assert.match(orphan.textContent, /meeting-x\.wav/);
});

// ── История note deletion ────────────────────────────────────────────────────
test("История note view: delete button lives in the note header, uses the shared .btn.danger style", async () => {
  const { window, $ } = await boot({
    listHistory: async () => [{ name: "2026-01-01", base_stamp: "2026-01-01", title: "Синк", note: "/o/meeting-x.md", audio: "/o/meeting-x.wav" }],
  });
  window.document.querySelector('.topbtn[data-view="history"]').click(); await tick(window);
  $("historyList").querySelector(".rail-item").click(); await tick(window);
  const btn = $("noteView").querySelector("#nvDelete");
  assert.ok(btn, "delete button not found in the open note's header");
  assert.ok(btn.classList.contains("danger"), "must reuse the shared danger token, not a hardcoded color");
  assert.equal(btn.getAttribute("style"), null, "no inline styling");
});

test("История note delete: confirm() cancel → deleteHistoryNote is never called, note stays open", async () => {
  let called = false;
  const { window, $ } = await boot({
    listHistory: async () => [{ name: "2026-01-01", base_stamp: "2026-01-01", title: "Синк", note: "/o/meeting-x.md", audio: "/o/meeting-x.wav" }],
    deleteHistoryNote: async () => { called = true; return { ok: true }; },
  });
  window.confirm = () => false;
  window.document.querySelector('.topbtn[data-view="history"]').click(); await tick(window);
  $("historyList").querySelector(".rail-item").click(); await tick(window);
  $("noteView").querySelector("#nvDelete").click(); await tick(window);
  assert.equal(called, false, "deleteHistoryNote must not be called when confirm is declined");
  assert.ok($("noteView").textContent.includes("Синк"), "note view must remain showing the note");
  assert.equal($("historyList").querySelectorAll(".rail-item").length, 1, "rail entry must survive a cancelled delete");
});

test("История note delete: confirmed → deleteHistoryNote called with the note's path, rail entry removed", async () => {
  let deletedPath = null;
  let notes = [{ name: "2026-01-01", title: "Синк", note: "/o/meeting-x.md", audio: "/o/meeting-x.wav" }];
  const { window, $ } = await boot({
    listHistory: async () => notes,
    deleteHistoryNote: async (notePath) => {
      deletedPath = notePath;
      notes = notes.filter((n) => n.note !== notePath);
      return { ok: true };
    },
  });
  window.confirm = () => true;
  window.document.querySelector('.topbtn[data-view="history"]').click(); await tick(window);
  $("historyList").querySelector(".rail-item").click(); await tick(window);
  $("noteView").querySelector("#nvDelete").click();
  await tick(window); await tick(window);
  assert.equal(deletedPath, "/o/meeting-x.md");
  assert.equal($("historyList").querySelectorAll(".rail-item").length, 0, "deleted note's row must be gone");
  assert.ok(!$("noteView").textContent.includes("Синк"), "deleted note's content must no longer show");
  assert.ok($("noteView").textContent.includes("Пока нет заметок"), "empty state shown once no notes remain");
});

test("История note delete: with another note remaining, refresh auto-opens it instead of leaving stale content", async () => {
  let notes = [
    { name: "2026-01-02", title: "Встреча 2", note: "/o/meeting-2.md", audio: null },
    { name: "2026-01-01", title: "Синк", note: "/o/meeting-x.md", audio: "/o/meeting-x.wav" },
  ];
  const { window, $ } = await boot({
    listHistory: async () => notes,
    readNote: async (p) => (p === "/o/meeting-2.md"
      ? '---\ntitle: "Встреча 2"\n---\n\nвторая заметка'
      : '---\ntitle: "Синк"\n---\n\nпервая заметка'),
    deleteHistoryNote: async (notePath) => {
      notes = notes.filter((n) => n.note !== notePath);
      return { ok: true };
    },
  });
  window.confirm = () => true;
  window.document.querySelector('.topbtn[data-view="history"]').click(); await tick(window);
  const rows = $("historyList").querySelectorAll(".rail-item");
  assert.equal(rows.length, 2);
  rows[0].click(); await tick(window); // open whichever the rail put first
  const openedTitle = $("noteView").querySelector(".note-title").textContent;
  $("noteView").querySelector("#nvDelete").click();
  await tick(window); await tick(window);
  assert.equal($("historyList").querySelectorAll(".rail-item").length, 1, "one row removed from the rail");
  assert.ok(!$("noteView").textContent.includes(openedTitle), "the deleted note's own title must no longer show");
  assert.ok($("noteView").querySelector(".note-title"), "the remaining note auto-opens instead of leaving a placeholder");
});

test("История note delete: main refuses while busy (ok:false) → alert shown, note stays open, button re-enabled", async () => {
  let alerted = null;
  const { window, $ } = await boot({
    listHistory: async () => [{ name: "2026-01-01", base_stamp: "2026-01-01", title: "Синк", note: "/o/meeting-x.md", audio: "/o/meeting-x.wav" }],
    deleteHistoryNote: async () => ({ ok: false, error: "Дождитесь окончания обработки" }),
  });
  window.alert = (msg) => { alerted = msg; };
  window.confirm = () => true;
  window.document.querySelector('.topbtn[data-view="history"]').click(); await tick(window);
  $("historyList").querySelector(".rail-item").click(); await tick(window);
  $("noteView").querySelector("#nvDelete").click();
  await tick(window); await tick(window);
  assert.equal(alerted, "Дождитесь окончания обработки");
  assert.ok($("noteView").textContent.includes("Синк"), "note must remain open after a refused delete");
  assert.equal($("noteView").querySelector("#nvDelete").disabled, false, "button re-enabled after refusal");
});

test("История note delete: confirm text now uses корзина semantics (30-day retention), not permanent-delete wording", async () => {
  let confirmMsg = null;
  const { window, $ } = await boot({
    listHistory: async () => [{ name: "2026-01-01", base_stamp: "2026-01-01", title: "Синк", note: "/o/meeting-x.md", audio: "/o/meeting-x.wav" }],
  });
  window.confirm = (msg) => { confirmMsg = msg; return false; }; // decline — this test only spies on the copy
  window.document.querySelector('.topbtn[data-view="history"]').click(); await tick(window);
  $("historyList").querySelector(".rail-item").click(); await tick(window);
  $("noteView").querySelector("#nvDelete").click(); await tick(window);
  assert.match(confirmMsg, /корзин/i);
  assert.match(confirmMsg, /30 дней/);
});

test("История note delete: deleteHistoryNote is called with the note's base_stamp as the 2nd arg (trash manifest correlation)", async () => {
  let gotBaseStamp;
  const { window, $ } = await boot({
    listHistory: async () => [{ name: "2026-01-01", base_stamp: "2026-01-01-100000", title: "Синк", note: "/o/meeting-x.md", audio: "/o/meeting-x.wav" }],
    deleteHistoryNote: async (notePath, baseStamp) => { gotBaseStamp = baseStamp; return { ok: true }; },
  });
  window.confirm = () => true;
  window.document.querySelector('.topbtn[data-view="history"]').click(); await tick(window);
  $("historyList").querySelector(".rail-item").click(); await tick(window);
  $("noteView").querySelector("#nvDelete").click(); await tick(window);
  assert.equal(gotBaseStamp, "2026-01-01-100000");
});

// ── История recording-level trash (rail ✕ — corзина feature) ────────────────
test("recording ✕ (notes-bearing): confirm() cancel → deleteHistoryRecording is never called, group stays", async () => {
  let called = false;
  const notes = [
    { name: "2026-07-11-100000", base_stamp: "2026-07-11-100000", title: "Планёрка", template: "Митинг", version: 1, note: "/o/a.md", audio: "/o/a.wav" },
  ];
  const audios = [{ base_stamp: "2026-07-11-100000", path: "/o/meeting-2026-07-11-100000.wav", size: 100, mtime: 1, duration_s: 60 }];
  const { window, $ } = await boot({
    listHistory: async () => Object.assign([...notes], { audios }),
    deleteHistoryRecording: async () => { called = true; return { ok: true }; },
  });
  window.confirm = () => false;
  window.document.querySelector('.topbtn[data-view="history"]').click(); await tick(window);
  $("historyList").querySelector(".rec-trash-btn").click(); await tick(window);
  assert.equal(called, false, "deleteHistoryRecording must not be called when confirm is declined");
  assert.equal($("historyList").querySelectorAll(".rail-group").length, 1, "group must survive a cancelled trash");
});

test("recording ✕ (notes-bearing, multi-обработка): confirmed → deleteHistoryRecording called with baseStamp + ALL note paths + audio path, rail refreshed", async () => {
  let payload = null;
  let notes = [
    { name: "2026-07-11-100000", base_stamp: "2026-07-11-100000", title: "Планёрка", template: "Митинг", version: 1, note: "/o/a.md", audio: "/o/a.wav" },
    { name: "2026-07-11-100000-r1", base_stamp: "2026-07-11-100000", title: "Планёрка", template: "Саммари", version: 1, note: "/o/b.md", audio: "/o/a.wav" },
  ];
  let audios = [{ base_stamp: "2026-07-11-100000", path: "/o/meeting-2026-07-11-100000.wav", size: 100, mtime: 1, duration_s: 60 }];
  const { window, $ } = await boot({
    listHistory: async () => Object.assign([...notes], { audios }),
    deleteHistoryRecording: async (p) => { payload = p; notes = []; audios = []; return { ok: true }; },
  });
  window.confirm = () => true;
  window.document.querySelector('.topbtn[data-view="history"]').click(); await tick(window);
  $("historyList").querySelector(".rec-trash-btn").click();
  await tick(window); await tick(window);
  assert.equal(payload.baseStamp, "2026-07-11-100000");
  assert.deepEqual(payload.notePaths.slice().sort(), ["/o/a.md", "/o/b.md"]);
  assert.deepEqual(payload.audioPaths, ["/o/meeting-2026-07-11-100000.wav"]);
  assert.equal($("historyList").querySelectorAll(".rail-group").length, 0, "the whole group must be gone after refresh");
});

test("recording ✕ (orphan): confirmed → deleteHistoryRecording called with the audio path only (no notes), orphan row disappears", async () => {
  let payload = null;
  let audios = [{ base_stamp: "2026-07-14-140300", path: "/out/meeting-2026-07-14-140300.wav", size: 100, mtime: 1, duration_s: 120 }];
  const { window, $ } = await boot({
    listHistory: async () => Object.assign([], { audios }),
    deleteHistoryRecording: async (p) => { payload = p; audios = []; return { ok: true }; },
  });
  window.confirm = () => true;
  window.document.querySelector('.topbtn[data-view="history"]').click(); await tick(window);
  $("historyList").querySelector(".rail-item.orphan .rec-trash-btn").click();
  await tick(window); await tick(window);
  assert.equal(payload.baseStamp, "2026-07-14-140300");
  assert.deepEqual(payload.notePaths, []);
  assert.deepEqual(payload.audioPaths, ["/out/meeting-2026-07-14-140300.wav"]);
  assert.ok(!$("historyList").querySelector(".rail-item.orphan"), "orphan row must be gone after refresh");
});

test("recording ✕: main refuses/fails (ok:false) → alert shown AND rail still refreshed (refreshHistory must not be skipped on the error path)", async () => {
  let alerted = null;
  let listHistoryCalls = 0;
  const notes = [{ name: "2026-07-11-100000", base_stamp: "2026-07-11-100000", title: "Планёрка", note: "/o/a.md", audio: "/o/a.wav" }];
  const { window, $ } = await boot({
    listHistory: async () => { listHistoryCalls++; return Object.assign([...notes], { audios: [] }); },
    deleteHistoryRecording: async () => ({ ok: false, error: "Дождитесь окончания обработки" }),
  });
  window.alert = (msg) => { alerted = msg; };
  window.confirm = () => true;
  window.document.querySelector('.topbtn[data-view="history"]').click(); await tick(window);
  const callsBeforeDelete = listHistoryCalls;
  $("historyList").querySelector(".rec-trash-btn").click();
  await tick(window); await tick(window);
  assert.equal(alerted, "Дождитесь окончания обработки");
  assert.equal($("historyList").querySelectorAll(".rail-group").length, 1, "group must survive a refused trash (nothing actually moved, so nothing to remove)");
  assert.ok(listHistoryCalls > callsBeforeDelete,
    "refreshHistory() must still run on the error path — a partial server-side failure (some files already moved+manifest-recorded) must not leave the rail showing stale rows whose files are gone");
});

test("recording ✕: excluded on pending rows — no .rec-trash-btn, existing remove-pending-recording ✕ untouched", async () => {
  const { window, $ } = await boot({
    listHistory: async () => [],
    listPendingRecordings: async () => ([
      { id: "r1", name: "Запись 1", mixed: "/rec/r1/mixed.wav", mic: "/rec/r1/mic.wav", system: null, tracks: 1 },
    ]),
  });
  window.document.querySelector('.topbtn[data-view="history"]').click(); await tick(window);
  const pendingRow = $("historyList").querySelector(".rail-item.pending");
  assert.ok(pendingRow, "pending row must render");
  assert.ok(!pendingRow.querySelector(".rec-trash-btn"), "pending keeps its own ✕ (remove-pending-recording) only — no trash button");
  assert.ok(pendingRow.querySelector(".pending-del-btn"), "the existing pending ✕ must still be present");
});

// ── Вариант B: История card redesign — «карточка, но тише» (design ref:
// history-compact-b.html). The old labeled-actions row + separate meta line (T1/T2,
// history-buttons-a.html вариант A) are retired: the header is now ONE row (caret + 🎙
// title + optional count-pill + time + a muted 🗑 icon-button, danger-fill only on
// hover), and an orphan row is ONE flat line (icon + filename·duration + ▶ + 🗑). ──────
test("История card redesign (variant B): a notes-bearing group's 🗑 lives in the one-row header, icon-only, not a separate actions/meta floor", async () => {
  const { window, $ } = await boot({
    listHistory: async () => [{ name: "2026-07-11-100000", base_stamp: "2026-07-11-100000", title: "Планёрка", template: "Митинг", version: 1, note: "/o/a.md", audio: "/o/a.wav" }],
  });
  window.document.querySelector('.topbtn[data-view="history"]').click(); await tick(window);
  const group = $("historyList").querySelector(".rail-group");
  const header = group.querySelector(".rail-group-header");
  assert.ok(header, "header must exist");
  const trashBtn = header.querySelector(".rec-trash-btn");
  assert.ok(trashBtn, "🗑 must live inside the one-row header");
  assert.equal(trashBtn.textContent.trim(), "🗑", "icon-only — no '🗑 В корзину' label, Вариант B is quieter");
  assert.ok(!group.querySelector(".rail-actions"), "the separate actions row is retired");
  assert.ok(!group.querySelector(".rail-rec-meta"), "the separate meta line is retired");
});

test("История card redesign (variant B): an orphan row's ▶ Обработать and 🗑 share ONE flat line, no actions/meta floor", async () => {
  const { window, $ } = await boot({
    listHistory: async () => Object.assign([], {
      audios: [{ base_stamp: "2026-07-14-140300", path: "/out/meeting-2026-07-14-140300.wav", size: 100, mtime: 1, duration_s: 120 }],
    }),
  });
  window.document.querySelector('.topbtn[data-view="history"]').click(); await tick(window);
  const orphan = $("historyList").querySelector(".rail-item.orphan");
  assert.ok(!orphan.querySelector(".rail-actions"), "the separate actions row is retired");
  assert.ok(!orphan.querySelector(".rail-rec-meta"), "the separate meta line is retired");
  assert.ok(orphan.querySelector(".process-orphan-btn"), "▶ Обработать still present, directly in the one-line row");
  const trashBtn = orphan.querySelector(".rec-trash-btn");
  assert.ok(trashBtn, "🗑 still present");
  assert.equal(trashBtn.textContent.trim(), "🗑", "icon-only, same as the group-header's");
});

test("История card redesign (variant B, overflow lock): header title and time are their own cells; version/orphan title cells stay ellipsis-safe", async () => {
  const { window, $ } = await boot({
    listHistory: async () => [{ name: "2026-07-11-100000", base_stamp: "2026-07-11-100000", title: "Планёрка", template: "Митинг", version: 1, note: "/o/a.md", audio: "/o/a.wav" }],
  });
  window.document.querySelector('.topbtn[data-view="history"]').click(); await tick(window);
  const group = $("historyList").querySelector(".rail-group");
  assert.ok(group.querySelector(".rail-group-title"), "group-header title must be its own shrinkable/ellipsis cell, not raw text next to the caret");
  assert.ok(group.querySelector(".rail-group-time"), "time must be its own fixed-width cell, not squeezed together with the title");
});

// CSS source-text lock (same idiom as the pending-row overflow guard below) — jsdom
// doesn't compute real layout, so the narrow-width "no wrap into vertical letters"
// guarantee for the header title and the orphan's combined filename·duration cell has
// to be locked at the CSS-rule level.
test("style.css: rail header title and orphan filename cell ellipsize instead of wrapping", () => {
  const css = fs.readFileSync(path.join(__dirname, "../renderer/style.css"), "utf8");
  const titleRule = css.match(/\.rail-group-title \{[^}]*\}/);
  assert.ok(titleRule, ".rail-group-title rule exists");
  assert.match(titleRule[0], /min-width: 0/);
  assert.match(titleRule[0], /white-space: nowrap/);
  const fileRule = css.match(/\.rail-title-file \{[^}]*\}/);
  assert.ok(fileRule, ".rail-title-file rule exists");
  assert.match(fileRule[0], /min-width: 0/);
  assert.match(fileRule[0], /white-space: nowrap/);
});

test("История card redesign (variant B): clicking the header's 🗑 does not also toggle collapse (stopPropagation)", async () => {
  const { window, $ } = await boot({
    listHistory: async () => [{ name: "2026-07-11-100000", base_stamp: "2026-07-11-100000", title: "Планёрка", template: "Митинг", version: 1, note: "/o/a.md", audio: "/o/a.wav" }],
  });
  window.confirm = () => false; // decline the trash confirm — isolate collapse-toggle behaviour only
  window.document.querySelector('.topbtn[data-view="history"]').click(); await tick(window);
  assert.equal($("historyList").querySelector(".rail-group-header .glossary-caret").textContent, "▾", "expanded by default");
  $("historyList").querySelector(".rec-trash-btn").click(); await tick(window);
  assert.equal($("historyList").querySelector(".rail-group-header .glossary-caret").textContent, "▾",
    "declining the trash confirm must leave the group exactly as it was — the click must not also bubble to the header's own collapse-toggle listener");
});

// The header is no longer a native <button> (a real 🗑 <button> now lives inside it —
// nesting <button>s is invalid HTML), so keyboard activation needs its own handler.
test("История card redesign (variant B): header is keyboard-activatable (Enter toggles collapse, same as a click)", async () => {
  const { window, $ } = await boot({
    listHistory: async () => [{ name: "2026-07-11-100000", base_stamp: "2026-07-11-100000", title: "Планёрка", template: "Митинг", version: 1, note: "/o/a.md", audio: "/o/a.wav" }],
  });
  window.document.querySelector('.topbtn[data-view="history"]').click(); await tick(window);
  const header = $("historyList").querySelector(".rail-group-header");
  assert.equal(header.getAttribute("tabindex"), "0", "must be keyboard-focusable");
  assert.equal(header.getAttribute("role"), "button");
  header.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await tick(window);
  assert.equal($("historyList").querySelector(".rail-group-header .glossary-caret").textContent, "▸", "Enter toggles collapse just like a click would");
  // Space is the other native-button activation key — and unlike Enter it scrolls the
  // rail if the handler forgets preventDefault, so both branches get locked.
  const spaceEv = new window.KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
  $("historyList").querySelector(".rail-group-header").dispatchEvent(spaceEv);
  await tick(window);
  assert.equal($("historyList").querySelector(".rail-group-header .glossary-caret").textContent, "▾", "Space toggles collapse back");
  assert.ok(spaceEv.defaultPrevented, "Space must be preventDefault'ed — otherwise it scrolls the rail");
});

test("История card redesign: version-row 🗑 deletes THAT note via the existing deleteHistoryNote flow, without selecting the row (stopPropagation)", async () => {
  let deletedNote = null;
  let selectNoteCalls = 0;
  const { window, $ } = await boot({
    listHistory: async () => [
      { name: "2026-07-11-100000", base_stamp: "2026-07-11-100000", title: "Планёрка", template: "Митинг", version: 1, note: "/o/a.md", audio: "/o/a.wav" },
      { name: "2026-07-11-100000-r1", base_stamp: "2026-07-11-100000", title: "Планёрка", template: "Митинг", version: 2, note: "/o/b.md", audio: "/o/a.wav" },
    ],
    deleteHistoryNote: async (notePath) => { deletedNote = notePath; return { ok: true }; },
    readNote: async () => {
      selectNoteCalls++;
      return '---\ntitle: "T"\n---\n\ntext';
    },
  });
  window.document.querySelector('.topbtn[data-view="history"]').click(); await tick(window);
  const callsBeforeDelete = selectNoteCalls;
  const rows = Array.from($("historyList").querySelectorAll(".rail-version-row"));
  assert.equal(rows.length, 2);
  rows[1].querySelector(".rail-version-del").click();
  await tick(window); await tick(window);
  // rows are version-descending (v2 first, v1 second) — rows[1] is /o/a.md (v1).
  assert.equal(deletedNote, "/o/a.md", "deletes the row's own note, not the auto-opened topmost-version one");
  assert.equal(selectNoteCalls, callsBeforeDelete, "clicking 🗑 must not also select/open the row (stopPropagation)");
});

test("История card redesign: deleting a version row that is NOT the currently open note leaves the open note view untouched", async () => {
  const notes = [
    { name: "2026-07-11-100000", base_stamp: "2026-07-11-100000", title: "Планёрка", template: "Митинг", version: 2, note: "/o/latest.md", audio: "/o/a.wav" },
    { name: "2026-07-11-100000-r1", base_stamp: "2026-07-11-100000", title: "Планёрка", template: "Митинг", version: 1, note: "/o/old.md", audio: "/o/a.wav" },
  ];
  const { window, $ } = await boot({
    listHistory: async () => notes,
    deleteHistoryNote: async () => ({ ok: true }),
  });
  window.document.querySelector('.topbtn[data-view="history"]').click(); await tick(window);
  // auto-open picks the topmost (highest-version) row — /o/latest.md — as covered elsewhere;
  // deleting the OTHER (older) row's note must not blank out the still-open note.
  assert.ok(!$("noteView").querySelector(".history-placeholder"), "a note must already be open (auto-open)");
  const rows = Array.from($("historyList").querySelectorAll(".rail-version-row"));
  rows[1].querySelector(".rail-version-del").click();
  await tick(window); await tick(window);
  assert.ok(!$("noteView").querySelector(".history-placeholder"),
    "noteView must NOT be cleared — the deleted note (/o/old.md) wasn't the one open (/o/latest.md)");
});

// main.js requires("electron") and can't be loaded headless under plain node --test
// (same reason as the other main.js checks above) — source-text assertions cover the
// handler's actual guard/validation/move-to-trash logic that a jsdom renderer test can't
// reach. Post-trash-feature: the handler moves the note into .trash/ (moveToTrash) instead
// of a permanent fs.unlinkSync — see lib/mainutil.js's trash helpers.
test("main.js: delete-history-note refuses while procProc is active, validates via isNoteDeletable, and moves (never permanently deletes) the note", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const handler = mainSrc.match(/ipcMain\.handle\("delete-history-note"[\s\S]*?\n\}\);/);
  assert.ok(handler, "delete-history-note handler not found");
  assert.match(handler[0], /if \(procProc\) return \{ ok: false/);
  assert.match(handler[0], /isNoteDeletable/);
  assert.match(handler[0], /fs\.realpathSync/);
  assert.match(handler[0], /moveToTrash/);
  assert.match(handler[0], /kind: "note"/);
  assert.ok(!/fs\.unlinkSync/.test(handler[0]), "must no longer permanently unlink — it moves to trash now");
  assert.ok(!/rmSync|rm\(/.test(handler[0]), "must never use a recursive/directory-capable delete");
});

test("main.js: delete-history-recording validates EVERY note/audio path before moving any, refuses while procProc is active, and never does a recursive delete", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const handler = mainSrc.match(/ipcMain\.handle\("delete-history-recording"[\s\S]*?\n\}\);/);
  assert.ok(handler, "delete-history-recording handler not found");
  assert.match(handler[0], /if \(procProc\) return \{ ok: false/);
  assert.match(handler[0], /isNoteDeletable/);
  assert.match(handler[0], /isAudioDeletable/);
  assert.match(handler[0], /fs\.realpathSync/);
  assert.match(handler[0], /moveToTrash/);
  assert.match(handler[0], /kind: "recording"/);
  assert.ok(!/fs\.unlinkSync/.test(handler[0]), "must move to trash, not permanently unlink");
  assert.ok(!/rmSync|rm\(/.test(handler[0]), "must never use a recursive/directory-capable delete");
});

// ── Корзина tab (main.js: list-trash / restore-trash-entry / delete-trash-entry /
// empty-trash) — main.js requires("electron") and can't load headless, same source-text
// assertion discipline as the delete-history-note/-recording checks above.
test("main.js: delete-history-note and delete-history-recording now build their manifest entry via buildTrashEntry, carrying title + an origin map (Корзина tab restore support)", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const noteHandler = mainSrc.match(/ipcMain\.handle\("delete-history-note"[\s\S]*?\n\}\);/)[0];
  const recHandler = mainSrc.match(/ipcMain\.handle\("delete-history-recording"[\s\S]*?\n\}\);/)[0];
  for (const handler of [noteHandler, recHandler]) {
    assert.match(handler, /buildTrashEntry/);
    assert.match(handler, /origin/);
    assert.match(handler, /title/);
    assert.match(handler, /crypto\.randomUUID\(\)/);
  }
});

// The audio/note byte+count split (including the "a missing file must not inflate
// noteCount" fix) is behavior-tested in tests/mainutil.test.js's "trashEntryBreakdown"
// suite; this regex lock only verifies list-trash actually delegates to it.
test("main.js: list-trash computes daysLeft per entry via trashEntryBreakdown, and backfills a missing id", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const handler = mainSrc.match(/ipcMain\.handle\("list-trash"[\s\S]*?\n\}\);/);
  assert.ok(handler, "list-trash handler not found");
  assert.match(handler[0], /trashDaysLeft/);
  assert.match(handler[0], /trashEntryBreakdown\(files\)/);
  assert.match(handler[0], /crypto\.randomUUID\(\)/, "legacy entries missing an id must get one backfilled");
});

// The actual destination-containment/partial-failure logic now lives in restoreTrashFiles/
// restoreDestinationFor (lib/mainutil.js) and is behavior-tested there (see
// tests/mainutil.test.js's "restoreTrashFiles"/"restoreDestinationFor" suites — origin
// escaping every allowed root, partial-failure remaining/error reporting). This regex
// lock only verifies the IPC wiring itself: busy-guard, source-containment, and that the
// handler actually delegates to the behavior-tested helper instead of re-inlining it.
test("main.js: restore-trash-entry busy-guards via busyVerdict, validates SOURCE containment (trashDir), and delegates destination handling to restoreTrashFiles", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const handler = mainSrc.match(/ipcMain\.handle\("restore-trash-entry"[\s\S]*?\n\}\);/);
  assert.ok(handler, "restore-trash-entry handler not found");
  assert.match(handler[0], /busyVerdict\(\[\[!!procProc/);
  assert.match(handler[0], /path\.dirname\(f\) !== trashDir/);
  assert.match(handler[0], /restoreTrashFiles\(files, entry\.origin, outDir, roots\)/);
  assert.ok(!/restoreDestinationFor|trashDestPath\(path\.dirname/.test(handler[0]), "destination computation must not be re-inlined here — it lives in restoreTrashFiles");
});

test("main.js: delete-trash-entry and empty-trash both reuse deleteTrashEntryFiles (same containment-checked unlink as purgeTrash)", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const delHandler = mainSrc.match(/ipcMain\.handle\("delete-trash-entry"[\s\S]*?\n\}\);/);
  const emptyHandler = mainSrc.match(/ipcMain\.handle\("empty-trash"[\s\S]*?\n\}\);/);
  assert.ok(delHandler, "delete-trash-entry handler not found");
  assert.ok(emptyHandler, "empty-trash handler not found");
  assert.match(delHandler[0], /deleteTrashEntryFiles/);
  assert.match(emptyHandler[0], /deleteTrashEntryFiles/);
  assert.ok(!/fs\.rmSync|fs\.rm\(/.test(delHandler[0] + emptyHandler[0]), "must never use a recursive/directory-capable delete");
});

// ── Корзина tab (trash-tab feature, renderer) ────────────────────────────────
test("switchView('trash'): shows the trash view, hides the others, sets the shared header title", async () => {
  const { window, $ } = await boot();
  window.document.querySelector('.topbtn[data-view="trash"]').click(); await tick(window);
  assert.ok(!$("view-trash").classList.contains("hidden"));
  assert.ok($("view-record").classList.contains("hidden"));
  assert.ok($("view-history").classList.contains("hidden"));
  assert.equal($("contentTitle").textContent, "Корзина");
  assert.ok($("contentTag").classList.contains("hidden"));
});

test("trash view: empty trash shows the «Корзина пуста» empty state and a 0-count toolbar", async () => {
  const { window, $ } = await boot({ listTrash: async () => ({ items: [], totalBytes: 0 }) });
  window.document.querySelector('.topbtn[data-view="trash"]').click(); await tick(window);
  assert.match($("trashList").textContent, /Корзина пуста/);
  assert.match($("trashCount").textContent, /0 записей/);
  assert.ok($("trashEmptyBtn").disabled, "Очистить корзину must be disabled when there's nothing to clear");
});

test("trash view: recording-kind row with notes — 🎙 icon, 'аудио X МБ + N заметок' meta, non-warn days pill", async () => {
  const deletedAt = Date.UTC(2026, 6, 18); // 18 июля
  const { window, $ } = await boot({
    listTrash: async () => ({
      items: [{ id: "r1", kind: "recording", title: "Синк по миграции Eapteka", deletedAt, daysLeft: 29, bytes: 100 * 1024 * 1024, audioBytes: 96 * 1024 * 1024, noteCount: 2 }],
      totalBytes: 100 * 1024 * 1024,
    }),
  });
  window.document.querySelector('.topbtn[data-view="trash"]').click(); await tick(window);
  const row = $("trashList").querySelector(".trash-row");
  assert.ok(row, "a trash row must render");
  assert.match(row.querySelector(".trash-row-icon").textContent, /🎙/);
  assert.equal(row.querySelector(".trash-row-title").textContent, "Синк по миграции Eapteka");
  assert.match(row.querySelector(".trash-row-meta").textContent, /аудио 96 МБ \+ 2 заметки · удалено/);
  const pill = row.querySelector(".trash-days");
  assert.match(pill.textContent, /осталось 29 дн/);
  assert.ok(!pill.classList.contains("warn"));
});

test("trash view: recording-kind row with ZERO notes uses ', без заметок' (not '+ 0 заметок')", async () => {
  const { window, $ } = await boot({
    listTrash: async () => ({
      items: [{ id: "r2", kind: "recording", title: "meeting-2026-06-21-091502", deletedAt: Date.now(), daysLeft: 2, bytes: 118 * 1024 * 1024, audioBytes: 118 * 1024 * 1024, noteCount: 0 }],
      totalBytes: 118 * 1024 * 1024,
    }),
  });
  window.document.querySelector('.topbtn[data-view="trash"]').click(); await tick(window);
  const row = $("trashList").querySelector(".trash-row");
  assert.match(row.querySelector(".trash-row-meta").textContent, /аудио 118 МБ, без заметок · удалено/);
});

test("trash view: note-kind row (single note, no audio) shows 📄 icon and 'только заметка'", async () => {
  const { window, $ } = await boot({
    listTrash: async () => ({
      items: [{ id: "n1", kind: "note", title: "Планёрка трайба — полная заметка", deletedAt: Date.now(), daysLeft: 23, bytes: 4096, audioBytes: 0, noteCount: 1 }],
      totalBytes: 4096,
    }),
  });
  window.document.querySelector('.topbtn[data-view="trash"]').click(); await tick(window);
  const row = $("trashList").querySelector(".trash-row");
  assert.match(row.querySelector(".trash-row-icon").textContent, /📄/);
  assert.match(row.querySelector(".trash-row-meta").textContent, /только заметка · удалено/);
});

test("trash view: daysLeft < 7 marks the pill .warn", async () => {
  const { window, $ } = await boot({
    listTrash: async () => ({
      items: [{ id: "r3", kind: "recording", title: "x", deletedAt: Date.now(), daysLeft: 2, bytes: 100, audioBytes: 100, noteCount: 0 }],
      totalBytes: 100,
    }),
  });
  window.document.querySelector('.topbtn[data-view="trash"]').click(); await tick(window);
  const pill = $("trashList").querySelector(".trash-days");
  assert.ok(pill.classList.contains("warn"));
});

test("trash view: toolbar shows 'N записей · M МБ' aggregate", async () => {
  const { window, $ } = await boot({
    listTrash: async () => ({
      items: [
        { id: "a", kind: "recording", title: "a", deletedAt: Date.now(), daysLeft: 29, bytes: 1, audioBytes: 1, noteCount: 0 },
        { id: "b", kind: "recording", title: "b", deletedAt: Date.now(), daysLeft: 23, bytes: 1, audioBytes: 1, noteCount: 0 },
        { id: "c", kind: "recording", title: "c", deletedAt: Date.now(), daysLeft: 2, bytes: 1, audioBytes: 1, noteCount: 0 },
      ],
      totalBytes: 214 * 1024 * 1024,
    }),
  });
  window.document.querySelector('.topbtn[data-view="trash"]').click(); await tick(window);
  assert.equal($("trashCount").textContent, "3 записи · 214 МБ");
  assert.ok(!$("trashEmptyBtn").disabled);
});

test("trash view: ↩ Восстановить calls restoreTrashEntry(id) and refreshes the list", async () => {
  let restoredId = null;
  let calls = 0;
  const { window, $ } = await boot({
    listTrash: async () => { calls++; return { items: calls === 1 ? [{ id: "r1", kind: "note", title: "x", deletedAt: Date.now(), daysLeft: 10, bytes: 1, audioBytes: 0, noteCount: 1 }] : [], totalBytes: 0 }; },
    restoreTrashEntry: async (id) => { restoredId = id; return { ok: true }; },
  });
  window.document.querySelector('.topbtn[data-view="trash"]').click(); await tick(window);
  $("trashList").querySelector(".trash-restore-btn").click(); await tick(window);
  assert.equal(restoredId, "r1");
  assert.match($("trashList").textContent, /Корзина пуста/, "list must refresh after a successful restore");
});

test("trash view: 'Удалить навсегда' confirms first — cancel means deleteTrashEntry is never called", async () => {
  let called = false;
  const { window, $ } = await boot({
    listTrash: async () => ({ items: [{ id: "n1", kind: "note", title: "x", deletedAt: Date.now(), daysLeft: 10, bytes: 1, audioBytes: 0, noteCount: 1 }], totalBytes: 1 }),
    deleteTrashEntry: async () => { called = true; return { ok: true }; },
  });
  window.confirm = () => false;
  window.document.querySelector('.topbtn[data-view="trash"]').click(); await tick(window);
  $("trashList").querySelector(".trash-del-btn").click(); await tick(window);
  assert.equal(called, false);
});

test("trash view: 'Удалить навсегда' confirmed → deleteTrashEntry(id) called, list refreshed", async () => {
  let deletedId = null;
  let calls = 0;
  const { window, $ } = await boot({
    listTrash: async () => { calls++; return { items: calls === 1 ? [{ id: "n1", kind: "note", title: "x", deletedAt: Date.now(), daysLeft: 10, bytes: 1, audioBytes: 0, noteCount: 1 }] : [], totalBytes: 0 }; },
    deleteTrashEntry: async (id) => { deletedId = id; return { ok: true }; },
  });
  window.confirm = () => true;
  window.document.querySelector('.topbtn[data-view="trash"]').click(); await tick(window);
  $("trashList").querySelector(".trash-del-btn").click(); await tick(window);
  assert.equal(deletedId, "n1");
  assert.match($("trashList").textContent, /Корзина пуста/);
});

test("trash view: 'Очистить корзину' confirms with the itemized count/size — cancel means emptyTrash is never called", async () => {
  let called = false;
  let confirmMsg = null;
  const { window, $ } = await boot({
    listTrash: async () => ({ items: [{ id: "n1", kind: "note", title: "x", deletedAt: Date.now(), daysLeft: 10, bytes: 1024 * 1024, audioBytes: 0, noteCount: 1 }], totalBytes: 1024 * 1024 }),
    emptyTrash: async () => { called = true; return { ok: true }; },
  });
  window.confirm = (msg) => { confirmMsg = msg; return false; };
  window.document.querySelector('.topbtn[data-view="trash"]').click(); await tick(window);
  $("trashEmptyBtn").click(); await tick(window);
  assert.equal(called, false);
  assert.match(confirmMsg, /1 запись/);
  assert.match(confirmMsg, /1 МБ/);
});

test("trash view: 'Очистить корзину' confirmed → emptyTrash called, list refreshed to empty", async () => {
  let called = false;
  let calls = 0;
  const { window, $ } = await boot({
    listTrash: async () => { calls++; return { items: calls === 1 ? [{ id: "n1", kind: "note", title: "x", deletedAt: Date.now(), daysLeft: 10, bytes: 1, audioBytes: 0, noteCount: 1 }] : [], totalBytes: 0 }; },
    emptyTrash: async () => { called = true; return { ok: true }; },
  });
  window.confirm = () => true;
  window.document.querySelector('.topbtn[data-view="trash"]').click(); await tick(window);
  $("trashEmptyBtn").click(); await tick(window);
  assert.equal(called, true);
  assert.match($("trashList").textContent, /Корзина пуста/);
});

test("История note delete: title is now passed through to deleteHistoryNote (Корзина tab title plumbing)", async () => {
  let gotTitle;
  const { window, $ } = await boot({
    listHistory: async () => [{ name: "2026-01-01", base_stamp: "2026-01-01-100000", title: "Синк", note: "/o/meeting-x.md", audio: "/o/meeting-x.wav" }],
    deleteHistoryNote: async (notePath, baseStamp, title) => { gotTitle = title; return { ok: true }; },
  });
  window.confirm = () => true;
  window.document.querySelector('.topbtn[data-view="history"]').click(); await tick(window);
  $("historyList").querySelector(".rail-item").click(); await tick(window);
  $("noteView").querySelector("#nvDelete").click(); await tick(window);
  assert.equal(gotTitle, "Синк");
});

test("recording ✕: title is now passed through to deleteHistoryRecording (Корзина tab title plumbing)", async () => {
  let gotTitle;
  const notes = [
    { name: "2026-07-11-100000", base_stamp: "2026-07-11-100000", title: "Планёрка", template: "Митинг", version: 1, note: "/o/a.md", audio: "/o/a.wav" },
  ];
  const audios = [{ base_stamp: "2026-07-11-100000", path: "/o/meeting-2026-07-11-100000.wav", size: 100, mtime: 1, duration_s: 60 }];
  const { window, $ } = await boot({
    listHistory: async () => Object.assign([...notes], { audios }),
    deleteHistoryRecording: async (p) => { gotTitle = p.title; return { ok: true }; },
  });
  window.confirm = () => true;
  window.document.querySelector('.topbtn[data-view="history"]').click(); await tick(window);
  $("historyList").querySelector(".rec-trash-btn").click(); await tick(window);
  assert.equal(gotTitle, "Планёрка");
});

// ── v1.4.10 overflow regressions (owner-reported: pending-row title collapsed into a
// one-letter-per-line vertical strip in the 280px rail after the T1 labeled ▶-button;
// note-view header buttons escaped the card at narrow widths). CSS source-text locks —
// same idiom as the main.js-source checks above (jsdom doesn't compute layout). ──────
test("style.css: pending rail row title ellipsizes instead of inheriting queue-name's word-break:break-all", () => {
  const css = fs.readFileSync(path.join(__dirname, "../renderer/style.css"), "utf8");
  const rule = css.match(/\.rail-item\.pending \.queue-name \{[^}]*\}/);
  assert.ok(rule, "scoped .rail-item.pending .queue-name rule exists");
  assert.match(rule[0], /text-overflow: ellipsis/);
  assert.match(rule[0], /word-break: normal/);
  assert.match(rule[0], /min-width: 0/);
});
test("style.css: rail badges don't wrap into two lines; note-view header actions wrap instead of overflowing", () => {
  const css = fs.readFileSync(path.join(__dirname, "../renderer/style.css"), "utf8");
  const badge = css.match(/\.rail-rec-badge \{[^}]*\}/);
  assert.ok(badge && /white-space: nowrap/.test(badge[0]), ".rail-rec-badge is nowrap");
  const actions = css.match(/\.note-actions \{[^}]*\}/);
  assert.ok(actions && /flex-wrap: wrap/.test(actions[0]), ".note-actions wraps");
});
