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


def test_combine_empty_segment_text_does_not_abort_remaining_segments():
    segments = [seg("привет", 0.0, 1.0), seg("", 1.0, 2.0), seg("пока", 2.0, 3.0)]
    timeline = [(0.0, 3.0, "SPEAKER_00")]
    out, _label_map = backend_core.combine(segments, timeline)
    assert out == "**[Спикер 1]**: привет пока"


def test_combine_resolves_speaker_at_overlap_of_exactly_one():
    # a 1.0-unit overlap is the smallest POSITIVE overlap possible here -- the
    # running "best" comparison must start low enough to be beaten by it,
    # or the segment falls back to "Unknown" despite a real, resolvable match.
    segments = [seg("слово", 0.0, 1.0)]
    timeline = [(0.0, 1.0, "SPEAKER_00")]
    out, _label_map = backend_core.combine(segments, timeline)
    assert out == "**[Спикер 1]**: слово"


def test_combine_joins_final_buffered_turn_with_a_single_space():
    # both segments belong to the SAME speaker throughout, so the buffer is
    # only ever flushed once, AFTER the loop ends -- this exercises that
    # tail-flush join specifically (the mid-loop flush is covered above).
    segments = [seg("привет", 0.0, 2.0), seg("мир", 2.0, 4.0)]
    timeline = [(0.0, 4.0, "SPEAKER_00")]
    out, _label_map = backend_core.combine(segments, timeline)
    assert out == "**[Спикер 1]**: привет мир"


def test_combine_joins_multiple_speaker_turns_with_blank_line():
    segments = [seg("привет", 0.0, 2.0), seg("пока", 4.0, 6.0)]
    timeline = [(0.0, 2.0, "SPEAKER_00"), (4.0, 6.0, "SPEAKER_01")]
    out, _label_map = backend_core.combine(segments, timeline)
    assert out == "**[Спикер 1]**: привет\n\n**[Спикер 2]**: пока"


# ── add_timestamps ──────────────────────────────────────────────────────────
def test_add_timestamps_format():
    out = backend_core.add_timestamps([seg("первая", 0, 1), seg("вторая", 65, 70)])
    assert out == "[00:00] первая\n[01:05] вторая"


def test_add_timestamps_minute_boundary_uses_60_second_minutes():
    out = backend_core.add_timestamps([seg("текст", 120, 121)])
    assert out == "[02:00] текст"


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
    assert conf < 0.15  # mirrors backend.py's _XCORR_MIN_CONFIDENCE (not imported —
    # this test file must stay decoupled from backend.py so mutmut's isolated
    # backend_core.py-only sandbox can import it without a sibling backend.py present)


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


def test_normalized_xcorr_peak_single_sample_arrays_still_compute_a_real_peak():
    # size-1 arrays are NOT the "empty" case -- they must still go through the
    # real correlation math (and land on confidence 1.0 here), not get
    # shunted into the empty-input early-return.
    import numpy as np
    lag, conf = backend_core._normalized_xcorr_peak(np.array([5.0]), np.array([5.0]), max_lag=10)
    assert lag == 0
    assert conf == pytest.approx(1.0)


def test_normalized_xcorr_peak_empty_array_returns_exact_zero_zero():
    import numpy as np
    lag, conf = backend_core._normalized_xcorr_peak(np.array([]), np.array([1.0, 2.0]), max_lag=5)
    assert lag == 0
    assert conf == 0.0


def test_normalized_xcorr_peak_lag_exactly_at_max_lag_boundary_is_included():
    # the true shift sits exactly ON the max_lag boundary -- an off-by-one on
    # the inclusive bound would mask out the actual peak lag entirely.
    import numpy as np
    rng = np.random.default_rng(11)
    shared = rng.standard_normal(2000)
    shift = 200
    early, late = shared[:1500], shared[shift:shift + 1500]
    lag, conf = backend_core._normalized_xcorr_peak(early, late, max_lag=200)
    assert lag == 200
    assert conf > 0.5


