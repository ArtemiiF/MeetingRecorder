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
  rewriteNoteSpeakers, isOutsideRoot, indexRunReducer, diskGuardVerdict,
  resolveOutDirOnVaultChange, trayMenuTemplate,
  resolvePythonBin, resolveFfmpegBin, resolveResourcePath, backendInstallStatus,
  whisperModelDir, vadJitPath, diarizationModelDirs, appReadinessStatus,
  cleanupPartialModelCache,
} = require("./lib/mainutil");

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
const APP_DIR = __dirname;
const PROJECT_DIR = path.dirname(APP_DIR); // MeetingRecorder/
const VENV_PYTHON = path.join(PROJECT_DIR, "venv", "bin", "python");
// backend.py/requirements.txt/vendor-wheels ship as app resources — packaged under
// process.resourcesPath (via electron-builder extraResources), dev checkout has them
// directly in APP_DIR. See resolveResourcePath (lib/mainutil).
const BACKEND = resolveResourcePath(app.isPackaged, process.resourcesPath, APP_DIR, "backend.py");
const REQUIREMENTS_FILE = resolveResourcePath(app.isPackaged, process.resourcesPath, APP_DIR, "requirements.txt");
const VENDOR_WHEELS_DIR = resolveResourcePath(app.isPackaged, process.resourcesPath, APP_DIR, "vendor/wheels");
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
    try { if (sysWav) sysWav.close(); } catch {}
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
    try {
      onEvent(JSON.parse(line));
    } catch {
      onEvent({ event: "log", msg: line });
    }
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
  const icon = nativeImage.createFromPath(path.join(APP_DIR, "assets", "trayTemplate.png"));
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
    if (tee) { try { await tee.stop(); } catch {} try { if (sysWav) sysWav.close(); } catch {} tee = null; sysWav = null; }
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
    app.quit();
  } else if (procProc || autoIndexProc || modelDlProc || searchProc || installBackendProc) {
    if (procProc) procProc.kill();
    if (autoIndexProc) autoIndexProc.kill();
    if (modelDlProc) modelDlProc.kill();
    if (searchProc) searchProc.kill();
    if (installBackendProc) installBackendProc.kill();
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
    runBackend(["preflight"], (ev) => { if (ev.event === "preflight") out = ev; },
      () => resolve(out), token ? { HF_TOKEN: token } : {});
  });
  return {
    lmStudio, mic, screen, embedModel,
    ffmpeg: !!be.ffmpeg, whisperCached: !!be.whisper_cached, hfToken: !!be.hf_token,
    backendInstalled: backendAvailable(),
  };
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

