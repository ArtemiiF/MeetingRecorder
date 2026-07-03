const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  buildWavHeader, WavWriter, rmsLevel, cacheKey,
  pairHistory, encodeTokenBlob, decodeTokenBlob, isStale,
  rewriteNoteSpeakers, isOutsideRoot, indexRunReducer, diskGuardVerdict,
} = require("../lib/mainutil");

// ── WAV header ──────────────────────────────────────────────────────────────
test("buildWavHeader: 44 bytes, correct markers and sizes", () => {
  const h = buildWavHeader(1000, 16000, 1, 16);
  assert.equal(h.length, 44);
  assert.equal(h.toString("ascii", 0, 4), "RIFF");
  assert.equal(h.toString("ascii", 8, 12), "WAVE");
  assert.equal(h.toString("ascii", 36, 40), "data");
  assert.equal(h.readUInt32LE(4), 36 + 1000);   // ChunkSize
  assert.equal(h.readUInt32LE(40), 1000);        // Subchunk2Size
  assert.equal(h.readUInt16LE(22), 1);           // channels
  assert.equal(h.readUInt32LE(24), 16000);       // sample rate
  assert.equal(h.readUInt32LE(28), 32000);       // byte rate = 16000*1*2
});

test("WavWriter: produces a readable WAV with correct data length", () => {
  const p = path.join(os.tmpdir(), `wavwriter-test-${process.pid}.wav`);
  const w = new WavWriter(p, 16000, 1, 16);
  for (let i = 0; i < 5; i++) w.write(Buffer.alloc(6400)); // 5 * 200ms
  w.close();
  const buf = fs.readFileSync(p);
  assert.equal(buf.toString("ascii", 0, 4), "RIFF");
  assert.equal(buf.readUInt32LE(40), 32000);     // 5*6400 data bytes
  assert.equal(buf.length, 44 + 32000);
  fs.unlinkSync(p);
});

// ── VU level ─────────────────────────────────────────────────────────────────
test("rmsLevel: silence is 0", () => {
  assert.equal(rmsLevel(Buffer.alloc(2048)), 0);
});
test("rmsLevel: empty buffer is 0", () => {
  assert.equal(rmsLevel(Buffer.alloc(0)), 0);
});
test("rmsLevel: constant 2000 amplitude → 0.5", () => {
  const n = 1000;
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) buf.writeInt16LE(2000, i * 2);
  assert.ok(Math.abs(rmsLevel(buf) - 0.5) < 1e-6);
});
test("rmsLevel: clamps at 1 for loud signal", () => {
  const n = 1000;
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) buf.writeInt16LE(32767, i * 2);
  assert.equal(rmsLevel(buf), 1);
});
test("rmsLevel: odd-length buffer doesn't overrun", () => {
  assert.doesNotThrow(() => rmsLevel(Buffer.alloc(2049)));
});

// ── cache key ─────────────────────────────────────────────────────────────
test("cacheKey: deterministic, 16 hex chars", () => {
  const k = cacheKey("a:1:2");
  assert.match(k, /^[0-9a-f]{16}$/);
  assert.equal(k, cacheKey("a:1:2"));
});
test("cacheKey: different tag → different key", () => {
  assert.notEqual(cacheKey("a:1:2"), cacheKey("a:1:3"));
});

// ── history pairing ─────────────────────────────────────────────────────────
test("pairHistory: pairs note with same-stem audio, sorts by mtime desc", () => {
  const files = [
    "meeting-2026-01-01-1000.md", "meeting-2026-01-01-1000.wav",
    "meeting-2026-02-02-1200.md", "meeting-2026-02-02-1200.m4a",
    "random.txt", "notes.md",
  ];
  const mt = { "meeting-2026-01-01-1000.md": 100, "meeting-2026-02-02-1200.md": 200 };
  const out = pairHistory(files, (n) => mt[n] || 0);
  assert.equal(out.length, 2);
  assert.equal(out[0].name, "2026-02-02-1200");        // newest first
  assert.equal(out[0].audio, "meeting-2026-02-02-1200.m4a");
  assert.equal(out[1].audio, "meeting-2026-01-01-1000.wav");
});
test("pairHistory: lang-suffixed note pairs to the shared (unsuffixed) audio", () => {
  const files = ["meeting-2026-02-02-1200-en.md", "meeting-2026-02-02-1200.wav"];
  const out = pairHistory(files, () => 1);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, "2026-02-02-1200-en");
  assert.equal(out[0].audio, "meeting-2026-02-02-1200.wav"); // not null — lang token stripped
});

test("pairHistory: audio null when missing, ignores non-meeting md", () => {
  const out = pairHistory(["meeting-x.md", "notes.md"], () => 1);
  assert.equal(out.length, 1);
  assert.equal(out[0].audio, null);
});

