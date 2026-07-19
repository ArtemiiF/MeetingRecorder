const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  buildWavHeader, WavWriter, rmsLevel, cacheKey, contentFingerprint, isFileStable,
  pairHistory, encodeTokenBlob, decodeTokenBlob, isStale,
  rewriteNoteSpeakers, isOutsideRoot, isNoteDeletable, indexRunReducer, upsertById, diskGuardVerdict, busyVerdict,
  isPathInsideRoots,
  isAudioDeletable, trashRootFor, trashDestPath, moveToTrash, purgeTrash,
  isTrashAudioFile, trashDaysLeft, buildTrashEntry, restoreDestinationFor, restoreTrashFiles,
  deleteTrashEntryFiles, trashEntryBreakdown,
  resolveOutDirOnVaultChange, trayMenuTemplate,
  resolvePythonBin, resolveFfmpegBin, resolveResourcePath, resolveAudioTeeBin, resolveAssetPath, backendInstallStatus,
  parseFfmpegVersion,
  hfCacheDir, whisperModelDir, vadJitPath, diarizationModelDirs, appReadinessStatus,
  modelCacheDirsFor, cleanupPartialModelCache, dirSizeBytes,
  compareVersions, pickUpdateAsset,
} = require("../lib/mainutil");
const { EVENT_NAMES, EVENTS } = require("../lib/events");

// ── lib/events.js (M4 arch-audit — event-name contract) ─────────────────────
// events.json is the shared source of truth read by BOTH this module and
// backend.py's own EVENT_NAMES frozenset (tests/test_backend.py has the
// cross-lock test on the Python side, scanning main.js for EVENTS.* usage).
test("EVENT_NAMES: non-empty array of unique strings, sourced from events.json", () => {
  assert.ok(Array.isArray(EVENT_NAMES) && EVENT_NAMES.length > 0);
  assert.equal(new Set(EVENT_NAMES).size, EVENT_NAMES.length, "no duplicate event names in the contract");
  for (const name of EVENT_NAMES) assert.equal(typeof name, "string");
});
test("EVENTS: every contract name gets its own constant (no naming collisions after the uppercase/underscore transform)", () => {
  assert.equal(Object.keys(EVENTS).length, EVENT_NAMES.length);
});
test("EVENTS: spot-check known constants resolve to their exact contract string", () => {
  assert.equal(EVENTS.CLASSIFIED, "classified");
  assert.equal(EVENTS.CLASSIFIED_TERMS, "classified-terms");
  assert.equal(EVENTS.SEARCH_RESULT, "search_result");
  assert.equal(EVENTS.STAGE_END, "stage_end");
  assert.equal(EVENTS.ERROR, "error");
  assert.equal(EVENTS.LOG, "log");
});
test("EVENTS: an unknown constant name resolves to undefined, not a throw (a typo like EVENTS.CLASIFIED must never silently match every ev.event string)", () => {
  assert.equal(EVENTS.NOT_A_REAL_EVENT, undefined);
});

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

// ── contentFingerprint (H3b arch-audit — cache staleness content check) ─────
test("contentFingerprint: identical content produces the identical fingerprint", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fp-test-"));
  const a = path.join(dir, "a.wav"); const b = path.join(dir, "b.wav");
  fs.writeFileSync(a, "hello world");
  fs.writeFileSync(b, "hello world");
  assert.equal(contentFingerprint(a), contentFingerprint(b));
});
test("contentFingerprint: different content, SAME size, produces a DIFFERENT fingerprint — the whole point, catches an in-place rewrite path+size+mtime alone would miss", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fp-test-"));
  const a = path.join(dir, "a.wav"); const b = path.join(dir, "b.wav");
  fs.writeFileSync(a, "aaaaaaaaaa");
  fs.writeFileSync(b, "bbbbbbbbbb");
  assert.notEqual(contentFingerprint(a), contentFingerprint(b));
});
test("contentFingerprint: missing file returns '' rather than throwing", () => {
  assert.equal(contentFingerprint(path.join(os.tmpdir(), `does-not-exist-${process.pid}.wav`)), "");
});
test("contentFingerprint: empty file (0 bytes) doesn't throw and returns a stable, non-empty hash string", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fp-test-"));
  const p = path.join(dir, "empty.wav");
  fs.writeFileSync(p, "");
  const fp = contentFingerprint(p);
  assert.equal(typeof fp, "string");
  assert.notEqual(fp, "");
  assert.equal(fp, contentFingerprint(p)); // deterministic
});
test("contentFingerprint: a change at the very start (inside the 64KB head window) IS detected, even on a large file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fp-test-"));
  const size = 200 * 1024; // bigger than the 64KB head/tail window on both ends
  const bufA = Buffer.alloc(size, "x");
  const bufB = Buffer.from(bufA);
  bufB.write("CHANGED", 10);
  const a = path.join(dir, "a.bin"); const b = path.join(dir, "b.bin");
  fs.writeFileSync(a, bufA);
  fs.writeFileSync(b, bufB);
  assert.notEqual(contentFingerprint(a), contentFingerprint(b));
});
test("contentFingerprint: a middle-only change (head+tail+size unchanged) is NOT detected — documents the 64KB-window tradeoff", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fp-test-"));
  const size = 200 * 1024;
  const bufA = Buffer.alloc(size, "x");
  const bufB = Buffer.from(bufA);
  bufB.write("CHANGED", Math.floor(size / 2)); // mutate only the middle
  const a = path.join(dir, "a.bin"); const b = path.join(dir, "b.bin");
  fs.writeFileSync(a, bufA);
  fs.writeFileSync(b, bufB);
  assert.equal(contentFingerprint(a), contentFingerprint(b),
    "middle-only edits are invisible to the 64KB head+tail window by design — a deliberate tradeoff, not a bug");
});

