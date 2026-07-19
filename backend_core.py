"""Pure-logic core of backend.py — no fs, no network, no subprocess, no sqlite,
no emit/log. Every function here is a deterministic transformation of its
arguments; nothing reads global/instance state or produces a side effect.
Sibling of backend.py in BOTH dev and packaged layouts (see package.json's
build.extraResources) — backend.py does `from backend_core import ...`.

This is the Python analogue of lib/mainutil.js on the JS side: pure helpers
with side effects injected via parameters rather than read from ambient state,
kept unit-testable under a bare `pytest` with no heavy mocks (see
tests/test_backend_core.py). Extracted verbatim (MOVE, not rewrite) from
backend.py — see CLAUDE.md's TDD convention and the #32 architecture audit
that identified these functions as pure.
"""

# ──────────────────────────────────────────────────────────────────────────
# Glossary-based transcript correction — pure helpers (no I/O, unit-testable).
# Two stages compose around these: a deterministic fuzzy pass (fuzzy_correct)
# and an LLM pass whose reply is validated token-by-token before acceptance
# (gate_llm_correction). The I/O side (LM Studio call, chunking) lives on
# Pipeline.correct_glossary_llm (backend.py).
# ──────────────────────────────────────────────────────────────────────────
_PUNCT_CHARS = ".,!?;:\"'«»()[]{}—–-…"

# correct_glossary_llm's request budget scales with what we actually send —
# a fixed max_tokens=4000/timeout=120 measured wrong on a real reasoning model
# (gemma-4-26b via LM Studio): a 1712-char chunk hit finish_reason=length at
# completion=3999 tokens, of which reasoning ALONE consumed 3997 — only ~2
# tokens were left for actual content — over 157.2s wall. So 4000 was already
# at (not above) the reasoning floor for this model; it must not be reduced.
# Request wall-time is bounded by max_tokens/generation-rate, not input size,
# so a fixed timeout reads a slow-but-working model as "LLM недоступен".
# Reasoning budget is kept at the measured floor of 4000 (matches
# k2-lmstudio-reasoning-tokens's ≥1500-2500 "thinking room" guidance, but
# clamped to the actually-measured floor rather than below it) with the
# chars/3 term added ON TOP of that floor for visible content — chars/3
# mirrors the ceil(chars/3) token heuristic of backend.py's _estimate_tokens. Timeout floor of 30s covers
# prefill+network; the 15 tok/s rate is a conservative floor under the ~25
# tok/s measured on the same model, so the computed timeout has headroom
# instead of hugging the measured wall-time.
_CORRECT_REASONING_BUDGET = 4000
_LLM_TIMEOUT_BASE = 30
_LLM_RATE_MIN_TPS = 15


def _llm_correct_budget(chunk_len):
    """Pure helper: (max_tokens, timeout_seconds) for a correct_glossary_llm
    request over a chunk of `chunk_len` characters. max_tokens scales with
    chunk size (chars/3, ceil); timeout scales transitively with max_tokens
    via the conservative min generation rate — so a bigger ask always gets a
    longer clock, instead of a request racing a clock sized for something
    else entirely."""
    max_tokens = _CORRECT_REASONING_BUDGET + -(-chunk_len // 3)  # ceil(chunk_len/3)
    timeout = _LLM_TIMEOUT_BASE + max_tokens / _LLM_RATE_MIN_TPS
    return max_tokens, timeout


# Best-effort Cyrillic→Latin transliteration so a slangy phonetic spelling of an
# anglicism (e.g. "слэк") lands close to its Latin glossary term ("Slack") under
# Levenshtein distance. э→'a' (not the phonetically stricter 'e') because that is
# the letter Russian informally reaches for to render a foreign short-a sound in
# loanwords ("слэк", "рэп", "трэк") — tuned for this use case, not IPA-accurate.
_RU_TO_LATIN = {
    "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "e",
    "ж": "zh", "з": "z", "и": "i", "й": "i", "к": "k", "л": "l", "м": "m",
    "н": "n", "о": "o", "п": "p", "р": "r", "с": "s", "т": "t", "у": "u",
    "ф": "f", "х": "h", "ц": "ts", "ч": "ch", "ш": "sh", "щ": "sch",
    "ъ": "", "ы": "y", "ь": "", "э": "a", "ю": "yu", "я": "ya",
}


def _translit(word):
    """Cyrillic→Latin via _RU_TO_LATIN; non-Cyrillic characters pass through
    unchanged, so comparing two Latin words is a no-op transliteration."""
    return "".join(_RU_TO_LATIN.get(ch, ch) for ch in word.lower())


def _levenshtein(a, b):
    """Edit distance (insert/delete/substitute). O(len(a)*len(b)), stdlib-only —
    no extra dependency for comparing a handful of short tokens per call."""
    if a == b:
        return 0
    if not a:
        return len(b)
    if not b:
        return len(a)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i] + [0] * len(b)
        for j, cb in enumerate(b, 1):
            cost = 0 if ca == cb else 1
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
        prev = cur
    return prev[-1]


