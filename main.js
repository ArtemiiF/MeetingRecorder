const {
  app, BrowserWindow, ipcMain, dialog, safeStorage, systemPreferences,
  Menu, Tray, nativeImage,
} = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const https = require("https");
const crypto = require("crypto");
const readline = require("readline");
const {
  WavWriter, rmsLevel, cacheKey, pairHistory,
  encodeTokenBlob, decodeTokenBlob, isStale,
  rewriteNoteSpeakers, isOutsideRoot, isNoteDeletable, indexRunReducer, upsertById, diskGuardVerdict, busyVerdict,
  isPathInsideRoots, contentFingerprint, isFileStable, paraDestinationDir,
  isAudioDeletable, trashRootFor, trashDestPath, moveToTrash, purgeTrash,
  trashDaysLeft, buildTrashEntry, restoreTrashFiles,
  deleteTrashEntryFiles, trashEntryBreakdown,
  resolveOutDirOnVaultChange, trayMenuTemplate,
  resolvePythonBin, resolveFfmpegBin, resolveResourcePath, resolveAudioTeeBin, resolveAssetPath, backendInstallStatus,
  parseFfmpegVersion,
  whisperModelDir, vadJitPath, diarizationModelDirs, appReadinessStatus,
  cleanupPartialModelCache, modelCacheDirsFor, dirSizeBytes, compareVersions, pickUpdateAsset,
} = require("./lib/mainutil");
// M4 arch-audit: single source of truth for backend.py's event-name protocol —
// see lib/events.js's own comment for the cross-lock this closes.
const { EVENT_NAMES, EVENTS } = require("./lib/events");
const EVENT_NAMES_SET = new Set(EVENT_NAMES);

// audiotee is ESM-only — load it lazily via dynamic import() from this CommonJS module.
let AudioTeeClass = null;
async function getAudioTee() {
  if (!AudioTeeClass) ({ AudioTee: AudioTeeClass } = await import("audiotee"));
  return AudioTeeClass;
}

// System audio (AudioTee Core Audio tap) is mono 16-bit PCM at this rate.
const SYS_SAMPLE_RATE = 16000;

function waitFor(cond, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (cond() || Date.now() - t0 > timeoutMs) { clearInterval(iv); resolve(); }
    }, 50);
  });
}

// ── paths ────────────────────────────────────────────────────────────────
// Test-only isolation: e2e/boot.test.js drives the PACKAGED app (playwright-core
// _electron.launch) and must never read/write the developer's real userData
// (presets.json, index.db, recordings, the backend-env install) — every
// app.getPath("userData") call below resolves through this override once set.
// Must run before app.whenReady() (Electron: setPath is only valid pre-ready);
// unset in every normal dev/packaged run, so behaviour is unchanged unless a
// caller opts in explicitly via this env var.
if (process.env.MEETING_RECORDER_USER_DATA) {
  app.setPath("userData", process.env.MEETING_RECORDER_USER_DATA);
}
const APP_DIR = __dirname;
const PROJECT_DIR = path.dirname(APP_DIR); // MeetingRecorder/
const VENV_PYTHON = path.join(PROJECT_DIR, "venv", "bin", "python");
// backend.py/requirements.txt/vendor-wheels ship as app resources — packaged under
// process.resourcesPath (via electron-builder extraResources), dev checkout has them
// directly in APP_DIR. See resolveResourcePath (lib/mainutil).
const BACKEND = resolveResourcePath(app.isPackaged, process.resourcesPath, APP_DIR, "backend.py");
const REQUIREMENTS_FILE = resolveResourcePath(app.isPackaged, process.resourcesPath, APP_DIR, "requirements.txt");
const VENDOR_WHEELS_DIR = resolveResourcePath(app.isPackaged, process.resourcesPath, APP_DIR, "vendor/wheels");
// audiotee resolves its own binary relative to its own (asar-internal, once
// packaged) __dirname and relies on Electron's implicit asar→unpacked spawn
// redirect to find the real bin — passed explicitly here instead so system
// audio never depends on that implicit behaviour. See resolveAudioTeeBin
// (lib/mainutil) for why this isn't just resolveResourcePath.
const AUDIOTEE_BIN = resolveAudioTeeBin(app.isPackaged, process.resourcesPath, APP_DIR);
console.log("[audiotee] binaryPath resolved to:", AUDIOTEE_BIN);
// Backend installer (settings "Бэкенд" section) — the heavy Python/ML stack (~1.3GB)
// is installed on-demand into userData rather than bundled into the .app, so the
// app itself stays thin and trivially code-signable (see install-backend below).
const BACKEND_ENV = path.join(app.getPath("userData"), "backend-env");
// install-backend stages a full install here first (python extract → ffmpeg →
// pip → marker write), then atomic-renames it onto BACKEND_ENV only once
// complete — a half-finished install can never be observed at BACKEND_ENV's
// resolved path, so pythonBin()/backendAvailable() never see a depless
// interpreter or a stale/partial ffmpeg. Sibling of BACKEND_ENV (same
// userData volume) so the final rename is a real, near-atomic POSIX rename,
// not a cross-device copy.
const BACKEND_ENV_STAGING = path.join(app.getPath("userData"), "backend-env.staging");
const INSTALLED_PYTHON = path.join(BACKEND_ENV, "python", "bin", "python3.11");
const INSTALLED_FFMPEG = path.join(BACKEND_ENV, "bin", "ffmpeg");
const BACKEND_MARKER = path.join(BACKEND_ENV, ".installed.json");
// Writable user state (presets, recordings, the derived index, the HF-token secret)
// must live outside the app bundle once packaged: __dirname/APP_DIR then resolves
// inside app.asar (or a signed, otherwise-immutable Resources/app), which rejects
// writes outright — the unconditional fs.mkdirSync(RECORDINGS_DIR) below would throw
// at launch. Dev checkout keeps writing next to the source tree (APP_DIR) so
// presets.json/index.db and the existing tests are untouched. Mirrors the BACKEND_ENV
// userData convention above.
const WRITABLE_DIR = app.isPackaged ? app.getPath("userData") : APP_DIR;
const PRESETS_FILE = path.join(WRITABLE_DIR, "presets.json");
const PRESETS_EXAMPLE = path.join(APP_DIR, "presets.example.json"); // read-only template, ships with the app
const DB_PATH = path.join(WRITABLE_DIR, "index.db"); // derived SQLite index (gitignored)
const TMP_DIR = path.join(os.tmpdir(), "meeting-recorder");
const DEFAULT_OUT = path.join(os.homedir(), "Documents", "Obsidian", "Meetings");
// Recordings live outside TMP_DIR (not swept by pruneTemp) so they survive an app
// restart — mixed/mic/system WAVs pile up here until processed. PENDING_FILE tracks
// which ones are still waiting (see loadPendingManifest/savePendingManifest below).
const RECORDINGS_DIR = path.join(WRITABLE_DIR, "recordings");
const PENDING_FILE = path.join(RECORDINGS_DIR, "pending.json");

fs.mkdirSync(TMP_DIR, { recursive: true });
fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

let mainWindow = null;
let tray = null;         // menu-bar Tray — module-level ref so GC doesn't kill it
let isRecording = false; // mirrors renderer's state.recording, pushed over "recording-state"
let recordProc = null; // live mic recording subprocess
let procProc = null;   // live processing subprocess
let autoIndexProc = null; // background auto-index subprocess (fires after a successful process run)
let procCanceled = false; // set when the user cancels processing
let modelDlProc = null;    // live model-download subprocess (settings "Модели" section)
let modelDlCanceled = false; // set when the user cancels a model download
let searchProc = null;      // live para-search subprocess (chat/search chunk)
let searchCanceled = false; // set when the user cancels an in-flight search
let installBackendProc = null;    // current killable step of an in-flight backend install (settings "Бэкенд")
let installBackendCanceled = false; // set when the user cancels an in-flight backend install
let tee = null;        // AudioTee instance (system audio)
let sysWav = null;     // WavWriter for system.wav
let session = null;    // { dir, micPath, sysPath, mixedPath, micRecorded }
// True while a mix (spawned in stop-recording, see runBackend below) is still
// running in the background. `session` is reassigned unconditionally on every
// start-recording call — without this flag a new recording could start (and
// reassign `session`) while an older recording's mix is still in flight, which
// used to let the mix's completion closure read the WRONG (new) session for
// id/dir/mic/system while `mixed` still pointed at the OLD file (cross-link
// bug). Set true right before the mix's runBackend call, cleared in that
// call's onClose — onClose is guaranteed to fire on success, backend error, AND
// process-spawn failure (see runBackend's proc.on("close"/"error") below), so a
// failed mix can never wedge recording permanently.
let mixInFlight = false;

function pythonBin() {
  return resolvePythonBin(
    INSTALLED_PYTHON, fs.existsSync(INSTALLED_PYTHON), fs.existsSync(BACKEND_MARKER),
    VENV_PYTHON, fs.existsSync(VENV_PYTHON)
  );
}

function ffmpegBin() {
  return resolveFfmpegBin(INSTALLED_FFMPEG, fs.existsSync(INSTALLED_FFMPEG));
}

// Whether a backend interpreter capable of actually running backend.py's ML
// pipeline is available at all — either a COMPLETE userData install (python +
// completion marker both present — see resolvePythonBin's comment for why the
// marker check matters), or (dev machines) the ../venv checkout. Bare
// "python3" fallback doesn't count: it almost never has the heavy deps, so
// callers use this to refuse outright rather than spawn a doomed
// process-audio/recording run. Kept in sync with backend-status's
// marker-based backendInstallStatus() below — both must agree on what
// "installed" means for the userData env specifically.
function backendAvailable() {
  return (fs.existsSync(INSTALLED_PYTHON) && fs.existsSync(BACKEND_MARKER)) || fs.existsSync(VENV_PYTHON);
}

// ── setup-gate readiness (renderer's #setupGate hard wall) ──────────────────
// Cache-existence checks for the wall's two REQUIRED models (whisper, vad) plus
// diarization (used only by process-audio's per-run diarize gate below, NOT
// part of the wall itself — see appReadinessStatus's comment in lib/mainutil).
// Paths come from lib/mainutil's whisperModelDir/vadJitPath/diarizationModelDirs,
// which mirror backend.py's MODEL_SPECS/_model_cached (backend.py:2623-2663).
const WHISPER_MODEL_DIR = whisperModelDir(os.homedir());
const VAD_JIT_PATH = vadJitPath(os.homedir());
const DIARIZATION_MODEL_DIRS = diarizationModelDirs(os.homedir());

function whisperCached() { return fs.existsSync(WHISPER_MODEL_DIR); }
function vadCached() { return fs.existsSync(VAD_JIT_PATH); }
function diarizationCached() { return DIARIZATION_MODEL_DIRS.every((d) => fs.existsSync(d)); }

// Send to renderer only if the window is still alive (avoids throw on close/reload).
function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

// Graceful: flush an in-progress recording to WAV, kill any processing child.
function shutdownChildren() {
  if (recordProc) {
    try { recordProc.stdin.write("stop\n"); } catch { recordProc.kill(); }
  }
  if (tee) {
    tee.stop().catch(() => {});
    try { if (sysWav) sysWav.close(); } catch {} /* best-effort */
    tee = null; sysWav = null;
  }
  if (procProc) procProc.kill();
}

// Spawn backend, stream parsed json events to the renderer over `channel`.
// Returns the child process. onDone(lastEvent) fires when it exits.
function runBackend(args, onEvent, onClose, extraEnv = {}) {
  const env = { ...process.env, PYTHONUNBUFFERED: "1", ...extraEnv };
  // backend.py resolves ffmpeg via shutil.which("ffmpeg") (convert_to_mono/cmd_mix/
  // cmd_preflight) — never touched directly. Prepending ffmpegBin()'s dir to PATH
  // here makes an installed static ffmpeg win over a brew-installed one with no
  // backend.py changes at all; when nothing is installed, ffmpegBin() returns the
  // bare "ffmpeg" and PATH is left untouched (shutil.which falls back as before).
  const resolvedFfmpeg = ffmpegBin();
  if (resolvedFfmpeg !== "ffmpeg") {
    env.PATH = `${path.dirname(resolvedFfmpeg)}${path.delimiter}${env.PATH || ""}`;
  }
  const proc = spawn(pythonBin(), [BACKEND, ...args], {
    // cwd must be a real on-disk directory for the OS-level spawn/chdir — APP_DIR
    // resolves inside app.asar once packaged (a virtual, Node-fs-only path; Electron's
    // asar transparency covers fs.* calls, not child_process's cwd), which fails with
    // ENOTDIR. path.dirname(BACKEND) is real in both modes: APP_DIR in dev (identical
    // to the old value — see resolveResourcePath), process.resourcesPath when packaged.
    cwd: path.dirname(BACKEND),
    env,
  });
  const rl = readline.createInterface({ input: proc.stdout });
  rl.on("line", (line) => {
    line = line.trim();
    if (!line) return;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      ev = { event: EVENTS.LOG, msg: line };
    }
    // M4 arch-audit: backend.py's own emit() asserts every event it sends against
    // the SAME events.json contract (backend.py can never emit outside it) — this
    // is the main.js-side half of the lock. An event name that isn't in the
    // contract at all (a stale main.js listening for a renamed/removed event, or a
    // version-mismatched backend.py) gets surfaced loudly here instead of silently
    // vanishing into whichever handler's narrower if/else-if chain happened to
    // receive it. Deliberately NOT warning for a cataloged event a given handler
    // simply doesn't special-case (e.g. a "log" line arriving during para-classify)
    // — that's normal, not a protocol violation, so this check is centralized here
    // (once per line) rather than repeated per-handler.
    if (ev && typeof ev.event === "string" && !EVENT_NAMES_SET.has(ev.event)) {
      console.warn(`[backend] неизвестное событие "${ev.event}" — нет в контракте events.json:`, ev);
    }
    onEvent(ev);
  });
  let stderr = "";
  proc.stderr.on("data", (d) => (stderr += d.toString()));
  proc.on("close", (code) => onClose(code, stderr));
  proc.on("error", (e) => onClose(-1, String(e)));
  return proc;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1040,
    height: 820,
    minWidth: 760,
    minHeight: 600,
    title: "Meeting Recorder",
    backgroundColor: "#111418",
    webPreferences: {
      preload: path.join(APP_DIR, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(APP_DIR, "renderer", "index.html"));
  // Close (red-button / Cmd+W) hides to the tray instead of quitting — recording
  // survives, app stays reachable from the dock + tray. `quitting` is set by
  // before-quit before this fires on a real quit path (Cmd+Q / tray "Выйти"),
  // so that path falls through to a real close instead of being intercepted.
  mainWindow.on("close", (e) => {
    if (!quitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

// Bring the window to front, creating it if it was never opened (or got destroyed).
// Shared by the dock icon (activate), tray "Открыть", and tray record-toggle.
function showWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
  } else {
    createWindow();
  }
}

// Delete tmp recording/cache dirs older than maxAgeMs (sensitive audio + unbounded growth).
function pruneTemp(maxAgeMs) {
  const now = Date.now();
  const sweep = (base, skip) => {
    let entries = [];
    try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || (skip && e.name === skip)) continue;
      const p = path.join(base, e.name);
      try {
        if (isStale(fs.statSync(p).mtimeMs, now, maxAgeMs)) fs.rmSync(p, { recursive: true, force: true });
      } catch {}
    }
  };
  // Recording session dirs now live under RECORDINGS_DIR (permanent, tracked in
  // PENDING_FILE) — this sweep only touches TMP_DIR, so it never deletes a pending
  // recording. The "rec-*" skip-cache branch is a safety net for pre-migration
  // leftovers under the old TMP_DIR location.
  sweep(TMP_DIR, "cache");                 // stray/legacy rec-* dirs, if any
  sweep(path.join(TMP_DIR, "cache"), null); // old per-audio cache dirs
}

