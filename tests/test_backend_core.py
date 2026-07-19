"""Tests for backend_core.py — the pure-logic core moved out of backend.py.

No Pipeline, no fixtures, no mocked I/O boundaries: every function under test
here is a deterministic transformation of its arguments (see backend_core.py's
module docstring). Kept in its own file/module so this suite runs fast under a
bare `pytest tests/test_backend_core.py`, without backend.py's heavy-mock
autouse fixture (`_no_real_lmstudio_by_default`) or Pipeline construction —
this is what makes whole-suite-per-mutant mutation testing (mutmut) viable.
"""
import sys
from pathlib import Path

import pytest

# import backend_core.py from the app dir
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import backend_core  # noqa: E402
import backend  # noqa: E402  (only for the _XCORR_MIN_CONFIDENCE constant, still owned by backend.py)


def seg(text, start=0.0, end=5.0):
    return {"text": text, "start": start, "end": end}


# ── str2bool ────────────────────────────────────────────────────────────────
@pytest.mark.parametrize("v,exp", [
    ("true", True), ("True", True), ("1", True), ("yes", True), ("on", True),
    ("false", False), ("0", False), ("no", False), ("", False), ("nope", False),
])
def test_str2bool(v, exp):
    assert backend_core.str2bool(v) is exp


# ── combine (transcript + diarization timeline) ─────────────────────────────
def test_combine_groups_by_speaker_via_overlap():
    segments = [
        seg("привет", 0.0, 2.0),
        seg("как дела", 2.0, 4.0),
        seg("отлично", 4.0, 6.0),
    ]
    timeline = [(0.0, 4.0, "SPEAKER_00"), (4.0, 6.0, "SPEAKER_01")]
    out, label_map = backend_core.combine(segments, timeline)
    assert "**[Спикер 1]**: привет как дела" in out   # friendly relabel of SPEAKER_00
    assert "**[Спикер 2]**: отлично" in out
    assert out.count("**[Спикер ") == 2
    assert label_map == {"SPEAKER_00": "Спикер 1", "SPEAKER_01": "Спикер 2"}


def test_combine_empty_timeline_returns_none():
    assert backend_core.combine([seg("x")], []) == (None, {})


def test_combine_unknown_when_no_overlap():
    out, _label_map = backend_core.combine([seg("hi", 100.0, 101.0)], [(0.0, 5.0, "SPEAKER_00")])
    assert "**[Неизвестно]**: hi" == out


# ── add_timestamps ──────────────────────────────────────────────────────────
def test_add_timestamps_format():
    out = backend_core.add_timestamps([seg("первая", 0, 1), seg("вторая", 65, 70)])
    assert out == "[00:00] первая\n[01:05] вторая"


# ── _normalized_xcorr_peak (pure helper, synthetic arrays) ─────────────────────
def test_normalized_xcorr_peak_recovers_positive_shift():
    import numpy as np
    rng = np.random.default_rng(42)
    shared = rng.standard_normal(2000)
    shift = 137
    early, late = shared[:1500], shared[shift:shift + 1500]
    lag, conf = backend_core._normalized_xcorr_peak(early, late, max_lag=500)
    assert lag == shift
    assert conf > 0.5


def test_normalized_xcorr_peak_recovers_negative_shift():
    import numpy as np
    rng = np.random.default_rng(42)
    shared = rng.standard_normal(2000)
    shift = 137
    early, late = shared[:1500], shared[shift:shift + 1500]
    # swapping a/b flips the sign of the recovered lag
    lag, conf = backend_core._normalized_xcorr_peak(late, early, max_lag=500)
    assert lag == -shift
    assert conf > 0.5


def test_normalized_xcorr_peak_uncorrelated_below_threshold():
    import numpy as np
    rng = np.random.default_rng(7)
    a = rng.standard_normal(1500)
    b = rng.standard_normal(1500)
    _, conf = backend_core._normalized_xcorr_peak(a, b, max_lag=500)
    assert conf < backend._XCORR_MIN_CONFIDENCE


def test_normalized_xcorr_peak_all_zero_no_divide_by_zero():
    import numpy as np
    lag, conf = backend_core._normalized_xcorr_peak(np.zeros(500), np.zeros(500), max_lag=100)
    assert lag == 0 and conf == 0.0