def _fuzzy_threshold(term):
    # Short terms are risky for distance-based fuzzy matching: plenty of unrelated
    # same-length real words sit at Levenshtein distance 1 (term "Дан" vs the common
    # word "дам" differs by one letter and would otherwise misfire). Terms ≤3 chars
    # get NO fuzz budget — only an exact (post-translit) match. 4-5 chars keep a ±1
    # budget (this is what makes "Онтон"→"Антон" recoverable); 6+ chars get ±2.
    # (A same-length first-letter-match constraint was tried for the 4-5 bucket to
    # tighten it further, but it also rejects "Онтон"→"Антон" — о/а differ even
    # transliterated — so it's dropped; see the developer report for this trade-off.)
    n = len(term)
    if n <= 3:
        return 0
    return 1 if n <= 5 else 2


# Closed whitelist of Russian case-ending suffixes accepted as a "declined form" of
# a glossary term (e.g. "Антон"+"а"→"Антона"). Deliberately closed and name-biased
# (glossary terms are typically people/tool names) rather than "any short suffix":
# an open-ended ≤3-char rule let LLM output like "Антонов" (a DIFFERENT name/surname,
# formed with the possessive/patronymic suffix "-ов") get accepted as a declined
# "Антон", which is wrong — "-ов"/"-ев" deliberately excluded for that reason.
_RU_DECLENSION_SUFFIXES = (
    "а", "я", "у", "ю", "е", "ы", "и", "о",
    "ом", "ем", "ой", "ей", "ым", "им",
    "ах", "ях", "ами", "ями", "ими",
)


def _term_or_declined_form(token, terms):
    """Return the glossary term `token` already IS — exact match, or that term
    plus a whitelisted Russian case-ending suffix (_RU_DECLENSION_SUFFIXES:
    "Антон" → "Антона"/"Антону"/"Антоном"/...). A hit means the token is already
    correctly spelled; callers must NOT touch it. This is the guard that keeps
    fuzzy_correct from flattening a correctly declined name to its nominative
    form. The whitelist (rather than "any ≤3-char suffix") is what keeps
    "Антонов" (a different word) from being accepted as a declined "Антон"."""
    low = token.strip(_PUNCT_CHARS).lower()
    if not low:
        return None
    for term in terms:
        term = (term or "").strip()
        if not term:
            continue
        lt = term.lower()
        if low == lt or (low.startswith(lt) and low[len(lt):] in _RU_DECLENSION_SUFFIXES):
            return term
    return None