// ── menu-bar tray ────────────────────────────────────────────────────────────
// Template image (filename ends in "Template" → macOS auto-tints it for dark/light
// menu bars using the alpha channel as the mask; the @2x file alongside it is picked
// up automatically by nativeImage's retina-representation lookup — no explicit
// setTemplateImage/resize call needed).
function createTray() {
  const iconPath = resolveAssetPath(app.isPackaged, process.resourcesPath, APP_DIR, "trayTemplate.png");
  const icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) console.error("[tray] icon failed to load:", iconPath);
  tray = new Tray(icon);
  tray.setToolTip("Meeting Recorder");
  refreshTray();
}

// Rebuilds the context menu (toggle label follows isRecording) and the "REC"
// title badge. Called once at tray creation and again whenever the renderer
// pushes a recording-state change. trayMenuTemplate (lib/mainutil) is the pure,
// testable descriptor builder — click handlers are wired here since Menu/Tray
// aren't available headless.
function refreshTray() {
  if (!tray) return;
  const items = trayMenuTemplate({ recording: isRecording }).map((d) => {
    if (d.type === "separator") return { type: "separator" };
    const item = { label: d.label, enabled: d.enabled !== false };
    if (d.id === "toggle-record") {
      item.click = () => {
        // starting: bring the recording UX (VU meter/timer/mic-errors) into view first
        if (!isRecording) showWindow();
        send("tray-record-toggle");
      };
    } else if (d.id === "open-window") {
      item.click = () => showWindow();
    } else if (d.id === "quit") {
      item.click = () => app.quit();
    }
    return item;
  });
  tray.setContextMenu(Menu.buildFromTemplate(items));
  tray.setTitle(isRecording ? "REC" : "");
}

app.whenReady().then(() => {
  try { pruneTemp(7 * 24 * 3600 * 1000); } catch {}
  try { cleanupUpdateLeftovers(); } catch {}
  try { purgeTrashOnStartup(); } catch {}
  createWindow();
  createTray();
});

let quitting = false;
app.on("before-quit", async (e) => {
  if (quitting) return;
  // Set unconditionally (not just on the recordProc/tee branch below) so the
  // auto-index respawn guard in startAutoIndex sees it on every quit path,
  // including the synchronous procProc/autoIndexProc-only branch.
  quitting = true;
  // mic.wav is finalized by python only after it sees "stop" — must await before exit
  if (recordProc || tee) {
    e.preventDefault();
    if (tee) { try { await tee.stop(); } catch {} /* best-effort */ try { if (sysWav) sysWav.close(); } catch {} /* best-effort */ tee = null; sysWav = null; }
    if (recordProc) {
      try { recordProc.stdin.write("stop\n"); } catch { recordProc.kill(); }
      // align with stop-recording: wait for the WAV to finalize, generous bound
      await waitFor(() => (session && (session.micRecorded || session.micErrored)) || recordProc === null, 30000);
    }
    if (procProc) procProc.kill();
    if (autoIndexProc) autoIndexProc.kill();
    if (modelDlProc) modelDlProc.kill();
    if (searchProc) searchProc.kill();
    if (installBackendProc) installBackendProc.kill();
    if (updateProc) updateProc.kill();
    app.quit();
  } else if (procProc || autoIndexProc || modelDlProc || searchProc || installBackendProc || updateProc) {
    if (procProc) procProc.kill();
    if (autoIndexProc) autoIndexProc.kill();
    if (modelDlProc) modelDlProc.kill();
    if (searchProc) searchProc.kill();
    if (installBackendProc) installBackendProc.kill();
    if (updateProc) updateProc.kill();
  }
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("activate", () => {
  // With close-hides-to-tray, getAllWindows() is rarely empty — dock-icon click
  // should just re-show the existing (possibly hidden) window, not spawn a second one.
  showWindow();
});

// ── IPC ────────────────────────────────────────────────────────────────────
ipcMain.handle("preflight", async () => {
  let lmStudio = false;
  let embedModel = false;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2000);
    const r = await fetch("http://localhost:1234/v1/models", { signal: ctrl.signal });
    clearTimeout(t);
    lmStudio = r.ok;
    if (r.ok) {
      try {
        const data = await r.json();
        const models = (data && data.data) || [];
        embedModel = models.some((m) => m.id && m.id.toLowerCase().includes("embed"));
      } catch {}
    }
  } catch {}
  let mic = "unknown", screen = "unknown";
  try { mic = systemPreferences.getMediaAccessStatus("microphone"); } catch {}
  try { screen = systemPreferences.getMediaAccessStatus("screen"); } catch {}
  const token = loadToken();
  const be = await new Promise((resolve) => {
    let out = {};
    runBackend(["preflight"], (ev) => { if (ev.event === EVENTS.PREFLIGHT) out = ev; },
      () => resolve(out), token ? { HF_TOKEN: token } : {});
  });
  return {
    lmStudio, mic, screen, embedModel,
    ffmpeg: !!be.ffmpeg, whisperCached: !!be.whisper_cached, hfToken: !!be.hf_token,
    backendInstalled: backendAvailable(),
  };
});

// Live LM Studio model inventory for the settings fastModel/mainModel dropdowns —
// fetched fresh each time the settings overlay opens (renderer's populateLmModelOptions,
// no polling). /api/v0/models (LM Studio's extended endpoint) carries a "type" field
// that plain /v1/models lacks, letting us filter out embedding models honestly instead
// of guessing from the id string. Any failure (LM Studio down, timeout, bad JSON)
// degrades silently to [] — the settings inputs stay usable as plain text, no error dialog.
ipcMain.handle("list-lm-models", async () => {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    const r = await fetch("http://localhost:1234/api/v0/models", { signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) return [];
    const data = await r.json();
    const models = (data && data.data) || [];
    return models
      .filter((m) => m && m.type !== "embeddings" && m.id)
      .map((m) => m.id);
  } catch {
    return [];
  }
});

// Setup-gate readiness (renderer's #setupGate hard wall) — unlike preflight's
// whisperCached above, this never spawns pythonBin(): before the backend is
// installed there may be no working interpreter at all (bare "python3" fallback
// can lack every ML dep, or not exist), so the model-cache check is plain
// Node fs, not a backend.py round-trip. See appReadinessStatus's comment in
// lib/mainutil for why diarization is excluded from `models`.
ipcMain.handle("app-readiness", async () => {
  return appReadinessStatus(backendAvailable(), whisperCached(), vadCached());
});

// macOS can only prompt for mic access while status is "not-determined" — once
// denied, the OS silently no-ops and the only path back is System Settings
// (see open-privacy-settings below). Non-darwin has no TCC gate to trigger.
ipcMain.handle("request-mic-access", async () => {
  if (process.platform !== "darwin") return true;
  try { return await systemPreferences.askForMediaAccess("microphone"); } catch { return false; }
});

// System audio (AudioTee's screen-capture TCC category) has no programmatic
// prompt from Electron at all — this just deep-links to the right pane.
ipcMain.handle("open-privacy-settings", async (_e, target) => {
  const { shell } = require("electron");
  const url = target === "screen"
    ? "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
    : "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone";
  await shell.openExternal(url);
});

// Open an external https link (e.g. the HF token page) in the default browser.
// https-only — never let the renderer hand shell.openExternal an arbitrary scheme.
ipcMain.handle("open-external", async (_e, url) => {
  if (typeof url !== "string" || !/^https:\/\//i.test(url)) return;
  const { shell } = require("electron");
  await shell.openExternal(url);
});

ipcMain.handle("list-devices", async () => {
  return new Promise((resolve) => {
    let devices = [];
    runBackend(["devices"], (ev) => {
      if (ev.event === EVENTS.DEVICES) devices = ev.devices;
    }, () => resolve(devices));
  });
});

function expandHome(p) {
  if (!p) return DEFAULT_OUT;
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

// Atomic JSON write (tmp + rename) so a crash mid-write can't truncate the file.
function writeJsonAtomic(file, obj) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf-8");
  fs.renameSync(tmp, file);
}

// Pending-recordings manifest ({ recordings: [{ id, name, stamp, dir, mixed, mic,
// system, tracks }] }) — recordings that finished capture but haven't been processed
// yet, so the queue survives an app restart.
function loadPendingManifest() {
  try {
    const data = JSON.parse(fs.readFileSync(PENDING_FILE, "utf-8"));
    return Array.isArray(data.recordings) ? data.recordings : [];
  } catch {
    return [];
  }
}
function savePendingManifest(recordings) {
  writeJsonAtomic(PENDING_FILE, { recordings });
}

// ── История trash (30-day retention) ─────────────────────────────────────────
// Trash manifest ({ entries: [...] }) — same shape convention as pending.json's
// { recordings: [...] } above. Lives inside the trash dir itself (<root>/.trash/
// manifest.json), not WRITABLE_DIR: the trash root is either out_dir or the PARA vault
// root depending on config (see trashRootFor, lib/mainutil.js), and the manifest must
// travel with whichever one is actually in use.
function loadTrashManifest(trashDir) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(trashDir, "manifest.json"), "utf-8"));
    return Array.isArray(data.entries) ? data.entries : [];
  } catch {
    return [];
  }
}
function saveTrashManifest(trashDir, entries) {
  writeJsonAtomic(path.join(trashDir, "manifest.json"), { entries });
}

// Current out_dir/vault-root pair from persisted config — same read delete-history-note's
// own `roots` computation always did, factored out so delete-history-recording and the
// startup purge below share one source of truth instead of three copies of the same
// two-line read.
function currentOutDirAndVault() {
  const presetsData = loadPresetsData();
  return { outDir: presetsData.defaultOutDir || DEFAULT_OUT, vaultRoot: readParaRoot() };
}

// One-time startup sweep (mirrors pruneTemp/cleanupUpdateLeftovers below, same
// try/catch-at-call-site discipline in app.whenReady): permanently deletes any trash
// entry older than 30 days. purgeTrash itself never throws; this function still isn't
// trusted blindly — the app.whenReady() call site wraps it in try/catch too, since a
// purge failure must never block app launch.
function purgeTrashOnStartup() {
  const { outDir, vaultRoot } = currentOutDirAndVault();
  const trashDir = trashRootFor(outDir, vaultRoot);
  if (!fs.existsSync(trashDir)) return;
  const entries = loadTrashManifest(trashDir);
  const kept = purgeTrash(entries, trashDir, 30 * 24 * 3600 * 1000, Date.now());
  if (kept.length !== entries.length) saveTrashManifest(trashDir, kept);
}

// HF token is a secret → kept out of presets.json, encrypted via OS keychain (safeStorage).
const SECRET_FILE = path.join(WRITABLE_DIR, ".secret");

// Every safeStorage call (decryptString/encryptString/isEncryptionAvailable) can trigger
// a macOS keychain-access prompt on some code-signing states. Startup alone calls
// loadToken()/isEncryptionAvailable() from BOTH the "preflight" handler and get-presets'
// loadPresetsData() — without caching, that's two independent keychain touches for the
// same launch → two prompts. Cache both for the life of the process; saveToken()
// invalidates the token cache since it's the only thing that can change it mid-run.
let _tokenCache = null;        // null = not loaded yet; "" is a valid (no-token) cached value
let _encAvailableCache = null;

function encryptionAvailable() {
  if (_encAvailableCache === null) _encAvailableCache = safeStorage.isEncryptionAvailable();
  return _encAvailableCache;
}

// L7 arch-audit: returns null on success, or a user-facing error string on
// failure — a failed keychain/file write used to vanish into this function's
// own catch with no way for save-presets (its only caller) to tell the
// renderer the token silently didn't persist. Returns null (not throw): every
// existing caller pre-dates this change and expects a plain call, not a
// try/catch — the NEW save-presets handler below is the one that reads this.
function saveToken(token) {
  try {
    if (!token) {
      // Best-effort: an already-missing/permission-denied unlink still leaves
      // the app in the intended "no token" state via _tokenCache below — a
      // failure to physically remove an already-irrelevant file has no
      // user-facing consequence worth surfacing.
      try { fs.unlinkSync(SECRET_FILE); } catch {}
      _tokenCache = null;
      return null;
    }
    const blob = encodeTokenBlob(token, encryptionAvailable(),
      (t) => safeStorage.encryptString(t));
    fs.writeFileSync(SECRET_FILE, blob, "utf-8");
    _tokenCache = null;
    return null;
  } catch (e) {
    return String((e && e.message) || e);
  }
}
function loadToken() {
  if (_tokenCache !== null) return _tokenCache;
  // No secret on disk → never touch safeStorage at all (avoids a keychain prompt on a
  // fresh machine / after a reset, where there's nothing to decrypt in the first place).
  if (!fs.existsSync(SECRET_FILE)) { _tokenCache = ""; return _tokenCache; }
  try {
    _tokenCache = decodeTokenBlob(fs.readFileSync(SECRET_FILE, "utf-8"),
      (b) => safeStorage.decryptString(b));
  } catch {
    _tokenCache = "";
  }
  return _tokenCache;
}

// Shared by get-presets and reset-app: read presets.json (or fall back to the
// committed presets.example.json template), expand paths, merge in the token.
function loadPresetsData() {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(PRESETS_FILE, "utf-8"));
  } catch {
    // fresh clone: fall back to the committed template (personal presets.json is gitignored)
    try {
      data = JSON.parse(fs.readFileSync(PRESETS_EXAMPLE, "utf-8"));
    } catch {
      const token = loadToken();
      // No token → secretEncrypted is moot (renderer's warning only reads it when
      // hfToken is truthy) → skip the encryption-availability lookup so a fresh/no-token
      // launch never touches the keychain.
      return { presets: [], defaultOutDir: DEFAULT_OUT, hfToken: token, secretEncrypted: token ? encryptionAvailable() : false };
    }
  }
  data.defaultOutDir = expandHome(data.defaultOutDir);
  if (data.para && data.para.root) data.para.root = expandHome(data.para.root);
  // Stable per-preset ids (prompts-tab / reprocess-picker feature): presets created
  // before this migration have no `id` — backfill once here so every preset can be
  // addressed by a stable id (not array index, which shifts on delete/reorder) from
  // now on. Persist immediately so the backfill runs at most once per preset.
  if (Array.isArray(data.presets) && data.presets.some((p) => p && !p.id)) {
    data.presets = data.presets.map((p) => (p && !p.id ? { ...p, id: crypto.randomUUID() } : p));
    const { hfToken, ...rest } = data;             // never persist the token in presets.json
    try { writeJsonAtomic(PRESETS_FILE, rest); } catch {}
  }
  let token = loadToken();
  if (!token && data.hfToken) {        // migrate legacy plaintext token out of presets.json
    token = data.hfToken;
    saveToken(token);
    const { hfToken, ...rest } = data;
    try { writeJsonAtomic(PRESETS_FILE, rest); } catch {}
  }
  delete data.hfToken;
  data.hfToken = token;
  // No token on disk → nothing to report on, and resolving encryption availability here
  // unconditionally would touch the keychain on every launch even when the user never
  // set an HF token at all. Only resolve it once there's an actual secret to describe.
  data.secretEncrypted = token ? encryptionAvailable() : false; // false → token stored reversibly (or absent)
  return data;
}

