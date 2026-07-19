const $ = (id) => document.getElementById(id);

// Pre-filled when the user has never set a glossary — biases Whisper/LLM correction
// toward common eng/dev jargon without forcing anyone to type it in from scratch.
const DEFAULT_GLOSSARY = "деплой, бэклог, спринт, ретро, стендап, груминг, эстимейт, роадмап, хотфикс, багфикс, тикет, пул-реквест, коммит, мёрж, код-ревью, статус-митинг, инцидент, продакшн, стейджинг, онбординг, скоуп, дедлайн, чекпоинт, апдейт, апрув, фидбек, Kubernetes, Docker, GitLab, GitHub, Jira, Confluence, Slack, Zoom, AWS, Kafka, Redis, PostgreSQL, ClickHouse, Grafana, Prometheus, Terraform, CI/CD, API, SQL, DevOps, MVP, KPI, OKR, дискавери, дискашн, синк, ван-он-ван, перформанс-ревью, квартал, планирование, приоритизация, метрика, гипотеза, эксперимент, A/B-тест, дашборд, воронка, конверсия, ретеншн, когорта, сегмент, атрибуция, пайплайн, релиз, рефакторинг, миграция, легаси, техдолг, архитектура, микросервис, монолит, фронтенд, бэкенд, эндпоинт, интеграция, оркестрация, Elasticsearch, RabbitMQ, nginx, Figma, Miro, Notion, Airflow, dbt, Tableau, Power BI, S3, VPN, SSO, LDAP, OAuth, нейросеть, промпт, эмбеддинг, инференс, файнтюнинг, LLM, RAG, ChatGPT, Claude";