def _closest_term(token, terms, lenient=False):
    """Return the glossary term `token` fuzzy-matches (transliteration-aware
    Levenshtein within _fuzzy_threshold), or None. `token` may be a single word
    or a space-joined multi-word window (for multi-word terms like "Иван
    Петров") — Levenshtein and _translit operate on the whole string either way,
    so no special-casing is needed for the multi-word case.

    With lenient=True also tries the term-length PREFIX of a token that is up
    to 3 chars longer than the term — tolerates an old token that is BOTH
    misrecognized AND declined (e.g. garbled "Онтона" still resolving to
    "Антон"). Stage-1's raw fuzzy pass keeps lenient=False: a correctly-declined
    word must be caught by _term_or_declined_form first, never guessed at here
    — v1 is conservative about garbled+declined tokens and leaves them
    untouched rather than risk corrupting a declension it can't confidently
    split (see fuzzy_correct)."""
    core = token.strip(_PUNCT_CHARS).lower()
    if not core:
        return None
    for term in terms:
        term = (term or "").strip()
        if not term:
            continue
        lt = term.lower()
        threshold = _fuzzy_threshold(term)
        candidates = [core]
        if lenient and len(core) > len(lt) and len(core) - len(lt) <= 3:
            candidates.append(core[:len(lt)])
        if any(_levenshtein(_translit(c), _translit(lt)) <= threshold for c in candidates):
            return term
    return None


def _term_specs(terms):
    """Dedupe/normalize `terms` into [(term, word_count), ...] sorted by word
    count DESCENDING (stable sort — ties keep glossary order). Longest-first so
    a multi-word term ("Иван Петров") is tried before a shorter single-word
    match at the same position — shared by fuzzy_correct and gate_llm_correction
    so both apply n-gram matching identically."""
    seen, specs = set(), []
    for t in terms:
        t = (t or "").strip()
        if t and t not in seen:
            seen.add(t)
            specs.append((t, len(t.split())))
    specs.sort(key=lambda ts: -ts[1])
    return specs


def _segments_text_hash(segments):
    """Short hash of segment texts, in order. Used to detect a stale
    correct-<lang><suffix>.json cache entry: that cache file's freshness key is
    language+glossary, same as transcribe's, but the two are independent files
    — if transcribe's own cache is busted/corrupted and recomputes with DIFFERENT
    segments while this stage's cache file happens to survive untouched, loading
    it would silently serve corrected text for the WRONG (old) transcript. The
    caller stores this hash of the pre-correction segments alongside the cached
    result and revalidates it on load; a mismatch forces a recompute."""
    import hashlib
    joined = "\x1f".join((s.get("text") or "") for s in segments)
    return hashlib.sha1(joined.encode("utf-8")).hexdigest()[:12]


def _fuzzy_correct_text(text, terms):
    if not terms or not text:
        return text, []
    specs = _term_specs(terms)
    if not specs:
        return text, []
    tokens = text.split()
    replacements = []
    out_tokens = []
    i, n = 0, len(tokens)
    while i < n:
        window_term, window_wc, skip = None, 0, False
        for term, wc in specs:
            if i + wc > n:
                continue
            window = tokens[i:i + wc]
            cores = [tok.strip(_PUNCT_CHARS) for tok in window]
            if not all(cores):
                continue
            joined = " ".join(cores)
            if _term_or_declined_form(joined, [term]) is not None:
                skip, window_wc = True, wc
                break
            if _closest_term(joined, [term], lenient=False):
                window_term, window_wc = term, wc
                break
        if skip:
            out_tokens.extend(tokens[i:i + window_wc])
            i += window_wc
            continue
        if window_term:
            window = tokens[i:i + window_wc]
            old_cores = [tok.strip(_PUNCT_CHARS) for tok in window]
            lead = window[0][:len(window[0]) - len(window[0].lstrip(_PUNCT_CHARS))]
            trail = window[-1][len(window[-1].rstrip(_PUNCT_CHARS)):]
            new_words = window_term.split()
            new_words[0] = lead + new_words[0]
            new_words[-1] = new_words[-1] + trail
            out_tokens.extend(new_words)
            replacements.append({"from": " ".join(old_cores), "to": window_term})
            i += window_wc
            continue
        out_tokens.append(tokens[i])
        i += 1
    return " ".join(out_tokens), replacements