def test_normalized_xcorr_peak_negative_max_lag_returns_exact_zero_zero():
    # max_lag < 0 means no lag can ever satisfy the mask -- must fall through
    # the "nothing in window" branch cleanly, not crash or fabricate a peak.
    import numpy as np
    lag, conf = backend_core._normalized_xcorr_peak(
        np.array([1.0, 2.0, 3.0]), np.array([1.0, 2.0, 3.0]), max_lag=-1)
    assert lag == 0
    assert conf == 0.0


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


# ── _track_rms (pure helper: RMS of a sample-index slice) ───────────────────
def test_track_rms_start_at_time_zero_includes_the_first_sample():
    import numpy as np
    samples = np.array([10.0, 0.0, 0.0, 0.0])
    rms = backend_core._track_rms(samples, start_s=0.0, end_s=4.0, rate=1)
    assert rms == pytest.approx(5.0)


def test_track_rms_end_at_time_zero_yields_empty_slice_not_one_sample():
    import numpy as np
    samples = np.array([7.0, 0.0, 0.0])
    rms = backend_core._track_rms(samples, start_s=-5.0, end_s=0.0, rate=1)
    assert rms == 0.0


def test_track_rms_reversed_range_returns_exact_zero():
    import numpy as np
    samples = np.array([1.0, 2.0, 3.0])
    assert backend_core._track_rms(samples, start_s=3.0, end_s=1.0, rate=1) == 0.0


def test_track_rms_single_sample_segment_computes_its_own_value_not_zero():
    import numpy as np
    samples = np.array([0.0, 6.0, 0.0])
    rms = backend_core._track_rms(samples, start_s=1.0, end_s=2.0, rate=1)
    assert rms == pytest.approx(6.0)


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


def test_compute_speaker_dominance_default_rate_is_16000():
    # relies on the DEFAULT rate (no explicit rate= kwarg) -- a wrong default
    # shifts the sample-index window just past a real amplitude jump placed
    # exactly at the true 16000 Hz one-second mark.
    import numpy as np
    mic = np.concatenate([np.ones(16000) * 1.0, np.ones(16000) * 100.0])
    sysd = np.zeros(32000)
    scores = backend_core.compute_speaker_dominance([(0.0, 1.0, "SPEAKER_00")], mic, sysd)
    assert scores["SPEAKER_00"]["mic_level"] == pytest.approx(1.0)


def test_compute_speaker_dominance_zero_duration_segment_is_skipped_entirely():
    import numpy as np
    mic = np.ones(1000)
    sysd = np.zeros(1000)
    scores = backend_core.compute_speaker_dominance([(1.0, 1.0, "SPEAKER_00")], mic, sysd, rate=1000)
    assert scores == {}


def test_compute_speaker_dominance_zero_duration_segment_does_not_abort_remaining_segments():
    import numpy as np
    mic = np.ones(2000)
    sysd = np.zeros(2000)
    timeline = [(0.0, 0.0, "SPEAKER_00"), (0.0, 1.0, "SPEAKER_01")]
    scores = backend_core.compute_speaker_dominance(timeline, mic, sysd, rate=1000)
    assert "SPEAKER_01" in scores
    assert scores["SPEAKER_01"]["duration_s"] == pytest.approx(1.0)


def test_compute_speaker_dominance_energy_is_mic_rms_times_duration_not_divided():
    import numpy as np
    rate = 1000
    # label A: 2s @ mic_rms=10; label B: 1s @ mic_rms=10 -- equal mic_rms, but
    # A's LONGER duration must give it MORE energy share (energy=rms*dur),
    # not less (which a mistaken rms/dur would produce).
    mic = np.concatenate([np.ones(2000) * 10.0, np.ones(1000) * 10.0])
    sysd = np.zeros(3000)
    timeline = [(0.0, 2.0, "A"), (2.0, 3.0, "B")]
    scores = backend_core.compute_speaker_dominance(timeline, mic, sysd, rate=rate)
    assert scores["A"]["mic_share"] > scores["B"]["mic_share"]