def test_normalized_xcorr_peak_shift_beyond_max_lag_stays_bounded():
    import numpy as np
    rng = np.random.default_rng(3)
    shared = rng.standard_normal(3000)
    shift = 1000  # far outside max_lag below
    early, late = shared[:1500], shared[shift:shift + 1500]
    lag, _ = backend_core._normalized_xcorr_peak(early, late, max_lag=100)
    assert abs(lag) <= 100  # bounded to the search window, never crashes


# ── _shift_chunks (pure helper) ─────────────────────────────────────────────
def test_shift_chunks_mid_track_shift():
    chunks = [{"start": 1000, "end": 2000}]
    out = backend_core._shift_chunks(chunks, delay_ms=100, rate=1000, max_len=10000)
    assert out == [{"start": 900, "end": 1900}]


def test_shift_chunks_clips_past_start():
    chunks = [{"start": 50, "end": 150}]
    out = backend_core._shift_chunks(chunks, delay_ms=100, rate=1000, max_len=10000)
    assert out == [{"start": 0, "end": 50}]


def test_shift_chunks_clips_past_end():
    chunks = [{"start": 9000, "end": 9500}]
    out = backend_core._shift_chunks(chunks, delay_ms=-600, rate=1000, max_len=10000)
    assert out == [{"start": 9600, "end": 10000}]


def test_shift_chunks_fully_out_of_range_dropped():
    chunks = [{"start": 0, "end": 50}]
    out = backend_core._shift_chunks(chunks, delay_ms=1000, rate=1000, max_len=10000)
    assert out == []


# ── compute_speaker_dominance (pure helper) ─────────────────────────────────
def test_compute_speaker_dominance_single_label_gets_full_mic_share():
    import numpy as np
    rate = 1000
    mic = np.ones(5000) * 1.0
    sysd = np.zeros(5000)
    scores = backend_core.compute_speaker_dominance([(1.0, 3.0, "SPEAKER_00")], mic, sysd, rate=rate)
    assert scores["SPEAKER_00"]["mic_share"] == pytest.approx(1.0)
    assert scores["SPEAKER_00"]["mic_level"] == pytest.approx(1.0)
    assert scores["SPEAKER_00"]["mic_ratio"] > 0.99  # kept for calibration logging only
    assert scores["SPEAKER_00"]["duration_s"] == pytest.approx(2.0)


def test_compute_speaker_dominance_system_dominant_segment():
    import numpy as np
    rate = 1000
    mic = np.zeros(5000)
    sysd = np.ones(5000) * 1.0
    scores = backend_core.compute_speaker_dominance([(1.0, 3.0, "SPEAKER_00")], mic, sysd, rate=rate)
    assert scores["SPEAKER_00"]["mic_ratio"] < 0.01
    assert scores["SPEAKER_00"]["mic_share"] == 0.0  # zero mic energy -> no share of the mic track


def test_compute_speaker_dominance_silent_segment_neutral_no_divide_by_zero():
    import numpy as np
    rate = 1000
    mic = np.zeros(5000)
    sysd = np.zeros(5000)
    scores = backend_core.compute_speaker_dominance([(1.0, 3.0, "SPEAKER_00")], mic, sysd, rate=rate)
    assert scores["SPEAKER_00"]["mic_ratio"] == 0.5
    assert scores["SPEAKER_00"]["mic_share"] == 0.0  # no mic energy anywhere -> no divide-by-zero
    assert scores["SPEAKER_00"]["duration_s"] == pytest.approx(2.0)


def test_compute_speaker_dominance_duration_weighting():
    import numpy as np
    rate = 1000
    # segment A: 1s, mic loud / system silent (ratio 1.0); segment B: 4s, mic == system (ratio 0.5)
    mic = np.concatenate([np.ones(1000) * 2.0, np.ones(4000) * 1.0])
    sysd = np.concatenate([np.zeros(1000), np.ones(4000) * 1.0])
    timeline = [(0.0, 1.0, "SPEAKER_00"), (1.0, 5.0, "SPEAKER_00")]
    scores = backend_core.compute_speaker_dominance(timeline, mic, sysd, rate=rate)
    # mic_ratio weighted mean = (1.0*1 + 0.5*4) / 5 = 0.6
    assert scores["SPEAKER_00"]["mic_ratio"] == pytest.approx(0.6)
    # mic_level weighted mean = (2.0*1 + 1.0*4) / 5 = 1.2
    assert scores["SPEAKER_00"]["mic_level"] == pytest.approx(1.2)
    assert scores["SPEAKER_00"]["duration_s"] == pytest.approx(5.0)