// ── isFileStable (H3a arch-audit — file-stability gate before processing) ───
test("isFileStable: size unchanged across the wait → stable (true)", async () => {
  const statFn = () => 1000; // same every call
  const waitFn = () => Promise.resolve();
  assert.equal(await isFileStable("/x", 10, statFn, waitFn), true);
});
test("isFileStable: size changed between the two samples → not stable (false) — mirrors the TODO.md incident's exact numbers (12KB → 48MB mid-write)", async () => {
  const sizes = [12000, 48000000];
  let i = 0;
  const statFn = () => sizes[i++];
  const waitFn = () => Promise.resolve();
  assert.equal(await isFileStable("/x", 10, statFn, waitFn), false);
});
test("isFileStable: missing/unreadable file (statFn returns null) on the FIRST sample → not stable, waitFn never even called", async () => {
  let waited = false;
  const statFn = () => null;
  const waitFn = () => { waited = true; return Promise.resolve(); };
  assert.equal(await isFileStable("/x", 10, statFn, waitFn), false);
  assert.equal(waited, false, "no point waiting on a file that doesn't exist at all");
});
test("isFileStable: file vanishes between samples (2nd statFn call returns null) → not stable", async () => {
  const results = [1000, null];
  let i = 0;
  const statFn = () => results[i++];
  const waitFn = () => Promise.resolve();
  assert.equal(await isFileStable("/x", 10, statFn, waitFn), false);
});
test("isFileStable: waitFn is called with exactly the requested waitMs", async () => {
  let seenMs = null;
  const statFn = () => 5;
  const waitFn = (ms) => { seenMs = ms; return Promise.resolve(); };
  await isFileStable("/x", 250, statFn, waitFn);
  assert.equal(seenMs, 250);
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

// ── busyVerdict (centralized concurrent-operation refusal, H1 arch-audit) ────
test("busyVerdict: nothing busy → null", () => {
  assert.equal(busyVerdict([[false, "a"], [false, "b"]]), null);
});
test("busyVerdict: single busy check returns its message", () => {
  assert.equal(busyVerdict([[true, "занято"]]), "занято");
});
test("busyVerdict: first-match-wins — earlier entries take priority over later ones", () => {
  assert.equal(busyVerdict([[true, "первый"], [true, "второй"]]), "первый");
});
test("busyVerdict: skips false entries, returns the first true one regardless of position", () => {
  assert.equal(busyVerdict([[false, "a"], [false, "b"], [true, "c"], [true, "d"]]), "c");
});
test("busyVerdict: empty checks array → null", () => {
  assert.equal(busyVerdict([]), null);
});
test("busyVerdict: no argument at all → null (defensive default)", () => {
  assert.equal(busyVerdict(), null);
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

// ── isPathInsideRoots (general path containment, H2 arch-audit) ─────────────
// General-purpose primitive behind isNoteDeletable/isAudioDeletable below —
// main.js's read-note/rename-speakers/reveal/para-extract/para-classify/
// para-file handlers validate renderer-supplied paths against it directly
// (no .md/audio-extension requirement, unlike the deletion-specific wrappers).
test("isPathInsideRoots: path inside out_dir (single root) is inside", () => {
  assert.equal(isPathInsideRoots("/out/meeting.md", ["/out"]), true);
});
test("isPathInsideRoots: path inside the PARA vault root (2nd root) is inside", () => {
  assert.equal(isPathInsideRoots("/vault/Projects/meeting.md", ["/out", "/vault"]), true);
});
test("isPathInsideRoots: path equal to a root itself is inside (directory-target case, e.g. para-file's root arg)", () => {
  assert.equal(isPathInsideRoots("/vault", ["/vault"]), true);
});
test("isPathInsideRoots: path outside every allowed root is refused", () => {
  assert.equal(isPathInsideRoots("/elsewhere/meeting.md", ["/out", "/vault"]), false);
});
test("isPathInsideRoots: traversal ('..') resolving outside the root is refused (symlink-escape shape — caller passes the REALPATH-resolved target)", () => {
  // Mirrors isNoteDeletable's own traversal test: main.js resolves symlinks via
  // fs.realpathSync BEFORE calling in, so a symlink named "x" inside an allowed
  // root that points outside it arrives here already resolved to the escaped
  // path — exactly like a literal ".." traversal would.
  const resolved = path.resolve("/out/../../etc/passwd");
  assert.equal(isPathInsideRoots(resolved, ["/out"]), false);
});
test("isPathInsideRoots: missing/unresolvable path (null) is refused", () => {
  assert.equal(isPathInsideRoots(null, ["/out"]), false);
});
test("isPathInsideRoots: no allowed roots configured is refused", () => {
  assert.equal(isPathInsideRoots("/out/meeting.md", []), false);
  assert.equal(isPathInsideRoots("/out/meeting.md", [null, ""]), false);
});
test("isPathInsideRoots: no argument at all (undefined roots) → refused, not a throw", () => {
  assert.equal(isPathInsideRoots("/out/meeting.md"), false);
});

// ── История note deletion (path validation before unlink) ───────────────────
test("isNoteDeletable: .md inside out_dir (single root) is deletable", () => {
  assert.equal(isNoteDeletable("/out/meeting.md", "/out/meeting.md", ["/out"]), true);
});
test("isNoteDeletable: .md inside the PARA vault root (2nd root) is deletable", () => {
  assert.equal(isNoteDeletable("/vault/Projects/meeting.md", "/vault/Projects/meeting.md", ["/out", "/vault"]), true);
});
test("isNoteDeletable: resolved path outside every allowed root is refused", () => {
  assert.equal(isNoteDeletable("/elsewhere/meeting.md", "/elsewhere/meeting.md", ["/out", "/vault"]), false);
});
test("isNoteDeletable: traversal ('..') resolving outside the root is refused", () => {
  // Caller resolves notePath to an absolute real path before calling in (main.js uses
  // fs.realpathSync) — a "../../etc/passwd.md"-style input collapses to whatever it
  // actually points at on disk; here it lands outside every allowed root.
  const resolved = path.resolve("/out", "../../etc/passwd.md");
  assert.equal(isNoteDeletable("/out/../../etc/passwd.md", resolved, ["/out"]), false);
});
test("isNoteDeletable: non-.md path is refused even if it resolves inside a root", () => {
  assert.equal(isNoteDeletable("/out/audio.wav", "/out/audio.wav", ["/out"]), false);
});
test("isNoteDeletable: missing/unresolvable file (resolvedPath null) is refused", () => {
  assert.equal(isNoteDeletable("/out/gone.md", null, ["/out"]), false);
});
test("isNoteDeletable: no allowed roots configured is refused", () => {
  assert.equal(isNoteDeletable("/out/meeting.md", "/out/meeting.md", []), false);
  assert.equal(isNoteDeletable("/out/meeting.md", "/out/meeting.md", [null, ""]), false);
});
test("isNoteDeletable: non-string notePath is refused", () => {
  assert.equal(isNoteDeletable(null, "/out/meeting.md", ["/out"]), false);
  assert.equal(isNoteDeletable(undefined, "/out/meeting.md", ["/out"]), false);
});
test("isNoteDeletable: notePath ends in .md but resolves to a non-.md target (symlink case) is refused", () => {
  assert.equal(isNoteDeletable("/out/x.md", "/out/config.json", ["/out"]), false);
});

// ── История trash (30-day retention — recording ✕ + per-note delete) ────────
test("isAudioDeletable: audio extension inside out_dir (single root) is deletable", () => {
  assert.equal(isAudioDeletable("/out/meeting-x.wav", "/out/meeting-x.wav", ["/out"]), true);
});
test("isAudioDeletable: audio extension inside the PARA vault root (2nd root) is deletable", () => {
  assert.equal(isAudioDeletable("/vault/Projects/meeting-x.mp3", "/vault/Projects/meeting-x.mp3", ["/out", "/vault"]), true);
});
test("isAudioDeletable: is case-insensitive on the extension", () => {
  assert.equal(isAudioDeletable("/out/meeting-x.WAV", "/out/meeting-x.WAV", ["/out"]), true);
});
test("isAudioDeletable: resolved path outside every allowed root is refused", () => {
  assert.equal(isAudioDeletable("/elsewhere/meeting-x.wav", "/elsewhere/meeting-x.wav", ["/out", "/vault"]), false);
});
test("isAudioDeletable: non-audio extension is refused even if it resolves inside a root", () => {
  assert.equal(isAudioDeletable("/out/meeting-x.md", "/out/meeting-x.md", ["/out"]), false);
  assert.equal(isAudioDeletable("/out/notes.txt", "/out/notes.txt", ["/out"]), false);
});
test("isAudioDeletable: missing/unresolvable file (resolvedPath null) is refused", () => {
  assert.equal(isAudioDeletable("/out/gone.wav", null, ["/out"]), false);
});
test("isAudioDeletable: no allowed roots configured is refused", () => {
  assert.equal(isAudioDeletable("/out/meeting-x.wav", "/out/meeting-x.wav", []), false);
  assert.equal(isAudioDeletable("/out/meeting-x.wav", "/out/meeting-x.wav", [null, ""]), false);
});
test("isAudioDeletable: non-string audioPath is refused", () => {
  assert.equal(isAudioDeletable(null, "/out/meeting-x.wav", ["/out"]), false);
  assert.equal(isAudioDeletable(undefined, "/out/meeting-x.wav", ["/out"]), false);
});
test("isAudioDeletable: audioPath ends in an audio extension but resolves to a non-audio target (symlink case) is refused", () => {
  assert.equal(isAudioDeletable("/out/x.wav", "/out/config.json", ["/out"]), false);
});

test("trashRootFor: a configured PARA vault root wins over out_dir (Obsidian convention — .trash lives at the vault root)", () => {
  assert.equal(trashRootFor("/vault/Meetings", "/vault"), path.join("/vault", ".trash"));
});
test("trashRootFor: no vault configured falls back to a sibling .trash under out_dir", () => {
  assert.equal(trashRootFor("/out", null), path.join("/out", ".trash"));
  assert.equal(trashRootFor("/out", ""), path.join("/out", ".trash"));
});

test("trashDestPath: no existing file at the destination returns the bare name", () => {
  const exists = () => false;
  assert.equal(trashDestPath("/out/.trash", "meeting-x.wav", exists), path.join("/out/.trash", "meeting-x.wav"));
});
test("trashDestPath: a name collision gets a '-1' suffix", () => {
  const taken = new Set([path.join("/out/.trash", "meeting-x.wav")]);
  const exists = (p) => taken.has(p);
  assert.equal(trashDestPath("/out/.trash", "meeting-x.wav", exists), path.join("/out/.trash", "meeting-x-1.wav"));
});
test("trashDestPath: multiple collisions pick the first free suffix", () => {
  const taken = new Set([
    path.join("/out/.trash", "meeting-x.wav"),
    path.join("/out/.trash", "meeting-x-1.wav"),
    path.join("/out/.trash", "meeting-x-2.wav"),
  ]);
  const exists = (p) => taken.has(p);
  assert.equal(trashDestPath("/out/.trash", "meeting-x.wav", exists), path.join("/out/.trash", "meeting-x-3.wav"));
});

test("moveToTrash: same-volume rename — only renameSync is called, no copy/unlink fallback", () => {
  const calls = [];
  const deps = {
    renameSync: (src, dest) => calls.push(["rename", src, dest]),
    copyFileSync: () => calls.push(["copy"]),
    unlinkSync: () => calls.push(["unlink"]),
  };
  moveToTrash("/out/a.wav", "/out/.trash/a.wav", deps);
  assert.deepEqual(calls, [["rename", "/out/a.wav", "/out/.trash/a.wav"]]);
});
test("moveToTrash: EXDEV (cross-device rename) falls back to copyFileSync + unlinkSync", () => {
  const calls = [];
  const deps = {
    renameSync: () => { const e = new Error("cross-device"); e.code = "EXDEV"; throw e; },
    copyFileSync: (src, dest) => calls.push(["copy", src, dest]),
    unlinkSync: (src) => calls.push(["unlink", src]),
  };
  moveToTrash("/out/a.wav", "/out/.trash/a.wav", deps);
  assert.deepEqual(calls, [["copy", "/out/a.wav", "/out/.trash/a.wav"], ["unlink", "/out/a.wav"]]);
});
test("moveToTrash: a non-EXDEV rename error propagates (no silent fallback)", () => {
  const deps = {
    renameSync: () => { throw new Error("permission denied"); },
    copyFileSync: () => { throw new Error("must not be called"); },
    unlinkSync: () => { throw new Error("must not be called"); },
  };
  assert.throws(() => moveToTrash("/out/a.wav", "/out/.trash/a.wav", deps), /permission denied/);
});

test("purgeTrash: a fresh (not-yet-stale) entry is kept and its files are never even existence-checked", () => {
  const now = 1_000_000_000_000;
  const entry = { deletedAt: now - 1000, kind: "note", files: ["/out/.trash/a.md"], baseStamp: "s1" };
  let existsCalled = false;
  const deps = { existsSync: () => { existsCalled = true; return true; }, unlinkSync: () => { throw new Error("must not be called"); } };
  const kept = purgeTrash([entry], "/out/.trash", 30 * 24 * 3600 * 1000, now, deps);
  assert.deepEqual(kept, [entry]);
  assert.equal(existsCalled, false, "a fresh entry's files must not even be existence-checked");
});
test("purgeTrash: an old (>30 day) entry has its existing files deleted and the entry dropped", () => {
  const now = 1_000_000_000_000;
  const maxAge = 30 * 24 * 3600 * 1000;
  const entry = { deletedAt: now - maxAge - 1, kind: "recording", files: ["/out/.trash/a.wav", "/out/.trash/a.md"], baseStamp: "s1" };
  const unlinked = [];
  const deps = { existsSync: () => true, unlinkSync: (p) => unlinked.push(p) };
  const kept = purgeTrash([entry], "/out/.trash", maxAge, now, deps);
  assert.deepEqual(kept, [], "old entry must be dropped from the surviving manifest");
  assert.deepEqual(unlinked, ["/out/.trash/a.wav", "/out/.trash/a.md"]);
});
test("purgeTrash: a missing file during purge is skipped silently (no throw) and the entry is still dropped", () => {
  const now = 1_000_000_000_000;
  const maxAge = 30 * 24 * 3600 * 1000;
  const entry = { deletedAt: now - maxAge - 1, kind: "note", files: ["/out/.trash/gone.md"], baseStamp: null };
  const deps = { existsSync: () => false, unlinkSync: () => { throw new Error("must not be called on a missing file"); } };
  assert.doesNotThrow(() => {
    const kept = purgeTrash([entry], "/out/.trash", maxAge, now, deps);
    assert.deepEqual(kept, []);
  });
});
test("purgeTrash: a mixed manifest keeps only the fresh entries", () => {
  const now = 1_000_000_000_000;
  const maxAge = 30 * 24 * 3600 * 1000;
  const fresh = { deletedAt: now - 1000, kind: "note", files: ["/out/.trash/fresh.md"], baseStamp: "s1" };
  const old = { deletedAt: now - maxAge - 1, kind: "note", files: ["/out/.trash/old.md"], baseStamp: "s2" };
  const deps = { existsSync: () => true, unlinkSync: () => {} };
  const kept = purgeTrash([fresh, old], "/out/.trash", maxAge, now, deps);
  assert.deepEqual(kept, [fresh]);
});
test("purgeTrash: a file outside trashDir in the manifest is skipped (never deleted) — defends against a tampered/malformed manifest.json", () => {
  const now = 1_000_000_000_000;
  const maxAge = 30 * 24 * 3600 * 1000;
  const trashDir = "/out/.trash";
  const entry = {
    deletedAt: now - maxAge - 1, kind: "recording",
    files: ["/etc/passwd", path.join(trashDir, "a.wav")], baseStamp: "s1",
  };
  const unlinked = [];
  const deps = { existsSync: () => true, unlinkSync: (p) => unlinked.push(p) };
  const kept = purgeTrash([entry], trashDir, maxAge, now, deps);
  assert.deepEqual(kept, [], "entry is still dropped from the manifest — the purge decision is time-based, not per-file-success-based");
  assert.deepEqual(unlinked, [path.join(trashDir, "a.wav")], "only the file actually inside trashDir gets deleted; the out-of-trashDir path is skipped");
});

// ── Корзина tab (trash-tab feature) ─────────────────────────────────────────
test("isTrashAudioFile: recognized audio extension (case-insensitive) is true", () => {
  assert.equal(isTrashAudioFile("/out/.trash/a.wav"), true);
  assert.equal(isTrashAudioFile("/out/.trash/a.WAV"), true);
  assert.equal(isTrashAudioFile("/out/.trash/a.mp3"), true);
});
test("isTrashAudioFile: a .md (or any non-audio) path is false", () => {
  assert.equal(isTrashAudioFile("/out/.trash/a.md"), false);
  assert.equal(isTrashAudioFile("/out/.trash/a.txt"), false);
});

test("trashDaysLeft: default 30-day window, deletedAt === now → 30 days left", () => {
  const now = 1_000_000_000_000;
  assert.equal(trashDaysLeft(now, now), 30);
});
test("trashDaysLeft: exactly at the 30-day boundary → 0 (not yet negative)", () => {
  const now = 1_000_000_000_000;
  const maxAge = 30 * 24 * 3600 * 1000;
  assert.equal(trashDaysLeft(now - maxAge, now), 0);
});
test("trashDaysLeft: 7 whole days elapsed out of 30 → 23 left", () => {
  const dayMs = 24 * 3600 * 1000;
  const now = 1_000_000_000_000;
  assert.equal(trashDaysLeft(now - 7 * dayMs, now), 23);
});
test("trashDaysLeft: a partial day remaining still rounds up to 1 (never shows 0 while anything remains)", () => {
  const now = 1_000_000_000_000;
  const maxAge = 30 * 24 * 3600 * 1000;
  assert.equal(trashDaysLeft(now - maxAge + 1, now), 1);
});
test("trashDaysLeft: custom maxAgeMs is honored instead of the 30-day default", () => {
  const dayMs = 24 * 3600 * 1000;
  const now = 1_000_000_000_000;
  assert.equal(trashDaysLeft(now - dayMs, now, 5 * dayMs), 4);
});

test("buildTrashEntry: fills baseStamp/title/origin defaults when omitted", () => {
  const entry = buildTrashEntry({ id: "id1", deletedAt: 123, kind: "note", files: ["/out/.trash/a.md"] });
  assert.deepEqual(entry, {
    id: "id1", deletedAt: 123, kind: "note", files: ["/out/.trash/a.md"],
    baseStamp: null, title: null, origin: {},
  });
});
test("buildTrashEntry: carries baseStamp/title/origin through unchanged when provided", () => {
  const entry = buildTrashEntry({
    id: "id2", deletedAt: 456, kind: "recording", files: ["/out/.trash/a.wav", "/out/.trash/a.md"],
    baseStamp: "s1", title: "Синк", origin: { "/out/.trash/a.wav": "/out/a.wav" },
  });
  assert.deepEqual(entry, {
    id: "id2", deletedAt: 456, kind: "recording", files: ["/out/.trash/a.wav", "/out/.trash/a.md"],
    baseStamp: "s1", title: "Синк", origin: { "/out/.trash/a.wav": "/out/a.wav" },
  });
});

test("restoreDestinationFor: an origin-mapped file inside an allowed root (the vault) restores to its recorded original path", () => {
  const origin = { "/out/.trash/a.wav": "/vault/Projects/a.wav" };
  assert.equal(restoreDestinationFor("/out/.trash/a.wav", origin, "/out", ["/out", "/vault"]), "/vault/Projects/a.wav");
});
test("restoreDestinationFor: a legacy file with no origin entry falls back to outDir/basename", () => {
  assert.equal(restoreDestinationFor("/out/.trash/a.wav", {}, "/out", ["/out"]), path.join("/out", "a.wav"));
  assert.equal(restoreDestinationFor("/out/.trash/a.wav", undefined, "/out", ["/out"]), path.join("/out", "a.wav"));
  assert.equal(restoreDestinationFor("/out/.trash/a.wav", null, "/out", ["/out"]), path.join("/out", "a.wav"));
});
test("restoreDestinationFor: origin present but missing THIS file's key still falls back to outDir/basename", () => {
  const origin = { "/out/.trash/other.wav": "/vault/other.wav" };
  assert.equal(restoreDestinationFor("/out/.trash/a.wav", origin, "/out", ["/out", "/vault"]), path.join("/out", "a.wav"));
});
test("restoreDestinationFor: an origin pointing OUTSIDE every allowed root falls back to outDir/basename instead of being honored verbatim (tampered/stale manifest.json defense — the origin map comes from a JSON file on disk, a vaultRoot reconfigured after the delete can also strand an old, once-valid origin outside the CURRENT roots)", () => {
  const origin = { "/out/.trash/a.wav": "/etc/passwd" };
  assert.equal(restoreDestinationFor("/out/.trash/a.wav", origin, "/out", ["/out", "/vault"]), path.join("/out", "a.wav"));
});
test("restoreDestinationFor: no roots passed at all → an origin-mapped path can't be validated and is never trusted verbatim — fails closed to outDir/basename", () => {
  const origin = { "/out/.trash/a.wav": "/vault/Projects/a.wav" };
  assert.equal(restoreDestinationFor("/out/.trash/a.wav", origin, "/out"), path.join("/out", "a.wav"));
  assert.equal(restoreDestinationFor("/out/.trash/a.wav", origin, "/out", []), path.join("/out", "a.wav"));
});

// restoreTrashFiles: the actual restore loop (main.js's restore-trash-entry handler body,
// extracted so it's behavior-testable without electron) — proves the full pipeline, not
// just restoreDestinationFor in isolation, respects containment and partial-failure
// handling end to end.
test("restoreTrashFiles: happy path — every file moved to its restoreDestinationFor target", () => {
  const moved = [];
  const deps = { mkdirSync: () => {}, existsSync: () => false, move: (src, dest) => moved.push([src, dest]) };
  const origin = { "/out/.trash/a.wav": "/vault/Projects/a.wav" };
  const { remaining, error } = restoreTrashFiles(["/out/.trash/a.wav", "/out/.trash/b.md"], origin, "/out", ["/out", "/vault"], deps);
  assert.deepEqual(remaining, []);
  assert.equal(error, null);
  assert.deepEqual(moved, [["/out/.trash/a.wav", "/vault/Projects/a.wav"], ["/out/.trash/b.md", path.join("/out", "b.md")]]);
});
test("restoreTrashFiles: an origin pointing outside every allowed root is never handed to move() verbatim — restored to outDir instead", () => {
  const moved = [];
  const deps = { mkdirSync: () => {}, existsSync: () => false, move: (src, dest) => moved.push([src, dest]) };
  const origin = { "/out/.trash/a.wav": "/etc/passwd" };
  const { remaining, error } = restoreTrashFiles(["/out/.trash/a.wav"], origin, "/out", ["/out", "/vault"], deps);
  assert.deepEqual(remaining, []);
  assert.equal(error, null);
  assert.deepEqual(moved, [["/out/.trash/a.wav", path.join("/out", "a.wav")]]);
});
test("restoreTrashFiles: one file's move fails — the others still restore, the failing one stays in `remaining`, its error is reported", () => {
  const moved = [];
  const move = (src, dest) => {
    if (src === "/out/.trash/bad.wav") throw new Error("disk full");
    moved.push([src, dest]);
  };
  const deps = { mkdirSync: () => {}, existsSync: () => false, move };
  const { remaining, error } = restoreTrashFiles(
    ["/out/.trash/a.md", "/out/.trash/bad.wav", "/out/.trash/c.md"], {}, "/out", ["/out"], deps
  );
  assert.deepEqual(remaining, ["/out/.trash/bad.wav"]);
  assert.match(error, /disk full/);
  assert.deepEqual(moved.map((m) => m[0]), ["/out/.trash/a.md", "/out/.trash/c.md"]);
});
test("restoreTrashFiles: defaults deps to real fs/moveToTrash when none injected (doesn't throw just from being called with no deps arg)", () => {
  assert.doesNotThrow(() => restoreTrashFiles([], {}, "/out", ["/out"]));
});

test("deleteTrashEntryFiles: unlinks every existing file inside trashDir", () => {
  const entry = { files: ["/out/.trash/a.wav", "/out/.trash/a.md"] };
  const unlinked = [];
  const deps = { existsSync: () => true, unlinkSync: (p) => unlinked.push(p) };
  deleteTrashEntryFiles(entry, "/out/.trash", deps);
  assert.deepEqual(unlinked, ["/out/.trash/a.wav", "/out/.trash/a.md"]);
});
test("deleteTrashEntryFiles: a file outside trashDir is skipped (same containment as purgeTrash)", () => {
  const entry = { files: ["/etc/passwd", "/out/.trash/a.wav"] };
  const unlinked = [];
  const deps = { existsSync: () => true, unlinkSync: (p) => unlinked.push(p) };
  deleteTrashEntryFiles(entry, "/out/.trash", deps);
  assert.deepEqual(unlinked, ["/out/.trash/a.wav"]);
});
test("deleteTrashEntryFiles: a missing file is skipped silently (no throw)", () => {
  const entry = { files: ["/out/.trash/gone.wav"] };
  const deps = { existsSync: () => false, unlinkSync: () => { throw new Error("must not be called on a missing file"); } };
  assert.doesNotThrow(() => deleteTrashEntryFiles(entry, "/out/.trash", deps));
});

// ── out-dir auto-follow (settings "Куда сохранять", Variant A) ──────────────
test("resolveOutDirOnVaultChange: custom=false follows the vault's Meetings subfolder", () => {
  assert.equal(resolveOutDirOnVaultChange("/old/out", false, "/vault"), path.join("/vault", "Meetings"));
});
test("resolveOutDirOnVaultChange: custom=true leaves outDir unchanged", () => {
  assert.equal(resolveOutDirOnVaultChange("/old/out", true, "/vault"), "/old/out");
});
test("resolveOutDirOnVaultChange: no existing outDir adopts the vault's Meetings subfolder", () => {
  assert.equal(resolveOutDirOnVaultChange("", false, "/vault"), path.join("/vault", "Meetings"));
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

// ── list upsert-by-id ────────────────────────────────────────────────────────
test("upsertById: unknown id appends", () => {
  const list = [{ id: "a", v: 1 }];
  const next = upsertById(list, { id: "b", v: 2 });
  assert.deepEqual(next, [{ id: "a", v: 1 }, { id: "b", v: 2 }]);
});
test("upsertById: existing id replaces in place instead of duplicating", () => {
  const list = [{ id: "a", v: 1 }, { id: "b", v: 2 }, { id: "c", v: 3 }];
  const next = upsertById(list, { id: "b", v: 99 });
  assert.deepEqual(next, [{ id: "a", v: 1 }, { id: "b", v: 99 }, { id: "c", v: 3 }]);
  assert.equal(next.length, 3, "must replace, not append a duplicate id");
});
test("upsertById: is pure — never mutates the input list or entry", () => {
  const list = [{ id: "a", v: 1 }];
  const listCopy = list.map((e) => ({ ...e }));
  upsertById(list, { id: "a", v: 2 });
  assert.deepEqual(list, listCopy, "input list must be untouched");
});
test("upsertById: empty list appends as the sole entry", () => {
  const next = upsertById([], { id: "a", v: 1 });
  assert.deepEqual(next, [{ id: "a", v: 1 }]);
});

// ── tray menu (macOS menu-bar icon) ──────────────────────────────────────────
test("trayMenuTemplate: not recording → 'Начать запись' toggle label", () => {
  const items = trayMenuTemplate({ recording: false });
  const toggle = items.find((i) => i.id === "toggle-record");
  assert.equal(toggle.label, "Начать запись");
  assert.equal(toggle.enabled, true);
});
test("trayMenuTemplate: recording → 'Остановить запись' toggle label", () => {
  const items = trayMenuTemplate({ recording: true });
  const toggle = items.find((i) => i.id === "toggle-record");
  assert.equal(toggle.label, "Остановить запись");
});
test("trayMenuTemplate: undefined state defaults to not-recording", () => {
  const items = trayMenuTemplate(undefined);
  assert.equal(items.find((i) => i.id === "toggle-record").label, "Начать запись");
});
test("trayMenuTemplate: has an 'open window' item and a trailing separator + quit item", () => {
  const items = trayMenuTemplate({ recording: false });
  assert.ok(items.find((i) => i.id === "open-window" && i.label === "Открыть Meeting Recorder"));
  const quitIdx = items.findIndex((i) => i.id === "quit");
  assert.ok(quitIdx > 0);
  assert.equal(items[quitIdx].label, "Выйти");
  assert.equal(items[quitIdx - 1].type, "separator");
});
test("trayMenuTemplate: exactly one toggle item regardless of recording state (no duplicated/disabled variants)", () => {
  for (const recording of [true, false]) {
    const items = trayMenuTemplate({ recording });
    assert.equal(items.filter((i) => i.id === "toggle-record").length, 1);
  }
});

// ── backend installer resolvers (settings "Бэкенд" section) ──────────────────
test("resolvePythonBin: installed env wins when it exists AND the completion marker is present", () => {
  assert.equal(
    resolvePythonBin("/userdata/backend-env/python/bin/python3.11", true, true, "/proj/venv/bin/python", true),
    "/userdata/backend-env/python/bin/python3.11"
  );
});
test("resolvePythonBin: falls back to dev venv when installed doesn't exist", () => {
  assert.equal(
    resolvePythonBin("/userdata/backend-env/python/bin/python3.11", false, false, "/proj/venv/bin/python", true),
    "/proj/venv/bin/python"
  );
});
test("resolvePythonBin: falls back to bare python3 when neither exists", () => {
  assert.equal(
    resolvePythonBin("/userdata/backend-env/python/bin/python3.11", false, false, "/proj/venv/bin/python", false),
    "python3"
  );
});
// ── regression lock: the blocker this session fixed ──────────────────────────
// install-backend extracts python BEFORE running pip and only writes the
// completion marker after pip succeeds, so a failed/cancelled install (or,
// pre-fix, any window where the interpreter briefly existed without the
// marker) must NOT be treated as an installed backend — it must fall through
// exactly as if nothing were installed at all.
test("resolvePythonBin: python file exists but marker is ABSENT (partial/cancelled install) → falls through to dev venv, never the depless interpreter", () => {
  assert.equal(
    resolvePythonBin("/userdata/backend-env/python/bin/python3.11", true, false, "/proj/venv/bin/python", true),
    "/proj/venv/bin/python"
  );
});
test("resolvePythonBin: python file exists but marker is ABSENT, and no dev venv either → falls through to bare python3, not the depless interpreter", () => {
  assert.equal(
    resolvePythonBin("/userdata/backend-env/python/bin/python3.11", true, false, "/proj/venv/bin/python", false),
    "python3"
  );
});

test("resolveFfmpegBin: installed static ffmpeg wins when it exists", () => {
  assert.equal(resolveFfmpegBin("/userdata/backend-env/bin/ffmpeg", true), "/userdata/backend-env/bin/ffmpeg");
});
test("resolveFfmpegBin: falls back to bare ffmpeg (resolved via $PATH) when not installed", () => {
  assert.equal(resolveFfmpegBin("/userdata/backend-env/bin/ffmpeg", false), "ffmpeg");
});

test("resolveResourcePath: dev checkout resolves directly under appDir", () => {
  assert.equal(resolveResourcePath(false, "/Contents/Resources", "/dev/app", "backend.py"), path.join("/dev/app", "backend.py"));
});
test("resolveResourcePath: packaged app resolves under resourcesPath, ignoring appDir", () => {
  assert.equal(
    resolveResourcePath(true, "/Contents/Resources", "/dev/app", "requirements.txt"),
    path.join("/Contents/Resources", "requirements.txt")
  );
});
test("resolveResourcePath: works for a nested relative path (vendor/wheels)", () => {
  assert.equal(resolveResourcePath(false, "/res", "/dev/app", "vendor/wheels"), path.join("/dev/app", "vendor/wheels"));
});

test("resolveAudioTeeBin: packaged app resolves under resourcesPath/app.asar.unpacked (not plain resourcesPath)", () => {
  assert.equal(
    resolveAudioTeeBin(true, "/Contents/Resources", "/dev/app"),
    path.join("/Contents/Resources", "app.asar.unpacked", "node_modules", "audiotee", "bin", "audiotee")
  );
});
test("resolveAudioTeeBin: dev checkout resolves directly under appDir/node_modules", () => {
  assert.equal(
    resolveAudioTeeBin(false, "/Contents/Resources", "/dev/app"),
    path.join("/dev/app", "node_modules", "audiotee", "bin", "audiotee")
  );
});

test("resolveAssetPath: packaged app resolves under resourcesPath/app.asar.unpacked/assets (not plain resourcesPath)", () => {
  assert.equal(
    resolveAssetPath(true, "/Contents/Resources", "/dev/app", "trayTemplate.png"),
    path.join("/Contents/Resources", "app.asar.unpacked", "assets", "trayTemplate.png")
  );
});
test("resolveAssetPath: dev checkout resolves directly under appDir/assets", () => {
  assert.equal(
    resolveAssetPath(false, "/Contents/Resources", "/dev/app", "trayTemplate.png"),
    path.join("/dev/app", "assets", "trayTemplate.png")
  );
});

test("backendInstallStatus: no marker + interpreter missing → not installed", () => {
  assert.deepEqual(backendInstallStatus(null, "abc123", false), { installed: false, pythonVersion: null, stale: false });
});
test("backendInstallStatus: marker present but interpreter missing (manually deleted env) → not installed", () => {
  assert.deepEqual(
    backendInstallStatus({ pythonVersion: "3.11.15", requirementsHash: "abc123" }, "abc123", false),
    { installed: false, pythonVersion: null, stale: false }
  );
});
test("backendInstallStatus: marker + interpreter present, hash matches current requirements → installed, not stale", () => {
  assert.deepEqual(
    backendInstallStatus({ pythonVersion: "3.11.15", requirementsHash: "abc123" }, "abc123", true),
    { installed: true, pythonVersion: "3.11.15", stale: false }
  );
});
test("backendInstallStatus: hash mismatch (requirements.txt changed since install) → installed but stale", () => {
  assert.deepEqual(
    backendInstallStatus({ pythonVersion: "3.11.15", requirementsHash: "old-hash" }, "new-hash", true),
    { installed: true, pythonVersion: "3.11.15", stale: true }
  );
});
test("backendInstallStatus: interpreter present but no marker at all → not installed (not a false 'stale')", () => {
  assert.deepEqual(backendInstallStatus(null, "abc123", true), { installed: false, pythonVersion: null, stale: false });
});

// ── setup-gate model cache paths (mirrors backend.py's MODEL_SPECS) ──────────
// Load-bearing correctness point: a mismatch here means the setup gate never
// dismisses (or dismisses wrongly) — these must match backend.py's
// _WHISPER_MODEL_DIR/_VAD_JIT_PATH/_PYANNOTE_REPO_IDS EXACTLY (backend.py:2623-2634):
//   _WHISPER_MODEL_DIR = Path.home() / ".cache/huggingface/hub/models--mlx-community--whisper-large-v3-turbo"
//   _VAD_JIT_PATH      = Path.home() / ".cache/torch/hub/snakers4_silero-vad_master/src/silero_vad/data/silero_vad.jit"
//   _PYANNOTE_REPO_IDS = ["pyannote/speaker-diarization-3.1", "pyannote/segmentation-3.0",
//                         "pyannote/wespeaker-voxceleb-resnet34-LM"]  (each via _hf_cache_dir)
test("whisperModelDir matches backend.py's _WHISPER_MODEL_DIR exactly", () => {
  assert.equal(
    whisperModelDir("/Users/x"),
    path.join("/Users/x", ".cache/huggingface/hub/models--mlx-community--whisper-large-v3-turbo")
  );
});
test("vadJitPath matches backend.py's _VAD_JIT_PATH exactly", () => {
  assert.equal(
    vadJitPath("/Users/x"),
    path.join("/Users/x", ".cache/torch/hub/snakers4_silero-vad_master/src/silero_vad/data/silero_vad.jit")
  );
});
test("diarizationModelDirs matches backend.py's _PYANNOTE_REPO_IDS (via _hf_cache_dir) exactly", () => {
  assert.deepEqual(diarizationModelDirs("/Users/x"), [
    path.join("/Users/x", ".cache/huggingface/hub/models--pyannote--speaker-diarization-3.1"),
    path.join("/Users/x", ".cache/huggingface/hub/models--pyannote--segmentation-3.0"),
    path.join("/Users/x", ".cache/huggingface/hub/models--pyannote--wespeaker-voxceleb-resnet34-LM"),
  ]);
});
test("hfCacheDir replaces every '/' in the repo id (not just the first)", () => {
  assert.equal(hfCacheDir("/h", "a/b/c"), path.join("/h", ".cache/huggingface/hub/models--a--b--c"));
});

// ── appReadinessStatus (wall verdict: backend + whisper + vad, diarization excluded) ──
test("appReadinessStatus: neither backend nor models ready", () => {
  assert.deepEqual(appReadinessStatus(false, false, false), { backend: false, whisper: false, vad: false, models: false });
});
test("appReadinessStatus: backend ready, models missing", () => {
  assert.deepEqual(appReadinessStatus(true, false, false), { backend: true, whisper: false, vad: false, models: false });
});
test("appReadinessStatus: models ready (whisper+vad), backend not (edge case — predicate doesn't couple them)", () => {
  assert.deepEqual(appReadinessStatus(false, true, true), { backend: false, whisper: true, vad: true, models: true });
});
test("appReadinessStatus: both backend and models ready", () => {
  assert.deepEqual(appReadinessStatus(true, true, true), { backend: true, whisper: true, vad: true, models: true });
});
test("appReadinessStatus: models is false unless BOTH whisper and vad are cached (partial doesn't count)", () => {
  assert.deepEqual(appReadinessStatus(true, true, false), { backend: true, whisper: true, vad: false, models: false });
  assert.deepEqual(appReadinessStatus(true, false, true), { backend: true, whisper: false, vad: true, models: false });
});

// ── modelCacheDirsFor / cleanupPartialModelCache (parent-side partial-download
// cleanup — the authoritative counterpart to backend.py's own best-effort
// _cleanup_partial_download; see main.js's download-models close handler for why
// this side, not the child's SIGTERM handler, is the actual race-free guarantee) ──
test("modelCacheDirsFor: whisper resolves to whisperModelDir", () => {
  assert.deepEqual(modelCacheDirsFor("/Users/x", "whisper"), [whisperModelDir("/Users/x")]);
});
test("modelCacheDirsFor: vad resolves to the repo dir (4 levels up from the .jit file), not the .jit file itself", () => {
  assert.deepEqual(
    modelCacheDirsFor("/Users/x", "vad"),
    [path.join("/Users/x", ".cache/torch/hub/snakers4_silero-vad_master")]
  );
});
test("modelCacheDirsFor: diarization resolves to all 3 pyannote sub-repo dirs", () => {
  assert.deepEqual(modelCacheDirsFor("/Users/x", "diarization"), diarizationModelDirs("/Users/x"));
});
test("modelCacheDirsFor: unknown model id resolves to nothing (no accidental wipe)", () => {
  assert.deepEqual(modelCacheDirsFor("/Users/x", "not-a-model"), []);
});

function tmpHomedir(name) {
  const dir = path.join(os.tmpdir(), `mainutil-cleanup-test-${process.pid}-${name}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test("cleanupPartialModelCache: removes a partial whisper dir", () => {
  const home = tmpHomedir("whisper");
  const dir = whisperModelDir(home);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "partial.bin"), "junk");
  cleanupPartialModelCache(home, "whisper");
  assert.equal(fs.existsSync(dir), false);
  fs.rmSync(home, { recursive: true, force: true });
});

// Direct check of the critical bug this whole mechanism exists to prevent: after
// a canceled/failed whisper download, the exact predicate main.js's whisperCached()
// (and backend.py's _model_cached) use to decide "is this ready" must read false —
// otherwise the setup wall would falsely dismiss on a broken model.
test("cleanupPartialModelCache: whisperCached()'s own predicate (fs.existsSync(whisperModelDir)) reads false after cleanup", () => {
  const home = tmpHomedir("whisper-readiness");
  const dir = whisperModelDir(home);
  fs.mkdirSync(dir, { recursive: true });
  assert.equal(fs.existsSync(dir), true, "sanity: partial dir exists before cleanup");
  cleanupPartialModelCache(home, "whisper");
  assert.equal(fs.existsSync(whisperModelDir(home)), false, "readiness must read false — the wall must stay up");
  fs.rmSync(home, { recursive: true, force: true });
});

test("cleanupPartialModelCache: removes the whole vad repo dir, not just the .jit file", () => {
  const home = tmpHomedir("vad");
  const jit = vadJitPath(home);
  fs.mkdirSync(path.dirname(jit), { recursive: true });
  fs.writeFileSync(jit, "junk");
  cleanupPartialModelCache(home, "vad");
  assert.equal(fs.existsSync(path.join(home, ".cache/torch/hub/snakers4_silero-vad_master")), false);
  fs.rmSync(home, { recursive: true, force: true });
});

test("cleanupPartialModelCache: removes all 3 pyannote sub-repo dirs for diarization, even ones that finished", () => {
  // A cancel/failure partway through the 3-repo diarization batch must not leave
  // a mixed state that _model_cached's all() check could misreport — wiping ALL
  // three (not just the interrupted one) guarantees "diarization" reads uncached.
  const home = tmpHomedir("diarization");
  for (const dir of diarizationModelDirs(home)) fs.mkdirSync(dir, { recursive: true });
  cleanupPartialModelCache(home, "diarization");
  for (const dir of diarizationModelDirs(home)) assert.equal(fs.existsSync(dir), false);
  fs.rmSync(home, { recursive: true, force: true });
});

test("cleanupPartialModelCache: a missing/already-clean dir is a silent no-op (no throw)", () => {
  const home = tmpHomedir("nothing-there");
  assert.doesNotThrow(() => cleanupPartialModelCache(home, "whisper"));
  fs.rmSync(home, { recursive: true, force: true });
});

test("cleanupPartialModelCache: an unknown model id touches nothing and does not throw", () => {
  const home = tmpHomedir("unknown-model");
  assert.doesNotThrow(() => cleanupPartialModelCache(home, "not-a-model"));
  fs.rmSync(home, { recursive: true, force: true });
});

// ── dirSizeBytes (settings "Модели" section — per-model on-disk footprint) ─────
test("dirSizeBytes: sums plain files across nested subdirectories", () => {
  const home = tmpHomedir("dirsize-plain");
  fs.mkdirSync(path.join(home, "a", "b"), { recursive: true });
  fs.writeFileSync(path.join(home, "top.bin"), Buffer.alloc(100));
  fs.writeFileSync(path.join(home, "a", "mid.bin"), Buffer.alloc(50));
  fs.writeFileSync(path.join(home, "a", "b", "deep.bin"), Buffer.alloc(25));
  assert.equal(dirSizeBytes(home), 175);
  fs.rmSync(home, { recursive: true, force: true });
});

test("dirSizeBytes: missing directory resolves to 0, not a throw", () => {
  assert.equal(dirSizeBytes(path.join(os.tmpdir(), "mainutil-dirsize-does-not-exist")), 0);
});

test("dirSizeBytes: empty directory is 0", () => {
  const home = tmpHomedir("dirsize-empty");
  assert.equal(dirSizeBytes(home), 0);
  fs.rmSync(home, { recursive: true, force: true });
});

test("dirSizeBytes: symlinked files are skipped, not double-counted — mirrors the HF cache's blobs/+snapshots/ layout", () => {
  // models--org--name/blobs/<hash> holds the real bytes; snapshots/<rev>/<file> is a
  // symlink into blobs/. Following the symlink too would double the reported size.
  const home = tmpHomedir("dirsize-symlink");
  const blobsDir = path.join(home, "blobs");
  const snapshotDir = path.join(home, "snapshots", "rev1");
  fs.mkdirSync(blobsDir, { recursive: true });
  fs.mkdirSync(snapshotDir, { recursive: true });
  const blobFile = path.join(blobsDir, "abc123");
  fs.writeFileSync(blobFile, Buffer.alloc(200));
  fs.symlinkSync(blobFile, path.join(snapshotDir, "model.bin"));
  assert.equal(dirSizeBytes(home), 200, "real bytes counted once via blobs/, the snapshot symlink adds nothing");
  fs.rmSync(home, { recursive: true, force: true });
});

// ── parseFfmpegVersion (settings "Бэкенд" section — "показать КАКОЙ именно бэкенд") ──
test("parseFfmpegVersion: extracts the version token from a standard release banner", () => {
  const banner = "ffmpeg version 8.1 Copyright (c) 2000-2025 the FFmpeg developers\nbuilt with Apple clang...";
  assert.equal(parseFfmpegVersion(banner), "8.1");
});

test("parseFfmpegVersion: extracts a git-describe build string", () => {
  const banner = "ffmpeg version n6.0-2-g1234567 Copyright (c) 2000-2023 the FFmpeg developers";
  assert.equal(parseFfmpegVersion(banner), "n6.0-2-g1234567");
});

test("parseFfmpegVersion: unrecognized output resolves null rather than guessing", () => {
  assert.equal(parseFfmpegVersion("command not found"), null);
  assert.equal(parseFfmpegVersion(""), null);
  assert.equal(parseFfmpegVersion(null), null);
});

// ── in-app updater: version comparator (settings "Обновления" section) ──────
test("compareVersions: equal versions (tag vs plain, 'v' prefix optional)", () => {
  assert.equal(compareVersions("v1.0.0", "1.0.0"), 0);
  assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
});
test("compareVersions: newer tag beats the running version", () => {
  assert.equal(compareVersions("v1.2.0", "1.0.0"), 1);
  assert.equal(compareVersions("v1.0.1", "1.0.0"), 1);
  assert.equal(compareVersions("v2.0.0", "1.9.9"), 1);
});
test("compareVersions: older tag loses to the running version", () => {
  assert.equal(compareVersions("v0.9.0", "1.0.0"), -1);
  assert.equal(compareVersions("v1.0.0", "1.0.1"), -1);
});
test("compareVersions: malformed tag (non-numeric, too few/many segments, empty) returns null, not a guess", () => {
  assert.equal(compareVersions("not-a-version", "1.0.0"), null);
  assert.equal(compareVersions("v1.2", "1.0.0"), null);
  assert.equal(compareVersions("v1.2.3.4", "1.0.0"), null);
  assert.equal(compareVersions("", "1.0.0"), null);
  assert.equal(compareVersions(null, "1.0.0"), null);
});
test("compareVersions: malformed current version also returns null, even with a well-formed tag", () => {
  assert.equal(compareVersions("v1.0.0", "abc"), null);
});

// ── in-app updater: arm64-zip asset picker ──────────────────────────────────
test("pickUpdateAsset: picks the arm64 .zip among a dmg + zip release", () => {
  const assets = [
    { name: "Meeting Recorder-1.0.0-arm64.dmg", browser_download_url: "https://x/dmg" },
    { name: "Meeting Recorder-1.0.0-arm64.zip", browser_download_url: "https://x/zip" },
  ];
  assert.equal(pickUpdateAsset(assets), "https://x/zip");
});
test("pickUpdateAsset: is case-insensitive on both 'arm64' and the .zip extension", () => {
  const assets = [{ name: "Meeting-Recorder-ARM64.ZIP", browser_download_url: "https://x/zip" }];
  assert.equal(pickUpdateAsset(assets), "https://x/zip");
});
test("pickUpdateAsset: missing arm64 asset (dmg-only release) returns null", () => {
  const assets = [{ name: "Meeting Recorder-1.0.0-arm64.dmg", browser_download_url: "https://x/dmg" }];
  assert.equal(pickUpdateAsset(assets), null);
});
test("pickUpdateAsset: empty assets array returns null", () => {
  assert.equal(pickUpdateAsset([]), null);
});
test("pickUpdateAsset: non-array input returns null (defensive, never throws)", () => {
  assert.equal(pickUpdateAsset(null), null);
  assert.equal(pickUpdateAsset(undefined), null);
});

// ── trashEntryBreakdown (list-trash's per-entry audio/note byte+count split) ────────
test("trashEntryBreakdown: sums audio bytes and note bytes/count separately for stat-confirmed files", () => {
  const stats = { "/out/.trash/a.md": { size: 100 }, "/out/.trash/b.wav": { size: 200 } };
  const statSync = (f) => { if (!stats[f]) throw new Error("ENOENT"); return stats[f]; };
  const result = trashEntryBreakdown(["/out/.trash/a.md", "/out/.trash/b.wav"], { statSync });
  assert.deepEqual(result, { audioBytes: 200, noteBytes: 100, noteCount: 1, bytes: 300 });
});
test("trashEntryBreakdown: a missing (statSync-throwing) file contributes NOTHING — not bytes, not noteCount", () => {
  const stats = { "/out/.trash/a.md": { size: 100 } };
  const statSync = (f) => { if (!stats[f]) throw new Error("ENOENT"); return stats[f]; };
  const result = trashEntryBreakdown(["/out/.trash/a.md", "/out/.trash/gone.md"], { statSync });
  assert.deepEqual(result, { audioBytes: 0, noteBytes: 100, noteCount: 1, bytes: 100 });
});
test("trashEntryBreakdown: empty/non-array files → all zeros, never throws", () => {
  assert.deepEqual(trashEntryBreakdown([], {}), { audioBytes: 0, noteBytes: 0, noteCount: 0, bytes: 0 });
  assert.deepEqual(trashEntryBreakdown(undefined, {}), { audioBytes: 0, noteBytes: 0, noteCount: 0, bytes: 0 });
});