const state = {
  mode: "record",      // 'record' | 'import'
  importQueue: [],     // [{ path, name, status }] status: 'queued'|'running'|'done'|'failed'|'canceled'
  queueIndex: -1,       // index of the import-queue item currently running / last acted on
  // Persistent queue of finished recordings waiting to be processed (survives an app
  // restart via main.js's pending.json manifest). [{ id, name, mixed, mic, system,
  // tracks, status }] status: 'pending'|'running'|'done'|'failed'. This is the ONLY
  // source of truth for a finished recording — there is no separate single-slot
  // "current recording" field; record-mode processing always acts on an explicit
  // pending item (per-row ▶ / "Обработать все"), never on "whatever finished last".
  pendingRecordings: [],
  recording: false,
  processing: false,
  hasRun: false,
  secretEncrypted: true,
  timer: 0,
  presets: [],
  currentPreset: -1,
  outDir: "",
  outDirCustom: false, // true once the user explicitly picked outDir — breaks vault auto-follow
  hfToken: "",
  language: "ru",
  theme: "classic",    // 'classic'|'pervanche'|'teal'|'orchid' — see applyTheme()
  authorName: "Автор",
  fastModel: "",
  mainModel: "",
  glossary: "",
  glossarySuggestions: [], // pending candidates from the "suggest" pipeline stage — accept/dismiss
  glossaryDismissed: [],   // dismissed candidates (original case; compared lowercased) — never re-suggested
  glossaryUsage: {},       // cumulative {termLower: fireCount} — merged in from each "done" event
                           // (see mergeGlossaryUsage), fed back to backend.py to order the
                           // Whisper initial_prompt's terms before its token-budget truncation.
  glossaryCategories: {},  // {termLower: category} — "Мои" grouping metadata ONLY (see
                           // GLOSSARY_CATEGORIES). Lives ALONGSIDE state.glossary (the comma-
                           // string mirror to the backend is untouched — backend doesn't need
                           // categories); a term absent here (or Стандартные terms, which are
                           // never categorized) falls into «Другое» — see glossaryCategoryOf.
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
    // Record mode has no single-slot "current audio" to run/retry/fresh (see
    // currentAudio()/startProcessing) — the shared Обработать/Остановить/Повторить/Заново
    // row is exclusively an import-mode affordance; hide it on the record tab so the record
    // card only shows mic-select/status/VU/recBtn/timer.
    document.querySelector(".run-row").classList.toggle("hidden", state.mode !== "import");
    // #processLatestBtn used to be nested inside #pane-record, so switching tabs hid it
    // for free via that pane's own .hidden toggle just above; now that it lives in the
    // record-action-bar alongside .run-row (both co-located, not nested under either
    // tabpane), it needs the same explicit mode-based toggle, inverted.
    $("processLatestBtn").classList.toggle("hidden", state.mode !== "record");
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

// ── copy to clipboard (result pane + chat bubbles + note-path buttons) ──────
// Writes text via the standard Clipboard API (available in the renderer regardless
// of contextIsolation/nodeIntegration — no IPC/main-process plumbing needed), then
// briefly flips the button's own label to `feedbackText` as click feedback.
// feedbackText/duration default to the original "✓" / 1000ms used by the result-pane
// and chat-bubble copy buttons; callers that want a different label/duration (e.g.
// the note-path copy buttons) pass their own.
function copyToClipboard(text, btn, feedbackText = "✓", duration = 1000) {
  navigator.clipboard.writeText(text || "").then(() => {
    const prev = btn.textContent;
    btn.textContent = feedbackText;
    setTimeout(() => { btn.textContent = prev; }, duration);
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
  // System audio (AudioTee's screen-capture TCC category) has no advance-check API —
  // main.js's getMediaAccessStatus("screen") call can read "denied" long before any
  // recording is attempted, but that reads as "broken" (mic's red bad) even though
  // nothing has actually failed yet; the real check only happens once AudioTee starts
  // (see setSysStatus's mid-recording fallback below). Only a confirmed "granted"
  // earns green — everything else (not-determined/denied/restricted/unknown) is a
  // calm grey "not confirmed", never the alarming red .bad.
  const permScreen = (s) => (s === "granted" ? "ok" : "neutral");
  const sysAudioTooltip = "AudioTee (запись системного звука) не сообщает доступ заранее — " +
    "статус подтверждается только фактической записью. " + SYS_HELP;
  const rows = [
    ["Бэкенд", ok(p.backendInstalled), p.backendInstalled ? "установлен" : "не установлен — см. раздел «Бэкенд» ниже"],
    ["LM Studio (сводка)", ok(p.lmStudio), p.lmStudio ? "запущен" : "не отвечает на :1234 — сводки не будет"],
    ["Микрофон", perm(p.mic), p.mic, "mic"],
    ["Системный звук (запись экрана)", permScreen(p.screen), p.screen === "granted" ? "разрешено" : "проверяется при записи", "screen", sysAudioTooltip],
    ["ffmpeg", ok(p.ffmpeg), p.ffmpeg ? "есть" : "не найден (brew install ffmpeg)"],
    ["Модель Whisper", p.whisperCached ? "ok" : "warn", p.whisperCached ? "скачана" : "скачается при 1й транскрипции (~1.5GB)"],
    ["HF-токен (диаризация)", p.hfToken ? "ok" : "warn", p.hfToken ? "задан" : "нет — спикеры по таймкодам"],
    ["Embedding-модель (поиск)", p.embedModel ? "ok" : "warn", p.embedModel ? "загружена" : "Embedding-модель не загружена — поиск будет работать только по ключевым словам"],
  ];
  wrap.innerHTML = "";
  rows.forEach(([label, state, detail, kind, tooltip]) => {
    const row = document.createElement("div");
    row.className = "pf-row";
    if (tooltip) row.title = tooltip;
    row.innerHTML = `<span class="pf-dot ${state}"></span><span class="pf-label">${label}</span><span class="pf-detail">${detail}</span>`;
    // Permission rows get an action button once not granted: mic can still be
    // prompted programmatically while not-determined, but once denied macOS
    // won't re-prompt — same for system audio, which has no prompt at all.
    if (kind === "mic" && p.mic !== "granted") {
      const btn = document.createElement("button");
      btn.className = "btn small pf-retry";
      // denied → macOS won't re-prompt; restricted (MDM-managed) can't be granted
      // in-app either — both dead-end to the same settings deep-link.
      if (p.mic === "denied" || p.mic === "restricted") {
        btn.textContent = "Открыть настройки";
        btn.addEventListener("click", () => window.api.openPrivacySettings("microphone"));
      } else {
        btn.textContent = "Разрешить";
        btn.addEventListener("click", async () => {
          btn.disabled = true;
          await window.api.requestMicAccess();
          refreshPreflight();
        });
      }
      row.appendChild(btn);
    } else if (kind === "screen" && p.screen !== "granted") {
      const btn = document.createElement("button");
      btn.className = "btn small pf-retry";
      btn.textContent = "Открыть настройки";
      btn.addEventListener("click", () => window.api.openPrivacySettings("screen"));
      row.appendChild(btn);
    }
    wrap.appendChild(row);
  });
  // overall verdict: critical = бэкенд + LM Studio + ffmpeg + mic; rest are warnings only
  const v = $("preflightVerdict");
  if (v) {
    const critical = p.backendInstalled && p.lmStudio && p.ffmpeg && p.mic === "granted";
    if (critical) { v.className = "pf-verdict ok"; v.textContent = "✅ Всё готово к работе."; }
    else {
      const miss = [];
      if (!p.backendInstalled) miss.push("бэкенд");
      if (!p.lmStudio) miss.push("LM Studio");
      if (!p.ffmpeg) miss.push("ffmpeg");
      if (p.mic !== "granted") miss.push("микрофон");
      v.className = "pf-verdict bad"; v.textContent = "⛔ Не готово: " + miss.join(", ");
    }
  }
}
$("preflightRefresh").addEventListener("click", refreshPreflight);

// ── backend installer (settings "Бэкенд" section: installs the Python/ffmpeg
// env backend.py actually runs in — the app ships without it, see README) ──────
// Separate from preflight's "ffmpeg" row (that one just reflects backend.py's own
// shutil.which check) — this section drives the one-button installer itself.
let backendInstallRunning = false;
let backendInstallLogLines = 0;
const BACKEND_INSTALL_LOG_MAX_LINES = 500;

function renderBackendStatus(status) {
  const row = $("backendStatusRow");
  const dotClass = !status.installed ? "bad" : status.stale ? "warn" : "ok";
  // "показать КАКОЙ именно бэкенд" — Python + ffmpeg versions, not just installed/not.
  const whatsInstalled = `Python ${status.pythonVersion}, ffmpeg ${status.ffmpegVersion || "не найден"}`;
  const detail = !status.installed
    ? "не установлен"
    : status.stale
    ? `установлен: ${whatsInstalled} — требования изменились, рекомендуется переустановить`
    : `установлен: ${whatsInstalled}`;
  row.innerHTML = `<span class="pf-dot ${dotClass}"></span><span class="pf-label">Бэкенд</span><span class="pf-detail"></span>`;
  row.querySelector(".pf-detail").textContent = detail;
  // A "Проверить" click that lands on an already-green, unchanged status must still
  // show *something* moved — otherwise it reads as a no-op. The env path (only
  // meaningful once installed) + a fresh timestamp on EVERY refresh (any status)
  // both change on every call, so this line is never visually identical twice in a row.
  const checkedAt = new Date().toLocaleTimeString();
  $("backendStatusDetail").textContent = status.installed
    ? `Папка окружения: ${status.envPath} · проверено ${checkedAt}`
    : `проверено ${checkedAt}`;
  // Установка монолитна (Python + ffmpeg + pip-зависимости ставятся одним атомарным
  // шагом, см. runInstallBackend в main.js) — переустановка всегда целиком, отдельных
  // кнопок "переустановить только ffmpeg" тут нет и не должно быть придумано.
  $("backendInstallBtn").textContent = status.installed
    ? "⟳ Переустановить целиком (Python + ffmpeg + зависимости)"
    : "⬇ Установить бэкенд";
}

async function refreshBackendStatus() {
  const row = $("backendStatusRow");
  row.innerHTML = '<span class="pf-dot warn"></span><span class="pf-label">Бэкенд</span><span class="pf-detail">Проверяю…</span>';
  const status = await window.api.backendStatus();
  renderBackendStatus(status);
  return status;
}

// Toggled in both settings' "Бэкенд" section AND the setup-gate wall's step 1 —
// same install, two render targets (see #setupGate in index.html).
function setBackendInstallUI(running) {
  backendInstallRunning = running;
  $("backendRefresh").disabled = running;
  $("backendInstallBtn").disabled = running;
  $("backendCancelBtn").classList.toggle("hidden", !running);
  $("gateBackendInstallBtn").disabled = running;
  $("gateBackendCancelBtn").classList.toggle("hidden", !running);
}

function backendLog(msg) {
  const box = $("backendInstallLog");
  box.classList.remove("hidden");
  box.textContent += msg + "\n";
  backendInstallLogLines++;
  if (backendInstallLogLines > BACKEND_INSTALL_LOG_MAX_LINES) {
    const lines = box.textContent.split("\n");
    box.textContent = lines.slice(lines.length - BACKEND_INSTALL_LOG_MAX_LINES).join("\n");
    backendInstallLogLines = BACKEND_INSTALL_LOG_MAX_LINES;
  }
  box.scrollTop = box.scrollHeight;
}

// One-line live status, mirrored into both the settings section and the gate
// (the gate has no log box — just this status line, see index.html).
function setBackendInstallStatusText(text) {
  $("backendInstallStatus").textContent = text;
  $("gateBackendInstallStatus").textContent = text;
}

// Shared by settings' "⬇ Установить бэкенд" button and the setup-gate's own
// install button — one install flow, triggerable from either surface.
async function startBackendInstall() {
  if (backendInstallRunning) return;
  setBackendInstallUI(true);
  $("backendInstallLog").textContent = "";
  setBackendInstallStatusText("");
  backendInstallLogLines = 0;
  const res = await window.api.installBackend();
  if (res && res.ok === false) {
    setBackendInstallUI(false);
    alert(res.error);
  }
}

$("backendRefresh").addEventListener("click", refreshBackendStatus);
$("backendInstallBtn").addEventListener("click", startBackendInstall);
$("backendCancelBtn").addEventListener("click", () => window.api.cancelInstallBackend());
$("gateBackendInstallBtn").addEventListener("click", startBackendInstall);
$("gateBackendCancelBtn").addEventListener("click", () => window.api.cancelInstallBackend());

window.api.onInstallBackendEvent((ev) => {
  if (ev.event === "stage") {
    setBackendInstallStatusText(ev.msg);
    backendLog("▶ " + ev.msg);
  } else if (ev.event === "download-progress") {
    setBackendInstallStatusText(`${ev.stage}: ${ev.pct}%`);
  } else if (ev.event === "stage_end") {
    const icon = ev.status === "ok" ? "✅ " : ev.status === "skip" ? "⏭ " : "⚠️ ";
    backendLog(icon + ev.msg);
  } else if (ev.event === "log") {
    backendLog(ev.msg);
  } else if (ev.event === "install-closed") {
    setBackendInstallUI(false);
    setBackendInstallStatusText("");
    refreshBackendStatus();
    refreshPreflight(); // backendInstalled feeds preflight's readiness verdict too
    refreshSetupGate(); // backend just changed — re-check the wall (unlocks step 2)
  } else if (ev.event === "disk-warning") {
    alert(ev.msg);
  }
});

// ── models (settings "Модели" section: cache status + on-demand pre-download) ──
// Additive, separate from the "Готовность" preflight section above — reuses its
// pf-row/pf-dot/pf-detail CSS, but is its own independent maintenance action
// (own IPC channel/process slot in main.js), not a preflight diagnostic.
let modelDlRunning = false;

function modelRowState(item) { return item.cached ? "ok" : item.locked ? "bad" : "warn"; }
function modelRowIcon(item) { return item.cached ? "✅" : item.locked ? "🔒" : "⬇"; }

// item.sizeBytes comes from main.js's "models" IPC (Node fs, du-style over the same
// cache dirs the readiness checks already use) — 0/falsy for an uncached model, which
// modelRowDetail below never even asks about (nothing on disk yet to size).
function formatModelSize(bytes) {
  if (!bytes) return null;
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? (mb / 1024).toFixed(1) + " ГБ" : mb.toFixed(0) + " МБ";
}

function modelRowDetail(item) {
  if (item.cached) {
    const size = formatModelSize(item.sizeBytes);
    return size ? `скачано (${size} на диске)` : "скачано";
  }
  if (item.locked) return "нужен HF-токен";
  return `нужно скачать (~${item.size_mb} МБ)`;
}

// Byte-level "model-progress" events (backend.py's _ProgressTqdm, whisper/pyannote
// only — VAD has no progress hook and stays on the coarse "⏳ скачивается…" text).
// total can be 0 momentarily right as a download starts (huggingface_hub hasn't
// reported a file size yet) — fall back to a live byte count rather than divide by zero.
function formatModelProgress(downloaded, total) {
  const mb = (n) => (n / (1024 * 1024)).toFixed(0);
  if (!total) return `⏳ скачивается… (${mb(downloaded)} МБ)`;
  const pct = Math.min(100, Math.round((downloaded / total) * 100));
  return `⏳ ${pct}% (${mb(downloaded)} / ${mb(total)} МБ)`;
}

function renderModelsList(items) {
  const wrap = $("modelsList");
  wrap.innerHTML = "";
  items.forEach((item) => {
    const row = document.createElement("div");
    row.className = "pf-row";
    row.id = "model-row-" + item.id;
    row.innerHTML =
      `<span class="pf-dot ${modelRowState(item)}"></span>` +
      `<span class="pf-label">${modelRowIcon(item)} ${item.label}</span>` +
      `<span class="pf-detail">${modelRowDetail(item)}</span>`;
    if (!item.cached && !item.locked) {
      // per-row retry, mirrors the bulk/scoped precedent already used for retryBtn/freshBtn
      const btn = document.createElement("button");
      btn.className = "btn small pf-retry";
      btn.textContent = "⬇";
      btn.title = "Скачать " + item.label;
      btn.disabled = modelDlRunning;
      btn.addEventListener("click", () => startModelDownload([item.id]));
      row.appendChild(btn);
    } else if (item.cached) {
      // Already cached — offer a scoped reinstall (wipe + redownload just this
      // model), distinct from the "missing" ⬇ button above. Reuses the same
      // pf-retry class so setModelsDownloadUI's disable-toggle covers it too.
      const btn = document.createElement("button");
      btn.className = "btn small pf-retry";
      btn.textContent = "↻";
      btn.title = "Скачать заново " + item.label;
      btn.disabled = modelDlRunning;
      btn.addEventListener("click", () => redownloadModel(item.id));
      row.appendChild(btn);
    }
    wrap.appendChild(row);
  });

  // Bulk "download missing" button only makes sense while something is actually
  // missing (not cached, not locked-behind-a-token) — all-cached and all-locked
  // states both hide it, matching the per-row retry's own visibility rule above.
  const missing = items.filter((item) => !item.cached && !item.locked);
  const bulkBtn = $("modelsDownloadMissing");
  if (missing.length) {
    bulkBtn.textContent = `⬇ Скачать недостающие (${missing.length})`;
    bulkBtn.classList.remove("hidden");
    bulkBtn.disabled = modelDlRunning;
  } else {
    bulkBtn.classList.add("hidden");
  }
}

async function refreshModels() {
  const wrap = $("modelsList");
  wrap.innerHTML = '<p class="hint">Проверяю…</p>';
  $("modelsDownloadMissing").classList.add("hidden");
  const items = await window.api.getModels();
  renderModelsList(items);
}

function setModelsDownloadUI(running) {
  modelDlRunning = running;
  $("modelsRefresh").disabled = running;
  $("modelsDownloadMissing").disabled = running;
  $("modelsCancelBtn").classList.toggle("hidden", !running);
  document.querySelectorAll("#modelsList .pf-retry").forEach((b) => { b.disabled = running; });
  // Gate's own download button — re-render restores its backend-first disabled
  // state afterwards (see renderSetupGate), this just covers the running state.
  $("gateModelsDownloadBtn").disabled = running;
  $("gateModelsCancelBtn").classList.toggle("hidden", !running);
}

// only: array of model ids to (re)try, or omitted = whatever's missing and eligible.
async function startModelDownload(only) {
  if (modelDlRunning) return;
  setModelsDownloadUI(true);
  const res = await window.api.downloadModels(only ? { only } : {});
  if (res && res.ok === false) {
    setModelsDownloadUI(false);
    alert(res.error);
  }
}

// Force-refetch a single already-cached model (the "↻" button above) — main.js's
// redownload-model IPC wipes that model's cache dir before starting the scoped
// download, since backend.py silently skips a model it already sees as cached.
// Shares modelDlRunning/setModelsDownloadUI and the download-models-event stream
// with startModelDownload above — it's the same underlying batch, just pre-wiped.
async function redownloadModel(modelId) {
  if (modelDlRunning) return;
  setModelsDownloadUI(true);
  const res = await window.api.redownloadModel(modelId);
  if (res && res.ok === false) {
    setModelsDownloadUI(false);
    alert(res.error);
  }
}
$("modelsRefresh").addEventListener("click", refreshModels);
$("modelsDownloadMissing").addEventListener("click", () => startModelDownload());
$("modelsCancelBtn").addEventListener("click", () => window.api.cancelModelDownload());
// Gate's step 2 only ever wants the two REQUIRED models — never the full
// "missing" batch (which would also pull pyannote if a token happens to be
// set), reusing the same startModelDownload(only) as the per-row retry buttons.
$("gateModelsDownloadBtn").addEventListener("click", () => startModelDownload(["whisper", "vad"]));
$("gateModelsCancelBtn").addEventListener("click", () => window.api.cancelModelDownload());

// Per-row live status while a download batch runs — ev.stage is "model:<id>"
// (backend.py's stage/stage_end vocabulary, same as the pipeline's own stages).
window.api.onModelDownloadEvent((ev) => {
  const rowFor = (stageName) => (stageName ? $("model-row-" + stageName.replace(/^model:/, "")) : null);
  // Gate's combined whisper+vad row mirrors only those two stages — diarization
  // isn't part of the wall (see appReadinessStatus's comment in lib/mainutil).
  const gateDetail = (ev.stage === "model:whisper" || ev.stage === "model:vad")
    ? $("gateModelsStatusRow").querySelector(".pf-detail") : null;
  if (ev.event === "stage") {
    const row = rowFor(ev.stage);
    if (row) {
      row.querySelector(".pf-dot").className = "pf-dot warn";
      row.querySelector(".pf-detail").textContent = "⏳ скачивается…";
    }
    if (gateDetail) gateDetail.textContent = "⏳ скачивается…";
  } else if (ev.event === "stage_end") {
    const row = rowFor(ev.stage);
    const icon = ev.status === "ok" ? "✅ " : ev.status === "skip" ? "⏭ " : "⚠️ ";
    if (row) {
      row.querySelector(".pf-dot").className = "pf-dot " + (ev.status === "fail" ? "bad" : "ok");
      row.querySelector(".pf-detail").textContent = icon + (ev.msg || "");
    }
    if (gateDetail) gateDetail.textContent = icon + (ev.msg || "");
  } else if (ev.event === "model-progress") {
    const row = $("model-row-" + ev.id);
    const text = formatModelProgress(ev.downloaded, ev.total);
    if (row) row.querySelector(".pf-detail").textContent = text;
    // gateModelsStatusRow's .pf-detail only exists once renderSetupGate() has run at
    // least once (it's built dynamically, see refreshSetupGate) — e.g. a re-download
    // triggered from settings after the wall was already dismissed never renders it.
    if (ev.id === "whisper" || ev.id === "vad") {
      const gateProgressDetail = $("gateModelsStatusRow").querySelector(".pf-detail");
      if (gateProgressDetail) gateProgressDetail.textContent = text;
    }
  } else if (ev.event === "download-closed") {
    setModelsDownloadUI(false);
    refreshModels(); // re-check real cache state — converges cached/needed/locked either way
    refreshSetupGate(); // models just changed — re-check the wall
  } else if (ev.event === "disk-warning") {
    alert(ev.msg);
  }
});

// ── setup gate (hard wall): blocks the entire app until the backend is
// installed AND whisper+vad are cached — main.js's app-readiness IPC computes
// this via plain fs checks (no python spawn needed pre-install). Diarization
// is NOT required to dismiss the wall (optional-by-design, see main.js).
function renderSetupGate(r) {
  const beRow = $("gateBackendStatusRow");
  beRow.innerHTML = `<span class="pf-dot ${r.backend ? "ok" : "bad"}"></span><span class="pf-label">Бэкенд</span><span class="pf-detail"></span>`;
  beRow.querySelector(".pf-detail").textContent = r.backend ? "установлен" : "не установлен";
  $("gateBackendInstallBtn").disabled = r.backend || backendInstallRunning;

  // Step 2 is backend-first: download-models spawns pythonBin(), which falls
  // back to a bare "python3" lacking huggingface_hub/torch until the backend
  // is installed (or a dev ../venv exists) — so it's disabled until r.backend.
  const moRow = $("gateModelsStatusRow");
  const modelsReady = r.whisper && r.vad;
  moRow.innerHTML = `<span class="pf-dot ${modelsReady ? "ok" : "bad"}"></span><span class="pf-label">Модели (Whisper + VAD)</span><span class="pf-detail"></span>`;
  moRow.querySelector(".pf-detail").textContent = modelsReady
    ? "скачано"
    : r.backend ? "нужно скачать" : "сначала установите бэкенд";
  $("gateModelsDownloadBtn").disabled = !r.backend || modelsReady || modelDlRunning;
}

async function refreshSetupGate() {
  // Fail CLOSED: the wall defaults to visible (index.html) and is hidden only on a
  // confirmed-ready readiness result. An IPC error keeps the wall up rather than
  // exposing an unusable app; also removes the boot flash-of-usable-app.
  let r;
  try {
    r = await window.api.appReadiness();
  } catch {
    $("setupGate").classList.remove("hidden");
    return { backend: false, whisper: false, vad: false, models: false };
  }
  const ready = r.backend && r.models;
  $("setupGate").classList.toggle("hidden", ready);
  if (!ready) renderSetupGate(r);
  return r;
}
window.addEventListener("focus", refreshSetupGate);

// ── in-app updater (settings "Обновления" section) ──────────────────────────
// Auto-checks once every time the settings overlay opens (in addition to the
// manual "Проверить обновления" button) — check only, never auto-downloads.
// appUpdateCheckInFlight guards both entry points against stacking a second
// concurrent check while one is still running; it's independent of
// appUpdateRunning, which guards the (much longer) install/download flow.
let appUpdateRunning = false;
let appUpdateCheckInFlight = false;
let appUpdateInfo = null; // last check-app-update() result — drives the install button's visibility

function renderUpdateStatusRow(text, dotClass) {
  const row = $("updateStatusRow");
  row.innerHTML = `<span class="pf-dot ${dotClass}"></span><span class="pf-label">Версия</span><span class="pf-detail"></span>`;
  row.querySelector(".pf-detail").textContent = text;
}

function setUpdateInstallUI(running) {
  appUpdateRunning = running;
  $("updateCheckBtn").disabled = running;
  $("updateInstallBtn").disabled = running;
  $("updateCancelBtn").classList.toggle("hidden", !running);
}

async function checkAppUpdate() {
  if (appUpdateRunning || appUpdateCheckInFlight) return;
  appUpdateCheckInFlight = true;
  $("updateCheckBtn").disabled = true;
  renderUpdateStatusRow("Проверяю…", "warn");
  $("updateInstallBtn").classList.add("hidden");
  $("updateDevHint").classList.add("hidden");
  $("updateInstallStatus").textContent = "";
  const res = await window.api.checkAppUpdate();
  appUpdateCheckInFlight = false;
  $("updateCheckBtn").disabled = false;
  appUpdateInfo = res;
  if (!res || res.ok === false) {
    const current = (res && res.current) || "—";
    renderUpdateStatusRow(`Текущая версия: ${current} — ошибка проверки: ${(res && res.error) || "неизвестная ошибка"}`, "bad");
    return;
  }
  if (res.hasUpdate) {
    const notesLine = res.releaseNotes ? ` — ${res.releaseNotes}` : "";
    renderUpdateStatusRow(`Текущая версия: ${res.current}. Доступна ${res.latest}${notesLine}`, "warn");
    $("updateInstallBtn").classList.remove("hidden");
    $("updateInstallBtn").disabled = !res.isPackaged;
    $("updateDevHint").classList.toggle("hidden", !!res.isPackaged);
  } else {
    renderUpdateStatusRow(`Текущая версия: ${res.current} — актуальная`, "ok");
    $("updateInstallBtn").classList.add("hidden");
  }
}

async function startAppUpdateInstall() {
  if (appUpdateRunning || !appUpdateInfo || !appUpdateInfo.isPackaged) return;
  setUpdateInstallUI(true);
  $("updateInstallStatus").textContent = "";
  const res = await window.api.downloadAndInstallUpdate();
  if (res && res.ok === false) {
    setUpdateInstallUI(false);
    alert(res.error);
  }
  // on success the app relaunches itself — no further UI update needed here
}

$("updateCheckBtn").addEventListener("click", checkAppUpdate);
$("updateInstallBtn").addEventListener("click", startAppUpdateInstall);
$("updateCancelBtn").addEventListener("click", () => window.api.cancelAppUpdate());

window.api.onAppUpdateEvent((ev) => {
  if (ev.event === "stage") {
    $("updateInstallStatus").textContent = ev.msg;
  } else if (ev.event === "download-progress") {
    $("updateInstallStatus").textContent = `Скачиваю: ${ev.pct}%`;
  } else if (ev.event === "install-closed") {
    setUpdateInstallUI(false);
    if (ev.canceled) $("updateInstallStatus").textContent = "Отменено";
    else if (ev.error) { $("updateInstallStatus").textContent = ""; alert(ev.error); }
  }
});

// settings / readiness modal
function openSettings() { $("settingsOverlay").classList.remove("hidden"); refreshPreflight(); refreshBackendStatus(); refreshModels(); checkAppUpdate(); }
function closeSettings() { $("settingsOverlay").classList.add("hidden"); }
$("settingsOpen").addEventListener("click", openSettings);
$("settingsClose").addEventListener("click", closeSettings);
$("settingsOverlay").addEventListener("click", (e) => { if (e.target === $("settingsOverlay")) closeSettings(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSettings(); });

// full reset ("настроить заново"): main rewrites presets.json to fresh defaults
// (para.root forced empty) + wipes the HF-token secret, then this reuses init()
// (already idempotent — re-fetches presets, rewrites state+DOM)
// instead of app.relaunch(). renderParaInboxView() isn't covered by init() (it's only
// called from subSwitchPara), so re-render it explicitly when the Разбор subtab is
// the one currently visible; paraInboxLoaded is reset so a later vault setup re-scans
// instead of trusting a stale disk read from before the reset.
async function onResetApp() {
  const btn = $("resetAppBtn");
  if (btn.disabled) return;
  const ok = confirm(
    "Сбросить настройки приложения (HF-токен, пресеты, имя автора, словарь, путь к vault)? " +
    "Заметки и записи в Obsidian не пострадают, индекс истории при необходимости пересоберётся."
  );
  if (!ok) return;
  btn.disabled = true;
  try {
    const res = await window.api.resetApp();
    if (res && res.ok === false) { alert(res.error); return; }
    paraInboxLoaded = false;
    await init();
    if (!$("view-para").classList.contains("hidden") && paraSub === "inbox") renderParaInboxView();
  } finally {
    btn.disabled = false;
  }
}
$("resetAppBtn").addEventListener("click", onResetApp);

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
  state.outDirCustom = !!data.outDirCustom;
  state.hfToken = data.hfToken || "";
  // "auto" was removed from the #language <select> options (no matching <option> left
  // to select) but old presets/settings files may still carry it — coerce to the default.
  state.language = (data.language === "auto" ? "" : data.language) || "ru";
  state.theme = data.theme || "classic";
  state.authorName = data.authorName || "Автор";
  state.fastModel = data.fastModel || "";
  state.mainModel = data.mainModel || "";
  state.glossary = data.glossary || DEFAULT_GLOSSARY;
  state.glossarySuggestions = data.glossarySuggestions || [];
  state.glossaryDismissed = data.glossaryDismissed || [];
  state.glossaryUsage = data.glossaryUsage || {};
  state.glossaryCategories = data.glossaryCategories || {};
  state.para = data.para || null;
  state.secretEncrypted = data.secretEncrypted !== false;
  $("outDir").value = state.outDir;
  $("hfToken").value = state.hfToken;
  $("language").value = state.language;
  $("themeSelect").value = state.theme;
  applyTheme();
  $("authorName").value = state.authorName;
  $("fastModel").value = state.fastModel;
  $("mainModel").value = state.mainModel;
  $("glossary").value = state.glossary;
  renderGlossaryChips();
  renderGlossarySuggestions();
  updateTokenWarn();
  renderPresets();
  if (state.presets.length) selectPreset(0);

  // Restore the persistent pending-recordings queue (survives an app restart —
  // main.js reads it back from pending.json). Rendered inline in the История rail
  // (renderRail) — there is no separate control strip. Awaited BEFORE refreshHistory()
  // so its updateNoteViewDefault() sees the real pending count on its very first pass,
  // not a not-yet-populated state.pendingRecordings (which would misjudge "no notes yet
  // but a pending recording exists" as fully empty).
  const pending = await window.api.listPendingRecordings();
  state.pendingRecordings = (pending || []).map((r) => ({ ...r, status: "pending" }));
  refreshHistory();
}

// Record-card #presetSelect stays index-based (option value = array index) — the
// full editor (name/prompt/add/delete) lives only in the «Промпты» tab (#promptsList
// rail + #promptsName/#promptsPrompt), which renderPromptsList() renders as a
// parallel view over the same state.presets array.
function renderPresets() {
  const sel = $("presetSelect");
  sel.innerHTML = "";
  state.presets.forEach((p, i) => {
    const o = document.createElement("option");
    o.value = i;
    o.textContent = p.name;
    sel.appendChild(o);
  });
  renderPromptsList();
}
function renderPromptsList() {
  const list = $("promptsList");
  list.innerHTML = "";
  if (!state.presets.length) {
    list.insertAdjacentHTML("beforeend", '<p class="hint">Пока пусто — добавь первый шаблон.</p>');
    return;
  }
  // Built via createElement + textContent (never innerHTML/string interpolation of
  // p.name) and the click handler closes over `i` from this same forEach — same
  // discipline as renderRail/chip rendering: no user string ever lands in an HTML
  // attribute or gets parsed as markup.
  state.presets.forEach((p, i) => {
    const btn = document.createElement("button");
    btn.className = "rail-item" + (i === state.currentPreset ? " active" : "");
    btn.textContent = p.name;
    btn.addEventListener("click", () => selectPreset(i));
    list.appendChild(btn);
  });
}
function selectPreset(i) {
  state.currentPreset = i;
  const p = state.presets[i];
  $("presetSelect").value = i;
  $("promptsName").value = p ? p.name : "";
  $("promptsPrompt").value = p ? p.prompt : "";
  renderPromptsList(); // refresh the rail's active highlight
}
$("presetSelect").addEventListener("change", (e) => selectPreset(+e.target.value));

// edits write back to the selected preset + persist (on blur/change, not per keystroke)
$("promptsName").addEventListener("change", () => {
  const p = state.presets[state.currentPreset];
  if (!p) return;
  p.name = $("promptsName").value;
  renderPresets();
  $("presetSelect").value = state.currentPreset;
  persistPresets();
});
$("promptsPrompt").addEventListener("change", () => {
  const p = state.presets[state.currentPreset];
  if (p) { p.prompt = $("promptsPrompt").value; persistPresets(); }
});

$("promptsNewBtn").addEventListener("click", async () => {
  // Stable id (independent of array position) — see main.js's loadPresetsData()
  // backfill for presets that predate this field.
  state.presets.push({ id: crypto.randomUUID(), name: "Новый пресет", prompt: $("promptsPrompt").value || "" });
  renderPresets();
  selectPreset(state.presets.length - 1);
  await persistPresets();
  $("promptsName").focus();
  $("promptsName").select();
});
$("promptsDelBtn").addEventListener("click", async () => {
  const i = state.currentPreset;
  if (!state.presets[i]) return;
  state.presets.splice(i, 1);
  renderPresets();
  if (state.presets.length) selectPreset(Math.min(i, state.presets.length - 1));
  else { state.currentPreset = -1; $("promptsName").value = ""; $("promptsPrompt").value = ""; }
  await persistPresets();
});
// Applies state.theme to the document root: [data-theme] drives the theme override
// blocks in style.css; classic has no override block, so the attribute is removed
// entirely rather than set to an empty string (matters for [data-theme="classic"]-
// style selectors never existing, and keeps the DOM clean for the default theme).
function applyTheme() {
  if (state.theme === "classic") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = state.theme;
}

async function persistPresets() {
  const res = await window.api.savePresets({
    presets: state.presets,
    defaultOutDir: state.outDir,
    outDirCustom: state.outDirCustom,
    hfToken: state.hfToken,
    language: state.language,
    theme: state.theme,
    authorName: state.authorName,
    fastModel: state.fastModel,
    mainModel: state.mainModel,
    glossary: state.glossary,
    glossarySuggestions: state.glossarySuggestions,
    glossaryDismissed: state.glossaryDismissed,
    glossaryUsage: state.glossaryUsage,
    glossaryCategories: state.glossaryCategories,
    para: state.para,
  });
  // L7 arch-audit: main.js's save-presets now reports a failed HF-token
  // keychain/file write instead of silently succeeding — surface it the same
  // way every other main-process failure in this file does (res.ok === false).
  if (res && res.ok === false) alert(res.error);
}

$("language").addEventListener("change", (e) => {
  state.language = e.target.value;
  persistPresets();
});

$("themeSelect").addEventListener("change", (e) => {
  state.theme = e.target.value;
  applyTheme();
  persistPresets();
});

$("hfToken").addEventListener("change", (e) => {
  state.hfToken = e.target.value;
  persistPresets();
  updateTokenWarn();
});
$("hfHelpLink").addEventListener("click", (e) => {
  e.preventDefault();
  window.api.openExternal("https://huggingface.co/settings/tokens");
});

$("authorName").addEventListener("change", (e) => {
  state.authorName = e.target.value || "Автор";
  persistPresets();
});

$("fastModel").addEventListener("change", (e) => {
  state.fastModel = e.target.value || "";
  persistPresets();
});

$("mainModel").addEventListener("change", (e) => {
  state.mainModel = e.target.value || "";
  persistPresets();
});

// LM Studio model inventory for the fastModel/mainModel <datalist> suggestions — fetched
// fresh every time the settings overlay opens (never polled). Registered as its OWN
// settingsOpen click listener rather than folded into openSettings() itself, so this
// stays clear of that function's body while other in-flight branches touch it.
// list-lm-models degrades to [] on any LM Studio failure (see main.js) — an empty
// datalist just means no suggestions; both inputs stay plain, freely-typable text fields.
async function populateLmModelOptions() {
  let ids;
  try {
    ids = await window.api.listLmModels();
  } catch {
    ids = [];
  }
  ids = ids || [];
  for (const listId of ["fastModelOptions", "mainModelOptions"]) {
    const dl = $(listId);
    dl.innerHTML = "";
    ids.forEach((id) => {
      const o = document.createElement("option");
      o.value = id;
      dl.appendChild(o);
    });
  }
}
$("settingsOpen").addEventListener("click", populateLmModelOptions);

// Textarea accepts either a comma- OR newline-separated paste ("Импорт/экспорт
// текстом") — parseGlossaryTerms already splits on both, and routing through
// setGlossaryTerms normalizes whatever was pasted back into the canonical
// ", "-joined form (both in state.glossary and mirrored into the textarea
// itself), rather than storing the raw pasted text verbatim.
$("glossary").addEventListener("change", (e) => {
  setGlossaryTerms(parseGlossaryTerms(e.target.value));
});

// ── glossary: chip list (add / remove / merge defaults) ─────────────────────
// Storage stays a single comma-joined string (state.glossary, mirrored into the
// #glossary textarea for the "текстом" fallback and for backend._glossary_terms,
// which splits on the same [,\n]+ pattern) — chips are just a view over it.
function parseGlossaryTerms(str) {
  return (str || "").split(/[,\n]+/).map((t) => t.trim()).filter(Boolean);
}

function setGlossaryTerms(terms) {
  state.glossary = terms.join(", ");
  $("glossary").value = state.glossary;
  renderGlossaryChips();
  persistPresets();
}

function showGlossaryHint(msg) {
  const el = $("glossaryHint");
  el.textContent = msg || "";
  el.classList.toggle("hidden", !msg);
}

// Case-insensitive membership check — same normalization mergeDefaultGlossary
// already uses (compare lowercased) — so a term classifies into the SAME
// section ("Мои" vs "Стандартные") whether it arrived via chip-add, textarea
// paste, or "Дополнить распространёнными".
const DEFAULT_GLOSSARY_TERMS_LOWER = new Set(parseGlossaryTerms(DEFAULT_GLOSSARY).map((t) => t.toLowerCase()));

let glossaryFilterQuery = "";        // transient live-filter text — UI-only, never persisted
let glossaryDefaultCollapsed = true; // "Стандартные" starts collapsed each session — UI-only, never persisted

// "Мои" category folders (Люди/Продукты и инструменты/Термины/Другое) collapse
// individually — a category name present in this Set is collapsed. Starts empty
// (every category expanded): these are the user's OWN terms, so — unlike «Стандартные»
// (100+ imported defaults, collapsed by default) — discoverability wins; collapsing is
// a new capability the user opts into per folder, not a default. Session-only, never
// persisted — same lifetime as glossaryDefaultCollapsed above.
let glossaryCategoryCollapsed = new Set();

function usageBadge(term) {
  const n = (state.glossaryUsage || {})[term.toLowerCase()] || 0;
  return n > 0 ? ` <span class="chip-usage">${n}×</span>` : "";
}

// ── glossary: "Мои" categories (V2 — «разбить по папочкам») ─────────────────
// Fixed, small bucket set ("папочки") rather than free-form tags — Otter-style
// precedent from this feature's research. Provisional taxonomy: derived from the
// owner's own examples (имена → «Люди», технические → «Термины»/«Продукты и
// инструменты»); "кулинария" wasn't promoted to its own bucket — «Другое» catches
// whatever doesn't fit. Only "Мои" terms are ever grouped/categorized —
// "Стандартные" stays the flat collapsed list it already was (V1).
// Kept in sync BY HAND with the identical Python tuple in backend.py
// (GLOSSARY_TERM_CATEGORIES) — renderer and backend never share a runtime.
const GLOSSARY_CATEGORY_OTHER = "Другое";
const GLOSSARY_CATEGORIES = ["Люди", "Продукты и инструменты", "Термины", GLOSSARY_CATEGORY_OTHER];

// A term with no entry in state.glossaryCategories, or an entry outside the fixed
// set (e.g. a stale value from a future/rolled-back version), always resolves to
// «Другое» — the fixed set never rejects a term.
function glossaryCategoryOf(term) {
  const c = (state.glossaryCategories || {})[term.toLowerCase()];
  return GLOSSARY_CATEGORIES.includes(c) ? c : GLOSSARY_CATEGORY_OTHER;
}

function setGlossaryTermCategory(term, category) {
  const cat = GLOSSARY_CATEGORIES.includes(category) ? category : GLOSSARY_CATEGORY_OTHER;
  const categories = Object.assign({}, state.glossaryCategories || {});
  categories[term.toLowerCase()] = cat;
  state.glossaryCategories = categories;
  renderGlossaryChips();
  persistPresets();
}

// withCategory=true adds a per-chip category <select> ("Мои" chips only —
// "Стандартные" chips never carry one, V1 behaviour unchanged for that section).
function glossaryChipHtml(t, withCategory) {
  const categorySelect = withCategory
    ? `<select class="chip-category" aria-label="Категория термина">` +
      GLOSSARY_CATEGORIES.map((c) =>
        `<option value="${escapeHtml(c)}"${c === glossaryCategoryOf(t) ? " selected" : ""}>${escapeHtml(c)}</option>`
      ).join("") +
      `</select>`
    : "";
  return `<span class="chip"><span class="chip-text">${escapeHtml(t)}${usageBadge(t)}</span>` +
    categorySelect +
    `<button type="button" class="chip-remove" aria-label="Удалить">×</button></span>`;
}

// Chips split into "Мои" (custom terms, always shown — now grouped into category
// subheaders, see GLOSSARY_CATEGORIES) and "Стандартные" (terms that are also in
// DEFAULT_GLOSSARY — there can be 100+, so collapsed by default with a toggle,
// flat, uncategorized — V1 behaviour). A live substring filter narrows both
// sections (and every "Мои" category group within them) and forces "Стандартные"
// open while it has matches, so a hidden default term is still reachable by
// typing instead of manually expanding first.
function renderGlossaryChips() {
  const terms = parseGlossaryTerms(state.glossary);
  const box = $("glossaryChips");
  const q = glossaryFilterQuery.trim().toLowerCase();
  const matches = (t) => !q || t.toLowerCase().includes(q);

  if (!terms.length) {
    box.innerHTML = '<p class="hint">Список пуст — добавь термин ниже.</p>';
    $("glossaryCount").textContent = "0 терминов";
    return;
  }

  const mineTerms = terms.filter((t) => !DEFAULT_GLOSSARY_TERMS_LOWER.has(t.toLowerCase()));
  const defaultTerms = terms.filter((t) => DEFAULT_GLOSSARY_TERMS_LOWER.has(t.toLowerCase()));
  const mineShown = mineTerms.filter(matches);
  const defaultShown = defaultTerms.filter(matches);
  const totalShown = mineShown.length + defaultShown.length;

  if (q && !totalShown) {
    box.innerHTML = '<p class="hint">Ничего не найдено по фильтру.</p>';
  } else {
    // mineOrder tracks terms in the exact order their chips land in the DOM
    // (grouped by category — GLOSSARY_CATEGORIES order — not mineShown's original
    // add-order); the closures below index into it, so a click always targets the
    // chip that was actually rendered at that position. Categories with 0 shown
    // terms are skipped entirely (no empty subheader), same "filter narrows what's
    // visible" contract the Стандартные toggle already has.
    const mineOrder = [];
    // Parallel to mineOrder above but one entry per RENDERED category group (skipping
    // categories with 0 shown terms, same as mineOrder skips filtered-out terms) — the
    // toggle wiring below indexes into it by rendered position, same closure-over-index
    // discipline as mineOrder/chip-remove (no category name ever round-trips through an
    // HTML attribute).
    const renderedCategories = [];
    const mineHtml = GLOSSARY_CATEGORIES.map((cat) => {
      const inCat = mineShown.filter((t) => glossaryCategoryOf(t) === cat);
      if (!inCat.length) return "";
      mineOrder.push(...inCat);
      renderedCategories.push(cat);
      const collapsed = glossaryCategoryCollapsed.has(cat);
      return `<div class="glossary-category-group">` +
        `<button type="button" class="glossary-category-header">` +
        `<span class="glossary-caret">${collapsed ? "▸" : "▾"}</span> ${escapeHtml(cat)} ` +
        `<span class="glossary-count">${inCat.length}</span></button>` +
        `<div class="chip-list${collapsed ? " hidden" : ""}">${inCat.map((t) => glossaryChipHtml(t, true)).join("")}</div>` +
        `</div>`;
    }).join("");

    const expandDefault = !glossaryDefaultCollapsed || (!!q && defaultShown.length > 0);
    const defaultCountLabel = q ? `${defaultShown.length} из ${defaultTerms.length}` : `${defaultTerms.length}`;
    box.innerHTML =
      `<div id="glossaryChipsMine">${mineHtml}</div>` +
      (defaultTerms.length
        ? `<div class="glossary-section-default">` +
          `<button type="button" id="glossaryDefaultToggle" class="glossary-section-toggle">` +
          `<span class="glossary-caret">${expandDefault ? "▾" : "▸"}</span> Стандартные ` +
          `<span class="glossary-count">${defaultCountLabel}</span></button>` +
          `<div class="chip-list glossary-default-chips${expandDefault ? "" : " hidden"}">` +
          `${defaultShown.map((t) => glossaryChipHtml(t, false)).join("")}</div></div>`
        : "");
    // Term is captured via closure (index into mineOrder/defaultShown, the SAME
    // arrays that produced each section's innerHTML) rather than round-tripped
    // through a data-* attribute — a term containing a `"` would otherwise break
    // out of the attribute (escapeHtml only escapes &<>, not quotes) and also
    // desync removal, since the garbled attribute value would no longer match the
    // original term.
    box.querySelector("#glossaryChipsMine").querySelectorAll(".chip-remove").forEach((btn, i) =>
      btn.addEventListener("click", () => removeGlossaryTerm(mineOrder[i])));
    box.querySelector("#glossaryChipsMine").querySelectorAll(".chip-category").forEach((sel, i) =>
      sel.addEventListener("change", () => setGlossaryTermCategory(mineOrder[i], sel.value)));
    box.querySelector("#glossaryChipsMine").querySelectorAll(".glossary-category-header").forEach((btn, i) =>
      btn.addEventListener("click", () => {
        const cat = renderedCategories[i];
        if (glossaryCategoryCollapsed.has(cat)) glossaryCategoryCollapsed.delete(cat);
        else glossaryCategoryCollapsed.add(cat);
        renderGlossaryChips();
      }));
    const defaultBox = box.querySelector(".glossary-default-chips");
    if (defaultBox) {
      defaultBox.querySelectorAll(".chip-remove").forEach((btn, i) =>
        btn.addEventListener("click", () => removeGlossaryTerm(defaultShown[i])));
    }
    const toggleBtn = box.querySelector("#glossaryDefaultToggle");
    if (toggleBtn) {
      toggleBtn.addEventListener("click", () => {
        glossaryDefaultCollapsed = !glossaryDefaultCollapsed;
        renderGlossaryChips();
      });
    }
  }
  $("glossaryCount").textContent = q ? `${totalShown} из ${terms.length} терминов` : `${terms.length} терминов`;
}

$("glossaryFilter").addEventListener("input", (e) => {
  glossaryFilterQuery = e.target.value || "";
  renderGlossaryChips();
});

function addGlossaryTerm() {
  const input = $("glossaryNewTerm");
  const raw = (input.value || "").trim();
  if (!raw) return;
  const terms = parseGlossaryTerms(state.glossary);
  if (terms.some((t) => t.toLowerCase() === raw.toLowerCase())) {
    showGlossaryHint(`«${raw}» уже есть в списке`);
    return;
  }
  setGlossaryTerms(terms.concat(raw));
  input.value = "";
  showGlossaryHint("");
}

function removeGlossaryTerm(term) {
  setGlossaryTerms(parseGlossaryTerms(state.glossary).filter((t) => t !== term));
}

function mergeDefaultGlossary() {
  const current = parseGlossaryTerms(state.glossary);
  const have = new Set(current.map((t) => t.toLowerCase()));
  const toAdd = parseGlossaryTerms(DEFAULT_GLOSSARY).filter((t) => !have.has(t.toLowerCase()));
  if (!toAdd.length) {
    showGlossaryHint("Все распространённые термины уже есть в списке");
    return;
  }
  setGlossaryTerms(current.concat(toAdd));
  showGlossaryHint(`Добавлено ${toAdd.length} новых терминов`);
}

$("glossaryAddBtn").addEventListener("click", addGlossaryTerm);
$("glossaryNewTerm").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); addGlossaryTerm(); }
});
$("glossaryFillDefaults").addEventListener("click", mergeDefaultGlossary);
$("glossaryToggleText").addEventListener("click", () => $("glossaryTextWrap").classList.toggle("hidden"));