def fuzzy_correct(text_or_segments, terms):
    """Stage 1 of glossary correction: deterministic, no LLM. Replace a token
    (or, for a multi-word term like "Иван Петров", a matching run of consecutive
    tokens — see _term_specs) with a glossary term when it is a close
    misrecognition (Levenshtein within _fuzzy_threshold, on transliterated
    lowercase forms) of that term — UNLESS the token/run is already the term or
    a declined form of it (_term_or_declined_form): a correctly declined
    "Антона" is left exactly as-is, never flattened to "Антон". A token that is
    BOTH misrecognized AND declined (e.g. "Онтона") is conservatively left
    untouched in v1 rather than guessed at — see _closest_term's docstring.

    Accepts either a plain string or a list of Whisper segments (dicts with a
    "text" key); returns the same shape. `terms` empty/falsy → no-op
    passthrough (byte-identical), so a caller can skip this stage cheaply when
    there is no glossary. Returns (corrected, replacements) where replacements
    is an ordered list of {"from": token(s), "to": term}, for logging/counting."""
    if isinstance(text_or_segments, list):
        replacements = []
        out = []
        for seg in text_or_segments:
            new_seg = dict(seg)
            corrected, reps = _fuzzy_correct_text(seg.get("text", ""), terms)
            new_seg["text"] = corrected
            replacements.extend(reps)
            out.append(new_seg)
        return out, replacements
    return _fuzzy_correct_text(text_or_segments or "", terms)


def _transplant_punctuation(old_tok, new_tok):
    """Keep `old_tok`'s leading/trailing punctuation, swap only the core word
    for `new_tok`'s (punctuation-stripped) core. Used by gate_llm_correction so
    an LLM's own punctuation choice ("слэк." → "Slack!") never leaks into the
    transcript — only the ORIGINAL token's punctuation survives."""
    old_core = old_tok.strip(_PUNCT_CHARS)
    lead = old_tok[:len(old_tok) - len(old_tok.lstrip(_PUNCT_CHARS))]
    trail = old_tok[len(old_tok.rstrip(_PUNCT_CHARS)):] if old_core else ""
    return lead + new_tok.strip(_PUNCT_CHARS) + trail


def gate_llm_correction(original, corrected, terms):
    """Stage 2 safety gate. `corrected` is an LLM's attempt to fix glossary
    terms in `original`; this validates it token-by-token (and, for multi-word
    terms, n-gram-by-n-gram — see _term_specs) and returns a string built from
    `original` with ONLY the validated swaps applied — anything the LLM
    invented, reworded, or restructured is discarded and the original wins.
    Punctuation always comes from the ORIGINAL token (_transplant_punctuation),
    never from the LLM's reply.

    Rejects the WHOLE chunk (returns `original` unchanged) when:
      - character-length delta vs `original` exceeds ~20% (cheap early-out), or
      - more than ~30% of original tokens differ from `corrected` (a wholesale
        rewrite, not a targeted term fix) — with a floor of 2 tokens so a
        single legitimate term fix in a short chunk/segment never trips this
        purely on percentage (1 changed word in a 3-word sentence is 33%, but
        it's still just one term fix, not a rewrite).
    Otherwise, walks the token-level diff (difflib); within each equal-length
    'replace' opcode, slides a window (longest term's word-count first, same
    strategy as fuzzy_correct) and accepts a swap ONLY when the new window is a
    glossary term or a whitelisted declined form of one
    (_term_or_declined_form) AND the old window it replaces was a plausible
    misrecognition of that SAME term (_closest_term, lenient=True so a
    garbled+declined old token like "Онтона" still counts). Insertions,
    deletions, and unequal-length replace spans are rejected outright — they
    change structure, which a term correction never should.

    Guarantees output token COUNT == input token count (every kept-or-swapped
    position comes 1:1 from `original`), which is what lets a caller redistribute
    an accepted chunk's words back onto the original per-segment boundaries."""
    if not terms or not (original or "").strip():
        return original
    orig_tokens = original.split()
    corr_tokens = (corrected or "").split()
    if not orig_tokens:
        return original
    len_delta = abs(len(corrected or "") - len(original)) / max(1, len(original))
    if len_delta > 0.2:
        return original
    import difflib
    opcodes = difflib.SequenceMatcher(None, orig_tokens, corr_tokens, autojunk=False).get_opcodes()
    changed = sum((i2 - i1) for tag, i1, i2, j1, j2 in opcodes if tag != "equal")
    if changed > max(2, 0.3 * len(orig_tokens)):
        return original
    specs = _term_specs(terms)
    word_counts = sorted({wc for _, wc in specs}, reverse=True)
    out = list(orig_tokens)
    for tag, i1, i2, j1, j2 in opcodes:
        if tag != "replace" or (i2 - i1) != (j2 - j1):
            continue
        span = i2 - i1
        k = 0
        while k < span:
            applied = False
            for wc in word_counts:
                if k + wc > span:
                    continue
                new_window = corr_tokens[j1 + k:j1 + k + wc]
                new_joined = " ".join(tok.strip(_PUNCT_CHARS) for tok in new_window)
                term = _term_or_declined_form(new_joined, terms)
                if not term:
                    continue
                old_window = orig_tokens[i1 + k:i1 + k + wc]
                old_joined = " ".join(tok.strip(_PUNCT_CHARS) for tok in old_window)
                if _closest_term(old_joined, terms, lenient=True) != term:
                    continue
                for p in range(wc):
                    out[i1 + k + p] = _transplant_punctuation(old_window[p], new_window[p])
                applied = True
                k += wc
                break
            if not applied:
                k += 1
    return " ".join(out)


