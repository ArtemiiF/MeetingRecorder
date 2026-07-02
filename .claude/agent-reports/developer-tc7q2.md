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

## Test tails
JS: 82/82 (baseline 81 + 1 new stage-label test)
PY: 140/140 (baseline 117 + 23 new tests)