def test_compute_speaker_dominance_mic_share_survives_system_track_echo():
    """The real-world shape this fix targets: SPEAKER_00 is loud on BOTH mic and
    system (the call mixes the author's own voice back into the system track), while
    SPEAKER_01 never appears on the mic at all (not wearing it). The old mic_ratio
    caps SPEAKER_00 at ~0.5 here — well below a sane 'dominant' cutoff — but mic_share
    (which never looks at the system track) correctly gives SPEAKER_00 nearly all of
    the mic energy."""
    import numpy as np
    rate = 1000
    mic = np.concatenate([np.ones(2000) * 1.0, np.zeros(2000)])       # SPEAKER_00 loud, SPEAKER_01 silent
    sysd = np.concatenate([np.ones(2000) * 1.0, np.ones(2000) * 1.0])  # both loud on system (echo)
    timeline = [(0.0, 2.0, "SPEAKER_00"), (2.0, 4.0, "SPEAKER_01")]
    scores = backend_core.compute_speaker_dominance(timeline, mic, sysd, rate=rate)
    assert scores["SPEAKER_00"]["mic_ratio"] == pytest.approx(0.5)  # would fail the old 0.65 gate
    assert scores["SPEAKER_00"]["mic_share"] == pytest.approx(1.0)  # mic_share gets it right anyway
    assert scores["SPEAKER_01"]["mic_share"] == pytest.approx(0.0)


# ── pick_author_label (pure helper) ─────────────────────────────────────────
def test_pick_author_label_clear_winner():
    scores = {"SPEAKER_00": {"mic_share": 0.9, "mic_level": 800.0, "duration_s": 10.0},
              "SPEAKER_01": {"mic_share": 0.1, "mic_level": 50.0, "duration_s": 10.0}}
    assert backend_core.pick_author_label(scores) == "SPEAKER_00"


def test_pick_author_label_six_speaker_matches_real_7ic8_observed_values():
    """Regression pinned to the ACTUAL numbers logged from a real end-to-end run on the
    7ic8 recording (backend.py process, real mic.wav/system.wav, real pyannote
    diarization — see developer report), not a rounder/more-forgiving stand-in: author
    SPEAKER_04 mic_share=0.53, runner-up SPEAKER_00 mic_share=0.34 (margin only 0.19),
    everyone else 0.01-0.06. An earlier version of this test used mic_share=0.87 for
    the author — far more forgiving than reality (margin 0.82) — which would not have
    caught a regression that pushed the real thresholds/margin back toward failure.
    mic_share still resolves the author here even though the old mic/system ratio
    observed for this same speaker was only ~0.46 (below the old 0.65 gate, because the
    system track also carried the author's own voice)."""
    scores = {
        "SPEAKER_03": {"mic_share": 0.06, "mic_level": 18.8, "duration_s": 108.6},
        "SPEAKER_05": {"mic_share": 0.04, "mic_level": 17.4, "duration_s": 78.4},
        "SPEAKER_00": {"mic_share": 0.34, "mic_level": 86.7, "duration_s": 129.3},  # runner-up
        "SPEAKER_04": {"mic_share": 0.53, "mic_level": 268.6, "duration_s": 65.5},  # the author
        "SPEAKER_02": {"mic_share": 0.02, "mic_level": 20.4, "duration_s": 40.6},
        "SPEAKER_01": {"mic_share": 0.01, "mic_level": 20.4, "duration_s": 20.6},
    }
    assert backend_core.pick_author_label(scores) == "SPEAKER_04"


def test_pick_author_label_two_labels_share_mic_within_margin_returns_none():
    """Two labels both audible on the mic within margin of each other (e.g. two people
    sharing one mic/room) -> ambiguous, no winner."""
    scores = {"SPEAKER_00": {"mic_share": 0.55, "mic_level": 400.0, "duration_s": 10.0},
              "SPEAKER_01": {"mic_share": 0.45, "mic_level": 380.0, "duration_s": 10.0}}  # margin 0.10 < default 0.15
    assert backend_core.pick_author_label(scores) is None


