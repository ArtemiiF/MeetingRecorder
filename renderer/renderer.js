const $ = (id) => document.getElementById(id);

const state = {
  mode: "record",      // 'record' | 'import'
  recordedFile: null,  // path from a finished recording
  importedFile: null,  // path from file picker
  recording: false,
  processing: false,
  hasRun: false,
  secretEncrypted: true,
  timer: 0,
  presets: [],
  currentPreset: -1,
  outDir: "",
  hfToken: "",
  language: "ru",
  authorName: "Автор",
  para: null, // { root, folders: {projects, areas, resources, archives} }
};

// ── tabs (source) ──────────────────────────────────────────────────────────
document.querySelectorAll(".tab").forEach((t) =>
  t.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
    t.classList.add("active");
    state.mode = t.dataset.tab;
    $("pane-record").classList.toggle("hidden", state.mode !== "record");
    $("pane-import").classList.toggle("hidden", state.mode !== "import");
    refreshRunBtn();
  })
);

// ── result tabs ─────────────────────────────────────────────────────────────
document.querySelectorAll(".rtab").forEach((t) =>
  t.addEventListener("click", () => {
    document.querySelectorAll(".rtab").forEach((x) => x.classList.remove("active"));
    t.classList.add("active");
    const r = t.dataset.r;
    $("resSummary").classList.toggle("hidden", r !== "summary");
    $("resTranscript").classList.toggle("hidden", r !== "transcript");
    $("resActions").classList.toggle("hidden", r !== "actions");
  })
);

// ── copy to clipboard (result pane + chat bubbles) ──────────────────────────
// Writes text via the standard Clipboard API (available in the renderer regardless
// of contextIsolation/nodeIntegration — no IPC/main-process plumbing needed), then
// briefly flips the button's own label to "✓" as click feedback.
function copyToClipboard(text, btn) {
  navigator.clipboard.writeText(text || "").then(() => {
    const prev = btn.textContent;
    btn.textContent = "✓";
    setTimeout(() => { btn.textContent = prev; }, 1000);
  });
}

const RESULT_PANE_BY_TAB = { summary: "resSummary", transcript: "resTranscript", actions: "resActions" };
$("copyResult").addEventListener("click", () => {
  const activeTab = document.querySelector(".rtab.active");
  const r = activeTab ? activeTab.dataset.r : "summary";
  const pane = $(RESULT_PANE_BY_TAB[r] || "resSummary");
  copyToClipboard(pane.textContent, $("copyResult"));
});

// format the done event's {items,decisions} into the same plain-markdown-text
// style as the "## Действия" note section (checkboxes are plain text, not
// interactive — matches resSummary/resTranscript, which are also plain <pre>).
function formatActions(actions) {
  const items = (actions && actions.items) || [];
  const decisions = (actions && actions.decisions) || [];
  if (!items.length && !decisions.length) return "(пунктов действий нет)";
  const lines = items.map((it) => {
    const who = it.who ? ` — ${it.who}` : "";
    const due = it.due ? ` (срок: ${it.due})` : "";
    return `- [ ] ${it.what}${who}${due}`;
  });
  if (decisions.length) {
    if (lines.length) lines.push("");
    lines.push("Решения:");
    decisions.forEach((d) => lines.push(`- ${d}`));
  }
  return lines.join("\n");
}

// ── preflight readiness ──────────────────────────────────────────────────────
async function refreshPreflight() {
  const wrap = $("preflightList");
  wrap.innerHTML = '<p class="hint">Проверяю…</p>';
  const p = await window.api.preflight();
  const ok = (b) => (b ? "ok" : "bad");
  const perm = (s) => (s === "granted" ? "ok" : s === "denied" ? "bad" : "warn");
  const rows = [
    ["LM Studio (сводка)", ok(p.lmStudio), p.lmStudio ? "запущен" : "не отвечает на :1234 — сводки не будет"],
    ["Микрофон", perm(p.mic), p.mic],
    ["Системный звук (запись экрана)", perm(p.screen), p.screen === "granted" ? "разрешено" : "проверится при записи"],
    ["ffmpeg", ok(p.ffmpeg), p.ffmpeg ? "есть" : "не найден (brew install ffmpeg)"],
    ["Модель Whisper", p.whisperCached ? "ok" : "warn", p.whisperCached ? "скачана" : "скачается при 1й транскрипции (~1.5GB)"],
    ["HF-токен (диаризация)", p.hfToken ? "ok" : "warn", p.hfToken ? "задан" : "нет — спикеры по таймкодам"],
    ["Embedding-модель (поиск)", p.embedModel ? "ok" : "warn", p.embedModel ? "загружена" : "Embedding-модель не загружена — поиск будет работать только по ключевым словам"],
  ];
  wrap.innerHTML = "";
  rows.forEach(([label, state, detail]) => {
    const row = document.createElement("div");
    row.className = "pf-row";
    row.innerHTML = `<span class="pf-dot ${state}"></span><span class="pf-label">${label}</span><span class="pf-detail">${detail}</span>`;
    wrap.appendChild(row);
  });
  // overall verdict: critical = LM Studio + ffmpeg + mic; rest are warnings only
  const v = $("preflightVerdict");
  if (v) {
    const critical = p.lmStudio && p.ffmpeg && p.mic === "granted";
    if (critical) { v.className = "pf-verdict ok"; v.textContent = "✅ Всё готово к работе."; }
    else {
      const miss = [];
      if (!p.lmStudio) miss.push("LM Studio");
      if (!p.ffmpeg) miss.push("ffmpeg");
      if (p.mic !== "granted") miss.push("микрофон");
      v.className = "pf-verdict bad"; v.textContent = "⛔ Не готово: " + miss.join(", ");
    }
  }
}
$("preflightRefresh").addEventListener("click", refreshPreflight);