ipcMain.handle("get-presets", async () => loadPresetsData());

ipcMain.handle("save-presets", async (_e, data) => {
  const { hfToken, ...rest } = data;     // never persist the token in presets.json
  // L7 arch-audit: saveToken's own catch used to swallow a failed keychain/file
  // write entirely — this handler always returned bare `true` regardless, so a
  // user who just set an HF token had no way to learn it silently didn't
  // persist. {ok, error} matches every other write-handler's contract in this file.
  const tokenError = saveToken(hfToken || "");
  if (tokenError) return { ok: false, error: "Не удалось сохранить HF-токен: " + tokenError };
  writeJsonAtomic(PRESETS_FILE, rest);
  return { ok: true };
});

// Full app reset ("настроить заново"): writes a fresh presets.json (derived from the
// committed template) with para.root forced empty, and wipes the HF-token secret.
// Never touches index.db, the Obsidian vault, or notes/recordings — those are the
// source of truth (see README).
//
// Deliberately WRITES presets.json rather than just deleting it: deleting alone would
// leave get-presets' PRESETS_EXAMPLE fallback in play, and that template bakes in a
// real owner path (presets.example.json's para.root) — every subsequent get-presets
// call, including after an app restart, would resurrect it, so PARA would never
// actually read as unconfigured. Writing the cleared config directly removes the
// fallback from the picture entirely.
ipcMain.handle("reset-app", async () => {
  if (recordProc || tee || procProc || modelDlProc) {
    return { ok: false, error: "Нельзя сбросить настройки во время записи или обработки" };
  }
  let fresh;
  try {
    fresh = JSON.parse(fs.readFileSync(PRESETS_EXAMPLE, "utf-8"));
  } catch {
    fresh = { presets: [], defaultOutDir: DEFAULT_OUT, authorName: "Автор", fastModel: "", mainModel: "", glossary: "", language: "ru" };
  }
  if (fresh.para) fresh.para.root = "";
  else fresh.para = { root: "", folders: {} };
  // Write the fresh presets BEFORE clearing the token: writeJsonAtomic can throw
  // (disk full, permissions). If it does, bail out here with the old token still
  // intact instead of leaving a wiped token next to untouched (stale) presets.
  writeJsonAtomic(PRESETS_FILE, fresh);
  saveToken("");
  return loadPresetsData();
});

ipcMain.handle("pick-audio", async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    properties: ["openFile", "multiSelections"],
    filters: [{ name: "Audio", extensions: ["wav", "mp3", "m4a", "aac", "flac", "ogg", "mp4", "mov"] }],
  });
  return res.canceled ? null : res.filePaths;
});

ipcMain.handle("pick-out-dir", async () => {
  const res = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory", "createDirectory"] });
  return res.canceled ? null : res.filePaths[0];
});

// recording: start — mic (python/pyaudio) + system audio (AudioTee), in parallel
ipcMain.handle("start-recording", async (_e, opts) => {
  const busy = busyVerdict([
    [!!(recordProc || tee), "Запись уже идёт"],
    // A previous recording's mix (stop-recording) is still finishing in the background —
    // starting now would reassign the module-level `session` out from under it. See
    // mixInFlight's declaration above for the cross-link bug this closes.
    [mixInFlight, "Дождитесь завершения обработки предыдущей записи"],
    // Recording spawns pythonBin() too (mic capture) — a concurrent install-backend
    // run can be actively overwriting that same interpreter file underneath it.
    [!!installBackendProc, "Дождитесь окончания установки бэкенда"],
    // An in-flight update swaps the whole .app bundle out from under the running
    // process and finishes with app.exit(0) — which skips before-quit's graceful
    // mic-finalize wait entirely. A recording started during that window would
    // die unplayable at relaunch (WavWriter only patches its header in close()).
    [!!updateProc, "Идёт обновление приложения — дождитесь завершения"],
  ]);
  if (busy) return { ok: false, error: busy };

  // Disk guard: session dirs live under RECORDINGS_DIR (permanent — see PENDING_FILE
  // above) — check that volume's free space before committing to a recording. statfs
  // failures (unsupported FS, etc.) don't block recording — the guard degrades to
  // "ok" silently.
  let diskVerdict = { action: "ok", msg: null };
  try {
    const st = fs.statfsSync(RECORDINGS_DIR);
    diskVerdict = diskGuardVerdict(st.bavail * st.bsize);
  } catch {}
  if (diskVerdict.action === "refuse") return { ok: false, error: diskVerdict.msg };

  const micDevice = opts && opts.micDevice;
  const displayStamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  // Second-resolution timestamps collide if two recordings start within the same
  // second — start-recording's own recordProc/tee guard only blocks a SECOND
  // SIMULTANEOUS recording, not two that start back-to-back within one second.
  // A short random suffix keeps `stamp` (used for both the session dir name and
  // the pending-recordings manifest id — they must stay equal to each other)
  // unique per recording; displayStamp (no suffix) is the human-readable name.
  const stamp = `${displayStamp}-${Math.random().toString(36).slice(2, 6)}`;
  const dir = path.join(RECORDINGS_DIR, `rec-${stamp}`);
  fs.mkdirSync(dir, { recursive: true });
  session = {
    dir,
    stamp,
    displayStamp,
    micPath: path.join(dir, "mic.wav"),
    sysPath: path.join(dir, "system.wav"),
    mixedPath: path.join(dir, "mixed.wav"),
    micRecorded: false,
  };

  // mic track
  const micArgs = ["record", "--out", session.micPath];
  if (micDevice !== null && micDevice !== undefined && micDevice !== "")
    micArgs.push("--device", String(micDevice));
  recordProc = runBackend(
    micArgs,
    (ev) => {
      if (ev.event === EVENTS.RECORDED) session.micRecorded = true;
      if (ev.event === EVENTS.ERROR) session.micErrored = true;
      send("record-event", ev); // forwards elapsed/log → timer + logs
    },
    (code, stderr) => {
      if (code !== 0 && stderr) send("record-event", { event: "log", msg: "[mic] " + stderr.slice(-300) });
      recordProc = null;
    }
  );

  // system audio track (Core Audio tap, no virtual device)
  try {
    const AudioTee = await getAudioTee();
    sysWav = new WavWriter(session.sysPath, SYS_SAMPLE_RATE, 1, 16);
    // Belt-and-suspenders: the binary SHOULD exist at AUDIOTEE_BIN (see its
    // resolution above) — if it doesn't, log + surface it loudly rather than
    // let it fail silently inside AudioTee's spawn. Still attempt the spawn
    // below regardless (AudioTee/the OS may resolve it another way).
    if (!fs.existsSync(AUDIOTEE_BIN)) {
      console.error("[audiotee] binary NOT FOUND at resolved binaryPath:", AUDIOTEE_BIN);
      send("record-event", { event: "system-audio-error", msg: "аудио-бинарник не найден: " + AUDIOTEE_BIN });
    }
    tee = new AudioTee({ sampleRate: SYS_SAMPLE_RATE, chunkDurationMs: 200, binaryPath: AUDIOTEE_BIN });
    let sysWriteFailed = false;
    tee.on("data", (chunk) => {
      try { sysWav.write(chunk.data); }
      catch (e) {
        if (!sysWriteFailed) {  // surface once, don't spam every 200ms
          sysWriteFailed = true;
          send("record-event", { event: "system-audio-error", msg: "запись на диск не удалась: " + (e.message || e) });
        }
      }
      send("record-event", { event: "level", source: "system", level: rmsLevel(chunk.data) });
    });
    tee.on("error", (err) => {
      console.error("[audiotee] error:", err);
      send("record-event", { event: "system-audio-error", msg: String((err && err.message) || err) });
    });
    // audiotee's binary emits structured debug/info lines on stderr that the
    // library re-exposes as a "log" event (message_type, data) — surface them
    // to the terminal so a packaged-app run reveals the real cause of a
    // silent system-audio failure, not just "it didn't work".
    tee.on("log", (level, data) => console.log("[audiotee]", level, data));
    await tee.start();
    send("record-event", { event: "system-audio-started" });
  } catch (e) {
    // permission denied / macOS < 14.2 / spawn failure → continue mic-only, surface to UI
    console.error("[audiotee] failed to start:", e);
    send("record-event", { event: "system-audio-error", msg: String((e && e.message) || e) });
    if (sysWav) { try { sysWav.close(); } catch {} sysWav = null; }
    tee = null;
  }
  // low-disk warning goes last so it isn't clobbered by the system-audio status above
  if (diskVerdict.action === "warn") send("record-event", { event: "disk-warning", msg: diskVerdict.msg });
  return { ok: true };
});

// recording: stop both tracks, then mix → mixed.wav
ipcMain.handle("stop-recording", async () => {
  if (!recordProc && !tee) return { ok: false, error: "Запись не идёт" };

  // 1. stop system audio + finalize system.wav
  if (tee) {
    try { await tee.stop(); } catch {} /* best-effort */
    try { if (sysWav) sysWav.close(); } catch {} /* best-effort */
    tee = null; sysWav = null;
  }
  // 2. stop mic gracefully and wait for the WAV to be finalized
  if (recordProc) {
    try { recordProc.stdin.write("stop\n"); } catch { recordProc.kill("SIGTERM"); }
    // gate the mix on the file being written: `recorded`/`error` event or proc close
    // (close fires only after python's blocking writeframes — seconds even for hours of audio).
    await waitFor(() => session.micRecorded || session.micErrored || recordProc === null, 20000);
    if (!session.micRecorded && !session.micErrored && recordProc !== null) {
      // pathological hang — force-stop so the user isn't stuck on "Свожу дорожки…"; mix proceeds with whatever exists
      send("record-event", { event: "log", msg: "⚠️ микрофон завис — принудительно завершаю, дорожка может быть неполной" });
      try { recordProc.kill("SIGTERM"); } catch {} /* best-effort */
      await waitFor(() => recordProc === null, 3000);
    }
  }
  // 3. mix whatever tracks we actually got
  // Snapshot THIS recording's identity/paths now, before the async mix — `session`
  // is a module-level singleton that start-recording reassigns unconditionally, and
  // the mix below can still be running when a new recording starts (that window is
  // what mixInFlight, below, now closes — this snapshot is the direct fix so the
  // manifest entry can never cross-link even if some future path reopens the window).
  // The "mixed" closure must read ONLY `sess`, never the live `session`.
  const sess = session;
  const nonEmpty = (p) => fs.existsSync(p) && fs.statSync(p).size > 44;
  const micOk = nonEmpty(sess.micPath);
  const sysOk = nonEmpty(sess.sysPath);
  const args = ["mix", "--out", sess.mixedPath];
  if (micOk) args.push("--mic", sess.micPath);
  if (sysOk) args.push("--system", sess.sysPath);
  // NOTE: no auto track-alignment. A receipt-time delta (Date.now at first mic event
  // vs first AudioTee chunk) is dominated by python/pyaudio startup latency, not by the
  // real audio-start offset — injecting it as adelay added hundreds of ms of skew to
  // otherwise-fine mixes. Proper alignment needs PCM cross-correlation; until then amix
  // at t=0 (the raw-capture baseline) is the honest default. build_mix_filter still
  // supports adelay for a future real measurement.

  mixInFlight = true;
  runBackend(
    args,
    (ev) => {
      if (ev.event === EVENTS.MIXED) {
        // Recording finished capture — persist it to the pending-recordings manifest
        // (survives an app restart) before telling the renderer, so the queue and the
        // notification can never disagree about what's waiting to be processed.
        const id = sess.stamp;
        const name = `Запись ${sess.displayStamp}`;
        // Upsert-by-id (defense-in-depth): even with the snapshot above and the
        // mixInFlight start-guard below, replace-by-id rather than blind push so a
        // duplicate id can never land in the manifest if two completions ever raced.
        const manifest = upsertById(loadPendingManifest(), {
          id, name, stamp: sess.stamp, dir: sess.dir,
          mixed: ev.file, mic: micOk ? sess.micPath : null, system: sysOk ? sess.sysPath : null,
          tracks: ev.tracks,
        });
        savePendingManifest(manifest);
        send("record-event", {
          event: "recorded",
          id, name,
          file: ev.file,
          mic: micOk ? sess.micPath : null,
          system: sysOk ? sess.sysPath : null,
          tracks: ev.tracks,
        });
      } else if (ev.event === EVENTS.ERROR) {
        send("record-event", { event: "error", msg: ev.msg });
      } else {
        send("record-event", ev);
      }
    },
    // Clears mixInFlight unconditionally on the process's own close/error (see
    // runBackend's proc.on("close"/"error") — always fires exactly once), not inside
    // the "mixed"/"error" stdout-event branches above: this is the fail-safe that
    // guarantees a crashed or hung-then-killed mix can never wedge recording forever.
    () => { mixInFlight = false; }
  );
  return { ok: true };
});

// Fire-and-forget push from the renderer's 3 state.recording update sites
// (start / stop / mic-error) — keeps the tray menu label + "REC" title in sync
// even while the window is hidden. One-way notification, no response expected,
// hence ipcMain.on (not .handle).
ipcMain.on("recording-state", (_e, recording) => {
  isRecording = !!recording;
  refreshTray();
});

// List recordings still waiting to be processed. Drops (and persists the drop of)
// any entry whose mixed file vanished from disk (manual deletion outside the app,
// etc.) so the renderer never offers to process something that no longer exists.
ipcMain.handle("list-pending-recordings", async () => {
  const manifest = loadPendingManifest();
  const surviving = manifest.filter((r) => r.mixed && fs.existsSync(r.mixed));
  if (surviving.length !== manifest.length) savePendingManifest(surviving);
  return surviving;
});