def test_pick_author_label_below_min_mic_share_returns_none():
    scores = {"SPEAKER_00": {"mic_share": 0.35, "mic_level": 300.0, "duration_s": 10.0},  # below default 0.40
              "SPEAKER_01": {"mic_share": 0.1, "mic_level": 50.0, "duration_s": 10.0}}
    assert backend_core.pick_author_label(scores) is None


def test_pick_author_label_winner_too_short_returns_none():
    scores = {"SPEAKER_00": {"mic_share": 0.9, "mic_level": 800.0, "duration_s": 1.0},    # below default 3.0s
              "SPEAKER_01": {"mic_share": 0.1, "mic_level": 50.0, "duration_s": 10.0}}
    assert backend_core.pick_author_label(scores) is None


def test_pick_author_label_empty_scores_returns_none():
    assert backend_core.pick_author_label({}) is None


def test_pick_author_label_single_speaker_active_mic_returns_author():
    """Single diarized label (solo recording) with real mic activity above the floor
    -> author, regardless of mic_share (trivially 1.0, nothing to share with)."""
    scores = {"SPEAKER_00": {"mic_share": 1.0, "mic_level": 900.0, "duration_s": 10.0}}
    assert backend_core.pick_author_label(scores) == "SPEAKER_00"


def test_pick_author_label_single_speaker_silent_mic_returns_none():
    """Single diarized label but the mic never picked up ANY activity at all (hard
    zero — e.g. all sound came from the system track only, user just watched
    something) -> not the author, below the mic_level floor. See the two tests below
    for the more realistic near-floor/ambient-noise boundary, not just hard zero."""
    scores = {"SPEAKER_00": {"mic_share": 1.0, "mic_level": 0.0, "duration_s": 10.0}}
    assert backend_core.pick_author_label(scores) is None


def test_pick_author_label_single_speaker_ambient_mic_just_below_floor_returns_none():
    """Low-level ambient mic noise (e.g. room hum picked up by an idle mic, not real
    speech) just UNDER _AUTHOR_MIN_MIC_RMS=50.0 -> still not authored. _AUTHOR_MIN_MIC_RMS
    is an uncalibrated HYPO floor (no real silent/ambient sample exists yet — see its
    definition) — this pins current boundary behavior, not a verified real-world
    guarantee that 49 RMS is always "just ambient"."""
    scores = {"SPEAKER_00": {"mic_share": 1.0, "mic_level": 49.0, "duration_s": 10.0}}
    assert backend_core.pick_author_label(scores) is None


def test_pick_author_label_single_speaker_ambient_mic_just_above_floor_returns_author():
    """Mic level just OVER the floor -> author. Documents the known, deferred
    false-positive risk head-on: real ambient noise that happens to clear this HYPO
    floor would be accepted exactly the same way a real solo author would be — see the
    _AUTHOR_MIN_MIC_RMS comment (uncalibrated, risk not yet resolved)."""
    scores = {"SPEAKER_00": {"mic_share": 1.0, "mic_level": 51.0, "duration_s": 10.0}}
    assert backend_core.pick_author_label(scores) == "SPEAKER_00"


def test_pick_author_label_single_speaker_too_short_returns_none():
    scores = {"SPEAKER_00": {"mic_share": 1.0, "mic_level": 900.0, "duration_s": 1.0}}  # below default 3.0s
    assert backend_core.pick_author_label(scores) is None


# ── fuzzy_correct — Stage 1 of glossary correction (deterministic, no LLM) ──
def test_fuzzy_correct_replaces_close_cyrillic_misrecognition():
    text, reps = backend_core.fuzzy_correct("Слово Онтон тут", ["Антон"])
    assert text == "Слово Антон тут"
    assert reps == [{"from": "Онтон", "to": "Антон"}]


def test_fuzzy_correct_keeps_surrounding_punctuation_around_replaced_token():
    text, reps = backend_core.fuzzy_correct("Позвал Онтон, потом ушёл.", ["Антон"])
    assert text == "Позвал Антон, потом ушёл."
    assert reps == [{"from": "Онтон", "to": "Антон"}]