def _diff_term_hits(orig_tokens, new_tokens, terms):
    """Attribute an already-accepted orig→new token swap (e.g. gate_llm_correction's
    output vs. its input, same length by construction) to the specific glossary term
    each changed window resolves to — mirrors fuzzy_correct's own {"from","to"}
    replacement format, but for Stage 2 (LLM) hits, so both stages' fires can be
    merged into one per-term usage count (see Pipeline.process's `correct` stage).

    Walks longest-term-first (same strategy as fuzzy_correct/gate_llm_correction) and
    only trusts a window that _term_or_declined_form confirms — every differing window
    here already passed gate_llm_correction's own validation, so this never guesses at
    a NEW match, it just re-identifies which term an already-accepted swap belongs to.
    A window that (surprisingly) doesn't resolve to any term is skipped rather than
    guessed at; length mismatch (should not happen — callers pass same-length token
    lists) degrades to no hits rather than raising."""
    if not terms or len(orig_tokens) != len(new_tokens):
        return []
    specs = _term_specs(terms)
    word_counts = sorted({wc for _, wc in specs}, reverse=True)
    hits = []
    n = len(orig_tokens)
    i = 0
    while i < n:
        if orig_tokens[i] == new_tokens[i]:
            i += 1
            continue
        matched = False
        for wc in word_counts:
            if i + wc > n:
                continue
            window = new_tokens[i:i + wc]
            joined = " ".join(tok.strip(_PUNCT_CHARS) for tok in window)
            term = _term_or_declined_form(joined, terms)
            if not term:
                continue
            old_window = orig_tokens[i:i + wc]
            hits.append({"from": " ".join(t.strip(_PUNCT_CHARS) for t in old_window), "to": term})
            i += wc
            matched = True
            break
        if not matched:
            i += 1
    return hits


# ──────────────────────────────────────────────────────────────────────────
# Recording-identity stamp parsing (audio-inventory feature).
# ──────────────────────────────────────────────────────────────────────────
_NOTE_LANGS = {"en", "auto"}


def _base_stamp(stem):
    """Canonical recording identity: strip a reprocess `-r<seq>` revision suffix (Pipeline.
    process's versioning), then a language suffix (_NOTE_LANGS), recovering the stem the
    physical audio was actually saved under. Every language variant and every reprocess
    version of one recording collapses to the same base_stamp. Prefix-agnostic — the regexes
    only anchor on the trailing end, so `stem` may still carry a leading "meeting-" (as
    _find_audio feeds it, matching on-disk filenames) or not (as cmd_history's prefix-free
    `stamp`/audio-inventory stems feed it) with identical stripping behaviour."""
    import re
    rev_m = re.match(r"^(.*)-r\d+$", stem)
    if rev_m:
        stem = rev_m.group(1)
    m = re.match(r"^(.*)-([a-z]{2,4})$", stem)
    return m.group(1) if (m and m.group(2) in _NOTE_LANGS) else stem


