const { app, BrowserWindow, ipcMain, dialog, safeStorage, systemPreferences } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const readline = require("readline");
const {
  WavWriter, rmsLevel, cacheKey, pairHistory,
  encodeTokenBlob, decodeTokenBlob, isStale,
  rewriteNoteSpeakers, isOutsideRoot, indexRunReducer, diskGuardVerdict,
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
const BACKEND = path.join(APP_DIR, "backend.py");
const PRESETS_FILE = path.join(APP_DIR, "presets.json");
const PRESETS_EXAMPLE = path.join(APP_DIR, "presets.example.json");
const DB_PATH = path.join(APP_DIR, "index.db"); // derived SQLite index (gitignored)
const TMP_DIR = path.join(os.tmpdir(), "meeting-recorder");
const DEFAULT_OUT = path.join(os.homedir(), "Documents", "Obsidian", "Meetings");

fs.mkdirSync(TMP_DIR, { recursive: true });

let mainWindow = null;
let recordProc = null; // live mic recording subprocess
let procProc = null;   // live processing subprocess
let procCanceled = false; // set when the user cancels processing
let tee = null;        // AudioTee instance (system audio)
let sysWav = null;     // WavWriter for system.wav
let session = null;    // { dir, micPath, sysPath, mixedPath, micRecorded }

function pythonBin() {
  return fs.existsSync(VENV_PYTHON) ? VENV_PYTHON : "python3";
}

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
  const proc = spawn(pythonBin(), [BACKEND, ...args], {
    cwd: APP_DIR,
    env: { ...process.env, PYTHONUNBUFFERED: "1", ...extraEnv },
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
  sweep(TMP_DIR, "cache");                 // old rec-* session dirs
  sweep(path.join(TMP_DIR, "cache"), null); // old per-audio cache dirs
}

app.whenReady().then(() => {
  try { pruneTemp(7 * 24 * 3600 * 1000); } catch {}
  createWindow();
});

let quitting = false;
app.on("before-quit", async (e) => {
  if (quitting) return;
  // mic.wav is finalized by python only after it sees "stop" — must await before exit
  if (recordProc || tee) {
    e.preventDefault();
    quitting = true;
    if (tee) { try { await tee.stop(); } catch {} try { if (sysWav) sysWav.close(); } catch {} tee = null; sysWav = null; }
    if (recordProc) {
      try { recordProc.stdin.write("stop\n"); } catch { recordProc.kill(); }
      // align with stop-recording: wait for the WAV to finalize, generous bound
      await waitFor(() => (session && (session.micRecorded || session.micErrored)) || recordProc === null, 30000);
    }
    if (procProc) procProc.kill();
    app.quit();
  } else if (procProc) {
    procProc.kill();
  }
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
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
  };
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

// HF token is a secret → kept out of presets.json, encrypted via OS keychain (safeStorage).
const SECRET_FILE = path.join(APP_DIR, ".secret");
function saveToken(token) {
  try {
    if (!token) { try { fs.unlinkSync(SECRET_FILE); } catch {} return; }
    const blob = encodeTokenBlob(token, safeStorage.isEncryptionAvailable(),
      (t) => safeStorage.encryptString(t));
    fs.writeFileSync(SECRET_FILE, blob, "utf-8");
  } catch {}
}
function loadToken() {
  try {
    return decodeTokenBlob(fs.readFileSync(SECRET_FILE, "utf-8"),
      (b) => safeStorage.decryptString(b));
  } catch {}
  return "";
}

ipcMain.handle("get-presets", async () => {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(PRESETS_FILE, "utf-8"));
  } catch {
    // fresh clone: fall back to the committed template (personal presets.json is gitignored)
    try {
      data = JSON.parse(fs.readFileSync(PRESETS_EXAMPLE, "utf-8"));
    } catch {
      return { presets: [], defaultOutDir: DEFAULT_OUT, hfToken: loadToken(), secretEncrypted: safeStorage.isEncryptionAvailable() };
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
  data.secretEncrypted = safeStorage.isEncryptionAvailable(); // false → token stored reversibly
  return data;
});

ipcMain.handle("save-presets", async (_e, data) => {
  const { hfToken, ...rest } = data;     // never persist the token in presets.json
  saveToken(hfToken || "");
  writeJsonAtomic(PRESETS_FILE, rest);
  return true;
});

ipcMain.handle("pick-audio", async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    properties: ["openFile"],
    filters: [{ name: "Audio", extensions: ["wav", "mp3", "m4a", "aac", "flac", "ogg", "mp4", "mov"] }],
  });
  return res.canceled ? null : res.filePaths[0];
});