def test_compute_speaker_dominance_energy_accumulates_across_multiple_segments():
    import numpy as np
    rate = 1000
    mic = np.concatenate([np.ones(1000) * 10.0, np.ones(1000) * 10.0, np.ones(1000) * 10.0])
    sysd = np.zeros(3000)
    timeline = [(0.0, 1.0, "A"), (1.0, 2.0, "A"), (2.0, 3.0, "B")]  # A has TWO segments, B has one
    scores = backend_core.compute_speaker_dominance(timeline, mic, sysd, rate=rate)
    # A's energy must be the SUM of both its segments (20), double B's (10) --
    # an overwrite instead of accumulation would lose the first segment.
    assert scores["A"]["mic_share"] == pytest.approx(2 / 3)


def test_compute_speaker_dominance_small_positive_total_energy_is_not_treated_as_zero():
    import numpy as np
    rate = 1000
    mic = np.ones(1000) * 0.5  # small mic_rms -> total energy 0.5 (strictly between 0 and 1)
    sysd = np.zeros(1000)
    scores = backend_core.compute_speaker_dominance([(0.0, 1.0, "SPEAKER_00")], mic, sysd, rate=rate)
    assert scores["SPEAKER_00"]["mic_share"] == pytest.approx(1.0)


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


def test_pick_author_label_duration_exactly_at_floor_is_accepted():
    scores = {"SPEAKER_00": {"mic_share": 0.9, "mic_level": 800.0, "duration_s": 3.0},  # exactly the default floor
              "SPEAKER_01": {"mic_share": 0.1, "mic_level": 50.0, "duration_s": 10.0}}
    assert backend_core.pick_author_label(scores) == "SPEAKER_00"


def test_pick_author_label_single_speaker_mic_level_exactly_at_floor_is_accepted():
    scores = {"SPEAKER_00": {"mic_share": 1.0, "mic_level": 50.0, "duration_s": 10.0}}  # exactly the default floor
    assert backend_core.pick_author_label(scores) == "SPEAKER_00"


def test_pick_author_label_mic_share_exactly_at_floor_is_accepted():
    scores = {"SPEAKER_00": {"mic_share": 0.40, "mic_level": 300.0, "duration_s": 10.0},  # exactly the default floor
              "SPEAKER_01": {"mic_share": 0.1, "mic_level": 50.0, "duration_s": 10.0}}
    assert backend_core.pick_author_label(scores) == "SPEAKER_00"


def test_pick_author_label_margin_exactly_at_floor_is_accepted():
    # 0.625/0.375 are exact binary fractions (5/8, 3/8) so their difference is
    # bit-for-bit 0.25 -- "0.55 - 0.40" would land a hair ABOVE 0.15 under
    # IEEE754 and silently miss the boundary this test needs to sit exactly on.
    scores = {"SPEAKER_00": {"mic_share": 0.625, "mic_level": 400.0, "duration_s": 10.0},
              "SPEAKER_01": {"mic_share": 0.375, "mic_level": 380.0, "duration_s": 10.0}}
    assert backend_core.pick_author_label(scores, min_margin=0.25) == "SPEAKER_00"


# ── _levenshtein (pure edit-distance helper) ────────────────────────────────
def test_levenshtein_identical_strings_is_zero():
    assert backend_core._levenshtein("test", "test") == 0


def test_levenshtein_single_substitution_is_one():
    assert backend_core._levenshtein("cat", "bat") == 1


def test_levenshtein_single_insertion_is_one():
    assert backend_core._levenshtein("cat", "cats") == 1


def test_levenshtein_multiple_deletions():
    # forces the DP to actually use the "delete from a" transition (prev[j]+1)
    # more than once in a row -- a dropped/miscounted deletion term recovers
    # the wrong (larger) distance here.
    assert backend_core._levenshtein("abc", "a") == 2