// Remove one pending recording: delete its permanent session dir + drop the
// manifest entry. Used both for an explicit user delete and after a pending
// recording has been processed successfully.
ipcMain.handle("remove-pending-recording", async (_e, id) => {
  // Mirrors delete-history-note/delete-history-recording's own procProc guard: a
  // reprocess run may be actively reading this very entry's mixed.wav (--in) when
  // the user clicks remove — rmSync'ing entry.dir out from under it would corrupt
  // an in-flight run instead of just refusing the removal upfront.
  const busy = busyVerdict([[!!procProc, "Дождитесь окончания обработки"]]);
  if (busy) return { ok: false, error: busy };
  const manifest = loadPendingManifest();
  const idx = manifest.findIndex((r) => r.id === id);
  if (idx < 0) return { ok: false, error: "Запись не найдена" };
  const [entry] = manifest.splice(idx, 1);
  // L7 arch-audit: rmSync's own failure used to vanish into an empty catch while
  // this handler still unconditionally returned {ok:true}. The manifest entry
  // (and the renderer's optimistic row) still disappear either way — leaving the
  // entry behind would resurrect a row the user already saw vanish, on the next
  // list-pending-recordings reconcile — but the caller now learns honestly
  // whether the on-disk files were actually removed, instead of a false success.
  let rmError = null;
  try {
    if (entry.dir) fs.rmSync(entry.dir, { recursive: true, force: true });
  } catch (e) {
    rmError = String((e && e.message) || e);
  }
  savePendingManifest(manifest);
  if (rmError) {
    return { ok: false, error: "Запись убрана из очереди, но файлы на диске не удалены: " + rmError };
  }
  return { ok: true };
});

