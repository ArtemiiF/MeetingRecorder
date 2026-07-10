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
  authorName: "Автор",
  fastModel: "",
  glossary: "",
  glossarySuggestions: [], // pending candidates from the "suggest" pipeline stage — accept/dismiss
  glossaryDismissed: [],   // dismissed candidates (original case; compared lowercased) — never re-suggested
  glossaryUsage: {},       // cumulative {termLower: fireCount} — merged in from each "done" event
                           // (see mergeGlossaryUsage), fed back to backend.py to order the
                           // Whisper initial_prompt's terms before its token-budget truncation.
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
  state.authorName = data.authorName || "Автор";
  state.fastModel = data.fastModel || "";
  state.glossary = data.glossary || DEFAULT_GLOSSARY;
  state.glossarySuggestions = data.glossarySuggestions || [];
  state.glossaryDismissed = data.glossaryDismissed || [];
  state.glossaryUsage = data.glossaryUsage || {};
  state.para = data.para || null;
  state.secretEncrypted = data.secretEncrypted !== false;
  $("outDir").value = state.outDir;
  $("hfToken").value = state.hfToken;
  $("language").value = state.language;
  $("authorName").value = state.authorName;
  $("fastModel").value = state.fastModel;
  $("glossary").value = state.glossary;
  renderGlossaryChips();
  renderGlossarySuggestions();
  updateTokenWarn();
  renderPresets();
  if (state.presets.length) selectPreset(0);
  refreshHistory();

  // Restore the persistent pending-recordings queue (survives an app restart —
  // main.js reads it back from pending.json). Rendered inline in the История rail
  // (renderRail) — there is no separate control strip.
  const pending = await window.api.listPendingRecordings();
  state.pendingRecordings = (pending || []).map((r) => ({ ...r, status: "pending" }));
  renderRail();
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
async function persistPresets() {
  await window.api.savePresets({
    presets: state.presets,
    defaultOutDir: state.outDir,
    outDirCustom: state.outDirCustom,
    hfToken: state.hfToken,
    language: state.language,
    authorName: state.authorName,
    fastModel: state.fastModel,
    glossary: state.glossary,
    glossarySuggestions: state.glossarySuggestions,
    glossaryDismissed: state.glossaryDismissed,
    glossaryUsage: state.glossaryUsage,
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

function usageBadge(term) {
  const n = (state.glossaryUsage || {})[term.toLowerCase()] || 0;
  return n > 0 ? ` <span class="chip-usage">${n}×</span>` : "";
}

function glossaryChipHtml(t) {
  return `<span class="chip"><span class="chip-text">${escapeHtml(t)}${usageBadge(t)}</span>` +
    `<button type="button" class="chip-remove" aria-label="Удалить">×</button></span>`;
}

// Chips split into "Мои" (custom terms, always shown) and "Стандартные" (terms
// that are also in DEFAULT_GLOSSARY — there can be 100+, so collapsed by
// default with a toggle). A live substring filter narrows both sections and
// forces "Стандартные" open while it has matches, so a hidden default term is
// still reachable by typing instead of manually expanding first.
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
    const expandDefault = !glossaryDefaultCollapsed || (!!q && defaultShown.length > 0);
    const defaultCountLabel = q ? `${defaultShown.length} из ${defaultTerms.length}` : `${defaultTerms.length}`;
    box.innerHTML =
      `<div id="glossaryChipsMine" class="chip-list">${mineShown.map(glossaryChipHtml).join("")}</div>` +
      (defaultTerms.length
        ? `<div class="glossary-section-default">` +
          `<button type="button" id="glossaryDefaultToggle" class="glossary-section-toggle">` +
          `<span class="glossary-caret">${expandDefault ? "▾" : "▸"}</span> Стандартные ` +
          `<span class="glossary-count">${defaultCountLabel}</span></button>` +
          `<div class="chip-list glossary-default-chips${expandDefault ? "" : " hidden"}">` +
          `${defaultShown.map(glossaryChipHtml).join("")}</div></div>`
        : "");
    // Term is captured via closure (index into the SHOWN array that produced
    // each section's innerHTML) rather than round-tripped through a data-*
    // attribute — a term containing a `"` would otherwise break out of the
    // attribute (escapeHtml only escapes &<>, not quotes) and also desync
    // removal, since the garbled attribute value would no longer match the
    // original term.
    box.querySelector("#glossaryChipsMine").querySelectorAll(".chip-remove").forEach((btn, i) =>
      btn.addEventListener("click", () => removeGlossaryTerm(mineShown[i])));
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

// Builds one pending-recording row (icon + name + ▶/✕) for the История rail — the single
// render path for a pending recording (owner decision: no separate control strip — see
// renderRail below). idx is the item's current position in state.pendingRecordings.
function buildPendingRow(item, idx) {
  const icon = QUEUE_STATUS_ICON[item.status] || "⏳";
  const row = document.createElement("div");
  row.className = "rail-item pending queue-item queue-" + item.status;
  row.innerHTML =
    `<span class="queue-icon">${icon}</span><span class="queue-name">${escapeHtml(item.name)}</span>`;
  const canProcess = item.status === "pending" || item.status === "failed";
  // First trailing button gets queue-retry-btn's margin-left:auto (pushes this
  // row's action button(s) to the right, same as renderImportQueue's ↻).
  if (canProcess) {
    // Closure over idx only (never the item's name/paths) — same rationale as
    // renderImportQueue's retry button: no user/LLM string in an HTML attribute.
    const playBtn = document.createElement("button");
    playBtn.className = "btn small pending-play-btn queue-retry-btn";
    playBtn.textContent = "▶";
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

// "Удалить" — removes the manifest entry + its on-disk session dir. Never deletes
// the row that's currently being processed (its outcome must land first).
function deletePendingRecording(idx) {
  const item = state.pendingRecordings[idx];
  if (!item || item.status === "running") return;
  state.pendingRecordings.splice(idx, 1);
  renderRail();
  window.api.removePendingRecording(item.id);
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

// Topnav badge — the only DOM region visible across all tabs (switchView()
// only hides #view-*, not the sibling <nav>), so this is where a recording
// stays visible even while the user is on История/PARA/Словарь.
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
    $("timer").textContent = "00:00";
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
    await window.api.stopRecording();
  }
}
$("recBtn").addEventListener("click", toggleRecording);
window.api.onTrayRecordToggle(toggleRecording);

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
      state.pendingRecordings.push({
        id: ev.id, name: ev.name || `Запись ${ev.id}`,
        mixed: ev.file, mic: ev.mic, system: ev.system, tracks: ev.tracks,
        status: "pending",
      });
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
    summarize: !$("noSummary").checked,
    template: override ? override.template : (activePreset.name || ""),
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
    if (cached) $("stage-" + ev.stage)?.classList.add("cached");
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
function switchView(v) {
  document.querySelectorAll(".topbtn").forEach((b) => b.classList.toggle("active", b.dataset.view === v));
  ["record", "history", "para", "glossary", "prompts"].forEach((id) => $("view-" + id).classList.toggle("hidden", id !== v));
  if (v === "history") refreshHistory();
  if (v === "para") renderPara();
}
document.querySelectorAll(".topbtn").forEach((b) => b.addEventListener("click", () => switchView(b.dataset.view)));
$("historyRefresh").addEventListener("click", refreshHistory);

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

// Note-origin badge (item 7): recording/batch/file are set by the backend at save time
// (backend.py Pipeline.process — see `source` frontmatter key); a legacy note saved before
// this feature existed has no `source` key at all → explicit "unknown" badge, never inferred.
const SOURCE_BADGE_ICON = { recording: "🎙", batch: "📦", file: "📄" };
const SOURCE_BADGE_TITLE = { recording: "Запись", batch: "Пакетная обработка", file: "Загруженный файл" };
function sourceBadge(source) {
  const icon = SOURCE_BADGE_ICON[source] || "❓";
  const title = SOURCE_BADGE_TITLE[source] || "Тип не определён (старая заметка)";
  return ` <span class="rail-badge" title="${escapeHtml(title)}">${icon}</span>`;
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

// render the rail filtered by search (title/date) + language + template + date range.
// dataset.idx points into the full historyItems so selection survives filtering.
// Pending recordings (state.pendingRecordings) render first and ALWAYS, bypassing every
// filter below — they aren't notes yet (no template/language/date to filter by), and the
// owner wants them visible in История regardless of whatever the rail is currently filtered to.
function renderRail() {
  const q = ($("historySearch").value || "").trim().toLowerCase();
  const lang = $("historyLang").value;
  const tmpl = $("historyTemplate").value;
  const from = $("historyFrom").value; // YYYY-MM-DD or ""
  const to = $("historyTo").value;
  const rail = $("historyList");
  rail.innerHTML = "";
  const pending = state.pendingRecordings || [];
  // The rail is the single render path for a pending recording (owner decision — no
  // separate control strip). Rows wire the same processPendingRecording/deletePendingRecording
  // used everywhere else; the row itself gets no click listener, so clicking it (outside the
  // buttons) is a no-op — it must never call selectNote/readNote like a real note row does.
  pending.forEach((item, idx) => rail.appendChild(buildPendingRow(item, idx)));
  const hasWork = pending.some((it) => it.status === "pending" || it.status === "failed");
  $("pendingProcessAll").classList.toggle("hidden", !hasWork);
  // Backend-merged listHistory rows carry kind:"pending" too (cmd_history --pending-file) —
  // real notes never do. Exclude them here so a restart-era pending row (already covered by
  // state.pendingRecordings above, loaded from the same manifest) isn't rendered a second
  // time as a broken "note" (it has no `note` path for openHistoryNote to read).
  const notes = historyItems.filter((it) => it.kind !== "pending");
  if (!notes.length) {
    rail.insertAdjacentHTML("beforeend", '<p class="hint">Пока пусто.</p>');
    return;
  }
  const shown = notes.filter((it) => {
    const d = (it.name || "").slice(0, 10); // stamp = YYYY-MM-DD-HHMMSS → ISO date sorts lexically
    return (!q || textMatchesQuery(it.title || "", q) || textMatchesQuery(it.name || "", q)) &&
      (!lang || it.language === lang) &&
      (!tmpl || it.template === tmpl) &&
      (!from || d >= from) && (!to || d <= to);
  });
  if (!shown.length) {
    rail.insertAdjacentHTML("beforeend", '<p class="hint">Ничего не найдено.</p>');
    return;
  }
  // Date-group headers: counted over `shown` (the filtered list) so "8 июля · N" always
  // matches what's actually visible, not the unfiltered total. `shown` is already in
  // backend/stamp order (see comment above notes filter), so same-day rows are
  // contiguous — a single forward pass with a running "last date seen" is enough.
  const dateCounts = new Map();
  shown.forEach((it) => {
    const d = (it.name || "").slice(0, 10);
    if (!d) return;
    dateCounts.set(d, (dateCounts.get(d) || 0) + 1);
  });
  let lastDate = null;
  shown.forEach((it) => {
    const d = (it.name || "").slice(0, 10);
    if (d && d !== lastDate) {
      lastDate = d;
      const header = document.createElement("div");
      header.className = "rail-date-header";
      header.textContent = `${formatGroupDate(d)} · ${dateCounts.get(d)}`;
      rail.appendChild(header);
    }
    const idx = historyItems.indexOf(it);
    const el = document.createElement("button");
    el.className = "rail-item";
    el.dataset.idx = idx;
    el.innerHTML = `<span class="rail-title">${escapeHtml(it.title || "Без темы")}</span>` +
      `<span class="rail-date">${escapeHtml(it.name)}${sourceBadge(it.source)}</span>`;
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
       <button class="btn small" id="nvCopyPath" title="Скопировать путь до заметки">📋 Путь</button>
       <button class="btn small ghost" id="nvReprocess">↻ Переобработать</button>
     </div>
     ${meta ? `<div class="note-meta">${escapeHtml(meta)}</div>` : ""}
     <div class="note-body">${renderMarkdown(md)}</div>`;
  $("nvOpen").onclick = () => window.api.reveal(item.note);
  if (item.audio) $("nvAudio").onclick = () => window.api.reveal(item.audio);
  $("nvCopyPath").onclick = () => copyToClipboard(item.note, $("nvCopyPath"), "✓ Скопировано", 1500);
  $("nvReprocess").onclick = () => { if (item.audio) openReprocessPicker(item); };
}

// Small inline panel appended to #noteView (not a full modal) letting the user pick
// which template to reprocess with, instead of silently reusing whatever the record
// card last held. Built entirely via createElement/textContent/property assignment —
// no innerHTML of user strings — so a template name can never break out as markup or
// an HTML attribute (same discipline as the chip/rail renderers).
function openReprocessPicker(item) {
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
    closeReprocessPicker();
    reprocessHistory(item.audio, presetId);
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
  $("noteView").appendChild(panel);
}
function closeReprocessPicker() {
  const el = $("reprocessPicker");
  if (el) el.remove();
}

// presetId: the chosen template's stable id (from the reprocess picker) — resolved
// here to a {prompt, template} override rather than trusting whatever the record
// card's own state.currentPreset happens to be at call time.
function reprocessHistory(audio, presetId) {
  if (state.recording || state.processing) return; // don't hijack an active run
  const preset = state.presets.find((p) => p.id === presetId);
  switchView("record");
  state.mode = "import";
  document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x.dataset.tab === "import"));
  $("pane-record").classList.add("hidden");
  $("pane-import").classList.remove("hidden");
  setImportQueue([audio]); // queue-of-1 — same path as an N-file batch
  $("pickedFile").textContent = audio.split("/").pop();
  startQueueRun(false, preset ? { prompt: preset.prompt, template: preset.name } : undefined);
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
       <button class="btn small" id="ptvCopyPath" title="Скопировать путь до заметки">📋 Путь</button>
     </div>
     <h2 class="note-title">${escapeHtml(name)}</h2>
     <div class="note-body">${renderMarkdown(md)}</div>`;
  $("ptvOpen").onclick = () => window.api.reveal(path);
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
    res = await window.api.paraSearch(state.para.root, chatMessages.slice());
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
  if (!paraInboxItems.length) { box.innerHTML = '<p class="hint">Все заметки разобраны.</p>'; return; }
  paraInboxItems.forEach((it, idx) => {
    const row = document.createElement("div");
    row.className = "para-row";
    row.dataset.idx = idx;
    row.innerHTML =
      `<span class="para-row-spinner spinner hidden"></span>
       <div class="para-note">${escapeHtml(it.title || it.name)}</div>
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
      const r = await window.api.paraClassify({ note: it.note, root: state.para.root, folders: state.para.folders });
      if (!r || r.error || !r.category) {
        paraLog(`   ✗ не классифицирована: ${(r && r.error) || "категория не определена"}`);
        errors++;
        setRowProcessing(row, false);
        continue;
      }
      row.querySelector(".para-cat").value = r.category;
      row.querySelector(".para-proj").value = r.project || "";
      // distil knowledge sections, then append into the accumulator + archive the raw note
      const ex = await window.api.paraExtract(it.note);
      if (!ex || ex.error || !ex.content) {
        paraLog(`   ✗ ${r.category} подобрана, но выжимка не извлечена: ${(ex && ex.error) || "пусто"}`);
        errors++;
        setRowProcessing(row, false);
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
  markRowFiled(row); // distilled + archived — grey/disabled in place, same as the bulk path
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