// ── token blob ────────────────────────────────────────────────────────────
test("encodeTokenBlob/decodeTokenBlob: enc roundtrip via injected crypto", () => {
  // fake reversible "encrypt": prefix bytes; decrypt strips it
  const enc = (t) => Buffer.from("X" + t, "utf8");
  const dec = (b) => b.toString("utf8").slice(1);
  const blob = encodeTokenBlob("hf_secret", true, enc);
  assert.ok(blob.startsWith("enc:"));
  assert.equal(decodeTokenBlob(blob, dec), "hf_secret");
});
test("encodeTokenBlob/decodeTokenBlob: raw roundtrip when encryption unavailable", () => {
  const blob = encodeTokenBlob("hf_secret", false, null);
  assert.ok(blob.startsWith("raw:"));
  assert.equal(decodeTokenBlob(blob, null), "hf_secret");
});
test("encodeTokenBlob: empty token → null; decode null/garbage → ''", () => {
  assert.equal(encodeTokenBlob("", true, () => Buffer.alloc(0)), null);
  assert.equal(decodeTokenBlob(null, null), "");
  assert.equal(decodeTokenBlob("garbage-no-prefix", null), "");
});

// ── retention ────────────────────────────────────────────────────────────────
test("isStale: older than maxAge is stale, newer is not", () => {
  const now = 1_000_000;
  assert.equal(isStale(now - 10, now, 100), false);
  assert.equal(isStale(now - 200, now, 100), true);
});

// ── disk guard ────────────────────────────────────────────────────────────────
const GIB = 1024 * 1024 * 1024;
test("diskGuardVerdict: below 1 GiB refuses with MB free in the message", () => {
  const v = diskGuardVerdict(500 * 1024 * 1024); // 500 MB
  assert.equal(v.action, "refuse");
  assert.match(v.msg, /Мало места на диске: свободно 500 МБ, нужно ≥1 ГБ/);
});
test("diskGuardVerdict: just under 1 GiB refuses", () => {
  const v = diskGuardVerdict(GIB - 1);
  assert.equal(v.action, "refuse");
});
test("diskGuardVerdict: exactly 1 GiB warns (not refuse)", () => {
  const v = diskGuardVerdict(GIB);
  assert.equal(v.action, "warn");
});
test("diskGuardVerdict: between 1 and 3 GiB warns with GB free in the message", () => {
  const v = diskGuardVerdict(2.4 * GIB);
  assert.equal(v.action, "warn");
  assert.match(v.msg, /Мало места на диске \(свободно 2\.4 ГБ\)/);
});
test("diskGuardVerdict: just under 3 GiB warns", () => {
  const v = diskGuardVerdict(3 * GIB - 1);
  assert.equal(v.action, "warn");
});
test("diskGuardVerdict: exactly 3 GiB and above is ok, no message", () => {
  const v = diskGuardVerdict(3 * GIB);
  assert.equal(v.action, "ok");
  assert.equal(v.msg, null);
});
test("diskGuardVerdict: plenty of free space is ok", () => {
  const v = diskGuardVerdict(50 * GIB);
  assert.equal(v.action, "ok");
});

// ── diskGuardVerdict: parameterized thresholds (model-download call site) ────
// Defaults (no extra args) must keep producing today's exact recording-path
// wording/behavior — asserted again here so a future signature change can't
// silently break the existing call site without a red test.
test("diskGuardVerdict: no threshold args behaves exactly like the original 1/3 GiB defaults", () => {
  assert.deepEqual(diskGuardVerdict(500 * 1024 * 1024), {
    action: "refuse", msg: "Мало места на диске: свободно 500 МБ, нужно ≥1 ГБ",
  });
  assert.equal(diskGuardVerdict(2.4 * GIB).action, "warn");
  assert.equal(diskGuardVerdict(3 * GIB).action, "ok");
});
test("diskGuardVerdict: custom refuseBytes/warnBytes (download path, ~2/3 GiB)", () => {
  const REFUSE = 2 * GIB, WARN = 3 * GIB;
  const refused = diskGuardVerdict(1.5 * GIB, REFUSE, WARN);
  assert.equal(refused.action, "refuse");
  assert.match(refused.msg, /нужно ≥2 ГБ/);

  const warned = diskGuardVerdict(2.5 * GIB, REFUSE, WARN);
  assert.equal(warned.action, "warn");

  const ok = diskGuardVerdict(4 * GIB, REFUSE, WARN);
  assert.equal(ok.action, "ok");
  assert.equal(ok.msg, null);
});
test("diskGuardVerdict: custom threshold refuse message reflects the given threshold, not the default", () => {
  const v = diskGuardVerdict(100 * 1024 * 1024, 2 * GIB, 3 * GIB);
  assert.equal(v.action, "refuse");
  assert.match(v.msg, /нужно ≥2 ГБ/);
  assert.doesNotMatch(v.msg, /≥1 ГБ/);
});