# ──────────────────────────────────────────────────────────────────────────
# auto-«Я»: which diarized speaker is the recording author — pure scoring
# helpers. Orchestration (file I/O, logging) stays on Pipeline.detect_author_speaker
# (backend.py); everything below is a deterministic function of arrays/dicts.
# ──────────────────────────────────────────────────────────────────────────

def _normalized_xcorr_peak(a, b, max_lag):
    """Pure numpy/scipy: find the integer sample lag that best aligns `b` to `a` via
    FFT cross-correlation, restricted to |lag| <= max_lag.
    lag > 0  → `b` started later (its content matches `a` shifted back by `lag` samples)
    lag < 0  → `a` started later
    lag == 0 → already aligned (or nothing could be resolved)
    Returns (lag, confidence). confidence = corr[peak] / (||a|| * ||b||), a
    cosine-similarity-like score (global normalization, not per-lag — a known
    conservative approximation, weaker near the edges of the search window).
    All-zero / empty / degenerate input never raises — returns (0, 0.0)."""
    import numpy as np
    from scipy.signal import correlate

    a = np.asarray(a, dtype=np.float64)
    b = np.asarray(b, dtype=np.float64)
    if a.size == 0 or b.size == 0:
        return 0, 0.0
    norm = float(np.linalg.norm(a) * np.linalg.norm(b))
    if norm == 0.0:
        return 0, 0.0

    corr = correlate(a, b, mode="full", method="fft")
    lags = np.arange(-(len(b) - 1), len(a))
    mask = np.abs(lags) <= max_lag
    if not np.any(mask):
        return 0, 0.0
    corr_r, lags_r = corr[mask], lags[mask]
    peak_idx = int(np.argmax(corr_r))
    lag = int(lags_r[peak_idx])
    confidence = float(corr_r[peak_idx] / norm)
    return lag, confidence


# Thresholds for auto-«Я» author-speaker detection below (§ pick_author_label).
# HYPO defaults, not calibrated against real recordings — same documented status as
# _XCORR_MIN_CONFIDENCE (backend.py). Every run (including no-ops) logs the computed
# mic_share/mic_level/mic_ratio so real data exists to tune these later (see
# Pipeline.detect_author_speaker).
#
# Scored by mic_share (this label's fraction of TOTAL mic-track energy), NOT the old
# mic/system ratio: on real conferencing audio the system track ALSO carries the
# author's own voice (call echo/mix), so the author's mic/system ratio caps out well
# below any sane "dominant" cutoff — observed ~0.46 on a real 2-track recording
# (headphones, recording 7ic8) — even though the author is the ONLY one present on
# the mic track at all (everyone else's mic_rms ~0, they're not wearing this mic).
# mic_share sidesteps that: it never looks at the system track, only asks "of all the
# energy that hit THIS mic, how much happened during this label's segments" — the
# author alone on mic approaches 1.0, everyone else ~0 (7ic8 observation, see report).
#
# _AUTHOR_MIN_MIC_SHARE / _AUTHOR_MIN_MARGIN set from the actual 7ic8 run (6 diarized
# labels, real mic/system WAVs): author SPEAKER_04 mic_share=0.53, runner-up
# SPEAKER_00 mic_share=0.34 (margin 0.19), everyone else 0.01-0.06. 0.5 left only a
# 0.03 clearance over the observed author value — brittle, a slightly quieter mic
# take would miss it. 0.40 gives 0.13 clearance instead, while _AUTHOR_MIN_MARGIN
# (0.15, just under the observed 0.19 margin) still rejects ambiguous cases — a
# runner-up would have to close to within 0.15 of the top share to block a decision.
_AUTHOR_MIN_MIC_SHARE = 0.40  # top label's share of total mic energy (multi-speaker path)
_AUTHOR_MIN_MARGIN = 0.15     # top vs runner-up margin, now measured on mic_share
_AUTHOR_MIN_DURATION_S = 3.0  # top label must have at least this much speech
_AUTHOR_MIN_MIC_RMS = 50.0    # single-speaker path: absolute mic-activity floor, in the
                              # RAW RMS scale _track_rms/_read_mono_decimated actually
                              # return (native PCM units, e.g. int16 -32768..32767 — NOT
                              # normalized to [-1,1]). Guards a silent-mic solo recording
                              # (e.g. user only watched something on the system track)
                              # from being labeled author just because a lone label
                              # trivially "shares" 100% of ~zero mic energy.
                              # UNCALIBRATED against any real silent-mic/ambient-mic
                              # recording (no such sample available yet) — 50.0 is a
                              # guess, not measured. Known deferred risk: real room
                              # ambient noise picked up by an idle mic could plausibly
                              # clear this floor and falsely label a solo "just
                              # watching, not speaking" recording as authored. Left as
                              # a HYPO floor (not raised) rather than tuned blind —
                              # raising it without a real ambient sample risks instead
                              # rejecting a genuine soft-spoken solo author.


