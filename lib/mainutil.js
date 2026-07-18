// Pure, electron-free helpers used by main.js — extracted so they're unit-testable
// under plain `node --test` (main.js itself requires("electron") and can't be loaded headless).
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// ── WAV ────────────────────────────────────────────────────────────────────
function buildWavHeader(dataLen, sampleRate, channels, bits) {
  const byteRate = (sampleRate * channels * bits) / 8;
  const blockAlign = (channels * bits) / 8;
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + dataLen, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22); h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(byteRate, 28); h.writeUInt16LE(blockAlign, 32);
  h.writeUInt16LE(bits, 34); h.write("data", 36); h.writeUInt32LE(dataLen, 40);
  return h;
}

// Streaming WAV writer: placeholder header, append PCM, patch sizes on close.
class WavWriter {
  constructor(filePath, sampleRate, channels, bits) {
    this.path = filePath; this.sr = sampleRate; this.ch = channels;
    this.bits = bits; this.dataLen = 0;
    this.fd = fs.openSync(filePath, "w");
    fs.writeSync(this.fd, buildWavHeader(0, sampleRate, channels, bits), 0, 44, 0);
  }
  // explicit position (after the 44-byte header) — mixing positional + non-positional
  // writeSync leaves the fd offset undefined on macOS and corrupts the header/first samples.
  write(buf) {
    fs.writeSync(this.fd, buf, 0, buf.length, 44 + this.dataLen);
    this.dataLen += buf.length;
  }
  close() {
    fs.writeSync(this.fd, buildWavHeader(this.dataLen, this.sr, this.ch, this.bits), 0, 44, 0);
    fs.closeSync(this.fd);
  }
}

// ── VU level ────────────────────────────────────────────────────────────────
// RMS level (0..1) of an Int16LE PCM buffer.
function rmsLevel(buf) {
  const n = buf.length >> 1;
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i + 1 < buf.length; i += 2) { const s = buf.readInt16LE(i); sum += s * s; }
  return Math.min(1, Math.sqrt(sum / n) / 4000);
}

// ── cache key ─────────────────────────────────────────────────────────────
// Stable per-audio key (path+size+mtime). Same inputs → same key; any change → new key.
function cacheKey(tag) {
  return crypto.createHash("sha1").update(tag).digest("hex").slice(0, 16);
}