def test_fuzzy_correct_declined_correct_form_not_flattened_to_nominative():
    # "Антона" is a correctly-spelled genitive/accusative of "Антон" — must be
    # left exactly as-is, never "corrected" down to the nominative term.
    text, reps = backend_core.fuzzy_correct("Встретил Антона вчера", ["Антон"])
    assert text == "Встретил Антона вчера"
    assert reps == []


def test_fuzzy_correct_leaves_distant_unrelated_word_untouched():
    text, reps = backend_core.fuzzy_correct("Взял стол вчера", ["Антон"])
    assert text == "Взял стол вчера"
    assert reps == []


def test_fuzzy_correct_matches_latin_term_from_cyrillic_phonetic_spelling():
    text, reps = backend_core.fuzzy_correct("Напиши мне в слэк", ["Slack"])
    assert text == "Напиши мне в Slack"
    assert reps == [{"from": "слэк", "to": "Slack"}]


def test_fuzzy_correct_threshold_boundary_accepts_distance_equal_to_threshold():
    # "Database" is 8 chars (>5) → threshold=2; "Dotobase" differs by exactly 2 substitutions.
    text, reps = backend_core.fuzzy_correct("Открыл Dotobase утром", ["Database"])
    assert text == "Открыл Database утром"
    assert reps == [{"from": "Dotobase", "to": "Database"}]


def test_fuzzy_correct_threshold_boundary_rejects_distance_one_past_threshold():
    # same term, one substitution further away (3 vs threshold=2) → left untouched.
    text, reps = backend_core.fuzzy_correct("Открыл Dotobasa утром", ["Database"])
    assert text == "Открыл Dotobasa утром"
    assert reps == []


def test_fuzzy_correct_garbled_and_declined_token_conservatively_left_untouched_v1():
    # "Онтона" is BOTH a misrecognition (Онтон≠Антон) AND declined (nominative+"а").
    # v1 rule: fuzzy_correct only checks whole-token distance (no stem/suffix
    # splitting) — that distance (2) exceeds the <=5-char threshold (1), so the
    # token is conservatively left as-is rather than guessed at. Stage 2's LLM
    # pass (gate_llm_correction) is the one that may resolve this case instead.
    text, reps = backend_core.fuzzy_correct("Встретил Онтона вчера", ["Антон"])
    assert text == "Встретил Онтона вчера"
    assert reps == []


def test_fuzzy_correct_accepts_segment_list_and_returns_same_shape():
    segs = [{"text": "Позвал Онтон", "start": 0, "end": 2}]
    out, reps = backend_core.fuzzy_correct(segs, ["Антон"])
    assert out == [{"text": "Позвал Антон", "start": 0, "end": 2}]
    assert reps == [{"from": "Онтон", "to": "Антон"}]


def test_fuzzy_correct_empty_terms_is_noop_passthrough():
    text, reps = backend_core.fuzzy_correct("Онтон тут", [])
    assert text == "Онтон тут"
    assert reps == []


# ── gate_llm_correction — Stage 2 diff-gate over an LLM's proposed fix ──────
def test_gate_accepts_close_replacement_matching_glossary_term():
    out = backend_core.gate_llm_correction(
        "Позвал Онтон на встречу", "Позвал Антон на встречу", ["Антон"])
    assert out == "Позвал Антон на встречу"


def test_gate_rejects_unrelated_rewrite_keeps_original():
    original = "Позвал стол на встречу"
    out = backend_core.gate_llm_correction(original, "Позвал диван на встречу", ["Антон"])
    assert out == original


def test_gate_accepts_declined_form_insertion():
    # old token is BOTH misrecognized and declined; new token is the term's
    # declined form — gate must accept it even though fuzzy_correct (Stage 1,
    # conservative) would have left "Онтона" untouched.
    out = backend_core.gate_llm_correction(
        "Встретил Онтона вчера", "Встретил Антона вчера", ["Антон"])
    assert out == "Встретил Антона вчера"


def test_gate_discards_whole_chunk_on_wild_length_divergence():
    original = "Короткий текст тут"
    corrected = ("Совершенно другой и значительно более длинный текст, "
                 "который был придуман целиком заново без всякой связи с оригиналом")
    out = backend_core.gate_llm_correction(original, corrected, ["Антон"])
    assert out == original


def test_gate_discards_whole_chunk_on_too_many_token_changes():
    # 3 of 5 tokens rewritten (60% > the 30% cap) at matching character length
    # (so this isolates the token-change-ratio guard from the length-delta one).
    original = "слово слово слово слово слово"
    corrected = "текст текст текст слово слово"
    out = backend_core.gate_llm_correction(original, corrected, ["Антон"])
    assert out == original