// ── rewriteNoteSpeakers ───────────────────────────────────────────────────────
test("rewriteNoteSpeakers: rewrites body mentions", () => {
  const text = "---\ntype: meeting\n---\n\n**[Спикер 1]**: привет\n**[Спикер 2]**: пока";
  const out = rewriteNoteSpeakers(text, { "Спикер 1": "Алексей" });
  assert.ok(out.includes("**[Алексей]**: привет"));
  assert.ok(out.includes("**[Спикер 2]**: пока")); // unchanged
});

test("rewriteNoteSpeakers: rewrites frontmatter speakers key", () => {
  const text = '---\ntype: meeting\nspeakers: "Спикер 1, Спикер 2"\n---\n\nbody';
  const out = rewriteNoteSpeakers(text, { "Спикер 1": "Алексей" });
  assert.ok(out.includes('speakers: "Алексей, Спикер 2"'));
});

test("rewriteNoteSpeakers: rewrites both body and frontmatter in one call", () => {
  const text =
    '---\ntype: meeting\nspeakers: "Спикер 1, Спикер 2"\n---\n\n' +
    "**[Спикер 1]**: hi\n**[Спикер 2]**: bye";
  const out = rewriteNoteSpeakers(text, { "Спикер 1": "Алексей", "Спикер 2": "Мария" });
  assert.ok(out.includes('speakers: "Алексей, Мария"'));
  assert.ok(out.includes("**[Алексей]**: hi"));
  assert.ok(out.includes("**[Мария]**: bye"));
});

test("rewriteNoteSpeakers: skips empty or same-name mappings", () => {
  const text = '---\nspeakers: "Спикер 1"\n---\n\n**[Спикер 1]**: hi';
  const out = rewriteNoteSpeakers(text, { "Спикер 1": "" });
  // no rename: body and frontmatter unchanged
  assert.ok(out.includes('speakers: "Спикер 1"'));
  assert.ok(out.includes("**[Спикер 1]**: hi"));
});

test("rewriteNoteSpeakers: empty map returns text unchanged", () => {
  const text = "---\nspeakers: \"A\"\n---\n\nbody";
  assert.equal(rewriteNoteSpeakers(text, {}), text);
});

test("rewriteNoteSpeakers: no frontmatter speakers key leaves body-only rewrite intact", () => {
  const text = "---\ntype: meeting\n---\n\n**[Спикер 1]**: hi";
  const out = rewriteNoteSpeakers(text, { "Спикер 1": "Алексей" });
  assert.ok(out.includes("**[Алексей]**: hi"));
  assert.ok(!out.includes("speakers:")); // no key was added
});

// ── auto-index gating ────────────────────────────────────────────────────────
test("isOutsideRoot: dir inside root is not outside", () => {
  assert.equal(isOutsideRoot("/vault/Meetings", "/vault"), false);
});
test("isOutsideRoot: dir equal to root is not outside", () => {
  assert.equal(isOutsideRoot("/vault", "/vault"), false);
});
test("isOutsideRoot: dir outside root is outside", () => {
  assert.equal(isOutsideRoot("/Users/x/Documents/Obsidian/Meetings", "/Users/x/vault"), true);
});
test("isOutsideRoot: no root configured → false (nothing to compare)", () => {
  assert.equal(isOutsideRoot("/anywhere", ""), false);
  assert.equal(isOutsideRoot("/anywhere", null), false);
});
test("isOutsideRoot: no dir → false", () => {
  assert.equal(isOutsideRoot("", "/vault"), false);
});

test("indexRunReducer: trigger while idle starts immediately", () => {
  const r = indexRunReducer({ inFlight: false, queued: false }, "trigger");
  assert.equal(r.shouldStart, true);
  assert.deepEqual(r.state, { inFlight: true, queued: false });
});
test("indexRunReducer: trigger while in-flight queues a trailing run, does not start", () => {
  const r = indexRunReducer({ inFlight: true, queued: false }, "trigger");
  assert.equal(r.shouldStart, false);
  assert.deepEqual(r.state, { inFlight: true, queued: true });
});
test("indexRunReducer: second trigger while already queued stays queued (no pile-up)", () => {
  const r = indexRunReducer({ inFlight: true, queued: true }, "trigger");
  assert.equal(r.shouldStart, false);
  assert.deepEqual(r.state, { inFlight: true, queued: true });
});
test("indexRunReducer: complete with no queued trailing run goes idle", () => {
  const r = indexRunReducer({ inFlight: true, queued: false }, "complete");
  assert.equal(r.shouldStart, false);
  assert.deepEqual(r.state, { inFlight: false, queued: false });
});
test("indexRunReducer: complete with a queued trailing run starts it and clears the flag", () => {
  const r = indexRunReducer({ inFlight: true, queued: true }, "complete");
  assert.equal(r.shouldStart, true);
  assert.deepEqual(r.state, { inFlight: true, queued: false });
});
test("indexRunReducer: undefined state defaults to idle, trigger starts", () => {
  const r = indexRunReducer(undefined, "trigger");
  assert.equal(r.shouldStart, true);
  assert.deepEqual(r.state, { inFlight: true, queued: false });
});
