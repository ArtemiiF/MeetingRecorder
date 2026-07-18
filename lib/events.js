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

const CONTRACT_PATH = path.join(__dirname, "..", "events.json");
const EVENT_NAMES = JSON.parse(fs.readFileSync(CONTRACT_PATH, "utf-8")).events;

// "classified-terms" -> "CLASSIFIED_TERMS", "search_result" -> "SEARCH_RESULT" — a
// deterministic transform mirrored by tests/test_backend.py's cross-lock test (it
// rebuilds the same mapping from events.json directly, without requiring this file,
// so the lock holds even though one side is Python and can't require() a JS module).
const EVENTS = Object.fromEntries(
  EVENT_NAMES.map((name) => [name.toUpperCase().replace(/-/g, "_"), name])
);

module.exports = { EVENT_NAMES, EVENTS };