def test_gate_rejects_inserted_token_but_still_accepts_valid_replacement_in_same_chunk():
    original = "Позвал Онтон на большую встречу вчера"
    corrected = "Позвал Антон на очень большую встречу вчера"  # +"очень" inserted
    out = backend_core.gate_llm_correction(original, corrected, ["Антон"])
    # the valid term fix is kept, the inserted word is dropped — output token
    # count stays exactly equal to the original's.
    assert out == "Позвал Антон на большую встречу вчера"
    assert len(out.split()) == len(original.split())


def test_gate_empty_terms_is_noop_passthrough():
    original = "Позвал Онтон на встречу"
    assert backend_core.gate_llm_correction(original, "Позвал Антон на встречу", []) == original


# ── _llm_correct_budget (adaptive max_tokens/timeout for correct_glossary_llm) ──
def test_llm_correct_budget_known_value():
    max_tokens, timeout = backend_core._llm_correct_budget(300)
    assert max_tokens == 4000 + 100  # measured reasoning floor + ceil(300/3)
    assert timeout == pytest.approx(30 + 4100 / 15)


def test_llm_correct_budget_floor_at_zero_chars():
    # even an empty chunk gets the full reasoning floor — that's the floor,
    # not zero, because a reasoning model burns tokens on "thinking" before it
    # emits any visible output regardless of input size (measured: 3997 of a
    # 3999-token completion was reasoning alone on a real chunk, so 4000 is
    # the measured floor, not headroom above some smaller number).
    max_tokens, timeout = backend_core._llm_correct_budget(0)
    assert max_tokens == 4000
    assert timeout == pytest.approx(30 + 4000 / 15)


def test_llm_correct_budget_monotonic_in_chunk_len():
    small_tokens, small_timeout = backend_core._llm_correct_budget(100)
    large_tokens, large_timeout = backend_core._llm_correct_budget(5000)
    assert large_tokens > small_tokens
    assert large_timeout > small_timeout


# ── _diff_term_hits (attributes an already-gated LLM swap back to its term) ──
def test_diff_term_hits_identifies_swapped_term():
    orig = "Позвал Онтон на встречу".split()
    new = "Позвал Антон на встречу".split()
    assert backend_core._diff_term_hits(orig, new, ["Антон"]) == [{"from": "Онтон", "to": "Антон"}]


def test_diff_term_hits_ignores_unchanged_tokens():
    same = "Всё в порядке".split()
    assert backend_core._diff_term_hits(same, list(same), ["Антон"]) == []


def test_diff_term_hits_multi_word_term():
    orig = "Встретил Ивана Петрова вчера".split()
    new = "Встретил Иван Петров вчера".split()
    hits = backend_core._diff_term_hits(orig, new, ["Иван Петров"])
    assert hits == [{"from": "Ивана Петрова", "to": "Иван Петров"}]


def test_diff_term_hits_length_mismatch_returns_empty():
    assert backend_core._diff_term_hits(["a", "b"], ["a"], ["b"]) == []


def test_diff_term_hits_no_terms_returns_empty():
    assert backend_core._diff_term_hits(["a"], ["b"], []) == []


# ── critic follow-up fixes (fuzzy_correct/gate/_term_or_declined_form) ──────

# BLOCKER 1 — Stage-1 fuzzy was ungated for short terms: "Дан" (distance-1 from
# the common word "дам") used to misfire. Terms ≤3 chars now require an exact
# (post-translit) match — no fuzz budget.
def test_fuzzy_correct_short_term_distance_one_does_not_misfire_on_unrelated_word():
    text, reps = backend_core.fuzzy_correct("Я вам дам ответ", ["Дан"])
    assert text == "Я вам дам ответ"
    assert reps == []


def test_fuzzy_correct_short_term_still_matches_on_exact_form():
    text, reps = backend_core.fuzzy_correct("Позвал Дан вчера", ["Дан"])
    assert text == "Позвал Дан вчера"  # already correct — untouched, no replacement logged
    assert reps == []