// ── glossary: "Мои" auto-classification ("Разложить по категориям" button) ──
// One-shot LLM batch classify of ALL "Мои" terms (not just what the live filter
// currently shows — the point is to sort the whole shelf, not a filtered view)
// via backend.py's classify-terms subcommand (see main.js's classify-glossary-
// terms handler). Mirrors the suggest-stage's LM-down degrade: an unreachable/
// erroring LM Studio surfaces an honest hint, never a crash.
async function classifyGlossaryTerms() {
  const btn = $("glossaryClassifyBtn");
  if (btn.disabled) return;
  const mineTerms = parseGlossaryTerms(state.glossary)
    .filter((t) => !DEFAULT_GLOSSARY_TERMS_LOWER.has(t.toLowerCase()));
  if (!mineTerms.length) {
    showGlossaryHint("Нет своих терминов для разбора по категориям");
    return;
  }
  btn.disabled = true;
  showGlossaryHint("Раскладываю по категориям…");
  try {
    const res = await window.api.classifyGlossaryTerms(mineTerms, state.fastModel);
    if (!res || res.error) {
      showGlossaryHint(`Не удалось разложить по категориям: ${(res && res.error) || "нет ответа"}`);
      return;
    }
    const incoming = res.categories || {};
    const mineLower = new Set(mineTerms.map((t) => t.toLowerCase()));
    const categories = Object.assign({}, state.glossaryCategories || {});
    let assigned = 0;
    Object.keys(incoming).forEach((low) => {
      // Defensive re-check on top of the backend's own gate — only accept terms
      // that are actually in THIS batch and a category from the fixed set.
      if (!mineLower.has(low)) return;
      const cat = GLOSSARY_CATEGORIES.includes(incoming[low]) ? incoming[low] : GLOSSARY_CATEGORY_OTHER;
      categories[low] = cat;
      assigned++;
    });
    state.glossaryCategories = categories;
    renderGlossaryChips();
    persistPresets();
    showGlossaryHint(assigned ? `Разложено терминов: ${assigned}` : "LLM не вернул категорий для этих терминов");
  } finally {
    btn.disabled = false;
  }
}
$("glossaryClassifyBtn").addEventListener("click", classifyGlossaryTerms);

// ── glossary: "Предложения" inbox (auto-suggested terms from processing) ────
// The backend's "suggest" pipeline stage extracts candidate terms from the final
// transcript; on each process-complete they land here for the user to accept
// (→ glossary chips) or dismiss (→ glossaryDismissed, never re-suggested).
// Pending list is capped at 100 so a long run of processing can't grow it forever —
// the newest arrivals survive and the oldest pending entries are evicted first.
const GLOSSARY_SUGGEST_CAP = 100;

function mergeGlossarySuggestions(newTerms) {
  if (!Array.isArray(newTerms) || !newTerms.length) return;
  const haveGlossary = new Set(parseGlossaryTerms(state.glossary).map((t) => t.toLowerCase()));
  const dismissed = new Set((state.glossaryDismissed || []).map((t) => t.toLowerCase()));
  const pending = state.glossarySuggestions || [];
  const havePending = new Set(pending.map((t) => t.toLowerCase()));
  const merged = pending.slice();
  newTerms.forEach((raw) => {
    const term = (raw || "").trim();
    if (!term) return;
    const low = term.toLowerCase();
    if (haveGlossary.has(low) || dismissed.has(low) || havePending.has(low)) return;
    havePending.add(low);
    merged.push(term);
  });
  state.glossarySuggestions = merged.slice(-GLOSSARY_SUGGEST_CAP);
  renderGlossarySuggestions();
  persistPresets();
}

function renderGlossarySuggestions() {
  const section = $("glossarySuggestSection");
  const box = $("glossarySuggestChips");
  if (!section || !box) return;
  const terms = state.glossarySuggestions || [];
  section.classList.toggle("hidden", terms.length === 0);
  box.innerHTML = terms.map((t) =>
    `<span class="chip"><span class="chip-text">${escapeHtml(t)}</span>` +
    `<button type="button" class="chip-accept" aria-label="Принять">✚</button>` +
    `<button type="button" class="chip-dismiss chip-remove" aria-label="Отклонить">✕</button></span>`
  ).join("");
  // Term captured via closure (index into `terms`, same order that produced this
  // innerHTML) — same rationale as renderGlossaryChips: a quote in the term must
  // never round-trip through an HTML attribute.
  box.querySelectorAll(".chip-accept").forEach((btn, i) =>
    btn.addEventListener("click", () => acceptGlossarySuggestion(terms[i])));
  box.querySelectorAll(".chip-dismiss").forEach((btn, i) =>
    btn.addEventListener("click", () => dismissGlossarySuggestion(terms[i])));
  $("glossarySuggestCount").textContent = terms.length + " предложений";
  $("glossaryAcceptAll").classList.toggle("hidden", terms.length < 2);
}