def test_levenshtein_classic_kitten_sitting():
    assert backend_core._levenshtein("kitten", "sitting") == 3


# ── _fuzzy_threshold (pure helper: fuzz budget by term length) ──────────────
def test_fuzzy_threshold_three_chars_or_fewer_is_zero():
    assert backend_core._fuzzy_threshold("abc") == 0
    assert backend_core._fuzzy_threshold("a") == 0


def test_fuzzy_threshold_four_to_five_chars_is_one():
    assert backend_core._fuzzy_threshold("abcd") == 1
    assert backend_core._fuzzy_threshold("abcde") == 1


def test_fuzzy_threshold_six_or_more_chars_is_two():
    assert backend_core._fuzzy_threshold("abcdef") == 2
    assert backend_core._fuzzy_threshold("abcdefg") == 2


# ── _closest_term (pure fuzzy term matcher) ─────────────────────────────────
def test_closest_term_lenient_defaults_to_false():
    # "Иваном" is both misrecognized-length AND declined relative to "Иван" --
    # only reachable under lenient=True's prefix candidate. If the default
    # silently flipped to True this would incorrectly match here too.
    assert backend_core._closest_term("Иваном", ["Иван"]) is None


def test_closest_term_strips_punctuation_before_matching():
    assert backend_core._closest_term("Дан!", ["Дан"]) == "Дан"


def test_closest_term_skips_falsy_terms_in_list():
    assert backend_core._closest_term("XXXX", [None, "Антон"]) is None


def test_closest_term_empty_term_entry_does_not_abort_remaining_terms():
    assert backend_core._closest_term("Антон", ["", "Антон"]) == "Антон"


def test_closest_term_lenient_prefix_boundary_three_extra_chars_included():
    # core is 3 chars longer than the term (the lenient boundary, <=3) and its
    # first 4 chars are an exact match -- only the lenient prefix candidate
    # can resolve this (whole-string distance is 3, over threshold 1).
    assert backend_core._closest_term("иванбвг", ["Иван"], lenient=True) == "Иван"


def test_closest_term_lenient_prefix_more_than_three_extra_chars_excluded():
    # one char past the lenient boundary (4 extra, not <=3) -- must NOT match.
    assert backend_core._closest_term("иванбвгд", ["Иван"], lenient=True) is None


# ── _term_specs (pure helper: dedupe + sort terms by word count desc) ───────
def test_term_specs_skips_falsy_entries():
    assert backend_core._term_specs([None, "Иван Петров"]) == [("Иван Петров", 2)]


def test_term_specs_dedupes_repeated_terms():
    assert backend_core._term_specs(["Антон", "Антон"]) == [("Антон", 1)]


def test_term_specs_sorts_by_word_count_descending():
    specs = backend_core._term_specs(["Антон", "Иван Петров"])
    assert specs == [("Иван Петров", 2), ("Антон", 1)]


# ── _fuzzy_correct_text (pure per-string worker behind fuzzy_correct) ───────
def test_fuzzy_correct_text_none_text_is_noop_with_terms_present():
    # "not text" must catch None too, not just "" -- a caller-side crash here
    # (AttributeError from None.split()) is the observable failure mode.
    assert backend_core._fuzzy_correct_text(None, ["Антон"]) == (None, [])


def test_fuzzy_correct_text_multiword_term_window_never_overruns_remaining_tokens():
    # a term-window bounds check must reject a multi-word term whose word
    # count would extend past the END of the token stream -- otherwise a
    # truncated 1-token window can still "fuzzy match" a 2-word term (when
    # the dropped word is short enough to fit the term's own fuzz threshold)
    # and splice in a word that was never in the original text at all.
    text, reps = backend_core._fuzzy_correct_text("Позвал Иван", ["Иван П"])
    assert text == "Позвал Иван"
    assert reps == []