// settings / readiness modal
function openSettings() { $("settingsOverlay").classList.remove("hidden"); refreshPreflight(); }
function closeSettings() { $("settingsOverlay").classList.add("hidden"); }
$("settingsOpen").addEventListener("click", openSettings);
$("settingsClose").addEventListener("click", closeSettings);
$("settingsOverlay").addEventListener("click", (e) => { if (e.target === $("settingsOverlay")) closeSettings(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSettings(); });

// ── init ─────────────────────────────────────────────────────────────────────
async function init() {
  const devices = await window.api.listDevices();
  const sel = $("micDevice");
  sel.innerHTML = "";
  devices.forEach((d) => {
    const o = document.createElement("option");
    o.value = d.index;
    o.textContent = d.name + (d.default ? "  (по умолчанию)" : "");
    if (d.default) o.selected = true;
    sel.appendChild(o);
  });

  const data = await window.api.getPresets();
  state.presets = data.presets || [];
  state.outDir = data.defaultOutDir || "";
  state.hfToken = data.hfToken || "";
  state.language = data.language || "ru";
  state.authorName = data.authorName || "Автор";
  state.para = data.para || null;
  state.secretEncrypted = data.secretEncrypted !== false;
  $("outDir").value = state.outDir;
  $("hfToken").value = state.hfToken;
  $("language").value = state.language;
  $("authorName").value = state.authorName;
  updateTokenWarn();
  renderPresets();
  if (state.presets.length) selectPreset(0);
  refreshHistory();
}

function renderPresets() {
  const sel = $("presetSelect");
  sel.innerHTML = "";
  state.presets.forEach((p, i) => {
    const o = document.createElement("option");
    o.value = i;
    o.textContent = p.name;
    sel.appendChild(o);
  });
}
function selectPreset(i) {
  state.currentPreset = i;
  const p = state.presets[i];
  $("presetSelect").value = i;
  $("presetName").value = p ? p.name : "";
  $("prompt").value = p ? p.prompt : "";
}
$("presetSelect").addEventListener("change", (e) => selectPreset(+e.target.value));

// edits write back to the selected preset + persist (on blur/change, not per keystroke)
$("presetName").addEventListener("change", () => {
  const p = state.presets[state.currentPreset];
  if (!p) return;
  p.name = $("presetName").value;
  renderPresets();
  $("presetSelect").value = state.currentPreset;
  persistPresets();
});
$("prompt").addEventListener("change", () => {
  const p = state.presets[state.currentPreset];
  if (p) { p.prompt = $("prompt").value; persistPresets(); }
});

$("newPreset").addEventListener("click", async () => {
  state.presets.push({ name: "Новый пресет", prompt: $("prompt").value || "" });
  renderPresets();
  selectPreset(state.presets.length - 1);
  await persistPresets();
  $("presetName").focus();
  $("presetName").select();
});
$("delPreset").addEventListener("click", async () => {
  const i = state.currentPreset;
  if (!state.presets[i]) return;
  state.presets.splice(i, 1);
  renderPresets();
  if (state.presets.length) selectPreset(Math.min(i, state.presets.length - 1));
  else { state.currentPreset = -1; $("presetName").value = ""; $("prompt").value = ""; }
  await persistPresets();
});
async function persistPresets() {
  await window.api.savePresets({
    presets: state.presets,
    defaultOutDir: state.outDir,
    hfToken: state.hfToken,
    language: state.language,
    authorName: state.authorName,
    para: state.para,
  });
}

$("language").addEventListener("change", (e) => {
  state.language = e.target.value;
  persistPresets();
});

$("hfToken").addEventListener("change", (e) => {
  state.hfToken = e.target.value;
  persistPresets();
  updateTokenWarn();
});

$("authorName").addEventListener("change", (e) => {
  state.authorName = e.target.value || "Автор";
  persistPresets();
});

function updateTokenWarn() {
  const warn = $("tokenWarn");
  if (!warn) return;
  warn.style.display = state.hfToken && !state.secretEncrypted ? "" : "none";
}

// ── output dir ───────────────────────────────────────────────────────────────
$("pickOut").addEventListener("click", async () => {
  const dir = await window.api.pickOutDir();
  if (dir) { state.outDir = dir; $("outDir").value = dir; persistPresets(); }
});

// ── import file ───────────────────────────────────────────────────────────────
$("pickBtn").addEventListener("click", async () => {
  const f = await window.api.pickAudio();
  if (f) {
    state.importedFile = f;
    state.hasRun = false; // new source → hide retry/fresh until processed
    $("pickedFile").textContent = f.split("/").pop();
    setProcessingUI(false);
    refreshRunBtn();
  }
});

// ── recording ─────────────────────────────────────────────────────────────────
const SYS_HELP = "Разрешить: Настройки → Конфиденциальность и безопасность → " +
  "Запись экрана и системного звука → раздел «System Audio Recording Only» → добавить приложение.";

function setSysStatus(text, kind) {
  const el = $("sysStatus");
  el.textContent = text;
  el.className = "sys-status" + (kind ? " " + kind : "");
}

$("recBtn").addEventListener("click", async () => {
  if (!state.recording) {
    const micDevice = $("micDevice").value;
    setSysStatus("🔊 Системный звук: запуск…", "");
    const res = await window.api.startRecording({ micDevice });
    if (!res.ok) { alert(res.error); return; }
    state.recording = true;
    state.recordedFile = null;
    $("timer").textContent = "00:00";
    $("vuMic").style.width = "0%";
    $("vuSys").style.width = "0%";
    $("recBtn").textContent = "■ Остановить";
    $("recBtn").classList.add("recording");
    $("timer").classList.add("live");
    refreshRunBtn();
  } else {
    state.recording = false;
    $("recBtn").textContent = "● Начать запись";
    $("recBtn").classList.remove("recording");
    $("timer").classList.remove("live");
    $("vuMic").style.width = "0%";
    $("vuSys").style.width = "0%";
    setSysStatus("⏳ Свожу дорожки…", "");
    await window.api.stopRecording();
  }
});

function fmtTime(s) {
  const m = Math.floor(s / 60);
  return String(m).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
}

window.api.onRecordEvent((ev) => {
  if (ev.event === "level") {
    // direct write (not rAF): the recorder window is backgrounded during a call,
    // where requestAnimationFrame throttles to ~1Hz/pauses and would freeze the meter.
    // ~15 writes/sec is negligible.
    const bar = ev.source === "mic" ? $("vuMic") : $("vuSys");
    if (bar) bar.style.width = Math.round(ev.level * 100) + "%";
  } else if (ev.event === "elapsed") {
    $("timer").textContent = fmtTime(ev.seconds);
  } else if (ev.event === "log") {
    appendLog(ev.msg);
  } else if (ev.event === "system-audio-started") {
    setSysStatus("🔊 Системный звук: пишется ✅", "ok");
  } else if (ev.event === "system-audio-error") {
    setSysStatus("🔊 Системный звук недоступен — пишу только микрофон. " + SYS_HELP, "warn");
    appendLog("⚠️ system audio: " + ev.msg);
  } else if (ev.event === "disk-warning") {
    setSysStatus(ev.msg, "warn");
    appendLog(ev.msg);
  } else if (ev.event === "recorded") {
    state.recordedFile = ev.file;
    state.hasRun = false; // new recording → hide retry/fresh until processed
    setProcessingUI(false);
    const parts = [];
    if (ev.mic) parts.push("микрофон");
    if (ev.system) parts.push("системный звук");
    setSysStatus(`✅ Запись готова (${parts.join(" + ") || "—"})`, "ok");
    appendLog(`Запись готова: ${ev.tracks} дорожк${ev.tracks === 1 ? "а" : "и"}`);
    refreshRunBtn();
  } else if (ev.event === "error") {
    setSysStatus("❌ Ошибка записи: " + ev.msg, "warn");
    state.recording = false;
    $("recBtn").textContent = "● Начать запись";
    $("recBtn").classList.remove("recording");
    $("timer").classList.remove("live");
    refreshRunBtn();
  }
});

// ── current audio source resolution ─────────────────────────────────────────
function currentAudio() {
  return state.mode === "record" ? state.recordedFile : state.importedFile;
}
function refreshRunBtn() {
  $("runBtn").disabled = !currentAudio() || state.recording;
}

// ── run processing ───────────────────────────────────────────────────────────
const STAGE_LABELS = {
  convert: "Аудио", transcribe: "Транскрипция",
  diarize: "Спикеры", llm: "Сводка", meta: "Метаданные", save: "Сохранение",
};
const STAGE_KEYS = Object.keys(STAGE_LABELS);

let lastStage = null;
let runEnded = false;             // guard so a clean end isn't overwritten by trailing process-closed
let selectedStage = STAGE_KEYS[0]; // which stage's logs the pane currently shows
let logsByStage = {};

function buildStages() {
  const wrap = $("stages");
  wrap.innerHTML = "";
  logsByStage = {};
  STAGE_KEYS.forEach((k) => {
    logsByStage[k] = [];
    const el = document.createElement("span");
    el.className = "stage";
    el.id = "stage-" + k;
    el.dataset.stage = k;
    el.textContent = STAGE_LABELS[k];
    el.title = "Показать логи этапа";
    el.addEventListener("click", () => showStageLogs(k, true));
    wrap.appendChild(el);
  });
}

// Render one stage's logs into the pane. pinned=true means a user click
// (stops live auto-follow until the next stage starts).
let pinned = false;
function showStageLogs(stageKey, isUserClick) {
  selectedStage = stageKey;
  if (isUserClick) pinned = true;
  document.querySelectorAll(".stage").forEach((el) =>
    el.classList.toggle("selected", el.dataset.stage === stageKey));
  const el = $("logs");
  el.textContent = (logsByStage[stageKey] || []).join("\n");
  el.scrollTop = el.scrollHeight;
}

function pushLog(stageKey, msg) {
  // route stray/untagged logs into the running stage (or the first one) — no orphan bucket
  if (!stageKey || !(stageKey in logsByStage)) stageKey = lastStage || STAGE_KEYS[0];
  if (!logsByStage[stageKey]) logsByStage[stageKey] = [];
  logsByStage[stageKey].push(msg);
  if (selectedStage === stageKey) {
    const el = $("logs");
    el.textContent += msg + "\n";
    el.scrollTop = el.scrollHeight;
  }
}
// logger for non-pipeline messages (IPC errors, backend stderr) → current/active stage
function appendLog(msg) { pushLog(lastStage, msg); }

function setStageClass(stageKey, cls) {
  const el = $("stage-" + stageKey);
  if (!el) return;
  el.classList.remove("active", "done", "failed", "skip");
  el.classList.add(cls);
}

function markRunFailed() {
  // whatever stage was running when the pipeline died turns red
  if (lastStage) setStageClass(lastStage, "failed");
  runEnded = true;
  refreshRunBtn();
}

// Toggle Run ↔ Stop, and show Retry/Fresh only after a run has happened on this audio.
function setProcessingUI(running) {
  state.processing = running;
  document.body.classList.toggle("processing", running); // CSS disables history reprocess
  $("runBtn").style.display = running ? "none" : "";
  $("stopBtn").style.display = running ? "" : "none";
  $("procSpinner").style.display = running ? "" : "none";
  const showRetry = !running && !!currentAudio() && state.hasRun;
  $("retryBtn").style.display = showRetry ? "" : "none";
  $("freshBtn").style.display = showRetry ? "" : "none";
}
function finishProcessing() {
  $("stopBtn").disabled = false;
  setProcessingUI(false);
  refreshRunBtn();
}

// fresh=true clears the cache (full recompute); otherwise resume from cached stages.
async function startProcessing(fresh) {
  const audioFile = currentAudio();
  if (!audioFile) return;
  $("progressCard").style.display = "";
  $("resultCard").style.display = "none";
  buildStages();
  lastStage = null;
  runEnded = false;
  pinned = false;
  showStageLogs(STAGE_KEYS[0], false);
  state.hasRun = true;
  setProcessingUI(true);

  const res = await window.api.processAudio({
    audioFile,
    prompt: $("prompt").value,
    diarize: $("diarize").checked,
    outDir: state.outDir,
    engine: "mlx",
    hfToken: state.hfToken,
    fresh: !!fresh,
    language: state.language,
    summarize: !$("noSummary").checked,
    template: (state.presets[state.currentPreset] || {}).name || "",
  });
  if (res && res.ok === false) {
    appendLog("❌ " + res.error);
    finishProcessing();
  }
}

$("runBtn").addEventListener("click", () => startProcessing(false));
$("retryBtn").addEventListener("click", () => startProcessing(false));
$("freshBtn").addEventListener("click", () => startProcessing(true));
$("stopBtn").addEventListener("click", async () => {
  $("stopBtn").disabled = true;
  await window.api.cancelProcess();
});

window.api.onProcessEvent((ev) => {
  if (ev.event === "stage") {
    setStageClass(ev.stage, "active");
    lastStage = ev.stage;
    pushLog(ev.stage, "▶ " + ev.msg);
    if (!pinned) showStageLogs(ev.stage, false); // live-follow the running stage
  } else if (ev.event === "stage_end") {
    // real per-stage outcome drives the colour — not a blanket "all green"
    const cls = ev.status === "ok" ? "done" : ev.status === "skip" ? "skip" : "failed";
    setStageClass(ev.stage, cls);
    const cached = ev.status === "ok" && /кеша/.test(ev.msg || "");
    if (cached) $("stage-" + ev.stage)?.classList.add("cached");
    if (ev.msg) {
      const icon = cached ? "💾 " : ev.status === "ok" ? "✅ " : ev.status === "skip" ? "⏭ " : "⚠️ ";
      pushLog(ev.stage, icon + ev.msg);
    }
  } else if (ev.event === "log") {
    pushLog(ev.stage, ev.msg);
  } else if (ev.event === "done") {
    showResult(ev);
    runEnded = true;
    finishProcessing();
    refreshHistory();
  } else if (ev.event === "error") {
    appendLog("❌ " + ev.msg);
    markRunFailed();
    finishProcessing();
  } else if (ev.event === "process-closed") {
    if (ev.canceled) {
      appendLog("⏹ Остановлено — прогресс сохранён, нажми «↻ Повторить» чтобы продолжить");
      if (lastStage) setStageClass(lastStage, "skip");
      runEnded = true;
    } else if (ev.code !== 0 && !runEnded) {
      if (ev.stderr) appendLog("[backend] " + ev.stderr.slice(-600));
      appendLog("❌ Обработка прервана (код " + ev.code + ")");
      markRunFailed();
    } else if (ev.code !== 0 && ev.stderr) {
      appendLog("[backend] " + ev.stderr.slice(-600));
    }
    finishProcessing();
  }
});

// ── top-level view switching ─────────────────────────────────────────────────
function switchView(v) {
  document.querySelectorAll(".topbtn").forEach((b) => b.classList.toggle("active", b.dataset.view === v));
  ["record", "history", "para"].forEach((id) => $("view-" + id).classList.toggle("hidden", id !== v));
  if (v === "history") refreshHistory();
  if (v === "para") renderPara();
}
document.querySelectorAll(".topbtn").forEach((b) => b.addEventListener("click", () => switchView(b.dataset.view)));
$("historyRefresh").addEventListener("click", refreshHistory);
// Entry point into the PARA chat from История — same view-switch + subtab machinery, same chat instance.
$("historyAskBtn").addEventListener("click", () => {
  switchView("para");
  subSwitchPara("search");
  $("paraSearchQuery").focus();
});

// ── history (rail + note viewer) ─────────────────────────────────────────────
let historyItems = [];
async function refreshHistory() {
  historyItems = await window.api.listHistory(state.outDir);
  populateTemplateFilter();
  renderRail();
}

// fill the template <select> from distinct templates in the data (keep current choice)
function populateTemplateFilter() {
  const sel = $("historyTemplate");
  const cur = sel.value;
  const templates = [...new Set(historyItems.map((it) => it.template).filter(Boolean))].sort();
  sel.innerHTML = '<option value="">Все шаблоны</option>' +
    templates.map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join("");
  if (templates.includes(cur)) sel.value = cur;
}

// render the rail filtered by search (title/date) + language + template + date range.
// dataset.idx points into the full historyItems so selection survives filtering.
function renderRail() {
  const q = ($("historySearch").value || "").trim().toLowerCase();
  const lang = $("historyLang").value;
  const tmpl = $("historyTemplate").value;
  const from = $("historyFrom").value; // YYYY-MM-DD or ""
  const to = $("historyTo").value;
  const rail = $("historyList");
  rail.innerHTML = "";
  if (!historyItems.length) { rail.innerHTML = '<p class="hint">Пока пусто.</p>'; return; }
  const shown = historyItems.filter((it) => {
    const d = (it.name || "").slice(0, 10); // stamp = YYYY-MM-DD-HHMMSS → ISO date sorts lexically
    return (!q || (it.title || "").toLowerCase().includes(q) || (it.name || "").toLowerCase().includes(q)) &&
      (!lang || it.language === lang) &&
      (!tmpl || it.template === tmpl) &&
      (!from || d >= from) && (!to || d <= to);
  });
  if (!shown.length) { rail.innerHTML = '<p class="hint">Ничего не найдено.</p>'; return; }
  shown.forEach((it) => {
    const idx = historyItems.indexOf(it);
    const el = document.createElement("button");
    el.className = "rail-item";
    el.dataset.idx = idx;
    el.innerHTML = `<span class="rail-title">${escapeHtml(it.title || "Без темы")}</span>` +
      `<span class="rail-date">${escapeHtml(it.name)}</span>`;
    el.addEventListener("click", () => selectNote(idx));
    rail.appendChild(el);
  });
}
["historySearch"].forEach((id) => $(id).addEventListener("input", renderRail));
["historyLang", "historyTemplate", "historyFrom", "historyTo"].forEach((id) =>
  $(id).addEventListener("change", renderRail));

function selectNote(idx) {
  document.querySelectorAll(".rail-item").forEach((e) => e.classList.toggle("active", +e.dataset.idx === idx));
  openHistoryNote(historyItems[idx]);
}

async function openHistoryNote(item) {
  const view = $("noteView");
  const md = await window.api.readNote(item.note);
  if (md == null) { view.innerHTML = '<p class="hint">Не удалось прочитать заметку.</p>'; return; }
  const meta = [item.template && `шаблон: ${item.template}`, item.language && `язык: ${item.language}`]
    .filter(Boolean).join(" · ");
  view.innerHTML =
    `<h2 class="note-title">${escapeHtml(item.title || item.name)}</h2>
     <div class="note-actions">
       <button class="btn small" id="nvOpen">📄 Obsidian</button>
       ${item.audio ? '<button class="btn small" id="nvAudio">🎵 Аудио</button>' : ""}
       <button class="btn small ghost" id="nvReprocess">↻ Переобработать</button>
     </div>
     ${meta ? `<div class="note-meta">${escapeHtml(meta)}</div>` : ""}
     <div class="note-body">${renderMarkdown(md)}</div>`;
  $("nvOpen").onclick = () => window.api.reveal(item.note);
  if (item.audio) $("nvAudio").onclick = () => window.api.reveal(item.audio);
  $("nvReprocess").onclick = () => { if (item.audio) reprocessHistory(item.audio); };
}

function reprocessHistory(audio) {
  if (state.recording || state.processing) return; // don't hijack an active run
  switchView("record");
  state.mode = "import";
  document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x.dataset.tab === "import"));
  $("pane-record").classList.add("hidden");
  $("pane-import").classList.remove("hidden");
  state.importedFile = audio;
  $("pickedFile").textContent = audio.split("/").pop();
  state.hasRun = false;
  startProcessing(false);
}