function acceptGlossarySuggestion(term) {
  state.glossarySuggestions = (state.glossarySuggestions || []).filter((t) => t !== term);
  const terms = parseGlossaryTerms(state.glossary);
  if (terms.some((t) => t.toLowerCase() === term.toLowerCase())) {
    persistPresets(); // already in the glossary somehow — just drop it from pending
  } else {
    setGlossaryTerms(terms.concat(term)); // persists + re-renders chips
  }
  renderGlossarySuggestions();
}

function dismissGlossarySuggestion(term) {
  state.glossarySuggestions = (state.glossarySuggestions || []).filter((t) => t !== term);
  const dismissed = state.glossaryDismissed || [];
  if (!dismissed.some((t) => t.toLowerCase() === term.toLowerCase())) {
    state.glossaryDismissed = dismissed.concat(term);
  }
  renderGlossarySuggestions();
  persistPresets();
}

function acceptAllGlossarySuggestions() {
  const terms = parseGlossaryTerms(state.glossary);
  const have = new Set(terms.map((t) => t.toLowerCase()));
  const toAdd = (state.glossarySuggestions || []).filter((t) => !have.has(t.toLowerCase()));
  state.glossarySuggestions = [];
  if (toAdd.length) setGlossaryTerms(terms.concat(toAdd));
  else persistPresets();
  renderGlossarySuggestions();
}

$("glossaryAcceptAll").addEventListener("click", acceptAllGlossarySuggestions);

// ── glossary: cumulative usage counts (badges + initial_prompt ordering) ────
// `delta` is THIS run's {termLower: count} from the done event (see backend.py's
// glossary_usage field) — merged additively into the cumulative store so a chip's
// "12×" badge (see usageBadge) reflects fires across every run, not just the last.
function mergeGlossaryUsage(delta) {
  if (!delta || typeof delta !== "object") return;
  const keys = Object.keys(delta);
  if (!keys.length) return;
  const usage = Object.assign({}, state.glossaryUsage || {});
  keys.forEach((k) => { usage[k] = (usage[k] || 0) + (delta[k] || 0); });
  state.glossaryUsage = usage;
  renderGlossaryChips();
  persistPresets();
}

function updateTokenWarn() {
  const warn = $("tokenWarn");
  if (!warn) return;
  warn.style.display = state.hfToken && !state.secretEncrypted ? "" : "none";
}

// ── output dir ───────────────────────────────────────────────────────────────
$("pickOut").addEventListener("click", async () => {
  const dir = await window.api.pickOutDir();
  if (dir) { state.outDir = dir; state.outDirCustom = true; $("outDir").value = dir; persistPresets(); }
});

// ── import file(s) — sequential queue ───────────────────────────────────────
// A single pick or a reprocessHistory() call is a queue of length 1 — same
// code path as an N-file batch, so progress/result/retry logic isn't
// duplicated for "single" vs "batch".
const QUEUE_STATUS_ICON = { queued: "⏳", pending: "⏳", running: "🔵", done: "🟢", failed: "🔴", canceled: "⏹" };

// Set only while a single failed row is being retried via its own ↻ (retryQueueItem),
// as opposed to a batch run advancing position-by-position through startQueueRun/
// advanceQueue. advanceQueue reads this to record the retried row's outcome in place
// without cascading into later rows that already carry their own terminal status.
let queueSingleRetry = false;

// Replaces the queue wholesale (repeated pick = replace, not append — simplest
// mental model, matches today's single-pick "last pick wins" behavior).
function setImportQueue(paths) {
  state.importQueue = paths.map((p) => ({ path: p, name: p.split("/").pop(), status: "queued" }));
  state.queueIndex = -1;
  state.hasRun = false; // new source → hide retry/fresh until processed
  queueSingleRetry = false;
  renderImportQueue();
  refreshRunBtn();
}

function renderImportQueue() {
  const wrap = $("importQueue");
  wrap.innerHTML = "";
  if (!state.importQueue.length) { wrap.classList.add("hidden"); return; }
  wrap.classList.remove("hidden");
  state.importQueue.forEach((item, idx) => {
    const icon = QUEUE_STATUS_ICON[item.status] || "⏳";
    const row = document.createElement("div");
    row.className = "queue-item queue-" + item.status;
    row.innerHTML =
      `<span class="queue-icon">${icon}</span><span class="queue-name">${escapeHtml(item.name)}</span>`;
    if (item.status === "failed") {
      // Per-failed-row retry, mirrors the models-list per-row retry precedent (pf-retry,
      // above in this file). Closure over idx only — never the item's path/name — so no
      // user/LLM string ever lands in an HTML attribute.
      const btn = document.createElement("button");
      btn.className = "btn small queue-retry-btn";
      btn.textContent = "↻";
      btn.title = "Повторить";
      btn.addEventListener("click", () => retryQueueItem(idx));
      row.appendChild(btn);
    }
    wrap.appendChild(row);
  });
}

// ── pending recordings (persistent queue, survives an app restart) ──────────
// The single source of truth for recordings: every finished recording lands here
// (see the "recorded" handler below) and waits until a per-row ▶ or "Обработать все"
// processes it. There is no separate single-slot record flow.
let activePendingId = null;   // id of the pending recording the in-flight run belongs to, if any
let pendingBatchRunning = false; // true while "Обработать все" is driving the queue

// Builds one pending-recording row (icon + name + time + status badge + ▶/✕) for the
// История rail — the single render path for a pending recording (owner decision: no
// separate control strip, rendered inline at its real chronological position among
// notes/orphans — see buildRecordings/renderRail below). idx is the item's current
// position in state.pendingRecordings. ▶/✕ semantics are untouched by the audio-first
// rail redesign (item 3 — ✕ here is remove-pending-recording, not the trash feature).
function buildPendingRow(item, idx) {
  const icon = QUEUE_STATUS_ICON[item.status] || "⏳";
  const row = document.createElement("div");
  row.className = "rail-item pending queue-item queue-" + item.status;
  const time = formatStampTime(item.stamp || item.id);
  // "ждёт обработки" is only accurate for the true waiting state — running/failed
  // already have their own status icon (QUEUE_STATUS_ICON) and aren't given invented
  // badge text here.
  const badge = item.status === "pending" ? recordingBadge("pending") : "";
  row.innerHTML =
    `<span class="queue-icon">${icon}</span><span class="queue-name">${escapeHtml(item.name)}</span>` +
    (time || badge ? `<span class="rail-pending-meta">${escapeHtml(time)}${badge}</span>` : "");
  const canProcess = item.status === "pending" || item.status === "failed";
  // First trailing button gets queue-retry-btn's margin-left:auto (pushes this
  // row's action button(s) to the right, same as renderImportQueue's ↻).
  if (canProcess) {
    // Closure over idx only (never the item's name/paths) — same rationale as
    // renderImportQueue's retry button: no user/LLM string in an HTML attribute.
    // T1 redesign: labeled to match the explicit-actions style used elsewhere in the
    // rail now (rail-action-btn sizing only — behaviour/handler untouched).
    const playBtn = document.createElement("button");
    playBtn.className = "btn small rail-action-btn pending-play-btn queue-retry-btn";
    playBtn.textContent = "▶ Обработать";
    playBtn.title = "Обработать";
    playBtn.addEventListener("click", () => processPendingRecording(idx));
    row.appendChild(playBtn);
  }
  const delBtn = document.createElement("button");
  delBtn.className = "btn small ghost pending-del-btn" + (canProcess ? "" : " queue-retry-btn");
  delBtn.textContent = "✕";
  delBtn.title = "Удалить";
  delBtn.addEventListener("click", () => deletePendingRecording(idx));
  row.appendChild(delBtn);
  return row;
}

function nextPendingWork() {
  return (state.pendingRecordings || []).find((it) => it.status === "pending" || it.status === "failed");
}

function runPendingItem(item) {
  item.status = "running";
  renderRail();
  startProcessing(false, item);
}

// Per-row ▶ — gated the same way as retryQueueItem so it can't hijack an active run.
function processPendingRecording(idx) {
  if (state.recording || state.processing) return;
  const item = state.pendingRecordings[idx];
  if (!item || item.status === "running") return;
  runPendingItem(item);
}

// Запись-tab quick action (index.html #processLatestBtn, below the record controls)
// — always targets the LATEST finished recording: the last-appended entry in
// state.pendingRecordings (upsertById above only appends a new id at the end, never
// reorders on update), i.e. whichever recording just finished. Distinct from the
// История rail's per-row ▶ (explicit pick) and "Обработать все" (whole-queue drain);
// "latest" is defined once here and reused by both the click handler and the
// button's enable/disable check below.
function latestPendingRecording() {
  const list = state.pendingRecordings || [];
  return list.length ? list[list.length - 1] : null;
}

// Gated identically to processPendingRecording — can't hijack an active recording or
// an already-running process — then reuses the exact same runPendingItem() path
// (no parallel processing flow).
function processLatestRecording() {
  if (state.recording || state.processing) return;
  const item = latestPendingRecording();
  if (!item || item.status === "running") return;
  runPendingItem(item);
}

// True from the moment a recording is stopped until ITS "recorded" (mix landed)
// or "error" (mix failed) event arrives — the "⏳ Свожу дорожки…" window. Without
// this, latestPendingRecording() during that window would still return whatever
// OLDER item was already pending (the new one hasn't landed yet), so the button
// would enable and target the WRONG recording — exactly the "processed the wrong
// audio" failure mode this button exists to avoid. Set in toggleRecording's stop
// branch; cleared in onRecordEvent's "recorded" branch (the fail-safe: also
// cleared on "error", so a mix that never lands can't wedge the button disabled
// forever).
let awaitingRecorded = false;

// Single source of truth for #processLatestBtn's enabled state — mirrors
// refreshRunBtn() for the import-mode row. Called from refreshRunBtn() (covers
// state.recording transitions: toggleRecording start+stop, the "recorded"-event
// error branch, markRunFailed, finishProcessing), from setProcessingUI() (covers
// BOTH state.processing transitions — start and end), and from renderRail()
// (covers every state.pendingRecordings transition: a new "recorded" event, a
// per-row delete, a run finishing/failing, the restart-time initial load) — never
// toggled ad hoc at an individual call site.
function refreshProcessLatestBtn() {
  const item = latestPendingRecording();
  const canRun = !state.recording && !state.processing && !awaitingRecorded &&
    !!item && item.status !== "running";
  $("processLatestBtn").disabled = !canRun;
}
$("processLatestBtn").addEventListener("click", processLatestRecording);

// "Удалить" — removes the manifest entry + its on-disk session dir. Never deletes
// the row that's currently being processed (its outcome must land first).
function deletePendingRecording(idx) {
  const item = state.pendingRecordings[idx];
  if (!item || item.status === "running") return;
  state.pendingRecordings.splice(idx, 1);
  renderRail();
  // L7 arch-audit: main.js now reports honestly when the on-disk session dir
  // failed to actually delete (used to always look like a clean success) —
  // the row still stays removed from the queue (see main.js's own comment on
  // why), but the user learns their files may still be on disk.
  window.api.removePendingRecording(item.id).then((res) => {
    if (res && res.ok === false) alert(res.error);
  });
}

// "Обработать все" — processes pending/failed rows one at a time through the single
// procProc slot, mirroring startQueueRun/advanceQueue: a failed item continues the
// batch, a success removes it (see finishPendingItem below).
function startPendingBatch() {
  if (state.recording || state.processing) return;
  pendingBatchRunning = true;
  continuePendingBatch();
}
function continuePendingBatch() {
  if (!pendingBatchRunning) return;
  const item = nextPendingWork();
  if (!item) { pendingBatchRunning = false; return; }
  runPendingItem(item);
}
$("pendingProcessAll").addEventListener("click", startPendingBatch);

// Called from onProcessEvent's terminal branches when a run belonged to a pending
// recording (activePendingId set). Returns true iff it did, so the caller knows
// whether to continue a running batch.
function finishPendingItem(outcome) {
  if (activePendingId == null) return false;
  const id = activePendingId;
  activePendingId = null;
  const idx = (state.pendingRecordings || []).findIndex((it) => it.id === id);
  if (idx < 0) return false;
  if (outcome === "done") {
    state.pendingRecordings.splice(idx, 1);
    window.api.removePendingRecording(id);
  } else {
    state.pendingRecordings[idx].status = "failed";
  }
  renderRail();
  return true;
}

// true while a run in progress/last-acted belongs to the import queue (vs. record mode).
function queueActive() {
  return state.mode === "import" && state.queueIndex >= 0 && state.queueIndex < state.importQueue.length;
}

// Entry point wired to runBtn/retryBtn/freshBtn when mode==='import'. Starts
// the item at queueIndex (or the first item, on a fresh queue). override is forwarded
// to startProcessing unchanged — only reprocessHistory() (via the История picker)
// ever passes one; runBtn/retryBtn/freshBtn always call this with fresh only.
function startQueueRun(fresh, override) {
  if (!state.importQueue.length) return;
  if (state.queueIndex < 0 || state.queueIndex >= state.importQueue.length) state.queueIndex = 0;
  const item = state.importQueue[state.queueIndex];
  if (item) item.status = "running";
  queueSingleRetry = false; // whole-queue entry point, not a single-row retry
  renderImportQueue();
  startProcessing(fresh, undefined, override);
}

// Called from onProcessEvent's terminal branches (done / error / non-canceled
// process-closed) when the just-finished run belongs to the import queue.
// Marks the current item, then auto-advances to the next queued item — a
// per-item failure logs and continues (mirrors the download-models precedent),
// it does not abort the batch.
function advanceQueue(itemStatus) {
  if (!queueActive()) return;
  const item = state.importQueue[state.queueIndex];
  if (item) item.status = itemStatus;
  if (queueSingleRetry) {
    // A single failed-row retry, not a batch run — record the outcome and stop;
    // later rows already carry their own terminal status and must not be
    // silently reprocessed as a side effect of retrying an earlier one.
    queueSingleRetry = false;
    renderImportQueue();
    return;
  }
  const next = state.queueIndex + 1;
  if (next < state.importQueue.length) {
    state.queueIndex = next;
    const nextItem = state.importQueue[state.queueIndex];
    if (nextItem) nextItem.status = "running";
    renderImportQueue();
    startProcessing(false);
  } else {
    renderImportQueue();
  }
}

// Cancel (stopBtn) halts the whole batch — the current item stops, the
// remainder is left unprocessed with its status visible, no auto-advance.
function markQueueItemCanceled() {
  if (!queueActive()) return;
  const item = state.importQueue[state.queueIndex];
  if (item) item.status = "canceled";
  renderImportQueue();
}

// Per-row retry for one failed batch element (see renderImportQueue's ↻ button) —
// reuses the exact single-slot startProcessing() path with fresh=false (resume
// from cache, same ↻ semantics as retryBtn/freshBtn elsewhere), and is gated the
// same way as every other run trigger so it can't clobber a run already underway.
function retryQueueItem(idx) {
  if (state.recording || state.processing) return; // don't hijack an active run
  const item = state.importQueue[idx];
  if (!item || item.status !== "failed") return;
  state.queueIndex = idx;
  item.status = "running";
  queueSingleRetry = true;
  renderImportQueue();
  startProcessing(false);
}