def test_fuzzy_correct_text_oversized_leading_spec_does_not_block_shorter_spec_match():
    # the longest-first spec ("Иван Петров", 2 words) doesn't fit at the tail
    # position -- that must fall through to try the shorter spec ("Антон"),
    # not abandon the whole position untried.
    text, reps = backend_core._fuzzy_correct_text("Слово Онтон", ["Иван Петров", "Антон"])
    assert text == "Слово Антон"
    assert reps == [{"from": "Онтон", "to": "Антон"}]


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


def test_fuzzy_correct_segment_missing_text_key_defaults_to_empty_string():
    segs = [{"start": 0, "end": 1}]  # no "text" key at all
    out, reps = backend_core.fuzzy_correct(segs, ["Антон"])
    assert out == [{"start": 0, "end": 1, "text": ""}]
    assert reps == []


def test_fuzzy_correct_falsy_non_list_input_defaults_to_empty_string():
    text, reps = backend_core.fuzzy_correct(None, ["Антон"])
    assert text == ""
    assert reps == []


# ── _transplant_punctuation (keeps original punctuation, swaps only the core) ──
def test_transplant_punctuation_pure_punctuation_old_token_no_duplicated_trail():
    # old_tok is ENTIRELY punctuation -> old_core is empty/falsy, so trail
    # must stay "" rather than re-deriving a (duplicated) trailing punctuation
    # slice from an already-fully-stripped rstrip.
    assert backend_core._transplant_punctuation("...", "Slack") == "...Slack"


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


def test_gate_empty_terms_preserves_original_whitespace_verbatim():
    # with terms=[] the function must short-circuit on the VERY FIRST guard
    # and hand back `original` byte-for-byte -- falling through to the
    # tokenize/rejoin path would silently normalize whitespace instead.
    original = "  hello  world  "
    out = backend_core.gate_llm_correction(original, "hello world", [])
    assert out == original


def test_gate_none_original_returns_none_without_crashing():
    assert backend_core.gate_llm_correction(None, "Антон", ["Антон"]) is None


def test_gate_accepts_correction_at_exact_twenty_percent_length_delta_boundary():
    # len 10 -> len 8 is a delta of exactly 0.2 (the ">" boundary itself, not
    # a hair past it) -- this must still be ACCEPTED, not gated away.
    original = "1234567890"
    corrected = "12345678"
    out = backend_core.gate_llm_correction(original, corrected, ["12345678"])
    assert out == "12345678"


def test_gate_rejects_three_token_changes_above_the_floor_of_two():
    # 5 tokens: 0.3*5=1.5, so the cap is the floor of 2, not the percentage.
    # 3 changed tokens must be rejected wholesale (over the floor).
    original = "Онтон Ивон Диман тут да"
    corrected = "Антон Иван Дима тут да"
    out = backend_core.gate_llm_correction(original, corrected, ["Антон", "Иван", "Дима"])
    assert out == original


def test_gate_accepts_three_changes_when_orig_is_long_enough_to_scale_the_cap():
    # 10 tokens: 0.3*10=3, so the cap scales up to 3 (not pinned at the floor
    # of 2) -- a long enough chunk must tolerate 3 legitimate term fixes.
    original = "Онтон Ивон Диман тут да и там тоже было хорошо"
    corrected = "Антон Иван Дима тут да и там тоже было хорошо"
    out = backend_core.gate_llm_correction(original, corrected, ["Антон", "Иван", "Дима"])
    assert out == corrected


def test_gate_applies_swap_at_the_very_first_token_position():
    # k starts at 0 and the swap loop must be able to apply AT k==0 (an
    # off-by-one in the window's start/end arithmetic would miss position 0
    # specifically while still working for later positions).
    out = backend_core.gate_llm_correction("Онтон тут", "Антон тут", ["Антон"])
    assert out == "Антон тут"


def test_gate_applies_two_consecutive_single_word_swaps_in_one_chunk():
    # forces the swap-application loop to advance k across TWO separate
    # accepted single-word windows in the same replace span -- a broken
    # advance (k left unmoved, or jumping past the second window) would
    # apply only the first swap, or corrupt/skip the second one.
    out = backend_core.gate_llm_correction(
        "Онтон Ивон тут", "Антон Иван тут", ["Антон", "Иван"])
    assert out == "Антон Иван тут"


