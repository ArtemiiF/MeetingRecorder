// Single source of truth for backend.py's stdout event-name protocol (M4 arch-audit).
// Reads the shared events.json contract (repo root) — backend.py's own EVENT_NAMES
// frozenset loads the SAME file, so main.js's dispatch (EVENTS.X below) and
// backend.py's emit() (which asserts every event it sends against that frozenset)
// can never silently drift apart: a typo/rename on either side either fails
// backend.py's own assertion at runtime, or is caught by tests/test_backend.py's
// cross-lock test (which scans main.js's source for EVENTS.* usage and confirms
// each one resolves to a name actually present in this same events.json).
const fs = require("fs");
const path = require("path");

// Packaged builds: electron-builder silently omits a root-level file from app.asar
// when the same file is also listed in extraResources (v1.4.5 shipped without
// /events.json in the asar → ENOENT at require time, app crashed on launch).
// The extraResources copy (needed by backend.py, which lives in Resources/) is
// therefore the fallback source when the asar-relative path is absent.
const CONTRACT_CANDIDATES = [
  path.join(__dirname, "..", "events.json"), // dev checkout / asar root
  process.resourcesPath ? path.join(process.resourcesPath, "events.json") : null, // packaged extraResources
].filter(Boolean);
const CONTRACT_PATH =
  CONTRACT_CANDIDATES.find((p) => fs.existsSync(p)) || CONTRACT_CANDIDATES[0];
const EVENT_NAMES = JSON.parse(fs.readFileSync(CONTRACT_PATH, "utf-8")).events;

// "classified-terms" -> "CLASSIFIED_TERMS", "search_result" -> "SEARCH_RESULT" — a
// deterministic transform mirrored by tests/test_backend.py's cross-lock test (it
// rebuilds the same mapping from events.json directly, without requiring this file,
// so the lock holds even though one side is Python and can't require() a JS module).
const EVENTS = Object.fromEntries(
  EVENT_NAMES.map((name) => [name.toUpperCase().replace(/-/g, "_"), name])
);

module.exports = { EVENT_NAMES, EVENTS };