ipcMain.handle("pick-out-dir", async () => {
  const res = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory", "createDirectory"] });
  return res.canceled ? null : res.filePaths[0];
});

// recording: start — mic (python/pyaudio) + system audio (AudioTee), in parallel
ipcMain.handle("start-recording", async (_e, opts) => {
  if (recordProc || tee) return { ok: false, error: "Запись уже идёт" };

  // Disk guard: session dirs live under TMP_DIR — check that volume's free space
  // before committing to a recording. statfs failures (unsupported FS, etc.)
  // don't block recording — the guard degrades to "ok" silently.
  let diskVerdict = { action: "ok", msg: null };
  try {
    const st = fs.statfsSync(TMP_DIR);
    diskVerdict = diskGuardVerdict(st.bavail * st.bsize);
  } catch {}
  if (diskVerdict.action === "refuse") return { ok: false, error: diskVerdict.msg };

  const micDevice = opts && opts.micDevice;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const dir = path.join(TMP_DIR, `rec-${stamp}`);
  fs.mkdirSync(dir, { recursive: true });
  session = {
    dir,
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
        send("record-event", {
          event: "recorded",
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
  const { audioFile, prompt, diarize, outDir, engine, hfToken, fresh, language, summarize, template } = opts;
  if (procProc) return { ok: false, error: "Обработка уже идёт" };

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
    "--summarize", summarize === false ? "false" : "true",
    "--template", template || "",
    "--db", DB_PATH,
  ];
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

ipcMain.handle("para-create-vault", async (_e, { root, folders }) => {
  try {
    for (const k of PARA_KEYS) fs.mkdirSync(path.join(root, folders[k]), { recursive: true });
    return { ok: true };
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
  runBackend(indexArgs(root),
    (ev) => {
      if (ev.event === "log" || ev.event === "error") send("para-reindex-event", ev);
    },
    () => {
      const next = indexRunReducer(indexRunState, "complete");
      indexRunState = next.state;
      if (next.shouldStart) startAutoIndex(root);
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
  return new Promise((resolve) => {
    let summary = null;
    runBackend(indexArgs(root),
      (ev) => {
        if (ev.event === "indexed") summary = { indexed: ev.indexed, skipped: ev.skipped, removed: ev.removed };
        else if (ev.event === "log" || ev.event === "error") send("para-reindex-event", ev);
      },
      (_code, stderr) => {
        if (!summary) summary = { error: stderr || "нет ответа от backend" };
        resolve(summary);
      });
  });
});

ipcMain.handle("para-search", async (_e, { root, messages, query }) => {
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
  return new Promise((resolve, reject) => {
    let result = null;
    let degraded = false;
    runBackend(["search", "--root", root, "--db", DB_PATH, "--messages", messagesJson],
      (ev) => {
        if (ev.event === "search_result") result = { found: ev.found, answer: ev.answer, citations: ev.citations, degraded };
        else if (ev.event === "error") result = { found: false, error: ev.msg };
        else if (ev.event === "log" && ev.msg === DEGRADED_LOG_MSG) degraded = true;
      },
      (_code, stderr) => {
        if (result) resolve(result);
        else reject(new Error(stderr || "нет ответа от backend"));
      });
  });
});