def test_gate_rejects_when_old_window_is_not_a_plausible_source_of_the_new_term():
    # new_joined validates as the term "Антон", but the OLD window it would
    # replace ("стол") is nowhere near "Антон" under _closest_term -- the old
    # side of the swap must independently gate the new side matching alone.
    original = "Взял стол на встречу"
    corrected = "Взял Антон на встречу"
    out = backend_core.gate_llm_correction(original, corrected, ["Антон"])
    assert out == original


def test_gate_rejects_length_delta_between_the_floor_and_a_much_looser_bound():
    # delta ~0.36 -- well past the real 0.2 cap, but still far under a
    # mistakenly loosened 1.2 cap. Whitespace padding makes a wrongly-let-
    # through correction visibly diverge (it gets rebuilt via token rejoin,
    # collapsing the padding) from the untouched original.
    original = "  Онтон  тут  "
    corrected = "Антон тут"
    out = backend_core.gate_llm_correction(original, corrected, ["Антон"])
    assert out == original


def test_gate_tries_longest_term_first_within_a_replace_span():
    # both "Иван Петров" and "Иван" are candidates for the same 2-token
    # replace span -- trying the shorter one first would apply only a
    # partial (wrong) correction to the first word and leave the second
    # uncorrected.
    original = "Ивана Петрова тут"
    corrected = "Иван Петров тут"
    out = backend_core.gate_llm_correction(original, corrected, ["Иван Петров", "Иван"])
    assert out == "Иван Петров тут"


def test_gate_rejects_replace_opcode_with_mismatched_span_lengths():
    # the LLM's corrected text inserts an extra word alongside a term fix --
    # a real length-mismatch on a "replace" opcode must reject the WHOLE
    # span (never partially apply against a structurally different span).
    # (kept long enough that the overall length-delta gate alone doesn't
    # already reject it, so this actually isolates the tag/length guard.)
    original = "Позвал Онтон тут вчера очень поздно"
    corrected = "Позвал Антон и тут вчера очень поздно"
    out = backend_core.gate_llm_correction(original, corrected, ["Антон"])
    assert out == original


def test_gate_swap_window_arithmetic_never_reads_past_the_token_list():
    # a corrupted window-bounds computation reads past the end of the token
    # lists for this input and crashes outright (IndexError) instead of
    # producing "Петрова Иван" -- the crash itself is the observable defect.
    original = "Петрова Ивон"
    corrected = "Петрова Иван"
    out = backend_core.gate_llm_correction(original, corrected, ["Иван Петров", "Иван"])
    assert out == "Петрова Иван"


def test_gate_strips_punctuation_from_new_window_before_matching():
    original = "Ивана, Петрова тут"
    corrected = "Иван, Петров тут"
    out = backend_core.gate_llm_correction(original, corrected, ["Иван Петров"])
    assert out == "Иван, Петров тут"


def test_gate_strips_punctuation_from_old_window_before_matching():
    original = "Ивана, Петрова тут"
    corrected = "Иван Петров тут"
    out = backend_core.gate_llm_correction(original, corrected, ["Иван Петров"])
    assert out == "Иван, Петров тут"


def test_gate_no_match_on_longest_word_count_still_tries_shorter_at_same_position():
    # at the same span position, the 2-word term fails to validate on the
    # NEW side -- must fall through to try the 1-word term next, not abandon
    # the whole position.
    original = "Онтон Ивон"
    corrected = "Антон Иван"
    out = backend_core.gate_llm_correction(original, corrected, ["Иван Петров", "Антон", "Иван"])
    assert out == "Антон Иван"