// ── minimal, XSS-safe markdown renderer for the note viewer ───────────────────
function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function renderMarkdown(md) {
  md = md.replace(/^---\n[\s\S]*?\n---\n?/, ""); // drop YAML frontmatter from display
  let h = escapeHtml(md);
  h = h.replace(/&lt;(\/?(?:details|summary))&gt;/g, "<$1>");        // whitelist details/summary
  h = h.replace(/!\[\[([^\]]+)\]\]/g, "🎵 $1");                       // obsidian embed → label
  h = h.replace(/^######\s?(.*)$/gm, "<h6>$1</h6>")
       .replace(/^#####\s?(.*)$/gm, "<h5>$1</h5>")
       .replace(/^####\s?(.*)$/gm, "<h4>$1</h4>")
       .replace(/^###\s?(.*)$/gm, "<h3>$1</h3>")
       .replace(/^##\s?(.*)$/gm, "<h2>$1</h2>")
       .replace(/^#\s?(.*)$/gm, "<h1>$1</h1>");
  h = h.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  h = h.replace(/^- \[[xX]\]\s?(.*)$/gm, "<div class='md-task'>☑ $1</div>")
       .replace(/^- \[ \]\s?(.*)$/gm, "<div class='md-task'>☐ $1</div>")
       .replace(/^[-*]\s+(.*)$/gm, "<li>$1</li>");
  h = h.replace(/^---$/gm, "<hr>");
  h = h.replace(/\n{2,}/g, "<br><br>").replace(/\n/g, "<br>");
  return h;
}

let currentNote = null;
function detectSpeakers(t) {
  const set = new Set();
  const re = /\*\*\[([^\]]+)\]\*\*/g;
  let m;
  while ((m = re.exec(t || ""))) set.add(m[1]);
  return [...set];
}
function buildSpeakerMap(transcript, prefill = {}) {
  const labels = detectSpeakers(transcript);
  const box = $("speakerInputs");
  box.innerHTML = "";
  if (!labels.length) { $("speakerMap").style.display = "none"; return; }
  $("speakerMap").style.display = "";
  labels.forEach((l) => {
    const row = document.createElement("div");
    row.className = "speaker-row";
    const old = document.createElement("span");
    old.className = "speaker-old";
    old.textContent = l + " →";
    const inp = document.createElement("input");
    inp.type = "text";
    inp.dataset.old = l;
    inp.placeholder = "имя";
    if (prefill[l]) inp.value = prefill[l];   // name inferred from context
    const meBtn = document.createElement("button");
    meBtn.type = "button";
    meBtn.className = "btn small speaker-me";
    meBtn.textContent = "это я";
    meBtn.title = "Вставить моё имя (" + state.authorName + ")";
    meBtn.addEventListener("click", () => { inp.value = state.authorName; });
    row.appendChild(old);
    row.appendChild(inp);
    row.appendChild(meBtn);
    box.appendChild(row);
  });
}
$("applySpeakers").addEventListener("click", async () => {
  if (!currentNote) return;
  const map = {};
  $("speakerInputs").querySelectorAll("input").forEach((i) => {
    const v = i.value.trim();
    if (v) map[i.dataset.old] = v;
  });
  if (!Object.keys(map).length) return;
  const res = await window.api.renameSpeakers(currentNote, map);
  if (res && res.ok === false) { alert("Не удалось переименовать: " + res.error); return; }
  let t = $("resTranscript").textContent;
  for (const [o, n] of Object.entries(map)) t = t.split(`**[${o}]**`).join(`**[${n}]**`);
  $("resTranscript").textContent = t;
  buildSpeakerMap(t);
  refreshHistory();
});

// ── PARA view ────────────────────────────────────────────────────────────────
let paraInboxItems = [];
const PARA_KEYS = ["projects", "areas", "resources", "archives"];

let paraSub = "inbox";
function renderPara() { subSwitchPara(paraSub); }
function subSwitchPara(sub) {
  paraSub = sub;
  document.querySelectorAll(".subbtn").forEach((b) => b.classList.toggle("active", b.dataset.sub === sub));
  $("para-pane-inbox").classList.toggle("hidden", sub !== "inbox");
  $("para-pane-search").classList.toggle("hidden", sub !== "search");
  $("para-pane-tree").classList.toggle("hidden", sub !== "tree");
  if (sub === "inbox") renderParaInboxView();
  if (sub === "tree") renderParaTree();
}
document.querySelectorAll(".subbtn").forEach((b) =>
  b.addEventListener("click", () => { if (!b.disabled) subSwitchPara(b.dataset.sub); }));

function renderParaInboxView() {
  const configured = !!(state.para && state.para.root);
  $("paraSetup").style.display = configured ? "none" : "";
  $("paraWork").style.display = configured ? "" : "none";
  if (configured) {
    $("paraVaultPath").textContent = "Vault: " + state.para.root;
    refreshParaInbox();
  }
}

async function renderParaTree() {
  const box = $("paraTree");
  if (!state.para || !state.para.root) {
    box.innerHTML = '<p class="hint">Сначала создай vault на вкладке «Разбор».</p>';
    return;
  }
  box.innerHTML = '<p class="hint">Загрузка…</p>';
  const tree = await window.api.paraTree(state.para.root);
  box.innerHTML = tree.length ? renderTreeNodes(tree) : '<p class="hint">Пусто.</p>';
  box.querySelectorAll(".tree-note").forEach((el) =>
    el.addEventListener("click", () => openTreeNote(el)));
  box.querySelectorAll(".tree-dir-head").forEach((el) =>
    el.addEventListener("click", () => el.parentElement.classList.toggle("collapsed")));
}
function renderTreeNodes(nodes) {
  return '<ul class="tree">' + nodes.map((n) => {
    if (n.type === "dir") {
      const hasChildren = n.children && n.children.length;
      const caret = hasChildren ? '<span class="tree-caret">▾</span>' : '<span class="tree-caret empty"></span>';
      return `<li class="tree-dir">` +
        `<div class="tree-dir-head">${caret}📁 ${escapeHtml(n.name)} <span class="tree-count">${n.notes}</span></div>` +
        (hasChildren ? renderTreeNodes(n.children) : "") + "</li>";
    }
    return `<li class="tree-note" data-path="${escapeHtml(n.path)}">📄 ${escapeHtml(n.name)}</li>`;
  }).join("") + "</ul>";
}
async function openTreeNote(el) {
  const path = el.dataset.path;
  const view = $("paraTreeView");
  document.querySelectorAll(".tree-note.active").forEach((e) => e.classList.remove("active"));
  el.classList.add("active");
  view.innerHTML = '<p class="hint">Загрузка…</p>';
  const md = await window.api.readNote(path);
  if (md == null) { view.innerHTML = '<p class="hint">Не удалось прочитать заметку.</p>'; return; }
  const name = path.split("/").pop().replace(/\.md$/i, "");
  view.innerHTML =
    `<div class="note-actions"><button class="btn small" id="ptvOpen">📄 Obsidian</button></div>
     <h2 class="note-title">${escapeHtml(name)}</h2>
     <div class="note-body">${renderMarkdown(md)}</div>`;
  $("ptvOpen").onclick = () => window.api.reveal(path);
}
$("paraTreeRefresh").addEventListener("click", renderParaTree);

// ── PARA search pane ─────────────────────────────────────────────────────────

// In-session chat history. Each item: {role: "user"|"assistant", content: string}.
// Reset only by «Новый чат» button. Kept alive across pane switches.
let chatMessages = [];

function paraSearchLog(msg) {
  const box = $("paraReindexLog");
  const t = new Date().toLocaleTimeString();
  box.textContent += `[${t}] ${msg}\n`;
  box.scrollTop = box.scrollHeight;
}

window.api.onParaReindexEvent((ev) => {
  if (ev.event === "log") paraSearchLog(ev.msg);
  else if (ev.event === "error") paraSearchLog("❌ " + ev.msg);
});

$("paraReindexBtn").addEventListener("click", async () => {
  if (!state.para || !state.para.root) { alert("Сначала создай vault на вкладке «Разбор»"); return; }
  const btn = $("paraReindexBtn");
  const status = $("paraReindexStatus");
  const logBox = $("paraReindexLog");
  btn.disabled = true;
  btn.textContent = "Индексирую…";
  status.textContent = "";
  logBox.textContent = "";
  logBox.classList.remove("hidden");
  const res = await window.api.paraReindex(state.para.root);
  btn.disabled = false;
  btn.textContent = "⟳ Переиндексировать";
  if (res && res.error) {
    status.textContent = "❌ " + res.error;
  } else if (res) {
    status.textContent = `✅ Готово: ${res.indexed} проиндексировано, ${res.skipped} без изменений, ${res.removed} удалено`;
  }
});

$("paraChatNewBtn").addEventListener("click", () => {
  chatMessages = [];
  $("paraChatLog").innerHTML = "";
});

$("paraSearchBtn").addEventListener("click", () => runParaSearch());
$("paraSearchQuery").addEventListener("keydown", (e) => { if (e.key === "Enter") runParaSearch(); });

// Append a bubble to the chat log.
// role: "user" | "assistant"
// content: plain text (user) or answer text (assistant)
// citations: array of {date, title, note_path} (assistant only, may be empty)
// degraded: true if this search ran keyword-only (embedding model unavailable)
function appendChatBubble(role, content, citations, degraded) {
  const log = $("paraChatLog");
  const bubble = document.createElement("div");
  bubble.className = "chat-bubble chat-bubble-" + role;
  if (role === "user") {
    bubble.innerHTML = `<div class="chat-text">${escapeHtml(content)}</div>`;
  } else {
    // assistant: render markdown answer + optional degraded-mode badge + citation list
    let inner = `<div class="chat-text">${renderMarkdown(content)}</div>`;
    if (degraded) {
      inner += `<div class="chat-degraded">⚠️ Поиск только по ключевым словам — embedding-модель не загружена</div>`;
    }
    if (citations && citations.length) {
      const citeItems = citations.map((c) =>
        `<li>${escapeHtml(c.date)} · ${escapeHtml(c.title || (c.note_path || "").split("/").pop())}</li>`
      ).join("");
      inner += `<ul class="chat-cites">${citeItems}</ul>`;
    }
    bubble.innerHTML = inner;
    // copies the raw answer text (this closure's `content`), not the citations/markdown HTML
    const copyRow = document.createElement("div");
    copyRow.className = "chat-copy-row";
    const copyBtn = document.createElement("button");
    copyBtn.className = "chat-copy-btn";
    copyBtn.title = "Скопировать ответ";
    copyBtn.textContent = "⧉";
    copyBtn.addEventListener("click", () => copyToClipboard(content, copyBtn));
    copyRow.appendChild(copyBtn);
    bubble.appendChild(copyRow);
  }
  log.appendChild(bubble);
  log.scrollTop = log.scrollHeight;
  return bubble;
}

// Append a "typing…" indicator bubble; returns the element so it can be removed.
function appendTypingIndicator() {
  const log = $("paraChatLog");
  const el = document.createElement("div");
  el.className = "chat-bubble chat-bubble-assistant chat-typing";
  el.innerHTML = '<div class="chat-text"><span class="chat-dots"><span></span><span></span><span></span></span></div>';
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
  return el;
}

async function runParaSearch() {
  if (!state.para || !state.para.root) { alert("Сначала создай vault на вкладке «Разбор»"); return; }
  const input = $("paraSearchQuery");
  const query = input.value.trim();
  if (!query) return;

  const btn = $("paraSearchBtn");
  // Append user turn
  chatMessages.push({ role: "user", content: query });
  appendChatBubble("user", query, null);
  input.value = "";
  btn.disabled = true;
  btn.textContent = "Ищу…";
  input.disabled = true;

  // Show typing indicator while waiting
  const typingEl = appendTypingIndicator();

  // Pass a snapshot so the mock/backend receives a stable array regardless of
  // when the caller inspects it (the live array gets the assistant reply appended later).
  let res;
  try {
    res = await window.api.paraSearch(state.para.root, chatMessages.slice());
  } catch (e) {
    typingEl.remove();
    const errMsg = "❌ " + (e.message || String(e));
    appendChatBubble("assistant", errMsg, null);
    chatMessages.push({ role: "assistant", content: errMsg });
    btn.disabled = false;
    btn.textContent = "🔍 Спросить";
    input.disabled = false;
    input.focus();
    return;
  }

  typingEl.remove();
  const answerText = res.answer || "Не нашёл по этому вопросу записей в заметках.";
  appendChatBubble("assistant", answerText, res.found ? (res.citations || []) : [], !!res.degraded);
  chatMessages.push({ role: "assistant", content: answerText });

  btn.disabled = false;
  btn.textContent = "🔍 Спросить";
  input.disabled = false;
  input.focus();
}

$("paraPick").addEventListener("click", async () => {
  const dir = await window.api.pickOutDir();
  if (dir) $("paraRoot").value = dir;
});

$("paraCreate").addEventListener("click", async () => {
  const root = $("paraRoot").value.trim();
  if (!root) { alert("Сначала выбери папку"); return; }
  const folders = {};
  PARA_KEYS.forEach((k) => { folders[k] = $("paraF" + k).value.trim() || k; });
  const res = await window.api.paraCreateVault({ root, folders });
  if (res && res.ok === false) { alert("Не удалось создать: " + res.error); return; }
  state.para = { root, folders };
  await persistPresets();
  renderPara();
});

$("paraChangeVault").addEventListener("click", () => {
  if (state.para) {
    $("paraRoot").value = state.para.root;
    PARA_KEYS.forEach((k) => { $("paraF" + k).value = state.para.folders[k]; });
  }
  $("paraSetup").style.display = "";
  $("paraWork").style.display = "none";
});

async function refreshParaInbox() {
  paraInboxItems = await window.api.listHistory(state.outDir); // unfiled = still in Meetings dir
  const box = $("paraInbox");
  box.innerHTML = "";
  if (!paraInboxItems.length) { box.innerHTML = '<p class="hint">Все заметки разобраны.</p>'; return; }
  paraInboxItems.forEach((it, idx) => {
    const row = document.createElement("div");
    row.className = "para-row";
    row.dataset.idx = idx;
    row.innerHTML =
      `<div class="para-note">${escapeHtml(it.title || it.name)}</div>
       <select class="para-cat">
         <option value="">— категория —</option>
         <option value="projects">Projects</option>
         <option value="areas">Areas</option>
         <option value="resources">Resources</option>
         <option value="archives">Archives</option>
       </select>
       <input class="para-proj" placeholder="проект / область" />
       <button class="btn small para-file-btn">Разложить</button>`;
    row.querySelector(".para-file-btn").addEventListener("click", () => fileParaRow(idx, row));
    box.appendChild(row);
  });
}

let paraClassifyCancelled = false;
function paraLog(msg) {
  const box = $("paraClassifyLog");
  const t = new Date().toLocaleTimeString();
  box.textContent += `[${t}] ${msg}\n`;
  box.scrollTop = box.scrollHeight;
}
$("paraClassifyCancel").addEventListener("click", () => {
  paraClassifyCancelled = true;
  $("paraClassifyCancel").disabled = true;
  paraLog("Отмена запрошена — останавливаюсь после текущей заметки…");
});
$("paraClassifyAll").addEventListener("click", async () => {
  const btn = $("paraClassifyAll");
  const cancelBtn = $("paraClassifyCancel");
  const log = $("paraClassifyLog");
  const rows = [...$("paraInbox").querySelectorAll(".para-row")];
  paraClassifyCancelled = false;
  btn.disabled = true;
  btn.textContent = "Разбираю…";
  cancelBtn.disabled = false;
  cancelBtn.classList.remove("hidden");
  log.textContent = "";
  log.classList.remove("hidden");
  paraLog(`Старт: ${rows.length} заметок.`);
  let done = 0, errors = 0;
  for (const row of rows) {
    if (paraClassifyCancelled) { paraLog("Прервано пользователем."); break; }
    const it = paraInboxItems[+row.dataset.idx];
    const name = it.title || it.name;
    paraLog(`→ ${name}`);
    try {
      const r = await window.api.paraClassify({ note: it.note, root: state.para.root, folders: state.para.folders });
      if (!r || r.error || !r.category) {
        paraLog(`   ✗ не классифицирована: ${(r && r.error) || "категория не определена"}`);
        errors++;
        continue;
      }
      row.querySelector(".para-cat").value = r.category;
      row.querySelector(".para-proj").value = r.project || "";
      // distil knowledge sections, then append into the accumulator + archive the raw note
      const ex = await window.api.paraExtract(it.note);
      if (!ex || ex.error || !ex.content) {
        paraLog(`   ✗ ${r.category} подобрана, но выжимка не извлечена: ${(ex && ex.error) || "пусто"}`);
        errors++;
        continue;
      }
      const res = await window.api.paraFile({
        note: it.note, audio: it.audio, category: r.category, project: r.project || "",
        extracted: ex.content, title: it.title || "", stamp: it.name,
        root: state.para.root, folders: state.para.folders,
      });
      if (res && res.ok === false) {
        paraLog(`   ✗ ${r.category} подобрана, но не разложена: ${res.error}`);
        errors++;
      } else {
        markRowFiled(row);
        paraLog(`   ✓ разложена → ${r.category}${r.project ? " / " + r.project : ""}`);
        done++;
      }
    } catch (e) {
      paraLog(`   ✗ исключение: ${e && e.message ? e.message : e}`);
      errors++;
    }
  }
  paraLog(`Готово: разобрано ${done}, ошибок ${errors}${paraClassifyCancelled ? ", прервано" : ""}.`);
  btn.disabled = false;
  btn.textContent = "🗂 Разобрать все (LLM)";
  cancelBtn.classList.add("hidden");
});

function markRowFiled(row) {
  row.classList.add("filed");
  row.querySelectorAll("select, input, button").forEach((el) => { el.disabled = true; });
  const btn = row.querySelector(".para-file-btn");
  if (btn) btn.textContent = "✓ Разложена";
}

async function fileParaRow(idx, row) {
  const it = paraInboxItems[idx];
  const category = row.querySelector(".para-cat").value;
  const project = row.querySelector(".para-proj").value.trim();
  if (!category) { alert("Выбери категорию"); return; }
  const btn = row.querySelector(".para-file-btn");
  const prev = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Извлекаю…";
  const ex = await window.api.paraExtract(it.note);
  if (!ex || ex.error || !ex.content) {
    alert("Не удалось извлечь выжимку: " + ((ex && ex.error) || "пусто"));
    btn.disabled = false; btn.textContent = prev; return;
  }
  const res = await window.api.paraFile({
    note: it.note, audio: it.audio, category, project,
    extracted: ex.content, title: it.title || "", stamp: it.name,
    root: state.para.root, folders: state.para.folders,
  });
  if (res && res.ok === false) {
    alert("Не удалось разложить: " + res.error);
    btn.disabled = false; btn.textContent = prev; return;
  }
  row.remove(); // distilled + archived → out of the Meetings inbox
}

function showResult(ev) {
  $("resultCard").style.display = "";
  $("resSummary").textContent = ev.summary || "(сводка пустая — LM Studio запущен?)";
  $("resTranscript").textContent = ev.transcript || "";
  $("resActions").textContent = formatActions(ev.actions);
  $("openNote").onclick = () => window.api.reveal(ev.note);
  $("openAudio").onclick = () => window.api.reveal(ev.audio);
  currentNote = ev.note;
  buildSpeakerMap(ev.transcript || "", ev.speakers || {});
}

init();