// ── history pairing ─────────────────────────────────────────────────────────
// Pair meeting-*.md notes with their audio (same stem). mtimeOf(name)->ms.
// non-ru notes are named meeting-<stamp>-<lang>.md while their audio stays
// meeting-<stamp>.<ext> (shared) — strip the lang token to find the audio.
const NOTE_LANGS = new Set(["en", "auto"]);
function pairHistory(files, mtimeOf) {
  const audioExt = new Set([".wav", ".mp3", ".m4a", ".aac", ".flac", ".ogg", ".mp4", ".mov"]);
  const ext = (f) => { const i = f.lastIndexOf("."); return i < 0 ? "" : f.slice(i).toLowerCase(); };
  return files
    .filter((f) => f.startsWith("meeting-") && f.endsWith(".md"))
    .map((note) => {
      const stem = note.slice(0, -3); // meeting-<stamp>[-<lang>]
      const m = stem.match(/^(.*)-([a-z]{2,4})$/);
      const audioStem = m && NOTE_LANGS.has(m[2]) ? m[1] : stem;
      const audio = files.find((f) => f !== note && f.startsWith(audioStem + ".") && audioExt.has(ext(f)));
      return {
        name: stem.replace(/^meeting-/, ""),
        note,
        audio: audio || null,
        mtime: mtimeOf(note) || 0,
      };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

// ── secret token blob (encryption injected so it's testable without electron) ──
function encodeTokenBlob(token, available, encryptFn) {
  if (!token) return null;
  return available
    ? "enc:" + encryptFn(token).toString("base64")
    : "raw:" + Buffer.from(token, "utf8").toString("base64");
}
function decodeTokenBlob(blob, decryptFn) {
  if (!blob) return "";
  if (blob.startsWith("enc:")) return decryptFn(Buffer.from(blob.slice(4), "base64"));
  if (blob.startsWith("raw:")) return Buffer.from(blob.slice(4), "base64").toString("utf8");
  return "";
}

// ── retention ────────────────────────────────────────────────────────────────
function isStale(mtimeMs, now, maxAgeMs) {
  return now - mtimeMs > maxAgeMs;
}

// ── disk guard ────────────────────────────────────────────────────────────────
// Recording writes mic+system+mixed WAVs at 16kHz mono 16-bit: ~1.9 MB/min per
// track, ~6 MB/min (~350 MB/h) for all three combined — so 1 GiB is only ~3h
// of headroom and 3 GiB is the "still comfortable" line.
const DISK_REFUSE_BYTES = 1 * 1024 * 1024 * 1024;  // < 1 GiB free → refuse to start
const DISK_WARN_BYTES = 3 * 1024 * 1024 * 1024;    // < 3 GiB free → start, but warn

// freeBytes: bytes available to the current user on the session dir's volume
// (e.g. statfs().bavail * statfs().bsize). Returns { action: "refuse"|"warn"|"ok", msg }.
// refuseBytes/warnBytes default to the recording thresholds above — every existing
// call site (recording) keeps today's behavior unchanged. The model-download call
// site passes its own (larger) thresholds, since a ~1.6 GB download batch needs
// more headroom than recording's ~350 MB/h.
function diskGuardVerdict(freeBytes, refuseBytes = DISK_REFUSE_BYTES, warnBytes = DISK_WARN_BYTES) {
  // whole GiB counts render without a decimal (".0") so the default 1 GiB / 3 GiB
  // thresholds keep producing their original exact wording ("≥1 ГБ", not "≥1.0 ГБ").
  const gib = (n) => { const g = n / (1024 * 1024 * 1024); return Number.isInteger(g) ? String(g) : g.toFixed(1); };
  if (freeBytes < refuseBytes) {
    const mb = Math.round(freeBytes / (1024 * 1024));
    return { action: "refuse", msg: `Мало места на диске: свободно ${mb} МБ, нужно ≥${gib(refuseBytes)} ГБ` };
  }
  if (freeBytes < warnBytes) {
    const gb = (freeBytes / (1024 * 1024 * 1024)).toFixed(1);
    return { action: "warn", msg: `⚠️ Мало места на диске (свободно ${gb} ГБ)` };
  }
  return { action: "ok", msg: null };
}

// ── speaker rename ────────────────────────────────────────────────────────────
// Rewrite a note's text when speakers are renamed.
// map: { oldLabel: newLabel, ... }
// Rewrites both:
//   - body mentions  **[OldLabel]**  →  **[NewLabel]**
//   - frontmatter    speakers: "Спикер 1, Спикер 2"  →  updated names
// Returns the rewritten note text.
function rewriteNoteSpeakers(text, map) {
  if (!map || !Object.keys(map).length) return text;

  // 1. Rewrite body mentions
  for (const [oldL, newL] of Object.entries(map)) {
    if (!newL || newL === oldL) continue;
    text = text.split(`**[${oldL}]**`).join(`**[${newL}]**`);
  }

  // 2. Rewrite frontmatter speakers key if present
  // Match: speakers: "Имя1, Имя2" (possibly with leading spaces/tabs)
  text = text.replace(
    /^([ \t]*speakers:\s*")([^"\n]*)(")/m,
    (_match, pre, value, post) => {
      // value is the current comma-joined list; replace each old name with new
      let updated = value;
      for (const [oldL, newL] of Object.entries(map)) {
        if (!newL || newL === oldL) continue;
        // Replace whole-word occurrences of oldL in the speakers string
        updated = updated.split(oldL).join(newL);
      }
      return pre + updated + post;
    }
  );

  return text;
}

// ── auto-index (background, after a successful `process` run) ───────────────
// True when `dir` (a just-saved note's folder) is not inside `root` (the PARA
// vault). No root configured → false; caller already skips entirely in that case.
function isOutsideRoot(dir, root) {
  if (!root || !dir) return false;
  const rel = path.relative(path.resolve(root), path.resolve(dir));
  return rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel);
}

// ── История note deletion (single .md file, audio untouched) ────────────────
// Decides whether `notePath` may be unlinked: must literally end in ".md" and
// (after symlink resolution) sit inside at least one of `roots` — out_dir and,
// when configured, the PARA vault root (a note moved there by para-file is no
// longer under out_dir at all — same duality triggerAutoIndex/isOutsideRoot
// already handle for the reverse direction).
// `resolvedPath` is the caller-resolved real path (main.js runs fs.realpathSync
// before calling in, catching the not-found/unreadable case as null) so this
// helper stays fs-free and unit-testable; null always means "not deletable".
// resolvedPath is ALSO checked against ".md" — main.js unlinks resolvedPath, not
// notePath, so a symlink named "x.md" that resolves to a non-.md target (e.g. a
// config file living inside an allowed root) must still be refused.
// Shared by isNoteDeletable/isAudioDeletable below: true when resolvedPath's directory
// sits inside at least one of `roots` (after symlink resolution) — the "safe zone" check
// both file-deletion validators are built on. Kept private (not exported) since callers
// only ever want the extension-specific wrapper, never the bare containment check.
function _resolvedDirInsideRoots(resolvedPath, roots) {
  if (!resolvedPath) return false;
  const dir = path.dirname(resolvedPath);
  return (roots || []).some((root) => root && !isOutsideRoot(dir, root));
}

function isNoteDeletable(notePath, resolvedPath, roots) {
  if (!notePath || typeof notePath !== "string" || !notePath.endsWith(".md")) return false;
  if (!resolvedPath || !resolvedPath.endsWith(".md")) return false;
  return _resolvedDirInsideRoots(resolvedPath, roots);
}

// ── История trash (30-day retention) ────────────────────────────────────────
// Recording-level ✕ and per-note delete both move files into a `.trash/` dir instead of
// permanently deleting them (see main.js's delete-history-note/delete-history-recording
// handlers) — same allowed-roots discipline as isNoteDeletable, extended to audio
// extensions (mirrors backend.py's _AUDIO_EXT, backend.py:2162) since a recording's
// audio file must be validated before it's moved, exactly like a note's .md path is.
const _TRASH_AUDIO_EXT = new Set([".wav", ".mp3", ".m4a", ".aac", ".flac", ".ogg", ".mp4", ".mov"]);
function isAudioDeletable(audioPath, resolvedPath, roots) {
  if (!audioPath || typeof audioPath !== "string") return false;
  if (!resolvedPath) return false;
  if (!_TRASH_AUDIO_EXT.has(path.extname(audioPath).toLowerCase())) return false;
  if (!_TRASH_AUDIO_EXT.has(path.extname(resolvedPath).toLowerCase())) return false;
  return _resolvedDirInsideRoots(resolvedPath, roots);
}

// Trash root: `<vaultRoot>/.trash` when a PARA vault is configured (Obsidian convention —
// matches backend.py's _iter_vault_notes/_scan_audio_inventory dotdir-skip, both already
// verified to ignore .trash — see backend.py:2279 and 2309/2324), else a sibling `.trash`
// under out_dir for PARA-less setups (_scan_audio_inventory's own dotdir-skip covers this
// case too, since it scans out_dir directly).
function trashRootFor(outDir, vaultRoot) {
  return path.join(vaultRoot || outDir, ".trash");
}

// Destination filename inside the trash dir, suffixed on collision (e.g. two different
// recordings' audio sharing a base filename after repeated delete/reprocess cycles must
// never clobber each other). existsFn injected (defaults to fs.existsSync) purely so
// this stays unit-testable without touching a real .trash dir.
function trashDestPath(trashDir, baseName, existsFn) {
  const exists = existsFn || fs.existsSync;
  let candidate = path.join(trashDir, baseName);
  if (!exists(candidate)) return candidate;
  const ext = path.extname(baseName);
  const stem = baseName.slice(0, baseName.length - ext.length);
  let n = 1;
  do {
    candidate = path.join(trashDir, `${stem}-${n}${ext}`);
    n++;
  } while (exists(candidate));
  return candidate;
}

// Moves one file into the trash via rename (same-volume fast path). Falls back to
// copy+unlink on EXDEV (cross-device rename — e.g. an imported audio file living on a
// different volume than out_dir/the vault): renameSync can't cross devices, but
// copyFileSync+unlinkSync always can. deps injected ({renameSync, copyFileSync,
// unlinkSync}, default fs) so the EXDEV branch is unit-testable without a real
// cross-device filesystem in CI.
function moveToTrash(srcPath, destPath, deps) {
  const d = deps || fs;
  try {
    d.renameSync(srcPath, destPath);
  } catch (e) {
    if (e && e.code === "EXDEV") {
      d.copyFileSync(srcPath, destPath);
      d.unlinkSync(srcPath);
    } else {
      throw e;
    }
  }
}

// 30-day purge (main.js calls this once at startup, see purgeTrashOnStartup): drops
// every manifest entry whose deletedAt is older than maxAgeMs, permanently deleting its
// files first. A file that's already gone (manually cleared from Finder/Obsidian) is not
// an error — just skipped — and the entry is dropped either way; a fresh (not-yet-stale)
// entry is returned completely untouched (its files are never even existence-checked).
// trashDir bounds WHERE a purge is allowed to delete: any file whose containing
// directory isn't trashDir itself is skipped (not deleted, entry still dropped) — no
// runtime injection vector exists today (every files[] entry is written by main.js's own
// trashDestPath, always inside trashDir), but a purge is a permanent delete, so refusing
// anything outside the trash dir costs nothing (belt-and-braces against a
// hand-edited/corrupted manifest.json).
// deps injected ({existsSync, unlinkSync}, default fs) for unit-testability. Never
// throws — startup purge failures must not block app launch (main.js's caller wraps
// this in try/catch too, belt-and-suspenders).
function purgeTrash(manifest, trashDir, maxAgeMs, now, deps) {
  const d = deps || fs;
  const list = Array.isArray(manifest) ? manifest : [];
  const kept = [];
  for (const entry of list) {
    if (!entry || typeof entry.deletedAt !== "number" || !isStale(entry.deletedAt, now, maxAgeMs)) {
      kept.push(entry);
      continue;
    }
    for (const f of (Array.isArray(entry.files) ? entry.files : [])) {
      if (typeof f !== "string" || path.dirname(f) !== trashDir) continue;
      try {
        if (d.existsSync(f)) d.unlinkSync(f);
      } catch {}
    }
  }
  return kept;
}

// Serializes background index runs: never run two concurrently. A trigger while
// one is in flight queues exactly one trailing run (not one per trigger) so the
// vault still converges after a burst, without piling up redundant re-indexes.
// state: { inFlight, queued }. action: "trigger" | "complete".
// Returns { state: <next state>, shouldStart: <spawn a run now?> }.
function indexRunReducer(state, action) {
  const s = state || { inFlight: false, queued: false };
  if (action === "trigger") {
    if (s.inFlight) return { state: { inFlight: true, queued: true }, shouldStart: false };
    return { state: { inFlight: true, queued: false }, shouldStart: true };
  }
  if (action === "complete") {
    if (s.queued) return { state: { inFlight: true, queued: false }, shouldStart: true };
    return { state: { inFlight: false, queued: false }, shouldStart: false };
  }
  return { state: s, shouldStart: false };
}

// ── list upsert-by-id ────────────────────────────────────────────────────────
// Replace-or-append by `.id`: an entry sharing an existing id REPLACES it in
// place (position preserved) instead of duplicating; an unknown id is appended.
// Used by main.js's pending-recordings manifest and mirrored inline in
// renderer.js's state.pendingRecordings (renderer runs in a require()-less
// browser context — see its own copy for why this isn't shared directly).
// Defense-in-depth against a duplicate id landing in either list if two async
// "mixed" completions ever raced (main.js's stop-recording also fixes the
// underlying session-snapshot race directly — this is the second, independent
// line of defense, not the only one). Pure — returns a new array, list/entry
// untouched.
function upsertById(list, entry) {
  const idx = list.findIndex((it) => it.id === entry.id);
  if (idx < 0) return [...list, entry];
  const next = list.slice();
  next[idx] = entry;
  return next;
}

// ── tray menu (macOS menu-bar icon) ──────────────────────────────────────────
// Pure descriptor builder — main.js maps these onto real Electron MenuItems
// (attaches click handlers, since Menu/MenuItem aren't available headless).
// state: { recording }. The single toggle item's label follows recording state;
// no other item is ever disabled — deliberately simple (see task contract).
function trayMenuTemplate(state) {
  const recording = !!(state && state.recording);
  return [
    { id: "toggle-record", label: recording ? "Остановить запись" : "Начать запись", enabled: true },
    { id: "open-window", label: "Открыть Meeting Recorder", enabled: true },
    { type: "separator" },
    { id: "quit", label: "Выйти", enabled: true },
  ];
}

// ── backend installer resolvers (userData/packaged path resolution) ─────────
// Pure — main.js supplies the pre-computed existence checks (fs.existsSync results)
// and Electron flags/paths as plain args, so these stay testable without touching
// the filesystem or requiring electron itself.

// Which python interpreter to spawn backend.py with: an installed userData backend
// env (see main.js's install-backend IPC, settings "Бэкенд" section) wins, then a
// dev checkout's ../venv, then whatever "python3" resolves to on $PATH.
//
// installedExists alone is NOT enough: install-backend extracts the python
// interpreter BEFORE running pip, and only writes the completion marker after
// pip succeeds — so a failed/cancelled install can leave a real, executable
// but dependency-less interpreter sitting at installedPath. Without also
// requiring markerExists, that depless interpreter would win over a perfectly
// good dev venv and get handed a doomed process-audio/recording run. The
// installer additionally never lands a partial install at installedPath at
// all (stages into a sibling dir, atomic-renames in only after the marker is
// written) — this check is the second, independent line of defense, not the
// only one.
function resolvePythonBin(installedPath, installedExists, markerExists, venvPath, venvExists) {
  if (installedExists && markerExists) return installedPath;
  if (venvExists) return venvPath;
  return "python3";
}

// Static ffmpeg bundled into the installed backend env, or the bare "ffmpeg" the
// caller then resolves via $PATH (brew-installed or otherwise) — same fallback
// backend.py's own shutil.which("ffmpeg") already does.
function resolveFfmpegBin(installedPath, installedExists) {
  return installedExists ? installedPath : "ffmpeg";
}

// A packaged app's resources (backend.py, requirements.txt, vendor/wheels) live
// under process.resourcesPath; a dev checkout has them directly in APP_DIR.
function resolveResourcePath(isPackaged, resourcesPath, appDir, relPath) {
  return path.join(isPackaged ? resourcesPath : appDir, relPath);
}

// audiotee (npm) resolves its OWN default binaryPath relative to its own
// module __dirname (join(__dirname, "..", "bin", "audiotee") in its ESM
// entrypoint) — packaged, that __dirname sits inside app.asar, so the
// default path points at an asar member and only works because Electron's
// child_process.spawn implicitly redirects asar paths to their
// app.asar.unpacked twin. Passing an explicit binaryPath removes that
// implicit-redirect dependency entirely. Deliberately NOT reusing
// resolveResourcePath above: electron-builder's asarUnpack copies the
// native bin one level deeper than plain extraResources — under
// resourcesPath/app.asar.unpacked/<relPath>, not resourcesPath/<relPath>.
function resolveAudioTeeBin(isPackaged, resourcesPath, appDir) {
  return isPackaged
    ? path.join(resourcesPath, "app.asar.unpacked", "node_modules", "audiotee", "bin", "audiotee")
    : path.join(appDir, "node_modules", "audiotee", "bin", "audiotee");
}

// nativeImage.createFromPath (used for the menu-bar tray icon) is unreliable reading
// from inside app.asar — packaged, it silently returns an empty image, so the tray
// shows nothing. Same asar-read class as resolveAudioTeeBin above: package.json's
// asarUnpack lands assets/trayTemplate*.png as real files under
// resourcesPath/app.asar.unpacked/assets/, so this resolves there instead of into
// the asar archive itself.
function resolveAssetPath(isPackaged, resourcesPath, appDir, relName) {
  return isPackaged
    ? path.join(resourcesPath, "app.asar.unpacked", "assets", relName)
    : path.join(appDir, "assets", relName);
}

// ── backend install status (settings "Бэкенд" section) ───────────────────────
// marker: the parsed .installed.json ({pythonVersion, requirementsHash, installedAt})
// or null if missing/corrupt. currentRequirementsHash: cacheKey() of the
// requirements.txt currently shipped with the app. pythonBinExists: fs.existsSync
// on the installed interpreter (belt-and-suspenders against a marker surviving a
// manually-deleted env).
function backendInstallStatus(marker, currentRequirementsHash, pythonBinExists) {
  if (!pythonBinExists || !marker) return { installed: false, pythonVersion: null, stale: false };
  return {
    installed: true,
    pythonVersion: marker.pythonVersion || null,
    stale: marker.requirementsHash !== currentRequirementsHash,
  };
}

// Extracts just the version token from ffmpeg's own `-version` banner ("ffmpeg
// version 8.1 Copyright (c) ..." or a git-describe build like "ffmpeg version
// n6.0-2-g1234567 Copyright ...") — used by main.js's backend-status handler
// (settings "Бэкенд" section, richer status: "показать КАКОЙ именно бэкенд")
// to report exactly which ffmpeg build the installed env is running, without
// hardcoding the version main.js happens to download today. Pure string
// parsing so it's testable without spawning a real binary; main.js owns the
// actual spawn (see getFfmpegVersion there). Returns null on unrecognized
// output rather than guessing.
function parseFfmpegVersion(stdout) {
  const m = String(stdout || "").match(/ffmpeg version (\S+)/);
  return m ? m[1] : null;
}

// ── busy-guard (concurrent-operation refusal) ────────────────────────────────
// Centralizes the "is some conflicting background operation already running?"
// decision that main.js's IPC handlers used to hand-roll independently, each as
// its own chain of early-return ifs (start-recording, process-audio, download-
// models, install-backend, download-and-install-update all repeated the same
// shape) — and that left para-classify/para-extract/classify-glossary-terms (all
// of which spawn runBackend(), i.e. pythonBin()) with NO guard at all, vulnerable
// to the interpreter-overwrite-during-install race: a concurrent install-backend
// run atomically swaps BACKEND_ENV at the very end of installation (see main.js's
// runInstallBackend), and a spawn that resolves pythonBin() during that narrow
// window can get a stale/missing path.
//
// checks: ordered array of [isBusy, message] pairs, evaluated in the exact
// priority order the caller's original if/else-if chain used — so wording and
// precedence stay identical to what each handler already returned. Returns the
// FIRST matching message, or null when nothing in the list is busy.
function busyVerdict(checks) {
  for (const [isBusy, msg] of checks || []) {
    if (isBusy) return msg;
  }
  return null;
}

// ── setup-gate model cache paths (renderer's #setupGate hard wall) ──────────
// Node-side mirror of backend.py's MODEL_SPECS/_model_cached/_hf_cache_dir
// (backend.py:2623-2663) — homedir is injected rather than read via os.homedir()
// here so these stay pure/testable; main.js calls them with os.homedir() once
// at startup. Deliberately NOT computed by spawning backend.py: when the
// backend isn't installed yet, pythonBin() falls back to bare "python3" (see
// resolvePythonBin above), which may not even exist — readiness must be
// checkable before any interpreter is available at all.
// PATH-COUPLED with backend.py — if _WHISPER_MODEL_DIR/_VAD_JIT_PATH/
// _PYANNOTE_REPO_IDS there change, update both sides.
function hfCacheDir(homedir, repoId) {
  return path.join(homedir, ".cache", "huggingface", "hub", "models--" + repoId.replace(/\//g, "--"));
}

function whisperModelDir(homedir) {
  return hfCacheDir(homedir, "mlx-community/whisper-large-v3-turbo");
}

function vadJitPath(homedir) {
  return path.join(
    homedir, ".cache", "torch", "hub", "snakers4_silero-vad_master", "src", "silero_vad", "data", "silero_vad.jit"
  );
}

// All three must be present for diarization to work — mirrors backend.py's
// _PYANNOTE_REPO_IDS comment: pyannote's own config.yaml declares these
// sub-models the top pipeline repo pulls in.
const PYANNOTE_REPO_IDS = [
  "pyannote/speaker-diarization-3.1",
  "pyannote/segmentation-3.0",
  "pyannote/wespeaker-voxceleb-resnet34-LM",
];

function diarizationModelDirs(homedir) {
  return PYANNOTE_REPO_IDS.map((repoId) => hfCacheDir(homedir, repoId));
}

// The wall's readiness verdict: backend installed AND both REQUIRED models
// (whisper, vad) cached. Diarization is intentionally excluded — it's
// optional-by-design (transcript-only mode + a diarize toggle, gated behind
// an HF token) so forcing it would lock out users who don't diarize; it's
// gated separately, per-run, in main.js's process-audio instead.
function appReadinessStatus(backend, whisper, vad) {
  return { backend, whisper, vad, models: whisper && vad };
}

// ── partial model-download cleanup (cancel/failure) ─────────────────────────
// Cache dir(s) whose mere existence whisperCached()/vadCached()/diarizationCached()
// (main.js) — and backend.py's own _model_cached — treat as "done" for this
// model. Mirrors backend.py's _cache_dirs_for (backend.py:2734-2743) for
// whisper/diarization; vad's dir-exists-but-jit-missing state is already
// self-healed by backend.py's _download_model on the next attempt, but wiping
// it here immediately (rather than waiting for that) is strictly cleaner.
function modelCacheDirsFor(homedir, modelId) {
  if (modelId === "whisper") return [whisperModelDir(homedir)];
  if (modelId === "vad") {
    // vadJitPath is .../snakers4_silero-vad_master/src/silero_vad/data/silero_vad.jit —
    // the repo dir a partial download actually leaves behind is 4 levels up.
    // Derived (not re-declared) so it stays single-sourced with vadJitPath above.
    return [path.dirname(path.dirname(path.dirname(path.dirname(vadJitPath(homedir)))))];
  }
  if (modelId === "diarization") return diarizationModelDirs(homedir);
  return [];
}

// Recursive on-disk size (bytes) of a directory tree — a Node-only `du -sb`, used
// by main.js's "models" IPC (settings "Модели" section) to show each cached
// model's real footprint. A missing/inaccessible path resolves to 0 (a model
// that isn't cached yet simply has no cache dir — not an error).
// Symlinks are skipped, not followed: the Hugging Face cache layout
// (models--org--name/snapshots/<rev>/<file> -> ../../blobs/<hash>) would otherwise
// double-count every file — its real bytes are already counted once via blobs/,
// which holds the plain (non-symlink) files themselves.
function dirSizeBytes(dirPath) {
  let entries;
  try { entries = fs.readdirSync(dirPath, { withFileTypes: true }); } catch { return 0; }
  let total = 0;
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) total += dirSizeBytes(full);
    else {
      try { total += fs.statSync(full).size; } catch {}
    }
  }
  return total;
}

// Authoritative partial-download cleanup — the parent-side counterpart to
// backend.py's own _cleanup_partial_download. That one is best-effort only:
// its SIGTERM handler rmtree's on the main thread while snapshot_download's
// ThreadPoolExecutor workers (up to 8) may still be mid-write during
// interpreter shutdown, so a worker can recreate the dir right after the
// handler just removed it — leaving _model_cached reporting a broken model as
// "cached" again. main.js calls this from the download-models close handler,
// AFTER the child process (and every one of its worker threads) has fully
// exited — no workers alive, no race — so THIS is the actual guarantee.
// force:true makes an already-clean/missing dir a silent no-op.
function cleanupPartialModelCache(homedir, modelId) {
  for (const dir of modelCacheDirsFor(homedir, modelId)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

// ── out-dir auto-follow (settings "Куда сохранять", Variant A) ──────────────
// Decides the new outDir when a PARA vault is created/changed. Auto-follows
// into a "Meetings" landing subfolder of the vault root (stays inside root,
// so isOutsideRoot/_rag_walk_vault treat it as indexed — see main.js caller)
// unless the user has already picked a custom outDir (outDirCustom=true),
// in which case that explicit choice is left untouched.
function resolveOutDirOnVaultChange(outDir, outDirCustom, newRoot) {
  if (outDirCustom) return outDir;
  return path.join(newRoot, "Meetings");
}

// ── in-app updater (settings "Обновления" section) ──────────────────────────
// Pure — main.js supplies the GitHub release's tag_name/assets as plain data,
// so version comparison and asset selection stay testable without touching
// the network or Electron itself.

// "v1.2.3" or "1.2.3" -> [1,2,3]; null for anything that isn't exactly three
// numeric dot-separated segments (missing segment, extra segment, non-numeric
// part, empty string) — callers must never claim an update is available off
// an unparseable tag.
function parseVersionTriple(v) {
  if (!v) return null;
  const m = String(v).trim().replace(/^v/i, "").match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

// Compares two version strings (tag or plain, "v" prefix optional) as numeric
// triples. Returns 1 if a>b, -1 if a<b, 0 if equal, null if either side is
// malformed (caller treats null as "cannot compare", not as "no update").
function compareVersions(a, b) {
  const ta = parseVersionTriple(a);
  const tb = parseVersionTriple(b);
  if (!ta || !tb) return null;
  for (let i = 0; i < 3; i++) {
    if (ta[i] !== tb[i]) return ta[i] > tb[i] ? 1 : -1;
  }
  return 0;
}

// Picks the arm64 .zip asset from a GitHub release's assets array (the in-app
// updater only ever installs the arm64 build — mirrors package.json's
// mac.target arm64-only zip). assets: [{ name, browser_download_url }, ...].
// Returns the browser_download_url, or null if no matching asset is present
// (e.g. a release published dmg-only, or without any assets at all).
function pickUpdateAsset(assets) {
  if (!Array.isArray(assets)) return null;
  const match = assets.find(
    (a) => a && typeof a.name === "string" && /arm64/i.test(a.name) && /\.zip$/i.test(a.name)
  );
  return match ? match.browser_download_url : null;
}

module.exports = {
  buildWavHeader, WavWriter, rmsLevel, cacheKey,
  pairHistory, encodeTokenBlob, decodeTokenBlob, isStale,
  rewriteNoteSpeakers, isOutsideRoot, isNoteDeletable, indexRunReducer, upsertById, diskGuardVerdict, busyVerdict,
  isAudioDeletable, trashRootFor, trashDestPath, moveToTrash, purgeTrash,
  resolveOutDirOnVaultChange, trayMenuTemplate,
  resolvePythonBin, resolveFfmpegBin, resolveResourcePath, resolveAudioTeeBin, resolveAssetPath, backendInstallStatus,
  parseFfmpegVersion,
  hfCacheDir, whisperModelDir, vadJitPath, diarizationModelDirs, appReadinessStatus,
  modelCacheDirsFor, cleanupPartialModelCache, dirSizeBytes,
  compareVersions, pickUpdateAsset,
};