$("pickBtn").addEventListener("click", async () => {
  const files = await window.api.pickAudio();
  if (files && files.length) {
    setImportQueue(files);
    $("pickedFile").textContent = files.length === 1
      ? files[0].split("/").pop()
      : `Выбрано файлов: ${files.length}`;
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

// Sidebar rec-status block — the only DOM region visible across all tabs
// (switchView() only hides #view-*, not the sibling <aside id="sidebar">), so
// this is where a recording stays visible even while the user is on
// История/PARA/Словарь.
function setRecIndicator(on) {
  $("recIndicator").classList.toggle("hidden", !on);
}

// Named (not an inline click-handler lambda) so the tray "Начать/Остановить запись"
// menu item can invoke the exact same flow — no duplicated recording logic in main.js.
async function toggleRecording() {
  if (!state.recording) {
    // Recording during processing is allowed (owner-approved — reverts commit
    // 0a79d98's gate): finished recordings now pile up in the persistent pending
    // queue instead of being lost, so there's no reason to block a new one while an
    // older one processes. The hardware mutex in main.js's start-recording handler
    // (`if (recordProc || tee) return`) still blocks two SIMULTANEOUS recordings.
    const micDevice = $("micDevice").value;
    setSysStatus("🔊 Системный звук: запуск…", "");
    const res = await window.api.startRecording({ micDevice });
    if (!res.ok) { alert(res.error); return; }
    state.recording = true;
    window.api.notifyRecordingState(true); // syncs the tray menu label + REC title
    setRecIndicator(true);
    document.querySelectorAll(".timer").forEach((el) => el.textContent = "00:00"); // #timer + sidebar #sidebarTimer
    $("vuMic").style.width = "0%";
    $("vuSys").style.width = "0%";
    $("recBtn").textContent = "■ Остановить";
    $("recBtn").classList.add("recording");
    $("timer").classList.add("live");
    refreshRunBtn();
  } else {
    state.recording = false;
    window.api.notifyRecordingState(false);
    setRecIndicator(false);
    $("recBtn").textContent = "● Начать запись";
    $("recBtn").classList.remove("recording");
    $("timer").classList.remove("live");
    $("vuMic").style.width = "0%";
    $("vuSys").style.width = "0%";
    setSysStatus("⏳ Свожу дорожки…", "");
    awaitingRecorded = true; // block #processLatestBtn until THIS recording's mix lands (see declaration)
    refreshRunBtn(); // state.recording just flipped false — #processLatestBtn must re-evaluate
    await window.api.stopRecording();
  }
}
$("recBtn").addEventListener("click", toggleRecording);
window.api.onTrayRecordToggle(toggleRecording);

function fmtTime(s) {
  const m = Math.floor(s / 60);
  return String(m).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
}

// Replace-or-append by `.id`: mirrors main.js's lib/mainutil upsertById (renderer.js
// is window.eval'd in a require()-less browser context, no shared import across the
// main/renderer boundary — see that copy's comment). Guards state.pendingRecordings
// against a duplicate id if a "recorded" IPC event were ever delivered twice for the
// same recording. Pure — returns a new array, list/entry untouched.
function upsertById(list, entry) {
  const idx = list.findIndex((it) => it.id === entry.id);
  if (idx < 0) return [...list, entry];
  const next = list.slice();
  next[idx] = entry;
  return next;
}

window.api.onRecordEvent((ev) => {
  if (ev.event === "level") {
    // direct write (not rAF): the recorder window is backgrounded during a call,
    // where requestAnimationFrame throttles to ~1Hz/pauses and would freeze the meter.
    // ~15 writes/sec is negligible.
    const bar = ev.source === "mic" ? $("vuMic") : $("vuSys");
    if (bar) bar.style.width = Math.round(ev.level * 100) + "%";
  } else if (ev.event === "elapsed") {
    document.querySelectorAll(".timer").forEach((el) => el.textContent = fmtTime(ev.seconds)); // #timer + sidebar #sidebarTimer
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
    // A finished recording ONLY joins the persistent pending queue — there is no
    // single-slot fallback anymore. This handler must never touch state.processing,
    // stopBtn/spinner, or any other run's log/result area: a recording finishing
    // (possibly a SECOND one, started while an earlier recording is still being
    // processed — recording-during-processing is allowed) must never disturb an
    // unrelated in-flight run. Removed per critic finding: the old dual-path
    // (single-slot recordedFile/recordedId reconciled via activePendingId) let this
    // handler's unconditional setProcessingUI(false) tear down a live run's UI and,
    // worse, let a subsequent re-click reassign activePendingId to the WRONG
    // recording, causing finishPendingItem to delete an unprocessed recording while
    // the actually-finished one lingered pending forever.
    if (ev.id) {
      // Upsert-by-id, not blind push: a duplicate "recorded" event for the same id
      // (e.g. a race on the main-process side) must replace the existing row, never
      // add a second one.
      state.pendingRecordings = upsertById(state.pendingRecordings, {
        id: ev.id, name: ev.name || `Запись ${ev.id}`,
        mixed: ev.file, mic: ev.mic, system: ev.system, tracks: ev.tracks,
        status: "pending",
      });
      awaitingRecorded = false; // this recording landed — #processLatestBtn may target it now
      renderRail();
    }
    const parts = [];
    if (ev.mic) parts.push("микрофон");
    if (ev.system) parts.push("системный звук");
    setSysStatus(`✅ Запись готова (${parts.join(" + ") || "—"})`, "ok");
  } else if (ev.event === "error") {
    setSysStatus("❌ Ошибка записи: " + ev.msg, "warn");
    state.recording = false;
    window.api.notifyRecordingState(false);
    setRecIndicator(false);
    $("recBtn").textContent = "● Начать запись";
    $("recBtn").classList.remove("recording");
    $("timer").classList.remove("live");
    // Fail-safe: this "error" is the mix backend's failure path (main.js's
    // runBackend error branch on the post-stop mix, never a mid-recording event) —
    // a mix that never lands as "recorded" must not wedge #processLatestBtn
    // disabled forever.
    awaitingRecorded = false;
    refreshRunBtn();
  }
});

// ── current audio source resolution ─────────────────────────────────────────
// Record mode has no single-slot "current recording" — every finished recording is
// a row in state.pendingRecordings, processed explicitly via its own ▶ / "Обработать
// все" (see startProcessing's `item` param). The shared runBtn/retryBtn/freshBtn row
// below stays exclusively an import-mode affordance; it simply has nothing to act on
// while on the record tab.
function currentAudio() {
  if (state.mode === "record") return null;
  const idx = state.queueIndex >= 0 ? state.queueIndex : 0;
  const item = state.importQueue[idx];
  return item ? item.path : null;
}
function refreshRunBtn() {
  $("runBtn").disabled = !currentAudio() || state.recording;
  refreshProcessLatestBtn();
}

// ── run processing ───────────────────────────────────────────────────────────
const STAGE_LABELS = {
  convert: "Аудио", transcribe: "Транскрипция", correct: "Коррекция терминов",
  diarize: "Спикеры", llm: "Сводка", suggest: "Предложения словаря", meta: "Метаданные", save: "Сохранение",
};
const STAGE_KEYS = Object.keys(STAGE_LABELS);

let lastStage = null;
let runEnded = false;             // guard so a clean end isn't overwritten by trailing process-closed
let selectedStage = STAGE_KEYS[0]; // which stage's logs the pane currently shows
let logsByStage = {};

// Set for the entire duration of a История-initiated reprocess run (see
// reprocessHistory) so the render helpers below target the in-place История progress
// panel (#histStages/#histLogs) instead of the Запись tab's #progressCard/#stages/
// #logs — mirrors how activePendingId/queueSingleRetry track "what kind of run is
// this" for their own terminal-handling branches. Reset in finishProcessing once the
// run ends, so a later record-tab/import-tab run always falls back to the default ids.
let reprocessTargetsHistory = false;

// Single source of truth for "where do live pipeline events render" — every render
// helper below resolves its target through this one point so a История-initiated run
// and a normal Запись-tab run never write into each other's DOM.
function progressTargetIds() {
  return reprocessTargetsHistory
    ? { stagesId: "histStages", logsId: "histLogs", stagePrefix: "histStage-" }
    : { stagesId: "stages", logsId: "logs", stagePrefix: "stage-" };
}

function buildStages() {
  const { stagesId, stagePrefix } = progressTargetIds();
  const wrap = $(stagesId);
  wrap.innerHTML = "";
  logsByStage = {};
  STAGE_KEYS.forEach((k) => {
    logsByStage[k] = [];
    const el = document.createElement("span");
    el.className = "stage";
    el.id = stagePrefix + k;
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
  const { stagesId, logsId } = progressTargetIds();
  // Scoped to the active container only — a leftover run's stage pills in the OTHER
  // container (e.g. a previous Запись-tab run's #stages, still in the DOM but hidden)
  // must not have their "selected" class toggled by a История run's clicks, or vice versa.
  $(stagesId).querySelectorAll(".stage").forEach((el) =>
    el.classList.toggle("selected", el.dataset.stage === stageKey));
  const el = $(logsId);
  el.textContent = (logsByStage[stageKey] || []).join("\n");
  el.scrollTop = el.scrollHeight;
}

function pushLog(stageKey, msg) {
  // route stray/untagged logs into the running stage (or the first one) — no orphan bucket
  if (!stageKey || !(stageKey in logsByStage)) stageKey = lastStage || STAGE_KEYS[0];
  if (!logsByStage[stageKey]) logsByStage[stageKey] = [];
  logsByStage[stageKey].push(msg);
  if (selectedStage === stageKey) {
    const { logsId } = progressTargetIds();
    const el = $(logsId);
    el.textContent += msg + "\n";
    el.scrollTop = el.scrollHeight;
  }
}
// logger for non-pipeline messages (IPC errors, backend stderr) → current/active stage
function appendLog(msg) { pushLog(lastStage, msg); }

function setStageClass(stageKey, cls) {
  const { stagePrefix } = progressTargetIds();
  const el = $(stagePrefix + stageKey);
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
  refreshProcessLatestBtn(); // reflect state.processing on #processLatestBtn on BOTH transitions —
  // refreshRunBtn() only re-checks on the end transition (via finishProcessing), never on start.
  document.body.classList.toggle("processing", running); // CSS disables history reprocess
  $("runBtn").style.display = running ? "none" : "";
  $("stopBtn").style.display = running ? "" : "none";
  $("procSpinner").style.display = running ? "" : "none";
  // recBtn is intentionally never disabled here (owner-approved gate revert, see
  // toggleRecording) — it must only ever reflect whether a recording is actually in
  // progress (its own label/class), never the processing state.
  const showRetry = !running && !!currentAudio() && state.hasRun;
  $("retryBtn").style.display = showRetry ? "" : "none";
  $("freshBtn").style.display = showRetry ? "" : "none";
}
function finishProcessing() {
  $("stopBtn").disabled = false;
  setProcessingUI(false);
  refreshRunBtn();
  reprocessTargetsHistory = false; // run over — next run defaults back to the Запись ids
}

// fresh=true clears the cache (full recompute); otherwise resume from cached stages.
// item: an explicit entry from state.pendingRecordings (per-row ▶ / "Обработать все")
// — the ONLY way record-mode audio gets processed (there is no single-slot fallback;
// import mode leaves item undefined and drives audioFile from currentAudio() as before).
// override: { prompt, template } — set only by the История reprocess picker to force
// a specific preset regardless of state.currentPreset; every other caller omits it and
// falls back to the currently selected preset (record-mode and import-mode default
// flow, unchanged).
async function startProcessing(fresh, item, override) {
  const audioFile = item ? item.mixed : currentAudio();
  if (!audioFile) return;
  $("progressCard").style.display = "";
  $("resultCard").style.display = "none";
  buildStages();
  lastStage = null;
  runEnded = false;
  pinned = false;
  showStageLogs(STAGE_KEYS[0], false);
  if (!item) state.hasRun = true; // hasRun/retry/fresh stay an import-mode-only concept
  setProcessingUI(true);
  // activePendingId is set ONLY by an explicit item — never inferred from "whatever
  // recording finished most recently" (that inference was the dual-path bug: a second
  // recording finishing mid-run could silently reassign it to the wrong id).
  activePendingId = item ? item.id : null;

  const activePreset = state.presets[state.currentPreset] || {};
  const res = await window.api.processAudio({
    audioFile,
    prompt: override ? override.prompt : (activePreset.prompt || ""),
    diarize: $("diarize").checked,
    outDir: state.outDir,
    engine: "mlx",
    hfToken: state.hfToken,
    fresh: !!fresh,
    language: state.language,
    glossary: state.glossary,
    glossaryUsage: state.glossaryUsage,
    fastModel: state.fastModel,
    mainModel: state.mainModel,
    summarize: !$("noSummary").checked,
    template: override ? override.template : (activePreset.name || ""),
    // Note versioning by template on reprocess — set ONLY by the История reprocess
    // picker's override (see reprocessHistory/nextVersionFor); every other caller
    // (record/import first run, retryBtn/freshBtn) omits it, so backend.py's default
    // (None) preserves today's overwrite-by-cached-stamp behaviour exactly.
    ...(override && override.version ? { version: override.version } : {}),
    // auto-«Я»: only meaningful for a record-sourced mic/system pair — import mode
    // never passes an item, so these stay undefined and the backend sees identical
    // argv to today.
    ...(item ? { micFile: item.mic, systemFile: item.system, authorName: state.authorName }
             // note-origin typing for a plain import: a picked batch (N>1 files queued)
             // vs a single picked file — the backend only reads this when there's no
             // mic/system track (a pending recording always wins as "recording").
             : { origin: state.importQueue.length > 1 ? "batch" : "file" }),
  });
  if (res && res.ok === false) {
    appendLog("❌ " + res.error);
    finishProcessing();
  }
}

// import mode runs through the queue (queue-of-1 for a plain single pick);
// record mode has no queue and starts directly, unchanged.
$("runBtn").addEventListener("click", () => {
  if (state.mode === "import") startQueueRun(false); else startProcessing(false);
});
$("retryBtn").addEventListener("click", () => {
  if (state.mode === "import") startQueueRun(false); else startProcessing(false);
});
$("freshBtn").addEventListener("click", () => {
  if (state.mode === "import") startQueueRun(true); else startProcessing(true);
});
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
    if (cached) $(progressTargetIds().stagePrefix + ev.stage)?.classList.add("cached");
    if (ev.msg) {
      const icon = cached ? "💾 " : ev.status === "ok" ? "✅ " : ev.status === "skip" ? "⏭ " : "⚠️ ";
      pushLog(ev.stage, icon + ev.msg);
    }
  } else if (ev.event === "log") {
    pushLog(ev.stage, ev.msg);
  } else if (ev.event === "done") {
    showResult(ev);
    mergeGlossarySuggestions(ev.suggestions);
    mergeGlossaryUsage(ev.glossary_usage);
    runEnded = true;
    finishProcessing();
    refreshHistory();
    advanceQueue("done");
    if (finishPendingItem("done") && pendingBatchRunning) continuePendingBatch();
  } else if (ev.event === "error") {
    appendLog("❌ " + ev.msg);
    markRunFailed();
    finishProcessing();
    advanceQueue("failed");
    if (finishPendingItem("failed") && pendingBatchRunning) continuePendingBatch();
  } else if (ev.event === "process-closed") {
    let failedAdvance = false;
    if (ev.canceled) {
      appendLog("⏹ Остановлено — прогресс сохранён, нажми «↻ Повторить» чтобы продолжить");
      if (lastStage) setStageClass(lastStage, "skip");
      runEnded = true;
      markQueueItemCanceled(); // cancel halts the whole batch — no auto-advance
      finishPendingItem("failed"); // no pending status for "canceled" — mark failed, retry via ▶
      pendingBatchRunning = false; // cancel halts a running batch too, same as the import queue
    } else if (ev.code !== 0 && !runEnded) {
      if (ev.stderr) appendLog("[backend] " + ev.stderr.slice(-600));
      appendLog("❌ Обработка прервана (код " + ev.code + ")");
      markRunFailed();
      failedAdvance = true;
    } else if (ev.code !== 0 && ev.stderr) {
      appendLog("[backend] " + ev.stderr.slice(-600));
    }
    finishProcessing();
    if (failedAdvance) {
      advanceQueue("failed");
      if (finishPendingItem("failed") && pendingBatchRunning) continuePendingBatch();
    }
  }
});

// ── top-level view switching ─────────────────────────────────────────────────
// Per-view slim content-header title; the "локально · MLX Whisper · pyannote ·
// LM Studio" subtitle (#contentTag) only makes sense on Запись — every other
// view hides it.
const VIEW_TITLES = { record: "Запись", history: "История", para: "PARA", glossary: "Словарь", prompts: "Промпты", trash: "Корзина" };
function switchView(v) {
  document.querySelectorAll(".topbtn").forEach((b) => b.classList.toggle("active", b.dataset.view === v));
  ["record", "history", "para", "glossary", "prompts", "trash"].forEach((id) => $("view-" + id).classList.toggle("hidden", id !== v));
  $("contentTitle").textContent = VIEW_TITLES[v] || "";
  $("contentTag").classList.toggle("hidden", v !== "record");
  if (v === "history") refreshHistory();
  if (v === "para") renderPara();
  if (v === "trash") refreshTrash();
}
document.querySelectorAll(".topbtn").forEach((b) => b.addEventListener("click", () => switchView(b.dataset.view)));
$("historyRefresh").addEventListener("click", refreshHistory);

// ── history (rail + note viewer) ─────────────────────────────────────────────
let historyItems = [];
// Out-dir audio inventory (feat-history-audio-inventory's cmd_history addition):
// {base_stamp, path, size, mtime, duration_s}[] — every audio file physically
// present, including ones with zero surviving notes ("без обработок"). Read off
// historyItems.audios (an extra property main.js's list-history mapping attaches to
// the returned array — see its comment) rather than a second IPC round-trip; []
// whenever a fixture/test simply didn't populate it (that property is optional by
// construction, not a backend-staleness fallback).
let historyAudios = [];
// idx (into historyItems) of the note currently shown in #noteView, or null — renderRail()
// rebuilds the whole rail from scratch on every call (filters, refresh, auto-open included),
// which would otherwise silently drop the .active highlight on every re-render even though
// the same note stays open; re-applied at the end of renderRail() via applyActiveHighlight().
let openNoteIdx = null;
async function refreshHistory() {
  historyItems = await window.api.listHistory(state.outDir);
  historyAudios = historyItems.audios || [];
  populateTemplateFilter();
  renderRail();
  updateNoteViewDefault();
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

// ── search: minimal Russian suffix-stripping ("poor man's stemmer") ────────────
// Not a full morphological analyzer — strips one common inflectional ending
// (longest match first) so e.g. "проблема" and "проблемы" collapse to the same
// stem. Fixes the reported class of miss (query is a different case-ending of a
// word that appears in the title) without pulling in a stemmer dependency.
const RU_STEM_SUFFIXES = [
  "ами", "ями",                                                   // instrumental plural
  "ов", "ев", "ей", "ах", "ях", "ой", "ий", "ым", "ия",            // 2-letter endings
  "а", "я", "ы", "и", "е", "о", "у", "ю",                          // 1-letter endings
];
function ruStem(word) {
  if (word.length <= 3) return word; // too short to safely strip (acronyms, short tokens)
  for (const suf of RU_STEM_SUFFIXES) {
    if (word.length > suf.length + 2 && word.endsWith(suf)) return word.slice(0, -suf.length);
  }
  return word;
}
// true if any word in `haystack` shares a stem with `query`, or a word's stem starts
// with the query's stem (keeps matching while the user is still typing).
function textMatchesQuery(haystack, query) {
  if (!query) return true;
  const qStem = ruStem(query.toLowerCase());
  const words = (haystack || "").toLowerCase().split(/[^a-zа-яё0-9]+/i).filter(Boolean);
  return words.some((w) => {
    const wStem = ruStem(w);
    return wStem === qStem || wStem.startsWith(qStem);
  });
}

// Date-group divider text (item: История groups by day so the calendar isn't needed).
// ru-RU's "day + long month" CLDR pattern is genitive by design ("8 июля", not "8 июль") —
// no manual month-name table needed.
const RAIL_GROUP_DATE_FMT = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long" });
function formatGroupDate(isoDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) return isoDate; // defensive: an unparseable stamp still gets a header, just as-is
  const [, y, mo, d] = m;
  return RAIL_GROUP_DATE_FMT.format(new Date(+y, +mo - 1, +d)); // local Y/M/D ctor — no UTC shift
}

// ── note versioning by template on reprocess (История "Переобработать") ──────────
// Canonical recording identity for a note row: the backend-provided base_stamp
// (feat-history-audio-inventory's cmd_history addition — every note row is tagged
// with it, main.js passes it straight through — see list-history's mapping) pairs a
// note with the out_dir audio inventory and collapses every language variant/
// reprocess version of one recording to the same key. Named accessor (rather than
// reading `.base_stamp` inline at every call site) so the one field this whole
// feature keys off of has a single, greppable name.
function recordingBaseStamp(it) {
  return it.base_stamp;
}

// Mirrors backend.py's _parse_any_stamp — parses either stamp namespace into a real
// Date for the audio-first rail's unified chronological sort: a note/recording base
// stamp ("2026-07-07-123456", 17 chars) or a still-pending recording's stamp
// ("2026-07-07T12-34-56-x9k2" — a literal "T" at index 10 distinguishes it). Returns
// null on anything unparseable — callers sort those last rather than crashing.
function parseAnyStamp(stamp) {
  const s = String(stamp || "");
  if (s.length < 17) return null;
  const m = (s.length >= 19 && s[10] === "T")
    ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/.exec(s)
    : /^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(s);
  if (!m) return null;
  const [, y, mo, d, h, mi, se] = m;
  const date = new Date(+y, +mo - 1, +d, +h, +mi, +se); // local ctor — no UTC shift
  return Number.isNaN(date.getTime()) ? null : date;
}

// "HH:MM" time-of-day for a rail row's meta line (design "Вариант A" — history-audio-a.html).
const RAIL_TIME_FMT = new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" });
function formatStampTime(stamp) {
  const d = parseAnyStamp(stamp);
  return d ? RAIL_TIME_FMT.format(d) : "";
}
// Whole-minute duration for a rail row's meta line — seconds is audios[]'s duration_s
// (backend's best-effort WAV header read), null/undefined whenever it's unknown (a
// pending recording's audio isn't in the out_dir inventory yet, a non-wav orphan, etc.).
function formatDurationMin(seconds) {
  if (seconds == null) return "";
  return `${Math.round(seconds / 60)} мин`;
}

// Standard Russian count-noun declension (1 → nominative singular, 2-4 → genitive
// singular, everything else → genitive plural) — used only by recordingBadge's
// "N обработок" text below; ruStem (above) is a query stemmer, a different concept.
function ruPlural(n, one, few, many) {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

// Recording-level status badge (design "Вариант A" reference, history-audio-a.html):
// «ждёт обработки» (pending, --rec-tint), «без обработок» (orphan audio inventory entry
// with zero surviving notes, dashed --inactive outline), «N обработок» (has notes,
// neutral) — tokens only (style.css's .rail-rec-badge.* rules), no hardcoded colors.
function recordingBadge(kind, count) {
  if (kind === "pending") return '<span class="rail-rec-badge wait">ждёт обработки</span>';
  if (kind === "orphan") return '<span class="rail-rec-badge empty">без обработок</span>';
  return `<span class="rail-rec-badge count">${count} ${ruPlural(count, "обработка", "обработки", "обработок")}</span>`;
}

// Next per-template version number for a История reprocess: 1 + the highest existing
// version among ALL history notes (not just whatever the current search/date filter
// shows — numbering must stay correct even when sibling versions are filtered out)
// sharing this recording's base stamp AND the chosen template. A legacy note with no
// version field defaults to 1 (mirrors main.js's list-history mapping default).
function nextVersionFor(baseStamp, templateName) {
  const maxV = historyItems.reduce((m, it) => {
    if (it.kind === "pending") return m;
    if (recordingBaseStamp(it) !== baseStamp) return m;
    if ((it.template || "") !== (templateName || "")) return m;
    return Math.max(m, it.version || 1);
  }, 0);
  return maxV + 1;
}

// Session-only collapsed-state for История's per-recording обработки — same
// lifetime/rationale as glossaryCategoryCollapsed (glossary "Мои" category folders,
// see renderGlossaryChips): UI-only, reset every session, never persisted. Keyed by
// base stamp (app-derived from the note filename/backend field, not a user/LLM string)
// so the same recording's group stays collapsed/expanded across a renderRail()
// re-render triggered by a filter change.
let historyGroupCollapsed = new Set();

// Unified recording model for the audio-first История rail (design "Вариант A" —
// history-audio-a.html): merges backend note rows (grouped by recordingBaseStamp),
// the out_dir audio inventory (audios[] — pairs by base_stamp; an unpaired entry is an
// orphan, "без обработок"), and still-pending recordings (state.pendingRecordings)
// into ONE chronologically-sorted list of "recording" descriptors — replaces the old
// two-tier "pending always first" + separately-grouped-notes rail. Returns ALL
// recordings (unfiltered, newest first); renderRail() computes per-recording
// visibility (обработки filtering, date range) on top of this.
function buildRecordings() {
  const notes = historyItems.filter((it) => it.kind !== "pending");
  const order = [];
  const groups = new Map(); // base_stamp -> notes[]
  notes.forEach((it) => {
    const base = recordingBaseStamp(it);
    if (!groups.has(base)) { groups.set(base, []); order.push(base); }
    groups.get(base).push(it);
  });

  const recordings = order.map((base) => ({
    kind: "notes",
    baseStamp: base,
    allNotes: groups.get(base),
    audio: historyAudios.find((a) => a.base_stamp === base) || null,
  }));

  // audios[] entries whose base_stamp has NO surviving note at all are true orphans
  // (histmap4x analyzer report Q5/constraint (a): an audio file with zero notes was
  // previously invisible to the whole system). One paired with a note-group above
  // must not ALSO render as a second, orphan row.
  historyAudios.forEach((a) => {
    if (groups.has(a.base_stamp)) return;
    recordings.push({ kind: "orphan", baseStamp: a.base_stamp, audio: a });
  });

  (state.pendingRecordings || []).forEach((p, idx) => {
    recordings.push({ kind: "pending", baseStamp: p.stamp || p.id, pendingItem: p, pendingIdx: idx });
  });

  recordings.sort((a, b) => {
    const ta = parseAnyStamp(a.baseStamp);
    const tb = parseAnyStamp(b.baseStamp);
    if (!ta && !tb) return 0;
    if (!ta) return 1;
    if (!tb) return -1;
    return tb - ta; // newest first
  });
  return recordings;
}

// All out_dir audio inventory entries sharing a recording's base_stamp — normally
// exactly one (backend.py's Pipeline.process only ever copies ONE file — the mixed/
// imported source — into out_dir per recording, backend.py:1473-1500; mic.wav/system.wav
// never leave the pending recordings/ session dir), plural-safe in case more than one
// physical file ever shares a base_stamp. buildRecordings' own `.find(...)` above only
// needs the first match for display; trash (deleteRecording below) needs ALL of them so
// nothing physically tied to this recording is silently left behind.
function audiosForBaseStamp(baseStamp) {
  return historyAudios.filter((a) => a.base_stamp === baseStamp);
}

// One collapsible recording row for any base stamp with ≥1 (currently shown) note —
// EVERY notes-bearing recording renders this way now (a solitary обработка is no
// longer a special-cased flat row), organized by template (stable order = first-seen,
// already backend stamp-DESC) and, within a template, ordered by version DESCENDING —
// the highest version per template marked "(latest)". Caret/hidden-class/session-Set
// collapse mechanics mirror renderGlossaryChips' "Мои" category folders (see
// glossaryCategoryCollapsed) — same discipline: no user/LLM string (title, template
// name) ever lands in an HTML attribute; rows wire via closure-by-index, not a data-*
// attribute.
function buildNotesRecordingRow(rec) {
  const notes = rec.shownNotes; // may be a subset of rec.allNotes — filters "shrink" the group
  const wrap = document.createElement("div");
  wrap.className = "rail-group";

  const templateOrder = [];
  const byTemplate = new Map();
  notes.forEach((it) => {
    const t = it.template || "";
    if (!byTemplate.has(t)) { byTemplate.set(t, []); templateOrder.push(t); }
    byTemplate.get(t).push(it);
  });

  // rowOrder tracks the exact order rows land in the DOM (template-grouped, version-
  // descending) — the click-wiring below indexes into it by rendered position, same
  // discipline as renderGlossaryChips' mineOrder.
  const rowOrder = [];
  const rowsHtml = templateOrder.map((tmpl) => {
    const versions = byTemplate.get(tmpl).slice().sort((a, b) => (b.version || 1) - (a.version || 1));
    const maxV = versions[0] ? (versions[0].version || 1) : 1;
    return versions.map((it) => {
      rowOrder.push(it);
      const v = it.version || 1;
      const latest = v === maxV ? ' <span class="rail-latest">(latest)</span>' : "";
      // No source-origin badge here — sourceBadge/SOURCE_BADGE_* were removed as dead
      // code (L9 arch-audit): only the old solitary flat row, retired by the
      // audio-first rail, ever called it. The design reference (history-audio-a.html)
      // doesn't show a source icon on обработка rows either.
      // T1 redesign (history-buttons-a.html вариант A): the row itself keeps the
      // selectNote click listener (unchanged below — same element, same dataset.idx
      // discipline), but now also carries a 🗑 delete button — deleteHistoryNote's
      // existing flow (previously reachable only via the opened note's nvDelete),
      // stopPropagation'd so it doesn't also fire selectNote on the same click.
      return `<div class="rail-item rail-version-row">` +
        `<span class="rail-title">${escapeHtml(tmpl || "Без шаблона")} · v${v}${latest}</span>` +
        `<button type="button" class="rail-version-del" title="Удалить заметку (в корзину)">🗑</button></div>`;
    }).join("");
  }).join("");

  const collapsed = historyGroupCollapsed.has(rec.baseStamp);
  const title = notes[0].title || "Без темы";
  const time = formatStampTime(rec.baseStamp);
  const dur = rec.audio ? formatDurationMin(rec.audio.duration_s) : "";
  const metaText = [time, dur].filter(Boolean).join(" · ");
  wrap.innerHTML =
    `<button type="button" class="rail-group-header">` +
    `<span class="glossary-caret">${collapsed ? "▸" : "▾"}</span>` +
    `<span class="rail-group-title">🎙 ${escapeHtml(title)}</span></button>` +
    `<div class="rail-rec-meta"><span class="rail-rec-meta-text">${escapeHtml(metaText)}</span>${recordingBadge("notes", notes.length)}</div>` +
    `<div class="rail-actions">` +
    `<button type="button" class="btn small rail-action-btn danger rec-trash-btn" title="Удалить (в корзину)">🗑 В корзину</button>` +
    `</div>` +
    `<div class="rail-group-versions${collapsed ? " hidden" : ""}">${rowsHtml}</div>`;

  wrap.querySelector(".rail-group-header").addEventListener("click", () => {
    if (historyGroupCollapsed.has(rec.baseStamp)) historyGroupCollapsed.delete(rec.baseStamp);
    else historyGroupCollapsed.add(rec.baseStamp);
    renderRail();
  });
  wrap.querySelectorAll(".rail-version-row").forEach((row, i) => {
    const idx = historyItems.indexOf(rowOrder[i]);
    row.dataset.idx = idx; // selectNote's `.rail-item` active-highlight match relies on this
    row.addEventListener("click", () => selectNote(idx));
    const delBtn = row.querySelector(".rail-version-del");
    delBtn.addEventListener("click", (e) => {
      e.stopPropagation(); // don't also select the row via the listener just above
      deleteHistoryNote(rowOrder[i], delBtn);
    });
  });
  const trashBtn = wrap.querySelector(".rec-trash-btn");
  trashBtn.addEventListener("click", () => deleteRecording(rec, trashBtn));
  return wrap;
}

// «без обработок» row (an audios[] entry with zero surviving notes — see buildRecordings):
// a flat, non-clickable row (same shape as buildPendingRow — no note to open, so clicking
// the row itself is a no-op), with a prominent «▶ Обработать» that reuses the SAME
// reprocess entry point a note's own ▶ uses (openReprocessPicker/reprocessHistory) —
// there is no note metadata (template/language) to seed the picker with, so a synthetic
// item carrying only base_stamp stands in for a real one. Recording-level ✕ (trash
// feature) now applies here too — an orphan is just an audio-only recording, same as any
// other; the histaudrail2x report's "deferred to the trash PR" note is resolved by this
// one.
function buildOrphanRow(rec) {
  const el = document.createElement("div");
  el.className = "rail-item orphan";
  const time = formatStampTime(rec.baseStamp);
  const dur = formatDurationMin(rec.audio.duration_s);
  const name = (rec.audio.path || "").split("/").pop();
  // T1 redesign: the recording-level ✕ moves into a labeled .rail-actions row
  // alongside the existing "▶ Обработать" action (unchanged behaviour/handler,
  // .btn.primary kept so tests/CSS relying on that class still match — rail-action-btn
  // only adds the row's compact sizing).
  el.innerHTML =
    `<div class="rail-rec-head"><span>🎙</span><span class="rail-title rail-title-file">${escapeHtml(name)}</span></div>` +
    `<div class="rail-rec-meta"><span class="rail-rec-meta-text">${escapeHtml([time, dur].filter(Boolean).join(" · "))}</span>${recordingBadge("orphan")}</div>` +
    `<div class="rail-actions">` +
    `<button type="button" class="btn small primary rail-action-btn process-orphan-btn">▶ Обработать</button>` +
    `<button type="button" class="btn small rail-action-btn danger rec-trash-btn" title="Удалить (в корзину)">🗑 В корзину</button>` +
    `</div>`;
  el.querySelector(".process-orphan-btn").addEventListener("click", () => processOrphanAudio(rec.audio));
  const trashBtn = el.querySelector(".rec-trash-btn");
  trashBtn.addEventListener("click", () => deleteRecording(rec, trashBtn));
  return el;
}

// Dispatches a buildRecordings() descriptor to its row renderer — the single place
// renderRail() needs to know about the three recording kinds.
function buildRecordingRow(rec) {
  if (rec.kind === "pending") return buildPendingRow(rec.pendingItem, rec.pendingIdx);
  if (rec.kind === "orphan") return buildOrphanRow(rec);
  return buildNotesRecordingRow(rec);
}

// render the rail: a single chronologically-sorted list of RECORDINGS (design "Вариант
// A" — audio is the top level, обработки the second), date-separated. Notes/orphans/
// pending all interleave by their own real timestamp (buildRecordings) — pending no
// longer renders as a separate always-first section. dataset.idx (on each обработка
// row) points into the full historyItems so selection survives re-render.
function renderRail() {
  const q = ($("historySearch").value || "").trim().toLowerCase();
  const lang = $("historyLang").value;
  const tmpl = $("historyTemplate").value;
  const from = $("historyFrom").value; // YYYY-MM-DD or ""
  const to = $("historyTo").value;
  updateFiltersToggle();
  const rail = $("historyList");
  rail.innerHTML = "";
  // Unconditional, regardless of filter/search state or what ends up visible below —
  // same reasoning as before this feature (Запись-tab quick-process button must always
  // reflect state.pendingRecordings, not История's current filter).
  refreshProcessLatestBtn();
  const hasWork = (state.pendingRecordings || []).some((it) => it.status === "pending" || it.status === "failed");
  $("pendingProcessAll").classList.toggle("hidden", !hasWork);

  const noteMatches = (it) => {
    const d = (it.name || "").slice(0, 10); // stamp = YYYY-MM-DD-HHMMSS → ISO date sorts lexically
    return (!q || textMatchesQuery(it.title || "", q) || textMatchesQuery(it.name || "", q)) &&
      (!lang || it.language === lang) &&
      (!tmpl || it.template === tmpl) &&
      (!from || d >= from) && (!to || d <= to);
  };
  const dateInRange = (stamp) => {
    const d = (stamp || "").slice(0, 10);
    return (!from || d >= from) && (!to || d <= to);
  };

  const recordings = buildRecordings(); // chronological (desc), unfiltered
  // A recording is visible if ≥1 обработка matches the note-level filters (q/lang/
  // tmpl/date-range — same "shrinks the group" semantics as before), OR it has zero
  // обработки at all (orphan/pending) — those always pass every filter except the
  // date range, applied to the recording's own stamp (owner decision, item 6).
  const visible = [];
  recordings.forEach((rec) => {
    if (rec.kind === "notes") {
      rec.shownNotes = rec.allNotes.filter(noteMatches);
      if (rec.shownNotes.length) visible.push(rec);
    } else if (dateInRange(rec.baseStamp)) {
      visible.push(rec);
    }
  });

  if (!visible.length) {
    const msg = recordings.length ? "Ничего не найдено." : "Пока пусто.";
    rail.insertAdjacentHTML("beforeend", `<p class="hint">${msg}</p>`);
    return;
  }

  // Date-group headers count VISIBLE RECORDINGS (owner decision, item 6 — a multi-
  // обработка recording is one entry in the "N per day" count, not N), computed over
  // `visible` so "8 июля · N" always matches what's actually shown. `visible` is
  // already chronologically sorted, so same-day rows are contiguous — a single
  // forward pass with a running "last date seen" is enough.
  const dateCounts = new Map();
  visible.forEach((rec) => {
    const d = (rec.baseStamp || "").slice(0, 10);
    if (d) dateCounts.set(d, (dateCounts.get(d) || 0) + 1);
  });

  let lastDate = null;
  visible.forEach((rec) => {
    const d = (rec.baseStamp || "").slice(0, 10);
    if (d && d !== lastDate) {
      lastDate = d;
      const header = document.createElement("div");
      header.className = "rail-date-header";
      header.textContent = `${formatGroupDate(d)} · ${dateCounts.get(d)}`;
      rail.appendChild(header);
    }
    rail.appendChild(buildRecordingRow(rec));
  });
  applyActiveHighlight(); // re-mark whichever note is currently open — rebuilt rows start unmarked
}
["historySearch"].forEach((id) => $(id).addEventListener("input", renderRail));
["historyLang", "historyTemplate", "historyFrom", "historyTo"].forEach((id) =>
  $(id).addEventListener("change", renderRail));

// Filters collapse (rail-filters-body starts collapsed, in-memory only — no persistence).
// The search input stays outside the collapsible; lang/template/date-range live inside it.
$("historyFiltersToggle").addEventListener("click", () => {
  const collapsed = $("historyFiltersBody").classList.toggle("hidden");
  $("historyFiltersCaret").textContent = collapsed ? "▸" : "▾";
});
// Badge = count of non-default filter values among lang/template/from/to (search excluded —
// it's always visible, not part of the collapsible group). Recomputed on every renderRail()
// so it always matches the four fields' actual current values.
function updateFiltersToggle() {
  const activeCount = ["historyLang", "historyTemplate", "historyFrom", "historyTo"]
    .filter((id) => $(id).value).length;
  const badge = $("historyFiltersBadge");
  if (activeCount) {
    badge.textContent = String(activeCount);
    badge.classList.remove("hidden");
  } else {
    badge.classList.add("hidden");
  }
}

function selectNote(idx) {
  openNoteIdx = idx;
  applyActiveHighlight();
  openHistoryNote(historyItems[idx]);
}

// Scoped to the История rail: ".rail-item" is shared with Промпты's #promptsList rows
// (which carry no dataset.idx), and this now runs on every renderRail() rebuild (filters,
// refresh, auto-open) — an unscoped query would strip Промпты's own active-preset
// highlight the moment it runs, before that tab is ever opened.
function applyActiveHighlight() {
  $("historyList").querySelectorAll(".rail-item").forEach((e) => e.classList.toggle("active", +e.dataset.idx === openNoteIdx));
}

// Decides #noteView's content when nothing has been explicitly opened yet — runs after every
// renderRail() rebuild (via refreshHistory). ".history-placeholder" marks "nothing shown yet"
// (the static initial hint, or this function's own empty state); a real opened note never
// carries it, so once a note is open this becomes a permanent no-op for that note.
function updateNoteViewDefault() {
  const view = $("noteView");
  if (!view.querySelector(".history-placeholder")) return; // a note (or read-error) already showing
  if (!buildRecordings().length) {
    view.innerHTML =
      `<div class="note-view-empty history-placeholder">
         <div class="note-view-empty-icon">🎙</div>
         <p class="note-view-empty-title">Пока нет заметок</p>
         <p class="hint">Запиши первую встречу — заметка появится здесь</p>
         <button id="nvEmptyGoRecord" class="btn primary">● Начать запись</button>
       </div>`;
    $("nvEmptyGoRecord").onclick = () => switchView("record");
    return;
  }
  // "Most recent note" reuses the rail's own already-computed order (stamp-DESC across
  // ALL recordings, version-DESC — "(latest)" first — within a recording) instead of
  // re-deriving that sort here: .rail-version-row only ever renders for a notes-bearing
  // recording, so the FIRST one in DOM order is, by construction, the most recent
  // recording that actually has a note — if the very top of the unified rail is a
  // pending/orphan entry (nothing to open), this naturally falls through to whichever
  // note-bearing recording sorts next, exactly the "auto-open of last NOTE" contract.
  const topRow = $("historyList").querySelector(".rail-version-row");
  if (topRow) selectNote(+topRow.dataset.idx);
}

// Backend pairing gap (backend.py _reconcile/_find_audio) only resolves `audio` for
// notes still sitting in out_dir — a PARA-archived note (parent dir != out_dir) always
// gets audio=null even though its wav sits right next to it (PARA filing moves note+
// audio together, keeping basenames — see backend.py Pipeline.process's audio_basename/
// vault_audio and _reconcile's out_dir-only _find_audio call). Rather than fixing the
// backend pairing (separate concern), the reprocess button recovers the same info from
// the note's own embedded ![[filename.ext]] link (written once by add_audio_link at
// record time) — same directory as the note holds for both out_dir and any archive
// location, so no path beyond "next to the note" is ever needed.
const AUDIO_EMBED_RE = /!\[\[([^\]\|]+\.(?:wav|mp3|m4a|aac|flac|ogg|mp4|mov))(?:\|[^\]]*)?\]\]/i;
function resolveReprocessAudio(notePath, md) {
  const m = AUDIO_EMBED_RE.exec(md || "");
  if (!m) return null;
  const slash = notePath.lastIndexOf("/"); // note paths are POSIX-style throughout this app
  const dir = slash >= 0 ? notePath.slice(0, slash) : "";
  return dir ? `${dir}/${m[1]}` : m[1];
}

async function openHistoryNote(item) {
  const view = $("noteView");
  const md = await window.api.readNote(item.note);
  if (md == null) { view.innerHTML = '<p class="hint">Не удалось прочитать заметку.</p>'; return; }
  // item.audio (already resolved by the backend) wins when present; the embed-derived
  // path is purely a fallback for the out_dir-only pairing gap described above.
  const resolvedAudio = item.audio || resolveReprocessAudio(item.note, md);
  const meta = [item.template && `шаблон: ${item.template}`, item.language && `язык: ${item.language}`]
    .filter(Boolean).join(" · ");
  view.innerHTML =
    `<h2 class="note-title">${escapeHtml(item.title || item.name)}</h2>
     <div class="note-actions">
       <button class="btn small" id="nvOpen">📄 Obsidian</button>
       <button class="btn small" id="nvGoRecord">🎙 К записи</button>
       ${item.audio ? '<button class="btn small" id="nvAudio">🎵 Аудио</button>' : ""}
       <button class="btn small" id="nvCopyPath" title="Скопировать путь до заметки">📋 Путь</button>
       <button class="btn small ghost" id="nvReprocess">↻ Переобработать</button>
       <button class="btn small danger" id="nvDelete">🗑 Удалить</button>
     </div>
     ${meta ? `<div class="note-meta">${escapeHtml(meta)}</div>` : ""}
     <div id="nvSpeakerMap" class="speaker-map" style="display:none">
       <div class="speaker-title">Переименовать спикеров</div>
       <div id="nvSpeakerInputs"></div>
       <button id="nvApplySpeakers" class="btn small">Применить</button>
     </div>
     <div class="note-body">${renderMarkdown(md)}</div>`;
  $("nvOpen").onclick = () => window.api.reveal(item.note);
  $("nvGoRecord").onclick = () => switchView("record");
  if (item.audio) $("nvAudio").onclick = () => window.api.reveal(item.audio);
  $("nvCopyPath").onclick = () => copyToClipboard(item.note, $("nvCopyPath"), "✓ Скопировано", 1500);
  const reprocessBtn = $("nvReprocess");
  if (resolvedAudio) {
    reprocessBtn.disabled = false;
    reprocessBtn.title = "";
    reprocessBtn.onclick = () => openReprocessPicker(item, resolvedAudio);
  } else {
    // Never a silent no-op: audio is genuinely unrecoverable (no item.audio AND no
    // embed found in the note body) — disable with a visible reason instead.
    reprocessBtn.disabled = true;
    reprocessBtn.title = "Аудио не найдено — переобработка недоступна";
    reprocessBtn.onclick = null;
  }
  $("nvDelete").onclick = () => deleteHistoryNote(item);
  // Speaker reassignment for an already-saved История note — same rename-speakers IPC
  // the record card's #applySpeakers uses (rewriteNoteSpeakers works on any saved note,
  // no backend change needed), just targeting this note's own labels/container instead
  // of the record card's fixed #speakerMap + module-global currentNote.
  const labels = detectSpeakers(md);
  if (labels.length) {
    $("nvSpeakerMap").style.display = "";
    renderSpeakerRows($("nvSpeakerInputs"), labels);
    $("nvApplySpeakers").onclick = async () => {
      const map = readSpeakerMap($("nvSpeakerInputs"));
      if (!Object.keys(map).length) return;
      const btn = $("nvApplySpeakers");
      btn.disabled = true;
      const res = await window.api.renameSpeakers(item.note, map);
      if (res && res.ok === false) {
        alert("Не удалось переименовать: " + res.error);
        btn.disabled = false;
        return;
      }
      await openHistoryNote(item); // re-read + re-render so the new labels show
    };
  }
}

// Deletes ONE note (its .md file only — the audio stays on disk, versioned
// siblings are untouched) — moves it into корзина (.trash/, 30-day retention) rather
// than a permanent delete (История trash feature). Two callers now (T1 redesign,
// ux-para-batch): the opened note's own #nvDelete (btn omitted → defaults to it, exact
// prior behaviour), and each rail-version-row's own 🗑 (btn passed explicitly — see
// buildNotesRecordingRow) — the latter can fire while a DIFFERENT note is open, so the
// noteView-clearing below is now gated to "was the deleted note the one showing", same
// discipline deleteRecording already uses for its own trashedNotePaths check.
// Always confirms first (same native confirm() pattern as onResetApp above).
async function deleteHistoryNote(item, btn) {
  btn = btn || $("nvDelete");
  if (btn.disabled) return;
  const ok = confirm(
    `Вы точно хотите удалить заметку «${item.title || item.name}»? ` +
    "Аудиозапись останется на диске. Заметка переедет в корзину, хранится 30 дней, потом удаляется навсегда."
  );
  if (!ok) return;
  btn.disabled = true;
  try {
    const res = await window.api.deleteHistoryNote(item.note, recordingBaseStamp(item), item.title || item.name);
    if (res && res.ok === false) { alert(res.error); return; }
    if (openNoteIdx != null && historyItems[openNoteIdx] && historyItems[openNoteIdx].note === item.note) {
      openNoteIdx = null;
      $("noteView").innerHTML = '<p class="hint history-placeholder">Заметка удалена.</p>';
    }
    await refreshHistory();
  } finally {
    btn.disabled = false;
  }
}

// Per-template breakdown for a trash confirm's note count (design reference
// history-audio-trash.html: "3 заметки (Полная ×2, Саммари ×1)") — same grouping
// buildNotesRecordingRow computes for rendering, recomputed here since deleteRecording's
// confirm fires before any row-building context is available.
function noteTemplateBreakdown(notes) {
  const counts = new Map();
  notes.forEach((it) => {
    const t = it.template || "Без шаблона";
    counts.set(t, (counts.get(t) || 0) + 1);
  });
  return [...counts.entries()].map(([t, n]) => `${t} ×${n}`).join(", ");
}

// Recording-level ✕ (История trash feature, owner decision — now allowed since корзина
// exists): trashes the recording's out_dir audio file(s) and, for a notes-bearing
// recording, EVERY обработка (all versions/templates/languages — rec.allNotes, not the
// possibly-filtered rec.shownNotes). Not available on a pending row — pending keeps its
// existing ✕/remove-pending-recording semantics untouched (buildPendingRow/
// deletePendingRecording, unchanged by this feature). Always confirms (native confirm(),
// same pattern as deleteHistoryNote/onResetApp — see the design reference's itemized
// copy), itemizing exactly what moves to trash before asking.
async function deleteRecording(rec, btn) {
  if (btn && btn.disabled) return;
  const notes = rec.kind === "notes" ? rec.allNotes : [];
  const audios = rec.kind === "orphan" ? (rec.audio ? [rec.audio] : []) : audiosForBaseStamp(rec.baseStamp);
  const title = rec.kind === "orphan"
    ? (rec.audio.path || "").split("/").pop()
    : (notes[0].title || notes[0].name || "Без темы");
  const parts = [];
  if (audios.length) parts.push("аудио");
  if (notes.length) {
    parts.push(`${notes.length} ${ruPlural(notes.length, "заметка", "заметки", "заметок")} (${noteTemplateBreakdown(notes)})`);
  }
  const ok = confirm(
    `Удалить запись «${title}»?\n` +
    `В корзину: ${parts.join(" + ")}.\n` +
    "Хранится 30 дней, потом удаляется навсегда."
  );
  if (!ok) return;
  if (btn) btn.disabled = true;
  try {
    const res = await window.api.deleteHistoryRecording({
      baseStamp: rec.baseStamp,
      notePaths: notes.map((n) => n.note),
      audioPaths: audios.map((a) => a.path),
      title,
    });
    if (res && res.ok === false) {
      alert(res.error);
      // main.js's handler validates every path before moving anything, but a partial
      // failure can still land mid-move (e.g. disk error after 2 of 3 files already
      // moved + manifest-recorded server-side) — refreshHistory() below MUST still run
      // on this path so the rail re-fetches real on-disk state instead of keeping stale
      // rows around whose files are already gone (clicking one would otherwise error).
      // The busy-refuse case (procProc active, nothing moved at all) just makes this a
      // harmless no-op re-fetch.
    } else {
      // If the note currently open in #noteView belongs to the just-trashed recording,
      // it must not keep showing stale content — same placeholder-then-refresh discipline
      // as deleteHistoryNote above. Gated to the success branch: on a refusal nothing was
      // actually moved, so clearing the note view here would falsely claim it's deleted.
      const trashedNotePaths = new Set(notes.map((n) => n.note));
      if (openNoteIdx != null && historyItems[openNoteIdx] && trashedNotePaths.has(historyItems[openNoteIdx].note)) {
        openNoteIdx = null;
        $("noteView").innerHTML = '<p class="hint history-placeholder">Запись удалена.</p>';
      }
    }
    await refreshHistory();
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ── Корзина tab (trash-tab feature, design ref: trash-tab-a.html, variant A) ────────────
// list-trash's raw items ({id, kind, title, deletedAt, daysLeft, bytes, audioBytes,
// noteCount}) — re-fetched on every refreshTrash() call (view switch, or after any
// restore/delete/empty mutation), same "always re-fetch, never patch in place" discipline
// refreshHistory already uses.
let trashItems = [];
async function refreshTrash() {
  const res = await window.api.listTrash();
  trashItems = (res && res.items) || [];
  renderTrashList((res && res.totalBytes) || 0);
}

// Per-row meta line — three shapes depending on kind/noteCount (design card's exact
// copy): a note-only trash (single .md, delete-history-note) never has audio at all;
// a recording trash (delete-history-recording) always has audio, plus its notes IF any
// survived (an orphan-audio delete has zero). ", без заметок" (not "+ 0 заметок") is the
// design's own wording for the zero-notes case.
function trashRowMeta(item) {
  const dateStr = RAIL_GROUP_DATE_FMT.format(new Date(item.deletedAt));
  if (item.kind === "note") return `только заметка · удалено ${dateStr}`;
  const audioStr = `аудио ${formatModelSize(item.audioBytes) || "0 МБ"}`;
  const notesStr = item.noteCount
    ? `${item.noteCount} ${ruPlural(item.noteCount, "заметка", "заметки", "заметок")}`
    : null;
  return `${audioStr}${notesStr ? " + " + notesStr : ", без заметок"} · удалено ${dateStr}`;
}

// Built via innerHTML (not createElement/textContent) like buildOrphanRow/
// buildNotesRecordingRow above — every interpolated string goes through escapeHtml first,
// same discipline those rows already follow (title is user-authored: comes from История's
// own note title / the recording's filename, never trusted raw).
function buildTrashRow(item) {
  const el = document.createElement("div");
  el.className = "trash-row";
  const icon = item.kind === "recording" ? "🎙" : "📄";
  const warn = item.daysLeft < 7 ? " warn" : "";
  el.innerHTML =
    `<span class="trash-row-icon">${icon}</span>` +
    `<div class="trash-row-main">` +
      `<div class="trash-row-title">${escapeHtml(item.title)}</div>` +
      `<div class="trash-row-meta">${escapeHtml(trashRowMeta(item))}</div>` +
    `</div>` +
    `<span class="trash-days${warn}">осталось ${item.daysLeft} дн</span>` +
    `<div class="trash-acts">` +
      `<button type="button" class="btn small trash-restore-btn">↩ Восстановить</button>` +
      `<button type="button" class="btn small ghost danger trash-del-btn">Удалить навсегда</button>` +
    `</div>`;
  el.querySelector(".trash-restore-btn").addEventListener("click", (e) => restoreTrashItem(item, e.currentTarget));
  el.querySelector(".trash-del-btn").addEventListener("click", (e) => deleteTrashItem(item, e.currentTarget));
  return el;
}

function renderTrashList(totalBytes) {
  $("trashCount").textContent =
    `${trashItems.length} ${ruPlural(trashItems.length, "запись", "записи", "записей")} · ${formatModelSize(totalBytes) || "0 МБ"}`;
  $("trashEmptyBtn").disabled = trashItems.length === 0;
  const list = $("trashList");
  if (!trashItems.length) {
    list.innerHTML = '<p class="hint">Корзина пуста</p>';
    return;
  }
  list.innerHTML = "";
  trashItems.forEach((item) => list.appendChild(buildTrashRow(item)));
}

// Restore is non-destructive (unlike delete/empty below) — no confirm(), same reasoning
// applied/save actions elsewhere in this app never confirm either; only irreversible
// mutations do (project convention: любое удаление → confirm окно).
async function restoreTrashItem(item, btn) {
  if (btn.disabled) return;
  btn.disabled = true;
  try {
    const res = await window.api.restoreTrashEntry(item.id);
    if (res && res.ok === false) { alert(res.error); return; }
    await refreshTrash();
  } finally {
    btn.disabled = false;
  }
}

async function deleteTrashItem(item, btn) {
  if (btn.disabled) return;
  const ok = confirm(`Удалить навсегда «${item.title}»? Это необратимо.`);
  if (!ok) return;
  btn.disabled = true;
  try {
    const res = await window.api.deleteTrashEntry(item.id);
    if (res && res.ok === false) alert(res.error);
    await refreshTrash();
  } finally {
    btn.disabled = false;
  }
}

// Itemizes count+size before wiping everything (same "list what dies before you commit"
// confirm discipline as deleteRecording above).
async function emptyTrash() {
  const btn = $("trashEmptyBtn");
  if (btn.disabled) return;
  const n = trashItems.length;
  const totalBytes = trashItems.reduce((sum, it) => sum + (it.bytes || 0), 0);
  const ok = confirm(
    `Удалить навсегда всё содержимое корзины?\n` +
    `${n} ${ruPlural(n, "запись", "записи", "записей")} · ${formatModelSize(totalBytes) || "0 МБ"}.\n` +
    "Это необратимо."
  );
  if (!ok) return;
  btn.disabled = true;
  try {
    const res = await window.api.emptyTrash();
    if (res && res.ok === false) alert(res.error);
    await refreshTrash();
  } finally {
    btn.disabled = false;
  }
}
$("trashEmptyBtn").addEventListener("click", emptyTrash);

// Small inline panel inserted above the transcript in #noteView (not a full modal) letting the user pick
// which template to reprocess with, instead of silently reusing whatever the record
// card last held. Built entirely via createElement/textContent/property assignment —
// no innerHTML of user strings — so a template name can never break out as markup or
// an HTML attribute (same discipline as the chip/rail renderers).
// audioPath: the resolved audio to reprocess with — passed explicitly by the caller
// (openHistoryNote) rather than read from item.audio, since item.audio can be null
// while a derived (embed-recovered) path is still available (see resolveReprocessAudio).
function openReprocessPicker(item, audioPath) {
  if (state.recording || state.processing) return; // don't hijack an active run
  closeReprocessPicker(); // toggle-safe if one is already open (e.g. re-click)

  const byTemplate = state.presets.find((p) => p.name === item.template);
  const preselected = byTemplate || state.presets[state.currentPreset];

  const sel = document.createElement("select");
  sel.id = "reprocessPresetSelect";
  state.presets.forEach((p) => {
    const o = document.createElement("option");
    o.value = p.id;
    o.textContent = p.name;
    if (preselected && p.id === preselected.id) o.selected = true;
    sel.appendChild(o);
  });

  const label = document.createElement("label");
  label.textContent = "Шаблон для переобработки";
  label.appendChild(sel);

  const confirmBtn = document.createElement("button");
  confirmBtn.id = "reprocessConfirm";
  confirmBtn.className = "btn small primary";
  confirmBtn.textContent = "▶ Запустить";
  confirmBtn.addEventListener("click", () => {
    const presetId = sel.value;
    // Note versioning by template on reprocess: computed HERE (not inside
    // reprocessHistory) because `item` — the note being reprocessed, needed for its
    // base stamp — is only in scope in this closure.
    const chosen = state.presets.find((p) => p.id === presetId);
    const version = nextVersionFor(recordingBaseStamp(item), chosen ? chosen.name : "");
    closeReprocessPicker();
    reprocessHistory(audioPath, presetId, version);
  });

  const cancelBtn = document.createElement("button");
  cancelBtn.id = "reprocessCancel";
  cancelBtn.className = "btn small ghost";
  cancelBtn.textContent = "Отмена";
  cancelBtn.addEventListener("click", () => closeReprocessPicker());

  const row = document.createElement("div");
  row.className = "run-row";
  row.appendChild(confirmBtn);
  row.appendChild(cancelBtn);

  const panel = document.createElement("div");
  panel.id = "reprocessPicker";
  panel.className = "reprocess-picker";
  panel.appendChild(label);
  panel.appendChild(row);
  insertAboveNoteBody(panel);
}
function closeReprocessPicker() {
  const el = $("reprocessPicker");
  if (el) el.remove();
}

// Insert a panel at the TOP of the note view — right above the transcript body —
// instead of appended after it. The reprocess trigger (#nvReprocess) lives in the
// note header, so its picker and the progress panel must surface next to the button,
// not a full transcript-length scroll below it. Falls back to append if the body node
// isn't present (defensive — openHistoryNote always renders .note-body).
function insertAboveNoteBody(panel) {
  const view = $("noteView");
  const body = view.querySelector(".note-body");
  if (body) view.insertBefore(panel, body);
  else view.appendChild(panel);
}

// «без обработок» row's ▶ Обработать (buildOrphanRow) — there's no note to show
// underneath the picker, so #noteView first gets a minimal "audio only" view (this
// audio's own name/time/duration, not a real note) purely so insertAboveNoteBody has a
// sensible place to insert the picker into and the user can see WHICH audio they're
// about to process. Reuses openReprocessPicker/reprocessHistory unchanged — a
// synthetic item carrying only the audio's base_stamp stands in for a real note (no
// template/language exists to preselect from for an orphan).
function renderOrphanView(audio) {
  openNoteIdx = null;
  applyActiveHighlight();
  const view = $("noteView");
  const name = (audio.path || "").split("/").pop();
  const dur = formatDurationMin(audio.duration_s);
  view.innerHTML =
    `<h2 class="note-title">${escapeHtml(name)}</h2>
     <p class="note-meta">${escapeHtml([formatStampTime(audio.base_stamp), dur].filter(Boolean).join(" · "))}</p>
     <p class="hint">Аудио без обработок. Выбери шаблон и запусти обработку.</p>`;
}
function processOrphanAudio(audio) {
  if (state.recording || state.processing) return; // don't hijack an active run
  renderOrphanView(audio);
  openReprocessPicker({ name: audio.base_stamp, base_stamp: audio.base_stamp, template: "" }, audio.path);
}

// In-place progress/logs panel for a История-initiated reprocess (owner decision: no
// more yanking the user into the Запись tab mid-История-session — see reprocessHistory
// below). Mirrors openReprocessPicker's insert-above-.note-body placement; buildStages/
// pushLog/showStageLogs/setStageClass (see progressTargetIds) populate #histStages/
// #histLogs instead of the record view's #stages/#logs while reprocessTargetsHistory
// is set. Left in place after the run finishes (same "leave the final state visible"
// behavior #progressCard already has on the Запись tab) — only removed when the note
// view itself is next rebuilt (openHistoryNote replaces #noteView's innerHTML wholesale).
function buildHistoryProgressPanel() {
  removeHistoryProgressPanel(); // toggle-safe, same rationale as closeReprocessPicker
  const panel = document.createElement("div");
  panel.id = "histProgressPanel";
  panel.className = "card";
  panel.innerHTML =
    `<h2>Прогресс переобработки</h2>
     <div class="stages" id="histStages"></div>
     <p class="hint">Кликни по этапу — увидишь его логи. 🟢 ок · 🔴 ошибка · ⚪ пропущен</p>
     <pre id="histLogs"></pre>`;
  insertAboveNoteBody(panel);
}
function removeHistoryProgressPanel() {
  const el = $("histProgressPanel");
  if (el) el.remove();
}

// presetId: the chosen template's stable id (from the reprocess picker) — resolved
// here to a {prompt, template} override rather than trusting whatever the record
// card's own state.currentPreset happens to be at call time.
// version: the next per-template version number (nextVersionFor, computed by the
// picker's confirm handler above) — forwarded into the override so startProcessing
// sends it to the backend; a plain runBtn/retryBtn/freshBtn run never passes one.
function reprocessHistory(audio, presetId, version) {
  if (state.recording || state.processing) return; // don't hijack an active run
  const preset = state.presets.find((p) => p.id === presetId);
  // Deliberately NOT calling switchView("record") — the owner wants this run to stay
  // visually inside История, not jump to Запись (see buildHistoryProgressPanel above).
  // state.mode/tab-pane ARE still flipped to "import" (mirrors what a manual "Загрузить
  // файл" tab click would do): the queue/processing functions below key off state.mode,
  // not view visibility, so this has no visible effect on the currently-shown История
  // view — it only keeps state.mode consistent with what's rendered if the user later
  // switches to Запись manually (avoids a stale state.mode="import" while that tab's
  // own pane still shows "Запись").
  state.mode = "import";
  document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x.dataset.tab === "import"));
  $("pane-record").classList.add("hidden");
  $("pane-import").classList.remove("hidden");
  // #processLatestBtn used to live inside #pane-record, so hiding that pane (above) hid
  // it for free. It now lives in the record-action-bar, a sibling of both tabpanes — left
  // untouched here it would stay visible (and, once refreshProcessLatestBtn() re-enables it
  // after this run ends, clickable) while the rest of the UI shows import mode; a later
  // click would process the latest RECORDING, not this reprocess. Mirrors the tab handler's
  // own toggle (the only other site that flips state.mode/pane visibility — see its comment).
  $("processLatestBtn").classList.add("hidden");
  reprocessTargetsHistory = true;
  buildHistoryProgressPanel();
  setImportQueue([audio]); // queue-of-1 — same path as an N-file batch
  $("pickedFile").textContent = audio.split("/").pop();
  startQueueRun(false, preset ? { prompt: preset.prompt, template: preset.name, version } : undefined);
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
// Renders one "oldLabel → [input] [это я]" row per label into `container`, built
// entirely via createElement/textContent (no innerHTML of a speaker name — a name
// must never be able to break out as markup, same discipline as the chip/rail
// renderers). Shared between the record card's #speakerInputs and the История
// note-view's own speaker editor (see openHistoryNote) — the only difference
// between call sites is which container + prefill values they pass in.
function renderSpeakerRows(container, labels, prefill = {}) {
  container.innerHTML = "";
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
    container.appendChild(row);
  });
}
// Reads back the {oldLabel: newName} map from a container built by renderSpeakerRows,
// skipping rows the user left blank — same contract renameSpeakers expects.
function readSpeakerMap(container) {
  const map = {};
  container.querySelectorAll("input").forEach((i) => {
    const v = i.value.trim();
    if (v) map[i.dataset.old] = v;
  });
  return map;
}
function buildSpeakerMap(transcript, prefill = {}) {
  const labels = detectSpeakers(transcript);
  const box = $("speakerInputs");
  if (!labels.length) { box.innerHTML = ""; $("speakerMap").style.display = "none"; return; }
  $("speakerMap").style.display = "";
  renderSpeakerRows(box, labels, prefill);
}
$("applySpeakers").addEventListener("click", async () => {
  if (!currentNote) return;
  const map = readSpeakerMap($("speakerInputs"));
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
// Guards against re-fetching (and wiping filed/grey rows) on every pane re-entry —
// set once the first auto-load has run; reset only when the vault identity changes.
let paraInboxLoaded = false;
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
    if (!paraInboxLoaded) refreshParaInbox(); // sets paraInboxLoaded itself, only on success
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
      return `<li class="tree-dir${hasChildren ? " collapsed" : ""}">` +
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
    `<div class="note-actions">
       <button class="btn small" id="ptvOpen">📄 Obsidian</button>
       <button class="btn small" id="ptvGoRecord">🎙 К записи</button>
       <button class="btn small" id="ptvCopyPath" title="Скопировать путь до заметки">📋 Путь</button>
     </div>
     <h2 class="note-title">${escapeHtml(name)}</h2>
     <div class="note-body">${renderMarkdown(md)}</div>`;
  $("ptvOpen").onclick = () => window.api.reveal(path);
  $("ptvGoRecord").onclick = () => switchView("record");
  $("ptvCopyPath").onclick = () => copyToClipboard(path, $("ptvCopyPath"), "✓ Скопировано", 1500);
}
$("paraTreeRefresh").addEventListener("click", renderParaTree);

// ── PARA search pane ─────────────────────────────────────────────────────────

// In-session chat history. Each item: {role: "user"|"assistant", content: string}.
// Reset only by «Новый чат» button. Kept alive across pane switches.
let chatMessages = [];

// Cap: unlike the manual reindex button (which resets this box on click, see
// logBox.textContent = "" below), the background auto-index trigger in main.js
// has no renderer-side "run start" moment to hook a reset into — it can fire
// many times over a long session, so bound the buffer instead of clearing it.
const PARA_REINDEX_LOG_MAX_LINES = 300;
function paraSearchLog(msg) {
  const box = $("paraReindexLog");
  const t = new Date().toLocaleTimeString();
  box.textContent += `[${t}] ${msg}\n`;
  const lines = box.textContent.split("\n");
  if (lines.length > PARA_REINDEX_LOG_MAX_LINES) {
    box.textContent = lines.slice(lines.length - PARA_REINDEX_LOG_MAX_LINES).join("\n");
  }
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
$("paraSearchCancel").addEventListener("click", () => {
  // Self-disable so a second click before the backend's onClose fires is a no-op
  // (mirrors paraClassifyCancel's own click-guard).
  $("paraSearchCancel").disabled = true;
  window.api.cancelSearch();
});

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

// Tag the most recent user bubble as canceled (search was aborted mid-flight) — the
// bubble stays visible so the user can see what they asked, but no assistant reply
// follows. Caller is responsible for popping the phantom turn from chatMessages.
function markLastUserBubbleCanceled() {
  const bubbles = $("paraChatLog").querySelectorAll(".chat-bubble-user");
  const last = bubbles[bubbles.length - 1];
  if (!last) return;
  const tag = document.createElement("div");
  tag.className = "chat-canceled-tag";
  tag.textContent = "⏹ отменено";
  last.appendChild(tag);
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
  const cancelBtn = $("paraSearchCancel");
  // Append user turn
  chatMessages.push({ role: "user", content: query });
  appendChatBubble("user", query, null);
  input.value = "";
  btn.disabled = true;
  btn.textContent = "Ищу…";
  input.disabled = true;
  cancelBtn.disabled = false;
  cancelBtn.classList.remove("hidden");

  // Show typing indicator while waiting
  const typingEl = appendTypingIndicator();

  // Pass a snapshot so the mock/backend receives a stable array regardless of
  // when the caller inspects it (the live array gets the assistant reply appended later).
  let res;
  try {
    res = await window.api.paraSearch(state.para.root, chatMessages.slice(), state.mainModel);
  } catch (e) {
    typingEl.remove();
    const errMsg = "❌ " + (e.message || String(e));
    appendChatBubble("assistant", errMsg, null);
    chatMessages.push({ role: "assistant", content: errMsg });
    btn.disabled = false;
    btn.textContent = "🔍 Спросить";
    input.disabled = false;
    cancelBtn.classList.add("hidden");
    input.focus();
    return;
  }

  typingEl.remove();

  if (res.canceled) {
    // Backend was SIGTERM'd mid-query — drop the phantom user turn from the array
    // sent to the backend (it got no assistant reply) so a follow-up question's
    // history-rewrite never sees two consecutive user turns; the DOM bubble stays
    // visible but tagged, so the user can still see what they asked.
    chatMessages.pop();
    markLastUserBubbleCanceled();
  } else {
    const answerText = res.answer || "Не нашёл по этому вопросу записей в заметках.";
    appendChatBubble("assistant", answerText, res.found ? (res.citations || []) : [], !!res.degraded);
    chatMessages.push({ role: "assistant", content: answerText });
  }

  btn.disabled = false;
  btn.textContent = "🔍 Спросить";
  input.disabled = false;
  cancelBtn.classList.add("hidden");
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
  const res = await window.api.paraCreateVault({ root, folders, outDir: state.outDir, outDirCustom: state.outDirCustom });
  if (res && res.ok === false) { alert("Не удалось создать: " + res.error); return; }
  state.para = { root, folders };
  paraInboxLoaded = false; // new vault → force a fresh disk scan on next Разбор view
  if (res && res.outDir) { state.outDir = res.outDir; $("outDir").value = state.outDir; }
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

$("paraInboxRefresh").addEventListener("click", refreshParaInbox);

async function refreshParaInbox() {
  let items;
  try {
    items = await window.api.listHistory(state.outDir); // unfiled = still in Meetings dir
  } catch (e) {
    return; // fetch failed — paraInboxLoaded stays false so the next tab entry retries
  }
  paraInboxItems = items;
  paraInboxLoaded = true;
  const box = $("paraInbox");
  box.innerHTML = "";
  if (!paraInboxItems.length) { box.innerHTML = '<p class="hint">📥 Всё разобрано</p>'; return; }
  paraInboxItems.forEach((it, idx) => {
    const row = document.createElement("div");
    row.className = "para-row";
    row.dataset.idx = idx;
    row.innerHTML =
      `<div class="para-row-top">
         <span class="para-row-spinner spinner hidden"></span>
         <div class="para-note">${escapeHtml(it.title || it.name)}</div>
       </div>
       <div class="para-row-controls">
         <select class="para-cat">
           <option value="">— категория —</option>
           <option value="projects">Projects</option>
           <option value="areas">Areas</option>
           <option value="resources">Resources</option>
           <option value="archives">Archives</option>
         </select>
         <input class="para-proj" placeholder="проект / область" />
         <button class="btn small para-file-btn">Разложить</button>
       </div>`;
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
  $("paraInboxRefresh").disabled = true; // mid-batch refresh would detach the loop's captured rows
  // setRowProcessing only disables the row the loop is currently on — a manual "Разложить"
  // on any row further down the queue would still race the loop reaching it. Disable every
  // row's action button up front, same pattern as the "Обновить" disable above.
  rows.forEach((row) => {
    if (!row.classList.contains("filed")) row.querySelector(".para-file-btn").disabled = true;
  });
  log.textContent = "";
  log.classList.remove("hidden");
  paraLog(`Старт: ${rows.length} заметок.`);
  let done = 0, errors = 0;
  for (const row of rows) {
    if (paraClassifyCancelled) { paraLog("Прервано пользователем."); break; }
    const it = paraInboxItems[+row.dataset.idx];
    const name = it.title || it.name;
    paraLog(`→ ${name}`);
    setRowProcessing(row, true);
    try {
      const r = await window.api.paraClassify({
        note: it.note, root: state.para.root, folders: state.para.folders,
        mainModel: state.mainModel, language: state.language,
      });
      if (!r || r.error || !r.category) {
        paraLog(`   ✗ не классифицирована: ${(r && r.error) || "категория не определена"}`);
        errors++;
        setRowProcessing(row, false);
        continue;
      }
      row.querySelector(".para-cat").value = r.category;
      row.querySelector(".para-proj").value = r.project || "";
      const res = await window.api.paraFile({
        note: it.note, audio: it.audio, category: r.category, project: r.project || "",
        kind: r.kind, person: r.person, mission: r.mission,
        stamp: it.name,
        root: state.para.root, folders: state.para.folders,
      });
      if (res && res.ok === false) {
        paraLog(`   ✗ ${r.category} подобрана, но не разложена: ${res.error}`);
        errors++;
        setRowProcessing(row, false);
      } else {
        // setRowProcessing(false) first, markRowFiled last — markRowFiled's permanent
        // disable must win over setRowProcessing's transient re-enable.
        setRowProcessing(row, false);
        markRowFiled(row);
        paraLog(`   ✓ разложена → ${r.category}${r.project ? " / " + r.project : ""}`);
        done++;
      }
    } catch (e) {
      paraLog(`   ✗ исключение: ${e && e.message ? e.message : e}`);
      errors++;
      setRowProcessing(row, false);
    }
  }
  paraLog(`Готово: разобрано ${done}, ошибок ${errors}${paraClassifyCancelled ? ", прервано" : ""}.`);
  btn.disabled = false;
  btn.textContent = "🗂 Разобрать все (LLM)";
  cancelBtn.classList.add("hidden");
  $("paraInboxRefresh").disabled = false;
  rows.forEach((row) => {
    if (!row.classList.contains("filed")) row.querySelector(".para-file-btn").disabled = false;
  });
});

// Toggles the per-row spinner + a transient disable on this row's own controls while
// it's mid-flight in paraClassifyAll — narrows (does not fully close) the window where
// a manual "Разложить" click could race the bulk loop on the same row.
function setRowProcessing(row, on) {
  const spinner = row.querySelector(".para-row-spinner");
  if (spinner) spinner.classList.toggle("hidden", !on);
  row.querySelectorAll("select, input, button").forEach((el) => { el.disabled = on; });
}

function markRowFiled(row) {
  row.classList.add("filed");
  row.querySelectorAll("select, input, button").forEach((el) => { el.disabled = true; });
  const btn = row.querySelector(".para-file-btn");
  if (btn) btn.textContent = "✓ Разложена";
}

async function fileParaRow(idx, row) {
  const it = paraInboxItems[idx];
  let category = row.querySelector(".para-cat").value;
  let project = row.querySelector(".para-proj").value.trim();
  // Only ever populated by the auto-classify branch below (T4-T6) — a manually-picked
  // category/project (no LLM call) has no kind/person/mission opinion, and
  // paraDestinationDir already treats that as "other" (files under <Projects>/<project>).
  let kind, person, mission;
  const btn = row.querySelector(".para-file-btn");
  const prev = btn.textContent;
  btn.disabled = true;
  if (!category) {
    // No category picked — auto-classify via the same LLM path paraClassifyAll uses
    // (the paraClassify call inside paraClassifyAll above) instead of blocking with an alert.
    btn.textContent = "Категоризирую…";
    const cl = await window.api.paraClassify({
      note: it.note, root: state.para.root, folders: state.para.folders,
      mainModel: state.mainModel, language: state.language,
    });
    if (!cl || cl.error || !cl.category) {
      alert("Не удалось определить категорию автоматически — выбери вручную: " + ((cl && cl.error) || "категория не определена"));
      btn.disabled = false; btn.textContent = prev; return;
    }
    category = cl.category;
    row.querySelector(".para-cat").value = category;
    kind = cl.kind; person = cl.person; mission = cl.mission;
    // Keep a user-entered project as-is; only fill from classify if the field was empty.
    if (!project && cl.project) {
      project = cl.project;
      row.querySelector(".para-proj").value = project;
    }
  }
  const res = await window.api.paraFile({
    note: it.note, audio: it.audio, category, project, kind, person, mission,
    stamp: it.name,
    root: state.para.root, folders: state.para.folders,
  });
  if (res && res.ok === false) {
    alert("Не удалось разложить: " + res.error);
    btn.disabled = false; btn.textContent = prev; return;
  }
  markRowFiled(row); // filed into its classified folder — grey/disabled in place, same as the bulk path
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
refreshSetupGate(); // hard wall — independent of init()'s own async work, checked ASAP