ipcMain.handle("list-devices", async () => {
  return new Promise((resolve) => {
    let devices = [];
    runBackend(["devices"], (ev) => {
      if (ev.event === "devices") devices = ev.devices;
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

function saveToken(token) {
  try {
    if (!token) { try { fs.unlinkSync(SECRET_FILE); } catch {} _tokenCache = null; return; }
    const blob = encodeTokenBlob(token, encryptionAvailable(),
      (t) => safeStorage.encryptString(t));
    fs.writeFileSync(SECRET_FILE, blob, "utf-8");
    _tokenCache = null;
  } catch {}
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
  saveToken(hfToken || "");
  writeJsonAtomic(PRESETS_FILE, rest);
  return true;
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
    fresh = { presets: [], defaultOutDir: DEFAULT_OUT, authorName: "Автор", glossary: "", language: "ru" };
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
  if (recordProc || tee) return { ok: false, error: "Запись уже идёт" };
  // Recording spawns pythonBin() too (mic capture) — a concurrent install-backend
  // run can be actively overwriting that same interpreter file underneath it.
  if (installBackendProc) return { ok: false, error: "Дождитесь окончания установки бэкенда" };

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
      if (ev.event === "recorded") session.micRecorded = true;
      if (ev.event === "error") session.micErrored = true;
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
    tee = new AudioTee({ sampleRate: SYS_SAMPLE_RATE, chunkDurationMs: 200 });
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
    tee.on("error", (err) =>
      send("record-event", { event: "system-audio-error", msg: String((err && err.message) || err) }));
    await tee.start();
    send("record-event", { event: "system-audio-started" });
  } catch (e) {
    // permission denied / macOS < 14.2 → continue mic-only, surface to UI
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
    try { await tee.stop(); } catch {}
    try { if (sysWav) sysWav.close(); } catch {}
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
      try { recordProc.kill("SIGTERM"); } catch {}
      await waitFor(() => recordProc === null, 3000);
    }
  }
  // 3. mix whatever tracks we actually got
  const nonEmpty = (p) => fs.existsSync(p) && fs.statSync(p).size > 44;
  const micOk = nonEmpty(session.micPath);
  const sysOk = nonEmpty(session.sysPath);
  const args = ["mix", "--out", session.mixedPath];
  if (micOk) args.push("--mic", session.micPath);
  if (sysOk) args.push("--system", session.sysPath);
  // NOTE: no auto track-alignment. A receipt-time delta (Date.now at first mic event
  // vs first AudioTee chunk) is dominated by python/pyaudio startup latency, not by the
  // real audio-start offset — injecting it as adelay added hundreds of ms of skew to
  // otherwise-fine mixes. Proper alignment needs PCM cross-correlation; until then amix
  // at t=0 (the raw-capture baseline) is the honest default. build_mix_filter still
  // supports adelay for a future real measurement.

  runBackend(
    args,
    (ev) => {
      if (ev.event === "mixed") {
        // Recording finished capture — persist it to the pending-recordings manifest
        // (survives an app restart) before telling the renderer, so the queue and the
        // notification can never disagree about what's waiting to be processed.
        const id = session.stamp;
        const name = `Запись ${session.displayStamp}`;
        const manifest = loadPendingManifest();
        manifest.push({
          id, name, stamp: session.stamp, dir: session.dir,
          mixed: ev.file, mic: micOk ? session.micPath : null, system: sysOk ? session.sysPath : null,
          tracks: ev.tracks,
        });
        savePendingManifest(manifest);
        send("record-event", {
          event: "recorded",
          id, name,
          file: ev.file,
          mic: micOk ? session.micPath : null,
          system: sysOk ? session.sysPath : null,
          tracks: ev.tracks,
        });
      } else if (ev.event === "error") {
        send("record-event", { event: "error", msg: ev.msg });
      } else {
        send("record-event", ev);
      }
    },
    () => {}
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
  const manifest = loadPendingManifest();
  const idx = manifest.findIndex((r) => r.id === id);
  if (idx < 0) return { ok: false, error: "Запись не найдена" };
  const [entry] = manifest.splice(idx, 1);
  try { if (entry.dir) fs.rmSync(entry.dir, { recursive: true, force: true }); } catch {}
  savePendingManifest(manifest);
  return { ok: true };
});

// Stable cache dir for an audio file (path+size+mtime) → resumable stages survive
// a cancel/failed run, so a re-run reuses transcript/diarization instead of redoing them.
function cacheDirFor(audioFile) {
  let tag = audioFile;
  try {
    const st = fs.statSync(audioFile);
    tag = `${audioFile}:${st.size}:${Math.round(st.mtimeMs)}`;
  } catch {}
  const dir = path.join(TMP_DIR, "cache", cacheKey(tag));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// processing pipeline
ipcMain.handle("process-audio", async (_e, opts) => {
  const { audioFile, prompt, diarize, outDir, engine, hfToken, fresh, language, glossary, summarize, template, micFile, systemFile, authorName } = opts;
  if (procProc) return { ok: false, error: "Обработка уже идёт" };
  if (modelDlProc) return { ok: false, error: "Дождитесь окончания скачивания моделей" };
  // Same reasoning as start-recording's guard above: processing spawns pythonBin(),
  // which an in-flight install may be actively replacing on disk.
  if (installBackendProc) return { ok: false, error: "Дождитесь окончания установки бэкенда" };
  if (!backendAvailable()) return { ok: false, error: "Бэкенд не установлен — откройте Настройки → Бэкенд" };
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
  // UI-entered token wins over a shell env one; empty → backend skips diarization.
  const extraEnv = hfToken && hfToken.trim() ? { HF_TOKEN: hfToken.trim() } : {};
  let doneNote = null; // captured from the "done" event, used to auto-index on close
  procProc = runBackend(
    args,
    (ev) => {
      if (ev.event === "done") doneNote = ev.note;
      send("process-event", ev);
    },
    (code, stderr) => {
      const canceled = procCanceled;
      send("process-event", { event: "process-closed", code, stderr, canceled });
      try { fs.unlinkSync(promptFile); } catch {}
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
    runBackend(["models"], (ev) => { if (ev.event === "models") out = ev.items; },
      () => resolve(out), token ? { HF_TOKEN: token } : {});
  });
  return items;
});

// Start a (re)download batch. opts.only: array of model ids, or omitted = all missing.
// Mutually exclusive with procProc (and vice versa, see process-audio's guard above) —
// refuse to run a model download while a recording/processing run is active.
ipcMain.handle("download-models", async (_e, opts) => {
  if (modelDlProc) return { ok: false, error: "Скачивание уже идёт" };
  if (procProc) return { ok: false, error: "Дождитесь окончания обработки" };
  if (recordProc || tee) return { ok: false, error: "Дождитесь окончания записи" };
  // Model download also spawns pythonBin() (backend.py's download-models command) —
  // same install-in-progress hazard as start-recording/process-audio above.
  if (installBackendProc) return { ok: false, error: "Дождитесь окончания установки бэкенда" };

  // Disk guard: models download into ~/.cache, not TMP_DIR — check that volume.
  let diskVerdict = { action: "ok", msg: null };
  try {
    const st = fs.statfsSync(os.homedir());
    diskVerdict = diskGuardVerdict(st.bavail * st.bsize, MODEL_DL_REFUSE_BYTES, MODEL_DL_WARN_BYTES);
  } catch {}
  if (diskVerdict.action === "refuse") return { ok: false, error: diskVerdict.msg };

  const only = opts && Array.isArray(opts.only) && opts.only.length ? opts.only : null;
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
      if (ev.event === "stage") inFlightModelId = (ev.stage || "").replace(/^model:/, "") || null;
      else if (ev.event === "stage_end") inFlightModelId = null;
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

// Stream a URL to destPath, verifying its sha256 against expectedSha256 and
// following redirects (GitHub release assets 302 to a signed blob URL). Tracks
// itself in installBackendProc so cancel-install-backend can abort mid-download.
// onProgress(pct) fires at most once per whole percentage point.
function downloadToFile(url, destPath, expectedSha256, onProgress) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "MeetingRecorder" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        resolve(downloadToFile(res.headers.location, destPath, expectedSha256, onProgress));
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
    installBackendProc = { kill: () => req.destroy(new Error("отменено")) };
  });
}

// Spawn cmd/args to completion, tracked in installBackendProc for cancellation.
// opts.onLine(text), if given, gets both stdout lines and raw stderr chunks —
// pip interleaves progress on both streams.
function runInstallStep(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd: opts.cwd });
    installBackendProc = proc;
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
        (pct) => send("install-backend-event", { event: "download-progress", stage: "python", pct }));
      if (installBackendCanceled) throw new Error("отменено");
      await runInstallStep("tar", ["-xzf", pyTarball, "-C", BACKEND_ENV_STAGING]);
    });

    await withInstallStage("ffmpeg", "Скачиваю ffmpeg…", async () => {
      const ffmpegZip = path.join(tmpDir, "ffmpeg.zip");
      await downloadToFile(FFMPEG_STATIC_URL, ffmpegZip, FFMPEG_STATIC_SHA256,
        (pct) => send("install-backend-event", { event: "download-progress", stage: "ffmpeg", pct }));
      if (installBackendCanceled) throw new Error("отменено");
      const extractDir = path.join(tmpDir, "ffmpeg-extract");
      fs.mkdirSync(extractDir, { recursive: true });
      await runInstallStep("unzip", ["-o", ffmpegZip, "-d", extractDir]);
      fs.mkdirSync(path.join(BACKEND_ENV_STAGING, "bin"), { recursive: true });
      fs.copyFileSync(path.join(extractDir, "ffmpeg"), stagingFfmpeg);
      fs.chmodSync(stagingFfmpeg, 0o755);
    });

    await withInstallStage("pip", "Устанавливаю зависимости (~1.3 ГБ, несколько минут)…", () =>
      runInstallStep(stagingPython,
        ["-m", "pip", "install", "--no-cache-dir", "--find-links", VENDOR_WHEELS_DIR, "-r", REQUIREMENTS_FILE],
        { onLine: (line) => send("install-backend-event", { event: "log", msg: line }) }));

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
  if (installBackendProc) return { ok: false, error: "Установка уже идёт" };
  if (recordProc || tee) return { ok: false, error: "Дождитесь окончания записи" };
  if (procProc) return { ok: false, error: "Дождитесь окончания обработки" };
  if (modelDlProc) return { ok: false, error: "Дождитесь окончания скачивания моделей" };

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
ipcMain.handle("backend-status", async () => {
  let marker = null;
  try { marker = JSON.parse(fs.readFileSync(BACKEND_MARKER, "utf-8")); } catch {}
  let reqHash = null;
  try { reqHash = cacheKey(fs.readFileSync(REQUIREMENTS_FILE, "utf-8")); } catch {}
  return backendInstallStatus(marker, reqHash, fs.existsSync(INSTALLED_PYTHON));
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

// Past recordings: query the backend's SQLite index (reconciled against the notes dir).
ipcMain.handle("list-history", async (_e, outDir) => {
  const dir = expandHome(outDir) || DEFAULT_OUT;
  const items = await new Promise((resolve) => {
    let out = [];
    runBackend(["history", "--out-dir", dir, "--db", DB_PATH],
      (ev) => { if (ev.event === "history") out = ev.items; },
      () => resolve(out));
  });
  return items.map((it) => ({
    name: it.stamp,
    title: it.title,
    template: it.template,
    language: it.language,
    note: it.note,
    audio: it.audio,
    mtime: it.mtime,
  }));
});

// Rewrite speaker labels in a saved note (**[old]** → **[new]**) and the
// frontmatter speakers key, atomically.
ipcMain.handle("rename-speakers", async (_e, { notePath, map }) => {
  try {
    const text = fs.readFileSync(notePath, "utf-8");
    const rewritten = rewriteNoteSpeakers(text, map || {});
    const tmp = notePath + ".tmp";
    fs.writeFileSync(tmp, rewritten, "utf-8");
    fs.renameSync(tmp, notePath);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

ipcMain.handle("read-note", async (_e, notePath) => {
  try { return fs.readFileSync(notePath, "utf-8"); } catch { return null; }
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
  return walk(root, 3);
});

ipcMain.handle("para-classify", async (_e, arg) => {
  // arg may be a bare note path (legacy) or { note, root, folders }
  const notePath = typeof arg === "string" ? arg : arg.note;
  const { root, folders } = typeof arg === "string" ? {} : arg;
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
  const args = ["classify", "--note", notePath];
  if (existing) args.push("--existing", existing);
  return new Promise((resolve) => {
    let out = null;
    runBackend(args,
      (ev) => {
        if (ev.event === "classified") out = { category: ev.category, project: ev.project };
        else if (ev.event === "error") out = { error: ev.msg };
      },
      () => resolve(out || { error: "нет ответа от backend" }));
  });
});

ipcMain.handle("para-extract", async (_e, notePath) => {
  return new Promise((resolve) => {
    let out = null;
    runBackend(["extract", "--note", notePath],
      (ev) => {
        if (ev.event === "extracted") out = { content: ev.content };
        else if (ev.event === "error") out = { error: ev.msg };
      },
      () => resolve(out || { error: "нет ответа от backend" }));
  });
});

// "Разложить" = distil knowledge into a living accumulator file, not just move the
// raw note. Appends the extracted sections (dated block) into root/<category>/<project>.md,
// then files the raw note + audio into Archives so nothing is lost and the inbox clears.
ipcMain.handle("para-file", async (_e, { note, audio, category, project, extracted, title, stamp, root, folders }) => {
  try {
    const folder = (folders && folders[category]) || category;
    const proj = (project || "").trim().replace(/[/\\:]/g, "-") || "Без названия";
    const accum = path.join(root, folder, proj + ".md");
    fs.mkdirSync(path.dirname(accum), { recursive: true });
    if (!fs.existsSync(accum)) fs.writeFileSync(accum, `# ${proj}\n`);
    // heading date = the meeting date from the file stamp (meeting-YYYY-MM-DD-…),
    // not the extraction date; title appended only when there is a real one.
    const m = String(stamp || note || "").match(/(\d{4}-\d{2}-\d{2})/);
    const date = m ? m[1] : new Date().toISOString().slice(0, 10);
    const t = (title || "").trim();
    const heading = t ? `## ${date} — ${t}` : `## ${date}`;
    fs.appendFileSync(accum, `\n\n${heading}\n\n${(extracted || "").trim()}\n`);

    // archive the raw source (note + audio) out of the Meetings inbox
    const archiveDir = path.join(root, (folders && folders.archives) || "Archives", "Исходные встречи");
    fs.mkdirSync(archiveDir, { recursive: true });
    const mv = (src) => {
      if (!src || !fs.existsSync(src)) return;
      const d = path.join(archiveDir, path.basename(src));
      try { fs.renameSync(src, d); } catch { fs.copyFileSync(src, d); fs.unlinkSync(src); }
    };
    mv(note);
    mv(audio);
    return { ok: true, dest: accum };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});

ipcMain.handle("reveal", async (_e, p) => {
  const { shell } = require("electron");
  shell.showItemInFolder(p);
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
      if (ev.event === "log" || ev.event === "error") send("para-reindex-event", ev);
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
        if (ev.event === "indexed") summary = { indexed: ev.indexed, skipped: ev.skipped, removed: ev.removed };
        else if (ev.event === "log" || ev.event === "error") send("para-reindex-event", ev);
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

ipcMain.handle("para-search", async (_e, { root, messages, query }) => {
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
  return new Promise((resolve, reject) => {
    let result = null;
    let degraded = false;
    searchProc = runBackend(["search", "--root", root, "--db", DB_PATH, "--messages", messagesJson],
      (ev) => {
        if (ev.event === "search_result") result = { found: ev.found, answer: ev.answer, citations: ev.citations, degraded };
        else if (ev.event === "error") result = { found: false, error: ev.msg };
        else if (ev.event === "log" && ev.msg === DEGRADED_LOG_MSG) degraded = true;
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
