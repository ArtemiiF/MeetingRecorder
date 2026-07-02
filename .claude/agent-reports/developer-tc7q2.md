# Transcript correction stage — implementation report

Branch: feat/transcript-correction (no commit/push made, per instructions).

## Files changed
- backend.py (+301)
- renderer/renderer.js (+1/-1, STAGE_LABELS)
- tests/test_backend.py (+216, new tests)
- tests/renderer.test.js (+10, one new test)

## Design decisions
- fuzzy threshold: <=1 edit-distance for terms <=5 chars, <=2 for longer (backend.py `_fuzzy_threshold`).
- Morphology rule: a token that is the term or the term + a short (<=3 char) Cyrillic suffix is
  treated as an already-correct declined form and left untouched (`_term_or_declined_form`).
  A token that is BOTH misrecognized AND declined (e.g. "Онтона") is conservatively left as-is
  in Stage 1 (v1 rule, documented in test names, e.g.
  test_fuzzy_correct_garbled_and_declined_token_conservatively_left_untouched_v1) since Stage 1
  only compares whole-token distance, no stem/suffix splitting.
- gate_llm_correction: rejects whole chunk on >20% char-length delta, or on
  `changed_tokens > max(2, 0.3*len(orig_tokens))` (floor of 2 so one legitimate term fix in a
  short chunk/segment never trips a purely-percentage wild-divergence check). Otherwise walks
  difflib token opcodes; accepts only equal-length 'replace' spans where the new token is a term
  (or short declined form) AND the old token is fuzzy-close to that same term (lenient=True,
  tries the term-length prefix too, so garbled+declined old tokens still validate). Insertions/
  deletions/unequal-length replaces are rejected outright. Output token count always == input.
- Cache: SEPARATE cache file `correct-<lang><glossary-suffix>.json`, not folded into transcribe's
  cache. Mirrors the diarize stage's own-stage/own-cache pattern (reads the previous stage's
  already-loaded segments) rather than entangling two stages' logging inside transcribe()'s
  cache-hit/cache-miss branches.
- Chunking: NOT via `_rag_chunk_text` (it `.strip()`s each slice, which can silently drop
  boundary whitespace and corrupt reassembly). Chunk boundaries are built from consecutive
  *segments* (never mid-word) up to ~_RAG_CHUNK_CHARS (2000, reused from the RAG constant).
  gate_llm_correction's token-count-preservation lets each chunk's corrected words be
  redistributed back onto the original per-segment boundaries by word count.

## Test tails (initial implementation)
JS: 82/82 (baseline 81 + 1 new stage-label test)
PY: 140/140 (baseline 117 + 23 new tests)

## Round 2 — CI network regression (from coordinator report)
`test_glossary_change_busts_transcribe_cache`'s second `process()` run used a non-empty
glossary and never mocked `correct_glossary_llm`, so it hit real localhost:1234 (24s in CI).
Fix: `tests/test_backend.py` — added `monkeypatch.setattr(p, "correct_glossary_llm", ...)`
inside that test's `mk()` helper. Swept every other `.process(`/`glossary=` call site — all
others use an empty/default glossary (stage skipped, no network) or mock `Pipeline.process`
wholesale. PY suite back to 0.34s, 140/140.

## Round 3 — critic fix-blockers-first review
- BLOCKER 1 (backend.py `_fuzzy_threshold`): terms ≤3 chars now require an EXACT (post-translit)
  match (threshold 0) instead of ±1 — fixes "Дан" misfiring on "дам". 4-5 chars keep ±1 (needed
  to keep "Онтон"→"Антон" working). Deviation from the critic's suggested "also require first
  letter to match" sub-rule for the 4-5 bucket: implemented and checked against "Онтон"/"Антон"
  — о/а differ even transliterated, so it would have broken the mandated happy path. Documented
  the trade-off inline in `_fuzzy_threshold`'s docstring instead of applying it.
- BLOCKER 2 (backend.py `_term_specs`, rewritten `_fuzzy_correct_text`, rewritten
  `gate_llm_correction`): multi-word terms ("Иван Петров") now match via an n-gram sliding
  window (longest term's word-count first, stable-sorted so ties keep glossary order) in BOTH
  stages. `_closest_term`/`_term_or_declined_form` already operated on arbitrary strings, so
  joining a multi-token window and passing it through unchanged was enough — no duplicate
  distance logic needed.
- MAJOR (backend.py `_RU_DECLENSION_SUFFIXES`, `_term_or_declined_form`): replaced the "any
  ≤3-char suffix" rule with a closed whitelist of actual Russian case endings. Deviation from
  the critic's example list: excluded "-ов"/"-ев" (listed as an example by the critic) because
  including them would make "Антонов" (the exact case the critic wants REJECTED) pass as a
  declined "Антон" — those are surname/possessive-forming suffixes, not case endings for this
  word. Verified against both required outcomes: "Антона" accepted, "Антонов" rejected.
- MINOR: `_transplant_punctuation` — gate now always keeps the ORIGINAL token's lead/trail
  punctuation, swapping only the punctuation-stripped core; `_CORRECT_CHUNK_CHARS = 2000` is now
  its own constant (was borrowing `_RAG_CHUNK_CHARS`); `_segments_text_hash` + `input_hash` field
  in the correct-cache detects staleness when transcribe's cache was busted/recomputed with
  different segments but the correct-cache file survived untouched — mismatch forces a recompute.
- 14 new tests added (all adversarial per the critic's asks), no regressions in the 154 baseline.

## Test tails (final)
JS: 82/82
PY: 154/154, 0.25s (sub-second, no network I/O)