def _shift_chunks(chunks, delay_ms, rate, max_len):
    """Shift each {start,end} sample-index chunk by -delay_ms (in samples @ rate);
    clip to [0, max_len]; drop chunks that become empty. Pure, no I/O.

    Used to re-express VAD chunk boundaries — captured in the aligned mixed/mono
    timeline — back into a single raw track's own (unaligned) sample-index space,
    given that track's mix-time delay. `collect_chunks`-style concatenation of the
    *same* chunk list (shifted per-track) as was used to collapse `mono` reproduces
    mic/system arrays in mono's exact collapsed timebase (see detect_author_speaker)."""
    shift = int(round(delay_ms * rate / 1000))
    out = []
    for ch in chunks:
        start = max(0, min(ch["start"] - shift, max_len))
        end = max(0, min(ch["end"] - shift, max_len))
        if end > start:
            out.append({"start": start, "end": end})
    return out


def _track_rms(samples, start_s, end_s, rate):
    """RMS of samples[start_s*rate : end_s*rate]; 0.0 for an empty/out-of-range slice.
    Pure, no I/O."""
    import numpy as np
    i0 = max(0, int(round(start_s * rate)))
    i1 = max(0, int(round(end_s * rate)))
    if i1 <= i0 or i0 >= len(samples):
        return 0.0
    seg = samples[i0:i1]
    if seg.size == 0:
        return 0.0
    return float(np.sqrt(np.mean(np.square(seg))))


def compute_speaker_dominance(timeline, mic_collapsed, sys_collapsed, rate=16000):
    """Per raw diarization label, three scores:
    - mic_share: this label's fraction of TOTAL mic-track energy (sum of mic_rms*dur
      over the label's own segments, divided by that same sum over ALL segments in the
      timeline). Never looks at the system track — robust to the system track also
      carrying the author's voice (call echo/mix), which is what makes the ratio-based
      metric below fail on real conferencing audio.
    - mic_level: duration-weighted mean mic_rms during the label's segments (absolute
      mic loudness, not relative to anyone else) — used to gate the single-speaker case
      where mic_share is trivially 1.0.
    - mic_ratio: duration-weighted mean of mic_rms/(mic_rms+sys_rms) — the old metric,
      kept for calibration/back-compat logging only, no longer used to pick a winner.
    Plus total duration. A segment silent on both tracks contributes a neutral 0.5
    mic_ratio (no divide-by-zero) and zero energy (doesn't move mic_share) but still
    counts toward duration. Pure, no I/O.
    Returns {raw_label: {"mic_share": float, "mic_level": float, "mic_ratio": float,
    "duration_s": float}}."""
    raw = {}
    total_energy = 0.0
    for start, end, label in timeline:
        dur = end - start
        if dur <= 0:
            continue
        mic_rms = _track_rms(mic_collapsed, start, end, rate)
        sys_rms = _track_rms(sys_collapsed, start, end, rate)
        total = mic_rms + sys_rms
        ratio = 0.5 if total <= 0.0 else mic_rms / total
        energy = mic_rms * dur
        entry = raw.setdefault(label, {"mic_ratio": 0.0, "mic_level": 0.0, "duration_s": 0.0, "energy": 0.0})
        new_duration = entry["duration_s"] + dur
        entry["mic_ratio"] = (entry["mic_ratio"] * entry["duration_s"] + ratio * dur) / new_duration
        entry["mic_level"] = (entry["mic_level"] * entry["duration_s"] + mic_rms * dur) / new_duration
        entry["duration_s"] = new_duration
        entry["energy"] += energy
        total_energy += energy
    scores = {}
    for label, entry in raw.items():
        share = 0.0 if total_energy <= 0.0 else entry["energy"] / total_energy
        scores[label] = {"mic_share": share, "mic_level": entry["mic_level"],
                          "mic_ratio": entry["mic_ratio"], "duration_s": entry["duration_s"]}
    return scores


