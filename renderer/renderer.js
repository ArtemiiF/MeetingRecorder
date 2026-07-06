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
  glossary: "",
  glossarySuggestions: [], // pending candidates from the "suggest" pipeline stage — accept/dismiss
  glossaryDismissed: [],   // dismissed candidates (original case; compared lowercased) — never re-suggested
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

// ── models (settings "Модели" section: cache status + on-demand pre-download) ──
// Additive, separate from the "Готовность" preflight section above — reuses its
// pf-row/pf-dot/pf-detail CSS, but is its own independent maintenance action
// (own IPC channel/process slot in main.js), not a preflight diagnostic.
let modelDlRunning = false;

function modelRowState(item) { return item.cached ? "ok" : item.locked ? "bad" : "warn"; }
function modelRowIcon(item) { return item.cached ? "✅" : item.locked ? "🔒" : "⬇"; }
function modelRowDetail(item) {
  if (item.cached) return "скачано";
  if (item.locked) return "нужен HF-токен";
  return `нужно скачать (~${item.size_mb} МБ)`;
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
  document.querySelectorAll("#modelsList .pf-retry").forEach((b) => { b.disabled = running; });
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
$("modelsRefresh").addEventListener("click", refreshModels);
$("modelsDownloadMissing").addEventListener("click", () => startModelDownload());

// Per-row live status while a download batch runs — ev.stage is "model:<id>"
// (backend.py's stage/stage_end vocabulary, same as the pipeline's own stages).
window.api.onModelDownloadEvent((ev) => {
  const rowFor = (stageName) => (stageName ? $("model-row-" + stageName.replace(/^model:/, "")) : null);
  if (ev.event === "stage") {
    const row = rowFor(ev.stage);
    if (row) {
      row.querySelector(".pf-dot").className = "pf-dot warn";
      row.querySelector(".pf-detail").textContent = "⏳ скачивается…";
    }
  } else if (ev.event === "stage_end") {
    const row = rowFor(ev.stage);
    if (row) {
      const icon = ev.status === "ok" ? "✅ " : ev.status === "skip" ? "⏭ " : "⚠️ ";
      row.querySelector(".pf-dot").className = "pf-dot " + (ev.status === "fail" ? "bad" : "ok");
      row.querySelector(".pf-detail").textContent = icon + (ev.msg || "");
    }
  } else if (ev.event === "download-closed") {
    setModelsDownloadUI(false);
    refreshModels(); // re-check real cache state — converges cached/needed/locked either way
  } else if (ev.event === "disk-warning") {
    alert(ev.msg);
  }
});

// settings / readiness modal
function openSettings() { $("settingsOverlay").classList.remove("hidden"); refreshPreflight(); refreshModels(); }
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
  state.glossary = data.glossary || DEFAULT_GLOSSARY;
  state.glossarySuggestions = data.glossarySuggestions || [];
  state.glossaryDismissed = data.glossaryDismissed || [];
  state.para = data.para || null;
  state.secretEncrypted = data.secretEncrypted !== false;
  $("outDir").value = state.outDir;
  $("hfToken").value = state.hfToken;
  $("language").value = state.language;
  $("authorName").value = state.authorName;
  $("glossary").value = state.glossary;
  renderGlossaryChips();
  renderGlossarySuggestions();
  updateTokenWarn();
  renderPresets();
  if (state.presets.length) selectPreset(0);
  refreshHistory();

  // Restore the persistent pending-recordings queue (survives an app restart —
  // main.js reads it back from pending.json).
  const pending = await window.api.listPendingRecordings();
  state.pendingRecordings = (pending || []).map((r) => ({ ...r, status: "pending" }));
  renderPendingRecordings();
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
    outDirCustom: state.outDirCustom,
    hfToken: state.hfToken,
    language: state.language,
    authorName: state.authorName,
    glossary: state.glossary,
    glossarySuggestions: state.glossarySuggestions,
    glossaryDismissed: state.glossaryDismissed,
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

$("glossary").addEventListener("change", (e) => {
  state.glossary = e.target.value || "";
  renderGlossaryChips();
  persistPresets();
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

function renderGlossaryChips() {
  const terms = parseGlossaryTerms(state.glossary);
  const box = $("glossaryChips");
  box.innerHTML = terms.length
    ? terms.map((t) =>
        `<span class="chip"><span class="chip-text">${escapeHtml(t)}</span>` +
        `<button type="button" class="chip-remove" aria-label="Удалить">×</button></span>`
      ).join("")
    : '<p class="hint">Список пуст — добавь термин ниже.</p>';
  // Term is captured via closure (index into `terms`, the same array that produced
  // this innerHTML, in the same order) rather than round-tripped through a
  // data-* attribute — a term containing a `"` would otherwise break out of the
  // attribute (escapeHtml only escapes &<>, not quotes) and also desync removal,
  // since the garbled attribute value would no longer match the original term.
  box.querySelectorAll(".chip-remove").forEach((btn, i) =>
    btn.addEventListener("click", () => removeGlossaryTerm(terms[i])));
  $("glossaryCount").textContent = terms.length + " терминов";
}

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

function renderPendingRecordings() {
  const wrap = $("pendingRecordings");
  const list = state.pendingRecordings || [];
  wrap.innerHTML = "";
  wrap.classList.toggle("hidden", list.length === 0);
  list.forEach((item, idx) => {
    const icon = QUEUE_STATUS_ICON[item.status] || "⏳";
    const row = document.createElement("div");
    row.className = "queue-item queue-" + item.status;
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
    wrap.appendChild(row);
  });
  const hasWork = list.some((it) => it.status === "pending" || it.status === "failed");
  $("pendingProcessAll").classList.toggle("hidden", !hasWork);
}

function nextPendingWork() {
  return (state.pendingRecordings || []).find((it) => it.status === "pending" || it.status === "failed");
}

function runPendingItem(item) {
  item.status = "running";
  renderPendingRecordings();
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
  renderPendingRecordings();
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
  renderPendingRecordings();
  return true;
}

// true while a run in progress/last-acted belongs to the import queue (vs. record mode).
function queueActive() {
  return state.mode === "import" && state.queueIndex >= 0 && state.queueIndex < state.importQueue.length;
}

// Entry point wired to runBtn/retryBtn/freshBtn when mode==='import'. Starts
// the item at queueIndex (or the first item, on a fresh queue).
function startQueueRun(fresh) {
  if (!state.importQueue.length) return;
  if (state.queueIndex < 0 || state.queueIndex >= state.importQueue.length) state.queueIndex = 0;
  const item = state.importQueue[state.queueIndex];
  if (item) item.status = "running";
  queueSingleRetry = false; // whole-queue entry point, not a single-row retry
  renderImportQueue();
  startProcessing(fresh);
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
      renderPendingRecordings();
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
async function startProcessing(fresh, item) {
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

  const res = await window.api.processAudio({
    audioFile,
    prompt: $("prompt").value,
    diarize: $("diarize").checked,
    outDir: state.outDir,
    engine: "mlx",
    hfToken: state.hfToken,
    fresh: !!fresh,
    language: state.language,
    glossary: state.glossary,
    summarize: !$("noSummary").checked,
    template: (state.presets[state.currentPreset] || {}).name || "",
    // auto-«Я»: only meaningful for a record-sourced mic/system pair — import mode
    // never passes an item, so these stay undefined and the backend sees identical
    // argv to today.
    ...(item ? { micFile: item.mic, systemFile: item.system, authorName: state.authorName } : {}),
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
  ["record", "history", "para", "glossary"].forEach((id) => $("view-" + id).classList.toggle("hidden", id !== v));
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
    return (!q || textMatchesQuery(it.title || "", q) || textMatchesQuery(it.name || "", q)) &&
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
  setImportQueue([audio]); // queue-of-1 — same path as an N-file batch
  $("pickedFile").textContent = audio.split("/").pop();
  startQueueRun();
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
