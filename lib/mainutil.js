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

module.exports = {
  buildWavHeader, WavWriter, rmsLevel, cacheKey,
  pairHistory, encodeTokenBlob, decodeTokenBlob, isStale,
  rewriteNoteSpeakers, isOutsideRoot, indexRunReducer, diskGuardVerdict,
  resolveOutDirOnVaultChange,
};