def test_gate_old_side_mismatch_on_longest_word_count_still_tries_shorter():
    # the 2-word term validates on the NEW side but its OLD side is not a
    # plausible source -- must fall through to try the 1-word term next
    # (which IS plausible on both sides), not abandon the whole position.
    original = "Ивона Дима"
    corrected = "Иван Петров"
    out = backend_core.gate_llm_correction(original, corrected, ["Иван Петров", "Иван"])
    assert out == "Иван Дима"


def test_gate_unmatched_position_advances_by_exactly_one():
    # the first position doesn't resolve to any term -- the cursor must
    # advance by exactly one, not skip past the second (real) match.
    original = "стол Онтон"
    corrected = "диван Антон"
    out = backend_core.gate_llm_correction(original, corrected, ["Антон"])
    assert out == "стол Антон"


# ── _llm_correct_budget (adaptive max_tokens/timeout for correct_glossary_llm) ──
def test_llm_correct_budget_known_value():
    max_tokens, timeout = backend_core._llm_correct_budget(300)
    assert max_tokens == 4000 + 100  # measured reasoning floor + ceil(300/3)
    assert timeout == pytest.approx(30 + 4100 / 15)


def test_llm_correct_budget_ceils_non_multiple_of_three_as_exact_int():
    # 100/3 does not divide evenly -> ceil(100/3)=34 via integer floordiv trick.
    # A truediv-based miscount would yield a float (4033.33...) instead of the
    # exact int 4034 the real "-(-chunk_len // 3)" ceil produces.
    max_tokens, _timeout = backend_core._llm_correct_budget(100)
    assert max_tokens == 4034
    assert isinstance(max_tokens, int)


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


def test_diff_term_hits_tries_longest_term_first():
    # both "Иван Петров" and "Иван" are candidate terms -- the 2-word term
    # must be tried before the 1-word one, or the swap gets misattributed to
    # the shorter term instead of the full multi-word one.
    orig = "Ивана Петрова вчера".split()
    new = "Иван Петров вчера".split()
    hits = backend_core._diff_term_hits(orig, new, ["Иван Петров", "Иван"])
    assert hits == [{"from": "Ивана Петрова", "to": "Иван Петров"}]


def test_diff_term_hits_detects_a_swap_at_the_very_first_token():
    orig = "Онтон тут".split()
    new = "Антон тут".split()
    assert backend_core._diff_term_hits(orig, new, ["Антон"]) == [{"from": "Онтон", "to": "Антон"}]


def test_diff_term_hits_multiword_window_that_exactly_reaches_the_end_is_allowed():
    # the window ends EXACTLY at the last token (i+wc == n) -- this must be
    # allowed, not off-by-one rejected as if it overran the token stream.
    orig = "Позвал Ивана Петрова".split()
    new = "Позвал Иван Петров".split()
    hits = backend_core._diff_term_hits(orig, new, ["Иван Петров"])
    assert hits == [{"from": "Ивана Петрова", "to": "Иван Петров"}]


def test_diff_term_hits_oversized_leading_spec_does_not_block_shorter_spec():
    orig = "Слово Онтон".split()
    new = "Слово Антон".split()
    hits = backend_core._diff_term_hits(orig, new, ["Иван Петров", "Антон"])
    assert hits == [{"from": "Онтон", "to": "Антон"}]


def test_diff_term_hits_strips_punctuation_from_new_window_before_matching():
    orig = "Ивана, Петрова".split()
    new = "Иван, Петров".split()
    hits = backend_core._diff_term_hits(orig, new, ["Иван Петров"])
    assert hits == [{"from": "Ивана Петрова", "to": "Иван Петров"}]


def test_diff_term_hits_no_match_on_longest_spec_still_tries_shorter_spec():
    orig = "Онтон тут".split()
    new = "Антон тут".split()
    hits = backend_core._diff_term_hits(orig, new, ["Иван Петров", "Антон"])
    assert hits == [{"from": "Онтон", "to": "Антон"}]