def test_gate_short_term_distance_one_rewrite_rejected_as_unrelated():
    original = "Я вам дам ответ"
    out = backend_core.gate_llm_correction(original, "Я вам Дан ответ", ["Дан"])
    assert out == original


def test_fuzzy_correct_onton_to_anton_still_works_after_threshold_tightening():
    # the happy path the tightened threshold must not break (5-char term keeps ±1).
    text, reps = backend_core.fuzzy_correct("Слово Онтон тут", ["Антон"])
    assert text == "Слово Антон тут"
    assert reps == [{"from": "Онтон", "to": "Антон"}]


# BLOCKER 2 — multi-word glossary terms ("Иван Петров") now match across a run
# of consecutive tokens (n-gram window), in both fuzzy_correct and the gate.
def test_fuzzy_correct_multiword_term_matches_across_consecutive_tokens():
    text, reps = backend_core.fuzzy_correct("Встретил иван питров вчера", ["Иван Петров"])
    assert text == "Встретил Иван Петров вчера"
    assert reps == [{"from": "иван питров", "to": "Иван Петров"}]


def test_fuzzy_correct_single_token_terms_unaffected_by_multiword_glossary_entries():
    text, reps = backend_core.fuzzy_correct("Слово Онтон тут", ["Иван Петров", "Антон"])
    assert text == "Слово Антон тут"
    assert reps == [{"from": "Онтон", "to": "Антон"}]


def test_gate_accepts_multiword_term_correction():
    out = backend_core.gate_llm_correction(
        "Встретил иван питров вчера", "Встретил Иван Петров вчера", ["Иван Петров"])
    assert out == "Встретил Иван Петров вчера"


def test_gate_single_token_term_unaffected_by_multiword_glossary_entries():
    out = backend_core.gate_llm_correction(
        "Позвал Онтон на встречу", "Позвал Антон на встречу", ["Иван Петров", "Антон"])
    assert out == "Позвал Антон на встречу"


# MAJOR — declension guard now checks a whitelist of actual Russian case-ending
# suffixes, not "any ≤3 chars": "Антонов" is a different name (built with the
# possessive/patronymic-forming suffix "-ов"), not a declined "Антон".
def test_term_or_declined_form_accepts_whitelisted_case_endings():
    assert backend_core._term_or_declined_form("Антона", ["Антон"]) == "Антон"
    assert backend_core._term_or_declined_form("Антону", ["Антон"]) == "Антон"
    assert backend_core._term_or_declined_form("Антоном", ["Антон"]) == "Антон"


def test_term_or_declined_form_rejects_surname_forming_suffix():
    assert backend_core._term_or_declined_form("Антонов", ["Антон"]) is None


def test_gate_rejects_surname_like_suffix_not_a_real_declension():
    original = "Позвал Онтон на встречу"
    out = backend_core.gate_llm_correction(original, "Позвал Антонов на встречу", ["Антон"])
    assert out == original  # "Антонов" is a different word — not accepted


def test_gate_accepts_genuine_case_ending_declension():
    out = backend_core.gate_llm_correction(
        "Встретил Онтона вчера", "Встретил Антона вчера", ["Антон"])
    assert out == "Встретил Антона вчера"


# MINOR — gate must transplant the validated core onto the ORIGINAL token's own
# punctuation, never the LLM's punctuation choice.
def test_gate_transplants_validated_core_onto_original_punctuation():
    original = "Написал ему в слэк."
    corrected = "Написал ему в Slack!"
    out = backend_core.gate_llm_correction(original, corrected, ["Slack"])
    assert out == "Написал ему в Slack."  # keeps ORIGINAL's ".", drops the LLM's "!"


# ── shared _base_stamp() helper — canonical recording identity (audio-inventory
# feature, History audio inventory + base_stamp deliverable) ───────────────────
def test_base_stamp_plain_stamp_unchanged():
    assert backend_core._base_stamp("2026-01-01-100000") == "2026-01-01-100000"


def test_base_stamp_strips_revision_suffix():
    assert backend_core._base_stamp("2026-01-01-100000-r2") == "2026-01-01-100000"


def test_base_stamp_strips_language_suffix():
    assert backend_core._base_stamp("2026-01-01-100000-en") == "2026-01-01-100000"


def test_base_stamp_strips_revision_and_language_suffix():
    assert backend_core._base_stamp("2026-01-01-100000-en-r3") == "2026-01-01-100000"