def pick_author_label(scores, min_mic_share=_AUTHOR_MIN_MIC_SHARE, min_margin=_AUTHOR_MIN_MARGIN,
                       min_duration_s=_AUTHOR_MIN_DURATION_S, min_mic_rms=_AUTHOR_MIN_MIC_RMS):
    """Winner-take-all over mic_share (this label's fraction of total mic-track energy).
    Multi-speaker (>=2 labels in scores): top scorer must clear min_mic_share, beat the
    runner-up by min_margin, and have >= min_duration_s of speech.
    Single-speaker (1 label in scores): mic_share is trivially 1.0 (nothing to share
    with) — share/margin gates would be meaningless, so instead require mic_level (the
    label's own absolute mic loudness) >= min_mic_rms, so a silent-mic solo recording
    (e.g. the user only watched something on the system track, mic never picked up
    anything) isn't mislabeled author just for being alone.
    Any failure -> None (ambiguous / no signal). Pure, no I/O — caller logs the
    outcome (see detect_author_speaker)."""
    if not scores:
        return None
    ranked = sorted(scores.items(), key=lambda kv: kv[1]["mic_share"], reverse=True)
    top_label, top = ranked[0]
    if top["duration_s"] < min_duration_s:
        return None
    if len(ranked) == 1:
        return top_label if top["mic_level"] >= min_mic_rms else None
    if top["mic_share"] < min_mic_share:
        return None
    if (top["mic_share"] - ranked[1][1]["mic_share"]) < min_margin:
        return None
    return top_label


# ──────────────────────────────────────────────────────────────────────────
# Misc pure helpers
# ──────────────────────────────────────────────────────────────────────────
def str2bool(v):
    return str(v).lower() in ("1", "true", "yes", "on")


# ──────────────────────────────────────────────────────────────────────────
# Pipeline methods that never touch `self` — moved verbatim (self param
# dropped) and re-bound in backend.py as staticmethod delegates so
# `pipe.combine(...)` / `pipe.add_timestamps(...)` keep working unmodified.
# ──────────────────────────────────────────────────────────────────────────
def combine(segments, timeline):
    """Returns (formatted, label_map) — label_map maps raw diarization labels
    (SPEAKER_00, ...) to their friendly first-seen-order names, exposed so
    detect_author_speaker can translate its raw-label winner into the same
    friendly label used in `formatted`/`speakers`."""
    if not timeline:
        return None, {}
    # friendly labels: SPEAKER_00 → "Спикер 1" in first-seen order (renameable in UI)
    label_map = {}

    def friendly(spk):
        if spk == "Unknown":
            return "Неизвестно"
        if spk not in label_map:
            label_map[spk] = f"Спикер {len(label_map) + 1}"
        return label_map[spk]

    result, current, buf = [], None, []
    for seg in segments:
        text = seg["text"].strip()
        if not text:
            continue
        spk, best = "Unknown", 0
        for ts, te, s in timeline:
            ov = max(0, min(seg["end"], te) - max(seg["start"], ts))
            if ov > best:
                best, spk = ov, s
        if spk != current:
            if buf:
                result.append(f"**[{friendly(current)}]**: {' '.join(buf)}")
            buf, current = [text], spk
        else:
            buf.append(text)
    if buf:
        result.append(f"**[{friendly(current)}]**: {' '.join(buf)}")
    return ("\n\n".join(result) if result else None), label_map


def add_timestamps(segments):
    out = []
    for seg in segments:
        start = int(seg["start"])
        out.append(f"[{start//60:02d}:{start%60:02d}] {seg['text'].strip()}")
    return "\n".join(out)
