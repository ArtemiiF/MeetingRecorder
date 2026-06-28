// Pure, electron-free helpers used by main.js — extracted so they're unit-testable
// under plain `node --test` (main.js itself requires("electron") and can't be loaded headless).
const crypto = require("crypto");
const fs = require("fs");

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

module.exports = {
  buildWavHeader, WavWriter, rmsLevel, cacheKey,
  pairHistory, encodeTokenBlob, decodeTokenBlob, isStale,
};