def test_diff_term_hits_strips_punctuation_from_the_from_side_attribution():
    orig = "Онтон, тут".split()
    new = "Антон тут".split()
    hits = backend_core._diff_term_hits(orig, new, ["Антон"])
    assert hits == [{"from": "Онтон", "to": "Антон"}]


def test_diff_term_hits_advances_by_exactly_one_word_count_after_a_match():
    # two consecutive single-word matches -- an over-advance after the first
    # would skip past the second entirely.
    orig = "Онтон Онтон".split()
    new = "Антон Антон".split()
    hits = backend_core._diff_term_hits(orig, new, ["Антон"])
    assert hits == [{"from": "Онтон", "to": "Антон"}, {"from": "Онтон", "to": "Антон"}]


def test_diff_term_hits_single_unmatched_token_terminates_cleanly():
    assert backend_core._diff_term_hits(["стол"], ["диван"], ["Антон"]) == []


def test_diff_term_hits_unmatched_token_advances_by_exactly_one():
    # a differing-but-unmatched token must advance the cursor by exactly one
    # position -- an over-advance would skip past a real match right after it.
    orig = "стол Онтон".split()
    new = "диван Антон".split()
    hits = backend_core._diff_term_hits(orig, new, ["Антон"])
    assert hits == [{"from": "Онтон", "to": "Антон"}]


# ── _segments_text_hash (cache-staleness fingerprint for the `correct` stage) ──
def test_segments_text_hash_deterministic_for_same_input():
    segs = [{"text": "привет"}, {"text": "как дела"}]
    assert backend_core._segments_text_hash(segs) == backend_core._segments_text_hash(list(segs))


def test_segments_text_hash_changes_when_any_segment_text_changes():
    a = [{"text": "привет"}, {"text": "как дела"}]
    b = [{"text": "привет"}, {"text": "пока"}]
    assert backend_core._segments_text_hash(a) != backend_core._segments_text_hash(b)


def test_segments_text_hash_sensitive_to_segment_order():
    # same texts, different order — the join is positional, so order must matter
    # (a cache key must not treat a reordering as the same transcript).
    a = [{"text": "один"}, {"text": "два"}]
    b = [{"text": "два"}, {"text": "один"}]
    assert backend_core._segments_text_hash(a) != backend_core._segments_text_hash(b)


def test_segments_text_hash_missing_text_key_treated_as_empty_string():
    assert backend_core._segments_text_hash([{}]) == backend_core._segments_text_hash([{"text": ""}])


def test_segments_text_hash_returns_twelve_char_hex_digest():
    h = backend_core._segments_text_hash([{"text": "x"}])
    assert len(h) == 12
    assert all(c in "0123456789abcdef" for c in h)


def test_segments_text_hash_uses_bare_unit_separator_between_segments():
    # pins the exact join (bare "\x1f" between texts, nothing else) against an
    # independently-computed digest -- hashlib is stdlib, not a backend_core
    # import, so this stays decoupled from backend.py.
    import hashlib
    segs = [{"text": "a"}, {"text": "b"}]
    expected = hashlib.sha1("a\x1fb".encode("utf-8")).hexdigest()[:12]
    assert backend_core._segments_text_hash(segs) == expected


def test_segments_text_hash_empty_segment_text_joins_as_empty_string():
    import hashlib
    segs = [{"text": ""}, {"text": "b"}]
    expected = hashlib.sha1("\x1fb".encode("utf-8")).hexdigest()[:12]
    assert backend_core._segments_text_hash(segs) == expected


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


def test_term_or_declined_form_strips_punctuation_before_matching():
    assert backend_core._term_or_declined_form("Антон,", ["Антон"]) == "Антон"


def test_term_or_declined_form_skips_falsy_terms_in_list():
    # a None/"" entry must never become a literal matchable string
    assert backend_core._term_or_declined_form("XXXX", [None, "Антон"]) is None


def test_term_or_declined_form_empty_term_entry_does_not_abort_remaining_terms():
    assert backend_core._term_or_declined_form("Антон", ["", "Антон"]) == "Антон"


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