// Stable cache dir for an audio file (path+size+mtime+content fingerprint) →
// resumable stages survive a cancel/failed run, so a re-run reuses
// transcript/diarization instead of redoing them.
// H3b arch-audit: path+size+mtime ALONE can't tell an in-place rewrite that
// preserves size and lands on a coarse/same-second mtime from the original file
// — folding in contentFingerprint (lib/mainutil.js: sha1 of the first+last 64KB)
// closes that gap. This DELIBERATELY changes every existing cache key once —
// every cache computed before this fix is orphaned (never reused, never
// cleaned up automatically — same as any other TMP_DIR/cache leftover pruneTemp
// already sweeps on its own schedule).
function cacheDirFor(audioFile) {
  let tag = audioFile;
  try {
    const st = fs.statSync(audioFile);
    tag = `${audioFile}:${st.size}:${Math.round(st.mtimeMs)}:${contentFingerprint(audioFile)}`;
  } catch {}
  const dir = path.join(TMP_DIR, "cache", cacheKey(tag));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// H3a arch-audit: how long to wait between the two file-size samples in
// process-audio's stability gate below. cmd_mix's ffmpeg subprocess.run is
// synchronous (backend.py) — a genuine writer finishes well within this window;
// this only needs to be long enough to CATCH an actively-growing file, not to
// outlast a slow one.
const FILE_STABILITY_WAIT_MS = 300;

// processing pipeline
ipcMain.handle("process-audio", async (_e, opts) => {
  const { audioFile, prompt, diarize, outDir, engine, hfToken, fresh, language, glossary, summarize, template, micFile, systemFile, authorName, origin, fastModel, mainModel, glossaryUsage, version } = opts;
  const busy = busyVerdict([
    [!!procProc, "Обработка уже идёт"],
    [!!modelDlProc, "Дождитесь окончания скачивания моделей"],
    // Same reasoning as start-recording's guard above: processing spawns pythonBin(),
    // which an in-flight install may be actively replacing on disk.
    [!!installBackendProc, "Дождитесь окончания установки бэкенда"],
    // Same reasoning as start-recording's updateProc guard above.
    [!!updateProc, "Идёт обновление приложения — дождитесь завершения"],
  ]);
  if (busy) return { ok: false, error: busy };
  if (!backendAvailable()) return { ok: false, error: "Бэкенд не установлен — откройте Настройки → Бэкенд" };
  // H3a arch-audit — file-stability gate (TODO.md incident: a 25-min recording was
  // processed as 0.4s because mixed.wav was still being written when this handler's
  // own mono-conversion cache snapshotted it mid-write, 12KB captured against an
  // eventual 48MB file). Two checks, either one refuses:
  //  1. Fast/zero-latency: audioFile IS the file stop-recording's own mix
  //     (runBackend(["mix", ...])) is CURRENTLY writing — mixInFlight is set true
  //     right before that call and cleared unconditionally in its onClose (see
  //     mixInFlight's declaration above).
  //  2. General safety net (a short real wait, ~300ms — negligible against a
  //     multi-minute ML pipeline): the file's size must be unchanged across the
  //     interval, catching ANY other still-writing source (an import mid-copy,
  //     a sync tool), not just this app's own in-flight mix.
  if (mixInFlight && session && audioFile === session.mixedPath) {
    return { ok: false, error: "Дождитесь завершения сведения дорожек этой записи" };
  }
  const stable = await isFileStable(
    audioFile, FILE_STABILITY_WAIT_MS,
    (p) => { try { return fs.statSync(p).size; } catch { return null; } },
    (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  );
  if (!stable) return { ok: false, error: "Файл ещё дописывается — подождите и повторите" };
  // Diarization is optional-by-design (not part of the setup-gate wall — see
  // appReadinessStatus's comment in lib/mainutil) but still needs its own
  // per-run guard: pyannote's repos are gated behind an HF token, so a run
  // requesting diarize without the models cached would otherwise fail deep
  // inside backend.py instead of refusing upfront here.
  if (diarize && !diarizationCached()) {
    return { ok: false, error: "Модели диаризации не скачаны — Настройки → Модели, или выключите определение спикеров" };
  }

  const cacheDir = cacheDirFor(audioFile);
  if (fresh) {
    // full re-run: drop cached heavy-stage artifacts so everything recomputes
    try { fs.rmSync(cacheDir, { recursive: true, force: true }); fs.mkdirSync(cacheDir, { recursive: true }); } catch {}
  }

  const promptFile = path.join(TMP_DIR, `prompt-${Date.now()}.txt`);
  fs.writeFileSync(promptFile, prompt || "", "utf-8");
  const args = [
    "process",
    "--in", audioFile,
    "--prompt-file", promptFile,
    "--diarize", diarize ? "true" : "false",
    "--out-dir", outDir || DEFAULT_OUT,
    "--engine", engine || "mlx",
    "--cache-dir", cacheDir,
    "--language", language || "ru",
    "--glossary", glossary || "",
    "--summarize", summarize === false ? "false" : "true",
    "--template", template || "",
    "--db", DB_PATH,
  ];
  // record-mode-only auto-«Я» inputs (import mode never sends these — identical argv to today).
  if (micFile) args.push("--mic", micFile);
  if (systemFile) args.push("--system", systemFile);
  if (authorName) args.push("--author-name", authorName);
  // note-origin typing for a plain import (batch vs single file) — record-mode never
  // sends this, the backend infers "recording" from micFile/systemFile above instead.
  if (origin) args.push("--origin", origin);
  // Note versioning by template on reprocess (История "Переобработать" only — see
  // reprocessHistory/openReprocessPicker in renderer.js). The renderer computes the
  // next per-template version number and sends it ONLY for a deliberate История
  // reprocess; a plain record/import run never sends this, so backend.py's --version
  // default (None) preserves today's behaviour (same filename, overwrite-by-cached-
  // stamp) exactly.
  if (version) args.push("--version", String(version));
  // Fast model for mechanical LLM calls only (correct/title/suggest) — empty means
  // omit the flag entirely, backend.py's --fast-model default ("") preserves today's
  // behaviour (no "model" field sent, LM Studio uses whatever's loaded).
  if (fastModel) args.push("--fast-model", fastModel);
  // Main model for substantive LLM calls (summary/speaker-inference/actions) — same
  // omit-when-empty contract as fastModel above (backend.py's --main-model default
  // ("") preserves today's behaviour, including the reasoning-model summary).
  if (mainModel) args.push("--main-model", mainModel);
  // Cumulative {termLower: count} from the renderer's presets — same file-based
  // plumbing as --prompt-file (avoids CLI arg length/escaping concerns). Omitted
  // entirely when there's no usage data yet (first-ever run), mirroring fastModel
  // above — backend.py's default (no file → {}) preserves today's behaviour.
  let glossaryUsageFile = null;
  if (glossaryUsage && Object.keys(glossaryUsage).length) {
    glossaryUsageFile = path.join(TMP_DIR, `glossary-usage-${Date.now()}.json`);
    fs.writeFileSync(glossaryUsageFile, JSON.stringify(glossaryUsage), "utf-8");
    args.push("--glossary-usage-file", glossaryUsageFile);
  }
  // UI-entered token wins over a shell env one; empty → backend skips diarization.
  const extraEnv = hfToken && hfToken.trim() ? { HF_TOKEN: hfToken.trim() } : {};
  let doneNote = null; // captured from the "done" event, used to auto-index on close
  procProc = runBackend(
    args,
    (ev) => {
      if (ev.event === EVENTS.DONE) doneNote = ev.note;
      send("process-event", ev);
    },
    (code, stderr) => {
      const canceled = procCanceled;
      send("process-event", { event: "process-closed", code, stderr, canceled });
      try { fs.unlinkSync(promptFile); } catch {} /* best-effort: TMP_DIR leftovers are swept by pruneTemp anyway */
      if (glossaryUsageFile) { try { fs.unlinkSync(glossaryUsageFile); } catch {} } /* best-effort, same as promptFile above */
      procProc = null;
      procCanceled = false;
      // Fire-and-forget: resolves to the renderer above regardless; indexing runs after.
      if (!canceled && code === 0 && doneNote) triggerAutoIndex(doneNote);
    },
    extraEnv
  );
  return { ok: true };
});

// cancel an in-flight processing run; cached stages already on disk survive for resume
ipcMain.handle("cancel-process", async () => {
  if (!procProc) return { ok: false, error: "Обработка не идёт" };
  procCanceled = true;
  procProc.kill("SIGTERM");
  return { ok: true };
});

// ── model inventory / pre-download (settings "Модели" section) ─────────────
// This is an independent, out-of-band maintenance action — NOT a pipeline stage
// of a specific audio-processing run — so it gets its own child-process slot and
// event channel rather than reusing procProc/process-event (that machinery is
// hard-wired to the 7 pipeline-specific stage keys, see renderer.js STAGE_KEYS).
// Threshold is sized for a ~1.6 GB cold-machine download batch (Whisper + VAD +
// pyannote), not recording's ~350 MB/h headroom — diskGuardVerdict's own
// defaults (used by start-recording above) stay untouched.
const MODEL_DL_REFUSE_BYTES = 2 * 1024 * 1024 * 1024; // < 2 GiB free → refuse to start
const MODEL_DL_WARN_BYTES = 3 * 1024 * 1024 * 1024;   // < 3 GiB free → start, but warn

// Status only — cache inspection, no network (mirrors the "preflight" handler above).
ipcMain.handle("models", async () => {
  const token = loadToken();
  const items = await new Promise((resolve) => {
    let out = [];
    runBackend(["models"], (ev) => { if (ev.event === EVENTS.MODELS) out = ev.items; },
      () => resolve(out), token ? { HF_TOKEN: token } : {});
  });
  // On-disk footprint per model (settings "Модели" section: "добавить размер на
  // диске") — plain Node fs, no backend.py round-trip needed. Only meaningful
  // once cached; an uncached model has no cache dir at all (dirSizeBytes would
  // just return 0, but skipping the fs walk entirely is cheaper and clearer).
  const home = os.homedir();
  return items.map((item) => ({
    ...item,
    sizeBytes: item.cached
      ? modelCacheDirsFor(home, item.id).reduce((sum, dir) => sum + dirSizeBytes(dir), 0)
      : 0,
  }));
});

// Shared batch-starter for both "download-models" below (bulk / per-row retry —
// a model backend.py's _model_cached() already reports as done gets silently
// skipped, see backend.py:2959-2961) and "redownload-model" (force-refetches ONE
// already-cached model). only: array of model ids, or null = whatever's missing.
// beforeStart(), if given, runs only once every guard AND the disk check have
// passed — right before the child actually spawns — so redownload-model's cache
// wipe can never fire on a call that's about to be refused for an unrelated
// reason (busy/low disk), which would otherwise delete a working cache with no
// download happening to replace it.
async function runModelDownloadBatch(only, beforeStart) {
  const busy = busyVerdict([
    [!!modelDlProc, "Скачивание уже идёт"],
    [!!procProc, "Дождитесь окончания обработки"],
    [!!(recordProc || tee), "Дождитесь окончания записи"],
    // Model download also spawns pythonBin() (backend.py's download-models command) —
    // same install-in-progress hazard as start-recording/process-audio above.
    [!!installBackendProc, "Дождитесь окончания установки бэкенда"],
    // Same reasoning as start-recording's updateProc guard above.
    [!!updateProc, "Идёт обновление приложения — дождитесь завершения"],
  ]);
  if (busy) return { ok: false, error: busy };

  // Disk guard: models download into ~/.cache, not TMP_DIR — check that volume.
  let diskVerdict = { action: "ok", msg: null };
  try {
    const st = fs.statfsSync(os.homedir());
    diskVerdict = diskGuardVerdict(st.bavail * st.bsize, MODEL_DL_REFUSE_BYTES, MODEL_DL_WARN_BYTES);
  } catch {}
  if (diskVerdict.action === "refuse") return { ok: false, error: diskVerdict.msg };

  if (beforeStart) beforeStart();

  const args = ["download-models"];
  if (only) args.push("--only", only.join(","));

  const token = loadToken();
  modelDlCanceled = false;
  // Tracks the model whose "stage" fired but hasn't gotten its "stage_end" yet —
  // backend.py's own stage/stage_end event pairing already tells us exactly which
  // model was actively downloading (or nothing, between models); no separate
  // bookkeeping protocol needed. That's the one a cancel/crash mid-batch could
  // leave with a partial cache dir — an already-finished (ok/skip/fail) model's
  // dir must NOT be touched here.
  let inFlightModelId = null;
  modelDlProc = runBackend(
    args,
    (ev) => {
      if (ev.event === EVENTS.STAGE) inFlightModelId = (ev.stage || "").replace(/^model:/, "") || null;
      else if (ev.event === EVENTS.STAGE_END) inFlightModelId = null;
      send("download-models-event", ev);
    },
    (code, stderr) => {
      const canceled = modelDlCanceled;
      if ((canceled || code !== 0) && inFlightModelId) cleanupPartialModelCache(os.homedir(), inFlightModelId);
      send("download-models-event", { event: "download-closed", code, stderr, canceled });
      modelDlProc = null;
      modelDlCanceled = false;
    },
    token ? { HF_TOKEN: token } : {}
  );
  if (diskVerdict.action === "warn") send("download-models-event", { event: "disk-warning", msg: diskVerdict.msg });
  return { ok: true };
}

// Start a (re)download batch. opts.only: array of model ids, or omitted = all missing.
// Mutually exclusive with procProc (and vice versa, see process-audio's guard above) —
// refuse to run a model download while a recording/processing run is active.
ipcMain.handle("download-models", async (_e, opts) => {
  const only = opts && Array.isArray(opts.only) && opts.only.length ? opts.only : null;
  return runModelDownloadBatch(only);
});

// Force-refetch ONE already-cached model (settings "Модели" section: per-model
// "↻ Скачать заново" — renderer.js's redownloadModel). backend.py's
// cmd_download_models skips any model _model_cached() already reports as done, so
// re-running the ordinary scoped download on a cached model would be a silent
// no-op — its cache dir must be wiped first for there to be anything left to
// fetch. The wipe itself is deferred into runModelDownloadBatch's beforeStart
// hook (see its own comment) so a refused call (busy/low disk) never wipes a
// working cache without actually replacing it.
ipcMain.handle("redownload-model", async (_e, modelId) => {
  return runModelDownloadBatch([modelId], () => cleanupPartialModelCache(os.homedir(), modelId));
});

// cancel an in-flight model download. The close handler above wipes the
// interrupted model's partial cache dir (cleanupPartialModelCache) once the
// child process has fully exited, so a re-click of "Скачать все" re-fetches
// that model from scratch — not a resume.
ipcMain.handle("cancel-model-download", async () => {
  if (!modelDlProc) return { ok: false, error: "Скачивание не идёт" };
  modelDlCanceled = true;
  modelDlProc.kill("SIGTERM");
  return { ok: true };
});

// ── backend installer (settings "Бэкенд" section) ───────────────────────────
// Installs the heavy Python/ML stack (~1.3GB: torch/MLX/pyannote) into userData
// on button press — see BACKEND_ENV above. Pinned artifact versions: bump
// deliberately, and re-verify (download + run/import) before bumping, same bar
// as the original step-0 checks this feature was gated on.
const PYTHON_STANDALONE_VERSION = "3.11.15";
const PYTHON_STANDALONE_RELEASE_TAG = "20260623";
const PYTHON_STANDALONE_URL =
  `https://github.com/astral-sh/python-build-standalone/releases/download/${PYTHON_STANDALONE_RELEASE_TAG}/` +
  `cpython-${PYTHON_STANDALONE_VERSION}%2B${PYTHON_STANDALONE_RELEASE_TAG}-aarch64-apple-darwin-install_only.tar.gz`;
const PYTHON_STANDALONE_SHA256 = "d2324bfd1a7b9fc44ccd884c3a2505bcab6691dbfd4f8270e10c50aaa4e19506";
// osxexperts.net ffmpeg81arm: genuinely arm64-native (verified via `file`/otool — no
// /opt/homebrew or /usr/local deps, only Apple system frameworks + /usr/lib). Chosen
// over evermeet.cx, which explicitly ships x86_64-only builds (Rosetta) for macOS.
const FFMPEG_STATIC_URL = "https://www.osxexperts.net/ffmpeg81arm.zip";
const FFMPEG_STATIC_SHA256 = "ebb82529562b71170807bbc6b0e7eb4f0b13af8cbb0e085bb9e8f6fe709598ad";
// Rough floor for python(~30MB)+ffmpeg(~25MB)+pip installs(~1.3GB)+build overhead.
const BACKEND_INSTALL_REFUSE_BYTES = 4 * 1024 * 1024 * 1024; // < 4 GiB free → refuse to start
const BACKEND_INSTALL_WARN_BYTES = 6 * 1024 * 1024 * 1024;   // < 6 GiB free → start, but warn

// Stream a URL to destPath, optionally verifying its sha256 against
// expectedSha256 (pass null/undefined to skip verification — the in-app
// updater's own call site below intentionally does, see its comment there)
// and following redirects (GitHub release assets 302 to a signed blob URL).
// onKillable(obj), if given, hands the caller a { kill() } to store in ITS OWN
// cancel-tracking variable (installBackendProc for the backend installer,
// updateProc for the in-app updater — see their respective call sites) so a
// cancel call aborts the underlying request. onProgress(pct) fires at most
// once per whole percentage point.
function downloadToFile(url, destPath, expectedSha256, onProgress, onKillable) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "MeetingRecorder" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        resolve(downloadToFile(res.headers.location, destPath, expectedSha256, onProgress, onKillable));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} скачивая ${url}`));
        return;
      }
      const hash = crypto.createHash("sha256");
      const file = fs.createWriteStream(destPath);
      const total = parseInt(res.headers["content-length"] || "0", 10);
      let received = 0;
      let lastPct = -1;
      res.on("data", (chunk) => {
        hash.update(chunk);
        received += chunk.length;
        if (onProgress && total) {
          const pct = Math.round((received / total) * 100);
          if (pct !== lastPct) { lastPct = pct; onProgress(pct); }
        }
      });
      res.pipe(file);
      file.on("finish", () => {
        file.close(() => {
          const actual = hash.digest("hex");
          if (expectedSha256 && actual !== expectedSha256) {
            fs.unlink(destPath, () => {});
            reject(new Error(`контрольная сумма не совпала (${path.basename(destPath)})`));
          } else {
            resolve();
          }
        });
      });
      file.on("error", (e) => { try { fs.unlinkSync(destPath); } catch {} reject(e); });
    });
    req.on("error", (e) => { try { fs.unlinkSync(destPath); } catch {} reject(e); });
    if (onKillable) onKillable({ kill: () => req.destroy(new Error("отменено")) });
  });
}

// Spawn cmd/args to completion. opts.onProc(proc), if given, hands the caller
// the live child so it can track it in ITS OWN cancel-tracking variable
// (installBackendProc / updateProc — mirrors downloadToFile's onKillable
// above). opts.onLine(text), if given, gets both stdout lines and raw stderr
// chunks — pip interleaves progress on both streams.
function runInstallStep(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd: opts.cwd });
    if (opts.onProc) opts.onProc(proc);
    let stderr = "";
    if (opts.onLine && proc.stdout) {
      readline.createInterface({ input: proc.stdout }).on("line", opts.onLine);
    }
    proc.stderr.on("data", (d) => {
      const text = d.toString();
      stderr += text;
      if (opts.onLine) text.trim().split("\n").forEach((l) => l && opts.onLine(l));
    });
    proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(stderr || `${cmd} завершился с кодом ${code}`))));
    proc.on("error", reject);
  });
}

// Runs fn() bracketed by stage/stage_end events on the "Бэкенд" section's own
// channel — same stage/stage_end vocabulary backend.py's download-models uses,
// so the renderer's per-row rendering idiom (see renderer.js) carries over.
async function withInstallStage(stageName, startMsg, fn) {
  send("install-backend-event", { event: "stage", stage: stageName, msg: startMsg });
  try {
    const result = await fn();
    send("install-backend-event", { event: "stage_end", stage: stageName, status: "ok", msg: "готово" });
    return result;
  } catch (e) {
    const canceled = installBackendCanceled;
    send("install-backend-event", {
      event: "stage_end", stage: stageName,
      status: canceled ? "skip" : "fail",
      msg: canceled ? "отменено" : String((e && e.message) || e),
    });
    throw e;
  }
}

async function runInstallBackend() {
  // mkdtempSync deliberately lives INSIDE the try: if it throws, the catch/finally
  // below still run and clear installBackendProc/installBackendCanceled — outside
  // the try, a throw here would reject this fire-and-forget promise and leave the
  // app permanently refusing record/process/download until restart (main.js's
  // install-backend handler also wraps its call in .catch() as a second line of
  // defense against a bug in this function's own error handling).
  let tmpDir = null;
  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mr-backend-install-"));
    // Stage the whole install in a sibling-of-BACKEND_ENV dir; nothing is ever
    // written to BACKEND_ENV itself until the atomic rename at the very end, once
    // pip has succeeded and the marker is written. A crash/cancel at any point
    // before that leaves BACKEND_ENV exactly as it was (untouched, or absent) —
    // never partially overwritten — so pythonBin()/backendAvailable() can never
    // observe a depless interpreter or a stale ffmpeg.
    fs.rmSync(BACKEND_ENV_STAGING, { recursive: true, force: true }); // clear a stale leftover from a crashed prior attempt
    fs.mkdirSync(BACKEND_ENV_STAGING, { recursive: true });
    const stagingPython = path.join(BACKEND_ENV_STAGING, "python", "bin", "python3.11");
    const stagingFfmpeg = path.join(BACKEND_ENV_STAGING, "bin", "ffmpeg");
    const stagingMarker = path.join(BACKEND_ENV_STAGING, ".installed.json");

    await withInstallStage("python", "Скачиваю Python…", async () => {
      const pyTarball = path.join(tmpDir, "python.tar.gz");
      await downloadToFile(PYTHON_STANDALONE_URL, pyTarball, PYTHON_STANDALONE_SHA256,
        (pct) => send("install-backend-event", { event: "download-progress", stage: "python", pct }),
        (k) => { installBackendProc = k; });
      if (installBackendCanceled) throw new Error("отменено");
      await runInstallStep("tar", ["-xzf", pyTarball, "-C", BACKEND_ENV_STAGING], { onProc: (p) => { installBackendProc = p; } });
    });

    await withInstallStage("ffmpeg", "Скачиваю ffmpeg…", async () => {
      const ffmpegZip = path.join(tmpDir, "ffmpeg.zip");
      await downloadToFile(FFMPEG_STATIC_URL, ffmpegZip, FFMPEG_STATIC_SHA256,
        (pct) => send("install-backend-event", { event: "download-progress", stage: "ffmpeg", pct }),
        (k) => { installBackendProc = k; });
      if (installBackendCanceled) throw new Error("отменено");
      const extractDir = path.join(tmpDir, "ffmpeg-extract");
      fs.mkdirSync(extractDir, { recursive: true });
      await runInstallStep("unzip", ["-o", ffmpegZip, "-d", extractDir], { onProc: (p) => { installBackendProc = p; } });
      fs.mkdirSync(path.join(BACKEND_ENV_STAGING, "bin"), { recursive: true });
      fs.copyFileSync(path.join(extractDir, "ffmpeg"), stagingFfmpeg);
      fs.chmodSync(stagingFfmpeg, 0o755);
    });

    await withInstallStage("pip", "Устанавливаю зависимости (~1.3 ГБ, несколько минут)…", () =>
      runInstallStep(stagingPython,
        ["-m", "pip", "install", "--no-cache-dir", "--find-links", VENDOR_WHEELS_DIR, "-r", REQUIREMENTS_FILE],
        { onProc: (p) => { installBackendProc = p; }, onLine: (line) => send("install-backend-event", { event: "log", msg: line }) }));

    const reqText = fs.readFileSync(REQUIREMENTS_FILE, "utf-8");
    writeJsonAtomic(stagingMarker, {
      pythonVersion: PYTHON_STANDALONE_VERSION,
      requirementsHash: cacheKey(reqText),
      installedAt: new Date().toISOString(),
    });

    // Atomic(-ish) swap-in. fs.renameSync onto an existing NON-EMPTY directory
    // fails (ENOTEMPTY on POSIX), so a reinstall must move the previous
    // BACKEND_ENV aside first. If the process dies between these two renames,
    // BACKEND_ENV simply doesn't exist for a moment — which resolves as "not
    // installed" (falls through to dev venv), never a false "available".
    const backupEnv = BACKEND_ENV + ".old";
    fs.rmSync(backupEnv, { recursive: true, force: true });
    if (fs.existsSync(BACKEND_ENV)) fs.renameSync(BACKEND_ENV, backupEnv);
    fs.renameSync(BACKEND_ENV_STAGING, BACKEND_ENV);
    fs.rmSync(backupEnv, { recursive: true, force: true });

    send("install-backend-event", { event: "install-closed", code: 0, canceled: false });
  } catch (e) {
    send("install-backend-event", {
      event: "install-closed",
      code: installBackendCanceled ? null : 1,
      canceled: installBackendCanceled,
    });
  } finally {
    if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} }
    // Never leave a half-populated staging dir behind — a failed/cancelled
    // install must not survive as anything a later run could mistake for
    // progress (and BACKEND_ENV itself was never touched on this path).
    try { fs.rmSync(BACKEND_ENV_STAGING, { recursive: true, force: true }); } catch {}
    installBackendProc = null;
    installBackendCanceled = false;
  }
}

ipcMain.handle("install-backend", async () => {
  const busy = busyVerdict([
    [!!installBackendProc, "Установка уже идёт"],
    [!!(recordProc || tee), "Дождитесь окончания записи"],
    [!!procProc, "Дождитесь окончания обработки"],
    [!!modelDlProc, "Дождитесь окончания скачивания моделей"],
    // Same reasoning as start-recording's updateProc guard above — install-backend
    // wasn't previously mutually exclusive with the updater at all.
    [!!updateProc, "Идёт обновление приложения — дождитесь завершения"],
  ]);
  if (busy) return { ok: false, error: busy };

  let diskVerdict = { action: "ok", msg: null };
  try {
    const st = fs.statfsSync(app.getPath("userData"));
    diskVerdict = diskGuardVerdict(st.bavail * st.bsize, BACKEND_INSTALL_REFUSE_BYTES, BACKEND_INSTALL_WARN_BYTES);
  } catch {}
  if (diskVerdict.action === "refuse") return { ok: false, error: diskVerdict.msg };

  installBackendCanceled = false;
  // Placeholder so a second install-backend call sees "busy" immediately — the
  // real killable object replaces this once the first download/step starts.
  installBackendProc = { kill: () => { installBackendCanceled = true; } };
  // Fire-and-forget — progress streams over install-backend-event. runInstallBackend
  // itself never rethrows (its own try/catch/finally always clears these flags), but
  // .catch() here is a last-resort safety net against a bug in that handling itself,
  // so the app can never get stuck permanently refusing record/process/download.
  runInstallBackend().catch(() => {
    installBackendProc = null;
    installBackendCanceled = false;
  });
  if (diskVerdict.action === "warn") send("install-backend-event", { event: "disk-warning", msg: diskVerdict.msg });
  return { ok: true };
});

ipcMain.handle("cancel-install-backend", async () => {
  if (!installBackendProc) return { ok: false, error: "Установка не идёт" };
  installBackendCanceled = true;
  installBackendProc.kill();
  return { ok: true };
});

// Status only — marker/cache inspection, no network (mirrors "models" above).
// Runs `<ffmpegPath> -version` and hands the raw stdout to parseFfmpegVersion
// (lib/mainutil) — used below so backend-status can report exactly which ffmpeg
// build the installed env has ("показать КАКОЙ именно бэкенд"), not just that
// one exists. Best-effort: a missing binary or spawn error resolves null rather
// than rejecting, so backend-status always returns whatever it does know.
function getFfmpegVersion(ffmpegPath) {
  return new Promise((resolve) => {
    let proc;
    try { proc = spawn(ffmpegPath, ["-version"]); } catch { return resolve(null); }
    let out = "";
    proc.stdout.on("data", (d) => { out += d.toString(); });
    proc.on("error", () => resolve(null));
    proc.on("close", () => resolve(parseFfmpegVersion(out)));
  });
}

ipcMain.handle("backend-status", async () => {
  let marker = null;
  try { marker = JSON.parse(fs.readFileSync(BACKEND_MARKER, "utf-8")); } catch {}
  let reqHash = null;
  try { reqHash = cacheKey(fs.readFileSync(REQUIREMENTS_FILE, "utf-8")); } catch {}
  const status = backendInstallStatus(marker, reqHash, fs.existsSync(INSTALLED_PYTHON));
  // envPath/ffmpegVersion only mean anything once THIS section's own install is
  // present — a bare "не установлен" env path or a PATH-resolved system ffmpeg
  // would misrepresent what this button actually manages.
  if (!status.installed) return { ...status, envPath: null, ffmpegVersion: null };
  return { ...status, envPath: BACKEND_ENV, ffmpegVersion: await getFfmpegVersion(INSTALLED_FFMPEG) };
});

ipcMain.handle("uninstall-backend", async () => {
  if (installBackendProc) return { ok: false, error: "Установка идёт" };
  if (recordProc || tee || procProc) return { ok: false, error: "Нельзя удалить бэкенд во время записи или обработки" };
  try {
    fs.rmSync(BACKEND_ENV, { recursive: true, force: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

// ── in-app updater (settings "Обновления" section) ──────────────────────────
// DIY updater over GitHub Releases' public API (no auth token needed for a
// public repo) — the app is ad-hoc signed (no Developer ID), so
// electron-updater/Squirrel.Mac (both require a valid code signature) aren't
// usable here. Manual check + install only for v1 — no auto-check on startup.
// No signature verification of the downloaded zip: TLS-only trust, a
// conscious owner-accepted decision (out of scope for v1, see task contract).
const UPDATE_REPO = "ArtemiiF/MeetingRecorder";
const UPDATES_DIR = path.join(app.getPath("userData"), "updates");
let updateProc = null;      // current killable step of an in-flight update download/install
let updateCanceled = false; // set when the user cancels an in-flight update

// Electron's fs patches make an extracted/installed .app's Contents/Resources/
// app.asar LOOK like a directory to Node's fs calls (asar transparency), even
// though on disk it's a real file. fs.rmSync's recursive walk trusts that and
// calls rmdir(2) on it — which fails with ENOTDIR since it's actually a file.
// This is exactly the "Скачать и установить" incident: rmSync(extractDir) on
// a retry hit a leftover .app from a prior attempt and blew up on its asar.
// process.noAsar disables that transparency for the duration of the rmSync
// call, so app.asar is treated as the plain file it really is. Use this (not
// bare fs.rmSync) at any updater call site whose target may contain a .app
// bundle; a single known-to-be-a-file path (e.g. the downloaded zip) doesn't
// need it.
function rmNoAsar(p, opts) {
  const prevNoAsar = process.noAsar;
  process.noAsar = true;
  try {
    fs.rmSync(p, opts);
  } finally {
    process.noAsar = prevNoAsar;
  }
}

// GET .../releases/latest — no auth, subject to GitHub's unauthenticated rate
// limit (60 req/h/IP), which a manual "check for updates" button never gets
// close to. Throws on network error / non-2xx / 404 (no releases published
// yet) — callers catch this and turn it into an honest {ok:false, error}
// rather than ever throwing across the IPC boundary to the renderer.
async function fetchLatestRelease() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, {
      headers: { "User-Agent": "MeetingRecorder", Accept: "application/vnd.github+json" },
      signal: ctrl.signal,
    });
    if (res.status === 404) throw new Error("Релизы не найдены");
    if (!res.ok) throw new Error(`GitHub вернул ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

ipcMain.handle("check-app-update", async () => {
  const current = app.getVersion();
  try {
    const release = await fetchLatestRelease();
    const latest = release.tag_name || "";
    const cmp = compareVersions(latest, current);
    if (cmp === null) {
      return {
        ok: false, current, latest, hasUpdate: false, assetUrl: null, releaseNotes: null,
        isPackaged: app.isPackaged, error: "Не удалось разобрать версию релиза",
      };
    }
    const assetUrl = pickUpdateAsset(release.assets || []);
    const releaseNotes = ((release.body || "").split("\n")[0] || "").trim() || null;
    return {
      ok: true, current, latest, hasUpdate: cmp === 1 && !!assetUrl, assetUrl, releaseNotes,
      isPackaged: app.isPackaged,
    };
  } catch (e) {
    return {
      ok: false, current, latest: null, hasUpdate: false, assetUrl: null, releaseNotes: null,
      isPackaged: app.isPackaged, error: String((e && e.message) || e),
    };
  }
});

// Downloads the latest release's arm64 zip, unpacks it, and swaps it in for the
// running .app bundle, then relaunches. Re-fetches the release fresh (rather
// than trusting a possibly-stale assetUrl the renderer got from an earlier
// check-app-update call) so a user who waits before clicking install still
// gets whatever is actually latest at click time.
async function runUpdateInstall() {
  let zipPath = null;
  let extractDir = null;
  // Set when the pre-swap recheck below aborts because a conflicting op started
  // during the (multi-minute) download window — the finally block then leaves
  // the already-downloaded zip/extract in place rather than deleting it, per
  // the "keep the downloaded zip" abort contract. Note this flow doesn't
  // actually resume from it: a later retry re-fetches and re-downloads from
  // scratch (its own top-of-function fs.rmSync wipes this leftover first) —
  // preserving it here only avoids destroying evidence of THIS abort itself.
  let deferredBusy = false;
  try {
    let release;
    try {
      release = await fetchLatestRelease();
    } catch (e) {
      throw new Error("Не удалось проверить обновление: " + String((e && e.message) || e));
    }
    const assetUrl = pickUpdateAsset(release.assets || []);
    if (!assetUrl) throw new Error("В последнем релизе нет файла обновления (arm64 .zip)");

    fs.mkdirSync(UPDATES_DIR, { recursive: true });
    zipPath = path.join(UPDATES_DIR, "update.zip");
    extractDir = path.join(UPDATES_DIR, "extract");
    // clear a stale leftover from a crashed prior attempt — extractDir may hold a
    // previously-unpacked .app (see rmNoAsar above for why plain rmSync can't walk it)
    rmNoAsar(extractDir, { recursive: true, force: true });
    fs.rmSync(zipPath, { force: true }); // a single file (never a .app bundle) — plain rmSync is fine

    send("app-update-event", { event: "stage", stage: "download", msg: "Скачиваю обновление…" });
    // expectedSha256 is intentionally null — see the module-level comment above
    // this block on TLS-only trust for downloaded updates.
    await downloadToFile(assetUrl, zipPath, null,
      (pct) => send("app-update-event", { event: "download-progress", pct }),
      (k) => { updateProc = k; });
    if (updateCanceled) throw new Error("отменено");
    if (!fs.statSync(zipPath).size) throw new Error("Скачан пустой файл обновления");

    send("app-update-event", { event: "stage", stage: "unpack", msg: "Распаковываю…" });
    fs.mkdirSync(extractDir, { recursive: true });
    // ditto (not unzip) — preserves the ad-hoc signature/xattrs the .app bundle needs.
    await runInstallStep("ditto", ["-xk", zipPath, extractDir], { onProc: (p) => { updateProc = p; } });
    if (updateCanceled) throw new Error("отменено");

    const appEntry = fs.readdirSync(extractDir).find((n) => n.endsWith(".app"));
    if (!appEntry) throw new Error("В архиве обновления не найден .app");
    const newAppPath = path.join(extractDir, appEntry);
    // The zip travelled over the network — macOS quarantines it; without lifting
    // that, Gatekeeper would re-prompt (or refuse) on the very first relaunch.
    await runInstallStep("xattr", ["-dr", "com.apple.quarantine", newAppPath], { onProc: (p) => { updateProc = p; } });

    // Pre-swap recheck (belt-and-suspenders): download-and-install-update's own
    // entry guard checked these once, but the download+unpack above can take
    // several minutes — wide enough for a recording/processing/model-download/
    // backend-install to have started since, despite that front-door guard (or
    // its own guard against updateProc racing the other way). Never swap the
    // running bundle out from under an in-flight op — the relaunch+forced-exit
    // step further down skips before-quit's graceful mic-finalize wait entirely,
    // so a recording in progress at that point would die unplayable. Abort
    // cleanly instead: no swap, no relaunch, leave the downloaded zip in place
    // (see deferredBusy above).
    if (recordProc || tee || procProc || modelDlProc || installBackendProc) {
      deferredBusy = true;
      throw new Error("Обновление отложено: идёт запись/обработка");
    }

    send("app-update-event", { event: "stage", stage: "swap", msg: "Устанавливаю…" });
    // app.getPath("exe") = "<App>.app/Contents/MacOS/<App>" — three levels up is the bundle itself.
    const currentAppPath = path.dirname(path.dirname(path.dirname(app.getPath("exe"))));
    const oldAppPath = currentAppPath + ".old";
    // Each swap step below is wrapped so a failure names exactly which one broke —
    // load-bearing for diagnosing things like the unexplained partial ".app.old"
    // stub seen live (rename can't produce partial copies, so that failure mode
    // is still a mystery; naming the step at least narrows where to look next).
    try {
      rmNoAsar(oldAppPath, { recursive: true, force: true });
    } catch (e) {
      throw new Error(`Не удалось выполнить шаг «очистка старой копии»: ${(e && e.message) || e}`);
    }
    try {
      fs.renameSync(currentAppPath, oldAppPath);
    } catch (e) {
      throw new Error(`Не удалось выполнить шаг «перенос текущей версии»: ${(e && e.message) || e}`);
    }
    try {
      fs.renameSync(newAppPath, currentAppPath);
    } catch (e) {
      // Roll back immediately — the app must stay launchable even if this fails.
      try {
        fs.renameSync(oldAppPath, currentAppPath);
      } catch (rollbackErr) {
        throw new Error(`Не удалось выполнить шаг «откат»: ${(rollbackErr && rollbackErr.message) || rollbackErr}`);
      }
      // EXDEV: newAppPath (under userData/updates) and currentAppPath (wherever
      // the .app is actually installed) are on different volumes — rename can't
      // cross a mount boundary. Known limitation for v1 (e.g. the app installed
      // on an external/network drive) — surfaced honestly instead of as a raw
      // rename error.
      if (e && e.code === "EXDEV") {
        throw new Error("Обновление не поддерживается, когда приложение установлено на другом томе");
      }
      throw new Error(`Не удалось выполнить шаг «установка новой версии»: ${(e && e.message) || e}`);
    }

    send("app-update-event", { event: "install-closed", code: 0, canceled: false });
    app.relaunch();
    app.exit(0);
  } catch (e) {
    const canceled = updateCanceled;
    send("app-update-event", {
      event: "install-closed",
      code: canceled ? null : 1,
      canceled,
      error: canceled ? null : String((e && e.message) || e),
    });
  } finally {
    // Never leave a half-downloaded/half-unpacked update behind for the next attempt
    // to trip over — mirrors runInstallBackend's own staging cleanup above. Except
    // on a deferredBusy abort, where deletion is skipped per the "keep the
    // downloaded zip" abort contract (see the comment on the flag's declaration —
    // a later retry still re-downloads from scratch regardless).
    if (!deferredBusy) {
      if (zipPath) { try { fs.rmSync(zipPath, { force: true }); } catch {} } // single file — plain rmSync
      if (extractDir) { try { rmNoAsar(extractDir, { recursive: true, force: true }); } catch {} }
    }
    updateProc = null;
    updateCanceled = false;
  }
}

ipcMain.handle("download-and-install-update", async () => {
  if (!app.isPackaged) return { ok: false, error: "только в собранном приложении" };
  const busy = busyVerdict([
    [!!updateProc, "Обновление уже идёт"],
    [!!(recordProc || tee), "Дождитесь окончания записи"],
    [!!procProc, "Дождитесь окончания обработки"],
    [!!modelDlProc, "Дождитесь окончания скачивания моделей"],
    [!!installBackendProc, "Дождитесь окончания установки бэкенда"],
  ]);
  if (busy) return { ok: false, error: busy };

  updateCanceled = false;
  // Placeholder so a second call sees "busy" immediately — same pattern as
  // install-backend's own guard (the real killable object replaces this once
  // the download actually starts).
  updateProc = { kill: () => { updateCanceled = true; } };
  runUpdateInstall().catch(() => { updateProc = null; updateCanceled = false; });
  return { ok: true };
});

ipcMain.handle("cancel-app-update", async () => {
  if (!updateProc) return { ok: false, error: "Обновление не идёт" };
  updateCanceled = true;
  updateProc.kill();
  return { ok: true };
});

// One-time startup sweep: a successful update swap leaves the old bundle at
// "<App>.app.old" (kept only long enough to roll back on THAT run) and the
// zip/extract dir it downloaded into userData/updates — if the app got this
// far, the new bundle is already running fine, so both are safe to delete now.
function cleanupUpdateLeftovers() {
  if (!app.isPackaged) return;
  const appPath = path.dirname(path.dirname(path.dirname(app.getPath("exe"))));
  rmNoAsar(appPath + ".old", { recursive: true, force: true });
  rmNoAsar(UPDATES_DIR, { recursive: true, force: true }); // may still hold an unpacked .app under extract/
}

// Past recordings: query the backend's SQLite index (reconciled against the notes dir).
// Still-pending recordings are tracked separately (state.pendingRecordings, sourced
// from list-pending-recordings) and merged into the rail client-side by
// buildRecordings() — backend.py's OWN --pending-file merge (kind:"pending" synthetic
// rows) was retired as dead code (L9 arch-audit): the renderer already filtered those
// rows out everywhere (buildRecordings/nextVersionFor), never rendering them.
ipcMain.handle("list-history", async (_e, outDir) => {
  const dir = expandHome(outDir) || DEFAULT_OUT;
  // PARA vault root (if configured) so a note moved out of out_dir by filing still shows
  // up in История instead of disappearing on the next reconcile — see readParaRoot below.
  const vaultRoot = readParaRoot();
  const histArgs = ["history", "--out-dir", dir, "--db", DB_PATH];
  if (vaultRoot) histArgs.push("--vault-root", vaultRoot);
  const { items, audios } = await new Promise((resolve) => {
    let out = [];
    let auds = [];
    runBackend(histArgs,
      (ev) => { if (ev.event === EVENTS.HISTORY) { out = ev.items; auds = ev.audios || []; } },
      () => resolve({ items: out, audios: auds }));
  });
  const mapped = items.map((it) => ({
    name: it.stamp,
    title: it.title,
    template: it.template,
    language: it.language,
    note: it.note,
    audio: it.audio,
    mtime: it.mtime,
    source: it.source,
    // note versioning by template on reprocess — a legacy note (or the DB row
    // before its next mtime-triggered reconcile) has no version key; default 1
    // (mirrors backend.py's own _reconcile/process default for the same case).
    version: it.version || 1,
    // Canonical recording identity (feat-history-audio-inventory's cmd_history
    // addition — every note row is tagged with it) — pairs a note with the out_dir
    // audio inventory (see the renderer's recordingBaseStamp/buildRecordings).
    base_stamp: it.base_stamp,
  }));
  // audios[] (the out_dir audio inventory — same PR) rides along as a plain extra
  // property on the returned ARRAY rather than changing list-history's return shape
  // to {items, audios}: dozens of existing renderer tests (and refreshParaInbox,
  // which only wants the note list) already treat this call's result as a bare
  // array — an own property doesn't show up in .map/.filter/.forEach/.length, so
  // every one of those call sites keeps working untouched, while refreshHistory
  // (the only consumer that cares) can still read `.audios` off it.
  mapped.audios = audios;
  return mapped;
});

// Rewrite speaker labels in a saved note (**[old]** → **[new]**) and the
// frontmatter speakers key, atomically.
ipcMain.handle("rename-speakers", async (_e, { notePath, map }) => {
  // Containment check (H2 arch-audit): notePath is renderer-supplied and this
  // handler WRITES the note (tmp + rename) — same isPathInsideRoots primitive
  // and roots (out_dir + PARA vault) delete-history-note validates against, and
  // the same error wording for consistency.
  const { outDir, vaultRoot } = currentOutDirAndVault();
  const roots = [outDir, vaultRoot].filter(Boolean);
  let resolved = null;
  try { resolved = fs.realpathSync(notePath); } catch { resolved = null; }
  if (!isPathInsideRoots(resolved, roots)) {
    return { ok: false, error: "Заметка не найдена или находится вне рабочей папки" };
  }
  try {
    const text = fs.readFileSync(resolved, "utf-8");
    const rewritten = rewriteNoteSpeakers(text, map || {});
    const tmp = resolved + ".tmp";
    fs.writeFileSync(tmp, rewritten, "utf-8");
    fs.renameSync(tmp, resolved);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

ipcMain.handle("read-note", async (_e, notePath) => {
  // Containment check (H2 arch-audit) — same roots/validator as rename-speakers
  // above. Keeps read-note's existing null-on-failure contract (renderer already
  // treats a null result as "couldn't load"), just extended to cover "outside the
  // allowed roots" as another reason to fail closed.
  const { outDir, vaultRoot } = currentOutDirAndVault();
  const roots = [outDir, vaultRoot].filter(Boolean);
  let resolved = null;
  try { resolved = fs.realpathSync(notePath); } catch { resolved = null; }
  if (!isPathInsideRoots(resolved, roots)) return null;
  try { return fs.readFileSync(resolved, "utf-8"); } catch { return null; }
});

// Delete ONE История note (single .md version file) — moved into .trash/ (30-day
// retention, lib/mainutil.js's trash helpers) rather than permanently unlinked, so a
// misclick is recoverable — manually, via Obsidian/Finder; no restore UI in v1 (owner
// decision). The audio is never touched here — it stays on disk so the recording can be
// reprocessed later; trashing the recording's audio too is the separate
// delete-history-recording handler below. No separate index/db mutation is needed:
// cmd_history's reconcile (backend.py) drops any row whose file has vanished on the next
// scan, so moving the file out of out_dir/the vault is the whole mutation.
// Guarded the same way process-audio/redownload-model/download-and-install-update
// are ("Дождитесь окончания обработки") — a reprocess run may be about to write a
// new version of the same recording, so no note deletion is allowed to race it.
// Validated via isNoteDeletable (lib/mainutil.js): must end in .md and resolve
// (symlinks followed via fs.realpathSync) inside out_dir or the PARA vault root —
// same out_dir/vault duality triggerAutoIndex already handles — so this can never
// be pointed at an arbitrary path.
// `title` (Корзина tab addition — the История card's note title at delete time, sent by
// the renderer's own deleteHistoryNote call) is stored on the manifest entry via
// buildTrashEntry so the trash-tab row can show it directly instead of falling back to
// baseStamp/filename; `origin` records this ONE file's original location (dest → resolved)
// so a later restore puts it back exactly where it came from (see restoreDestinationFor).
ipcMain.handle("delete-history-note", async (_e, { notePath, baseStamp, title } = {}) => {
  if (procProc) return { ok: false, error: "Дождитесь окончания обработки" };
  const { outDir, vaultRoot } = currentOutDirAndVault();
  const roots = [outDir, vaultRoot].filter(Boolean);
  let resolved = null;
  try { resolved = fs.realpathSync(notePath); } catch { resolved = null; }
  if (!isNoteDeletable(notePath, resolved, roots)) {
    return { ok: false, error: "Заметка не найдена или находится вне рабочей папки" };
  }
  try {
    const trashDir = trashRootFor(outDir, vaultRoot);
    fs.mkdirSync(trashDir, { recursive: true });
    const dest = trashDestPath(trashDir, path.basename(resolved), fs.existsSync);
    moveToTrash(resolved, dest);
    const entries = loadTrashManifest(trashDir);
    entries.push(buildTrashEntry({
      id: crypto.randomUUID(), deletedAt: Date.now(), kind: "note", files: [dest],
      baseStamp, title, origin: { [dest]: resolved },
    }));
    saveTrashManifest(trashDir, entries);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

// Recording-level ✕ (audio-first История rail's trash feature): trashes the recording's
// out_dir audio file(s) AND every обработка (all versions/templates/languages) in one
// call — every path is validated BEFORE anything is moved, so a bad path can't leave the
// recording half-trashed. notePaths/audioPaths are resolved+validated exactly like
// delete-history-note's single note (isNoteDeletable/isAudioDeletable against out_dir/
// PARA-vault roots); audioPaths uses isAudioDeletable (lib/mainutil.js) — same
// containment check, extended to the known audio extensions (backend.py's _AUDIO_EXT).
// Guarded identically to delete-history-note (global procProc busy-guard) — this app
// only ever runs one processing job at a time, so this already refuses while ANY
// recording (including this one) is being processed.
// `title` (Корзина tab addition) is the recording's display title computed by the
// renderer's deleteRecording (its own notes[0].title/orphan-filename fallback chain) —
// stored on the manifest entry as-is via buildTrashEntry, same as delete-history-note.
ipcMain.handle("delete-history-recording", async (_e, { baseStamp, notePaths, audioPaths, title } = {}) => {
  if (procProc) return { ok: false, error: "Дождитесь окончания обработки" };
  const { outDir, vaultRoot } = currentOutDirAndVault();
  const roots = [outDir, vaultRoot].filter(Boolean);

  const resolvedNotes = [];
  for (const p of (Array.isArray(notePaths) ? notePaths : [])) {
    let resolved = null;
    try { resolved = fs.realpathSync(p); } catch { resolved = null; }
    if (!isNoteDeletable(p, resolved, roots)) {
      return { ok: false, error: "Заметка не найдена или находится вне рабочей папки" };
    }
    resolvedNotes.push(resolved);
  }
  const resolvedAudios = [];
  for (const p of (Array.isArray(audioPaths) ? audioPaths : [])) {
    let resolved = null;
    try { resolved = fs.realpathSync(p); } catch { resolved = null; }
    if (!isAudioDeletable(p, resolved, roots)) {
      return { ok: false, error: "Аудио не найдено или находится вне рабочей папки" };
    }
    resolvedAudios.push(resolved);
  }

  const trashDir = trashRootFor(outDir, vaultRoot);
  const moved = [];
  const origin = {};
  let moveError = null;
  try {
    fs.mkdirSync(trashDir, { recursive: true });
    for (const resolved of [...resolvedNotes, ...resolvedAudios]) {
      const dest = trashDestPath(trashDir, path.basename(resolved), fs.existsSync);
      moveToTrash(resolved, dest);
      moved.push(dest);
      origin[dest] = resolved;
    }
  } catch (e) {
    moveError = String((e && e.message) || e);
  }
  // A partial failure (e.g. 2 of 3 files moved before an error) must still record whatever
  // DID move — otherwise those files would sit in .trash with no manifest entry and never
  // get auto-purged by purgeTrashOnStartup. The manifest write itself is best-effort too:
  // this handler already reported the real error above; a manifest write failure on top of
  // that isn't surfaced as a second error.
  if (moved.length) {
    try {
      const entries = loadTrashManifest(trashDir);
      entries.push(buildTrashEntry({
        id: crypto.randomUUID(), deletedAt: Date.now(), kind: "recording", files: moved,
        baseStamp, title, origin,
      }));
      saveTrashManifest(trashDir, entries);
    } catch {}
  }
  if (moveError) return { ok: false, error: moveError };
  return { ok: true };
});

// ── Корзина tab (trash-tab feature) ──────────────────────────────────────────
// Full trash listing for the sidebar's «🗑 Корзина» view: entries + per-entry computed
// display fields the renderer needs (sizes/notes aren't stored in the manifest itself —
// only real file paths are — so they're recomputed here via fs.statSync on read) plus the
// toolbar's aggregate count+size. Legacy entries (moved before this feature shipped) have
// no `id` — backfilled here and persisted once, same opportunistic-migration pattern
// save-presets already uses for preset ids (see the presets.map(...crypto.randomUUID()...)
// call near this file's top).
ipcMain.handle("list-trash", async () => {
  const { outDir, vaultRoot } = currentOutDirAndVault();
  const trashDir = trashRootFor(outDir, vaultRoot);
  if (!fs.existsSync(trashDir)) return { items: [], totalBytes: 0 };
  let entries = loadTrashManifest(trashDir);
  let migrated = false;
  entries = entries.map((e) => {
    if (e && !e.id) { migrated = true; return { ...e, id: crypto.randomUUID() }; }
    return e;
  });
  if (migrated) { try { saveTrashManifest(trashDir, entries); } catch {} }

  const now = Date.now();
  let totalBytes = 0;
  const items = entries.map((e) => {
    const files = Array.isArray(e.files) ? e.files : [];
    const { audioBytes, noteCount, bytes } = trashEntryBreakdown(files);
    totalBytes += bytes;
    const title = e.title || e.baseStamp || (files[0] ? path.basename(files[0]) : "Без названия");
    return {
      id: e.id, kind: e.kind, title, deletedAt: e.deletedAt,
      daysLeft: trashDaysLeft(e.deletedAt, now), bytes, audioBytes, noteCount,
    };
  });
  return { items, totalBytes };
});

// Restore ONE trash entry: source must resolve inside trashDir (below), destination inside outDir/vaultRoot via restoreTrashFiles (not purgeTrash's check — that one has no destination side); busy-guarded against a concurrent reprocess.
ipcMain.handle("restore-trash-entry", async (_e, { id } = {}) => {
  const busy = busyVerdict([[!!procProc, "Дождитесь окончания обработки"]]);
  if (busy) return { ok: false, error: busy };
  const { outDir, vaultRoot } = currentOutDirAndVault();
  const roots = [outDir, vaultRoot].filter(Boolean);
  const trashDir = trashRootFor(outDir, vaultRoot);
  const entries = loadTrashManifest(trashDir);
  const idx = entries.findIndex((e) => e && e.id === id);
  if (idx === -1) return { ok: false, error: "Запись не найдена в корзине" };
  const entry = entries[idx];
  const files = Array.isArray(entry.files) ? entry.files : [];
  for (const f of files) {
    if (typeof f !== "string" || path.dirname(f) !== trashDir) {
      return { ok: false, error: "Некорректная запись корзины" };
    }
  }
  const { remaining, error: moveError } = restoreTrashFiles(files, entry.origin, outDir, roots);
  if (remaining.length) entries[idx] = { ...entry, files: remaining };
  else entries.splice(idx, 1);
  try { saveTrashManifest(trashDir, entries); } catch {}
  if (moveError) return { ok: false, error: moveError };
  return { ok: true };
});

// Permanently deletes ONE trash entry (Корзина tab's per-row "Удалить навсегда") —
// reuses deleteTrashEntryFiles (lib/mainutil.js), the exact same containment-checked
// unlink logic purgeTrash's 30-day sweep uses, so a hand-edited manifest.json can't turn
// this into a delete-anywhere primitive either.
ipcMain.handle("delete-trash-entry", async (_e, { id } = {}) => {
  const { outDir, vaultRoot } = currentOutDirAndVault();
  const trashDir = trashRootFor(outDir, vaultRoot);
  const entries = loadTrashManifest(trashDir);
  const idx = entries.findIndex((e) => e && e.id === id);
  if (idx === -1) return { ok: false, error: "Запись не найдена в корзине" };
  deleteTrashEntryFiles(entries[idx], trashDir);
  entries.splice(idx, 1);
  try { saveTrashManifest(trashDir, entries); } catch {}
  return { ok: true };
});

// Permanently empties the ENTIRE trash (Корзина tab's toolbar "Очистить корзину") — same
// per-entry deleteTrashEntryFiles reuse as delete-trash-entry above, just looped over
// every entry instead of one.
ipcMain.handle("empty-trash", async () => {
  const { outDir, vaultRoot } = currentOutDirAndVault();
  const trashDir = trashRootFor(outDir, vaultRoot);
  const entries = loadTrashManifest(trashDir);
  for (const entry of entries) deleteTrashEntryFiles(entry, trashDir);
  try { saveTrashManifest(trashDir, []); } catch {}
  return { ok: true };
});

// ── PARA ───────────────────────────────────────────────────────────────────
const PARA_KEYS = ["projects", "areas", "resources", "archives"];

// outDir/outDirCustom are optional — renderer sends the current settings so
// the response can carry the auto-followed outDir back (renderer.js has no
// require("path")/lib/mainutil access: contextIsolation, no nodeIntegration).
ipcMain.handle("para-create-vault", async (_e, { root, folders, outDir, outDirCustom }) => {
  try {
    for (const k of PARA_KEYS) fs.mkdirSync(path.join(root, folders[k]), { recursive: true });
    return { ok: true, outDir: resolveOutDirOnVaultChange(outDir, outDirCustom, root) };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});

// Walk the PARA vault into a nested tree (dirs with note counts + note files), depth-limited.
ipcMain.handle("para-tree", async (_e, root) => {
  const countNotes = (dir) => {
    let n = 0;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      if (e.isDirectory()) n += countNotes(path.join(dir, e.name));
      else if (e.name.endsWith(".md")) n += 1;
    }
    return n;
  };
  const walk = (dir, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
    const nodes = [];
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        nodes.push({ name: e.name, path: p, type: "dir", notes: countNotes(p),
          children: depth > 0 ? walk(p, depth - 1) : [] });
      } else if (e.name.endsWith(".md")) {
        nodes.push({ name: e.name, path: p, type: "note" });
      }
    }
    // dirs first, then notes; alpha within
    return nodes.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
  };
  // Depth 3 was already just enough for the new folder hierarchy's deepest shape
  // (Projects/миссии/<год>. миссия <mission>/meeting-*.md — verified by hand against
  // the real walk() logic: 3 nested walk() recursions reach the 3rd directory level,
  // whose own readdirSync listing then shows the note file regardless of depth,
  // since files bypass the depth gate entirely). Bumped to 4 anyway for headroom —
  // T4-T6, ux-para-batch — so one more level of nesting doesn't silently go dark.
  return walk(root, 4);
});

ipcMain.handle("para-classify", async (_e, arg) => {
  // Guards the interpreter-overwrite-during-install race (see busyVerdict's comment
  // in lib/mainutil.js): this handler spawns runBackend() (pythonBin()) just like
  // process-audio/start-recording, but had no guard at all before.
  const busy = busyVerdict([[!!installBackendProc, "Дождитесь окончания установки бэкенда"]]);
  if (busy) return { error: busy };
  // arg may be a bare note path (legacy) or { note, root, folders, mainModel, language }
  const notePath = typeof arg === "string" ? arg : arg.note;
  const { root, folders, mainModel, language } = typeof arg === "string" ? {} : arg;
  // Containment check (H2 arch-audit): notePath feeds into backend.py's --note
  // (Path(note_path).read_text()) — same roots/validator as read-note above.
  const { outDir, vaultRoot } = currentOutDirAndVault();
  const roots = [outDir, vaultRoot].filter(Boolean);
  let resolvedNote = null;
  try { resolvedNote = fs.realpathSync(notePath); } catch { resolvedNote = null; }
  if (!isPathInsideRoots(resolvedNote, roots)) {
    return { error: "Заметка не найдена или находится вне рабочей папки" };
  }
  // gather existing accumulators per category so the LLM can reuse one (anti-fragmentation)
  let existing = "";
  if (root && folders) {
    const map = {};
    for (const cat of ["projects", "areas", "resources", "archives"]) {
      const dir = path.join(root, folders[cat] || cat);
      try {
        map[cat] = fs.readdirSync(dir)
          .filter((f) => f.endsWith(".md"))
          .map((f) => f.replace(/\.md$/i, ""));
      } catch { map[cat] = []; }
    }
    existing = JSON.stringify(map);
  }
  const args = ["classify", "--note", resolvedNote];
  if (existing) args.push("--existing", existing);
  // Main model for this substantive task — same omit-when-empty contract as
  // process-audio's --main-model above.
  if (mainModel) args.push("--main-model", mainModel);
  // Language pin (T7) — same omit-when-empty contract, mirrors process-audio's own
  // --language passthrough; cmd_classify only special-cases "ru"/"en" (see backend.py).
  if (language) args.push("--language", language);
  return new Promise((resolve) => {
    let out = null;
    runBackend(args,
      (ev) => {
        if (ev.event === EVENTS.CLASSIFIED) {
          out = { category: ev.category, project: ev.project, kind: ev.kind, person: ev.person, mission: ev.mission };
        } else if (ev.event === EVENTS.ERROR) out = { error: ev.msg };
      },
      () => resolve(out || { error: "нет ответа от backend" }));
  });
});

// Словарь tab's «Разложить по категориям» — one-shot LLM batch sort of the "Мои"
// glossary terms into the fixed category buckets (backend.py's classify-terms
// subcommand does the actual LLM call + code-gate). Terms go through a temp JSON
// file (same file-based plumbing as --prompt-file/--glossary-usage-file above —
// avoids CLI arg length/escaping concerns), cleaned up on close either way.
ipcMain.handle("classify-glossary-terms", async (_e, { terms, fastModel } = {}) => {
  // Same interpreter-overwrite-during-install race as para-classify above — this
  // handler spawns runBackend() (pythonBin()) too and had no guard at all before.
  const busy = busyVerdict([[!!installBackendProc, "Дождитесь окончания установки бэкенда"]]);
  if (busy) return { error: busy };
  const list = Array.isArray(terms) ? terms : [];
  if (!list.length) return { categories: {} };
  const termsFile = path.join(TMP_DIR, `glossary-terms-${Date.now()}.json`);
  fs.writeFileSync(termsFile, JSON.stringify(list), "utf-8");
  const args = ["classify-terms", "--terms-file", termsFile];
  if (fastModel) args.push("--fast-model", fastModel);
  return new Promise((resolve) => {
    let out = null;
    runBackend(args,
      (ev) => {
        if (ev.event === EVENTS.CLASSIFIED_TERMS) out = { categories: ev.categories || {} };
        else if (ev.event === EVENTS.ERROR) out = { error: ev.msg };
      },
      () => {
        try { fs.unlinkSync(termsFile); } catch {} /* best-effort: TMP_DIR leftovers are swept by pruneTemp anyway */
        resolve(out || { error: "нет ответа от backend" });
      });
  });
});

// "Разложить" = classify (category + kind/person/mission) and file the RAW note + its
// audio into a folder-hierarchy destination (T4-T6, ux-para-batch): archives/areas/
// resources → <CategoryFolder>/<год>/<месяц>; projects → a one_to_one/mission_daily/
// per-project folder — see lib/mainutil.js's paraDestinationDir for the exact scheme.
// Basenames (meeting-<stamp>*.md) are preserved through the move — История's reconcile
// identity depends on it (backend.py's _iter_vault_notes/_reconcile). This REPLACES the
// old scheme (accumulate the LLM's distilled extract into one root/<category>/
// <project>.md, archive the raw note separately into Archives/Исходные встречи) —
// SEMANTIC CHANGE, see the commit/report: chronology now comes for free from the
// stamp-sorted basenames, so no separate accumulator file is written anymore. The
// LLM-выжимка step that fed the accumulator (para-extract IPC / backend cmd_extract)
// was removed with it — filing is classify + move, no extract call.
ipcMain.handle("para-file", async (_e, { note, audio, category, project, kind, person, mission, stamp, root, folders }) => {
  // Unlike para-classify/classify-glossary-terms, this handler never
  // spawns runBackend() (no pythonBin() involved) — its actual race is a concurrent
  // reprocess (procProc) rewriting the SAME note/audio path this handler is about to
  // rename out from under it. Guarded the same way delete-history-note/
  // delete-history-recording already guard their own note/audio moves.
  const busy = busyVerdict([[!!procProc, "Дождитесь окончания обработки"]]);
  if (busy) return { ok: false, error: busy };
  // Containment checks (H2 arch-audit):
  //  - `root` drives EVERY write destination below (destDir) — must
  //    resolve inside the server's OWN configured PARA vault root
  //    (readParaRoot()), not whatever the renderer happened to send, or this
  //    handler becomes a write-anywhere primitive for a compromised/buggy renderer.
  //  - `note`/`audio` are the SOURCE files renamed into the computed destination folder — must
  //    resolve inside out_dir or the vault root, same roots delete-history-note
  //    validates against (both are optional — mv() below already tolerates a
  //    falsy/missing src, so only present ones are checked).
  const configuredVaultRoot = readParaRoot();
  let resolvedRoot = null;
  try { resolvedRoot = fs.realpathSync(root); } catch { resolvedRoot = null; }
  if (!isPathInsideRoots(resolvedRoot, [configuredVaultRoot].filter(Boolean))) {
    return { ok: false, error: "PARA-корень не найден или не совпадает с настроенным" };
  }
  const { outDir, vaultRoot } = currentOutDirAndVault();
  const srcRoots = [outDir, vaultRoot].filter(Boolean);
  for (const src of [note, audio]) {
    if (!src) continue;
    let resolvedSrc = null;
    try { resolvedSrc = fs.realpathSync(src); } catch { resolvedSrc = null; }
    if (!isPathInsideRoots(resolvedSrc, srcRoots)) {
      return { ok: false, error: "Заметка или аудио не найдены либо вне рабочей папки" };
    }
  }
  try {
    const destSegments = paraDestinationDir({ category, folders, project, kind, person, mission, stamp: stamp || note });
    const destDir = path.join(resolvedRoot, ...destSegments);
    // Containment re-check of the FINAL computed destination (analyzer: the old accum
    // path was built off resolvedRoot but never re-verified itself). destSegments are
    // already sanitized per-segment (paraDestinationDir strips "/", "\\", leading dots),
    // but this is the actual enforcement boundary — belt-and-suspenders against any
    // future change to the builder, not a realpath (destDir doesn't exist yet on a
    // first file into a new folder; isPathInsideRoots/isOutsideRoot are pure string
    // checks, no fs access), so it's safe to run before mkdirSync below creates it.
    if (!isPathInsideRoots(destDir, [resolvedRoot])) {
      return { ok: false, error: "Вычисленный путь назначения вне PARA-корня" };
    }
    fs.mkdirSync(destDir, { recursive: true });

    // Move the RAW note + its audio into the classified folder, preserving their own
    // basenames — История's reconcile identity (meeting-<stamp>*.md, backend.py's
    // _iter_vault_notes/_reconcile, locked by test_backend.py:552-618) must survive
    // any move.
    const mv = (src) => {
      if (!src || !fs.existsSync(src)) return null;
      const d = path.join(destDir, path.basename(src));
      try { fs.renameSync(src, d); } catch { fs.copyFileSync(src, d); fs.unlinkSync(src); }
      return d;
    };
    const noteDest = mv(note);
    mv(audio);
    return { ok: true, dest: noteDest || destDir };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});

ipcMain.handle("reveal", async (_e, p) => {
  // Containment check (H2 arch-audit): reveal() is used for BOTH note and audio
  // paths (renderer.js's nvOpen/nvAudio/ptvOpen/openNote/openAudio) — unlike
  // isNoteDeletable/isAudioDeletable this only enforces containment, no
  // extension requirement, since Finder-revealing an arbitrary file OUTSIDE
  // out_dir/the PARA vault is the actual risk being closed here, not the file
  // type. Every current reveal() target resolves inside out_dir: backend.py's
  // "done"/history "audio" field is always vault_audio (the out_dir copy) —
  // main.js never passes --keep-audio, so backend.py's own default
  // (keep_audio_in_obsidian=True) is always in effect.
  const { outDir, vaultRoot } = currentOutDirAndVault();
  const roots = [outDir, vaultRoot].filter(Boolean);
  let resolved = null;
  try { resolved = fs.realpathSync(p); } catch { resolved = null; }
  if (!isPathInsideRoots(resolved, roots)) {
    return { ok: false, error: "Файл не найден или находится вне рабочей папки" };
  }
  const { shell } = require("electron");
  shell.showItemInFolder(resolved);
  return { ok: true };
});

// Shared with the auto-index trigger below — one place defines what "run the indexer" means.
function indexArgs(root) {
  return ["index", "--root", root, "--db", DB_PATH];
}

// ── auto-index (background, after a successful `process` run) ───────────────
// Same spawn as the button-driven para-reindex above, but self-triggered and
// serialized via indexRunReducer so a run already in flight isn't duplicated.
let indexRunState = { inFlight: false, queued: false };

// Direct presets.json read, mirroring get-presets's own read+fallback. Unlike
// para-reindex (root comes in as an IPC arg from the renderer's cached state),
// this fires from a background completion callback with no renderer round-trip
// to piggyback config on, so main reads the persisted config itself.
function readParaRoot() {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(PRESETS_FILE, "utf-8"));
  } catch {
    try { data = JSON.parse(fs.readFileSync(PRESETS_EXAMPLE, "utf-8")); }
    catch { return null; }
  }
  const root = data && data.para && data.para.root;
  return root ? expandHome(root) : null;
}

function startAutoIndex(root) {
  autoIndexProc = runBackend(indexArgs(root),
    (ev) => {
      if (ev.event === EVENTS.LOG || ev.event === EVENTS.ERROR) send("para-reindex-event", ev);
    },
    () => {
      autoIndexProc = null;
      const next = indexRunReducer(indexRunState, "complete");
      indexRunState = next.state;
      // Killing autoIndexProc in before-quit still lets this close callback fire
      // (kill() is async) — without the quitting check, a queued trailing run
      // would spawn a fresh, untracked child right as the app exits: the exact
      // orphan the before-quit fix targets. indexRunReducer itself stays a pure
      // state machine (see lib/mainutil.js) — the app-quit check belongs here.
      if (next.shouldStart && !quitting) startAutoIndex(root);
    });
}

// Called after process-audio saves a note. Silent no-op if PARA isn't configured.
function triggerAutoIndex(notePath) {
  const root = readParaRoot();
  if (!root) return;
  if (isOutsideRoot(path.dirname(notePath), root)) {
    send("para-reindex-event", {
      event: "log",
      msg: `Заметка сохранена вне индексируемого vault (${root}): ${notePath}`,
    });
  }
  const next = indexRunReducer(indexRunState, "trigger");
  indexRunState = next.state;
  if (next.shouldStart) startAutoIndex(root);
}

ipcMain.handle("para-reindex", async (_e, { root }) => {
  // Route through the same in-flight guard as the auto-index trigger (indexRunReducer)
  // so a manual reindex can never run concurrently with a background one on the same
  // index.db. If one is already running, this queues exactly one trailing run (same
  // semantics as triggerAutoIndex) and tells the renderer immediately via the existing
  // error slot instead of leaving the button spinner hanging on a run that never starts.
  const trig = indexRunReducer(indexRunState, "trigger");
  indexRunState = trig.state;
  if (!trig.shouldStart) {
    return { error: "Индексация уже выполняется — запрос поставлен в очередь" };
  }
  return new Promise((resolve) => {
    let summary = null;
    runBackend(indexArgs(root),
      (ev) => {
        if (ev.event === EVENTS.INDEXED) summary = { indexed: ev.indexed, skipped: ev.skipped, removed: ev.removed };
        else if (ev.event === EVENTS.LOG || ev.event === EVENTS.ERROR) send("para-reindex-event", ev);
      },
      (_code, stderr) => {
        if (!summary) summary = { error: stderr || "нет ответа от backend" };
        const next = indexRunReducer(indexRunState, "complete");
        indexRunState = next.state;
        if (next.shouldStart) startAutoIndex(root);
        resolve(summary);
      });
  });
});

ipcMain.handle("para-search", async (_e, { root, messages, query, mainModel }) => {
  if (searchProc) return { ok: false, error: "Поиск уже идёт" };
  // Accept either {root, messages} (multi-turn) or {root, query} (legacy single-shot).
  // Normalise to --messages form so backend always gets a proper conversation array.
  let msgArray = messages;
  if (!msgArray) {
    // back-compat: legacy {root, query} call → wrap as single-message array
    msgArray = [{ role: "user", content: query || "" }];
  }
  const messagesJson = JSON.stringify(msgArray);
  // backend.py logs this exact line (via log(), in _rag_retrieve) before emitting
  // search_result whenever no embedding model was found — search fell back to
  // keyword-only (FTS) retrieval. Surfaced to the renderer as result.degraded.
  const DEGRADED_LOG_MSG = "Embedding-модель недоступна — поиск только по ключевым словам";
  searchCanceled = false;
  const args = ["search", "--root", root, "--db", DB_PATH, "--messages", messagesJson];
  // Main model for the answer call only — same omit-when-empty contract as
  // process-audio's --main-model above.
  if (mainModel) args.push("--main-model", mainModel);
  return new Promise((resolve, reject) => {
    let result = null;
    let degraded = false;
    searchProc = runBackend(args,
      (ev) => {
        if (ev.event === EVENTS.SEARCH_RESULT) result = { found: ev.found, answer: ev.answer, citations: ev.citations, degraded };
        else if (ev.event === EVENTS.ERROR) result = { found: false, error: ev.msg };
        else if (ev.event === EVENTS.LOG && ev.msg === DEGRADED_LOG_MSG) degraded = true;
      },
      (_code, stderr) => {
        const canceled = searchCanceled;
        searchProc = null;
        searchCanceled = false;
        if (canceled) resolve({ found: false, canceled: true });
        else if (result) resolve(result);
        else reject(new Error(stderr || "нет ответа от backend"));
      });
  });
});

// cancel an in-flight search query; safe because backend's cmd_search closes its
// DB handle before the slow answer-LLM call (backend.py) — SIGTERM mid-request
// has no local state left to corrupt. Mirrors cancel-process verbatim.
ipcMain.handle("cancel-search", async () => {
  if (!searchProc) return { ok: false, error: "Поиск не идёт" };
  searchCanceled = true;
  searchProc.kill("SIGTERM");
  return { ok: true };
});
