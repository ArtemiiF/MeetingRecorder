"""Tests for backend.py pure logic + mocked I/O boundaries."""
import io
import json
import sys
import types
from pathlib import Path

import pytest

# import backend.py from the app dir
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import backend  # noqa: E402


# ── emit / log / stage produce one valid json line each ────────────────────
def capture(fn, *a, **k):
    buf = io.StringIO()
    old = sys.stdout
    sys.stdout = buf
    try:
        fn(*a, **k)
    finally:
        sys.stdout = old
    lines = [l for l in buf.getvalue().splitlines() if l.strip()]
    return [json.loads(l) for l in lines]


def test_emit_is_one_json_line():
    out = capture(backend.emit, "stage", stage="llm", msg="hi")
    assert out == [{"event": "stage", "stage": "llm", "msg": "hi"}]


def test_emit_preserves_unicode():
    out = capture(backend.emit, "log", msg="Привет 🎙")
    assert out[0]["msg"] == "Привет 🎙"


def test_log_carries_current_stage():
    backend._CURRENT_STAGE = "general"
    assert capture(backend.log, "x")[0] == {"event": "log", "msg": "x", "stage": "general"}


def test_stage_sets_current_and_emits():
    out = capture(backend.stage, "save", "done")[0]
    assert out == {"event": "stage", "stage": "save", "msg": "done"}
    assert backend._CURRENT_STAGE == "save"
    # subsequent logs now tag the new stage
    assert capture(backend.log, "y")[0]["stage"] == "save"
    backend._CURRENT_STAGE = "general"  # reset for other tests


def test_stage_end_emits_status():
    assert capture(backend.stage_end, "llm", "fail", "no summary")[0] == {
        "event": "stage_end", "stage": "llm", "status": "fail", "msg": "no summary"}


# ── str2bool ────────────────────────────────────────────────────────────────
@pytest.mark.parametrize("v,exp", [
    ("true", True), ("True", True), ("1", True), ("yes", True), ("on", True),
    ("false", False), ("0", False), ("no", False), ("", False), ("nope", False),
])
def test_str2bool(v, exp):
    assert backend.str2bool(v) is exp


# ── filter_hallucinations ───────────────────────────────────────────────────
def seg(text, start=0.0, end=5.0):
    return {"text": text, "start": start, "end": end}


@pytest.fixture
def pipe():
    return backend.Pipeline(out_dir="/tmp/mr-test-out", diarize=False)


def test_filter_keeps_normal_speech(pipe):
    segs = [seg("Давай обсудим релиз на следующей неделе")]
    assert len(pipe.filter_hallucinations(segs)) == 1


def test_filter_drops_empty_and_tiny(pipe):
    assert pipe.filter_hallucinations([seg(""), seg(" "), seg("a")]) == []


def test_filter_drops_repeated_syllables(pipe):
    assert pipe.filter_hallucinations([seg("па па па па па")]) == []


def test_filter_drops_long_letter_runs(pipe):
    assert pipe.filter_hallucinations([seg("ааааааааа")]) == []


def test_filter_drops_low_diversity(pipe):
    assert pipe.filter_hallucinations([seg("да да да да да да да нет")]) == []


def test_filter_drops_known_hallucinations(pipe):
    for bad in ["Субтитры сделал кто-то", "Спасибо что смотрите видео",
                "продолжение следует скоро"]:
        assert pipe.filter_hallucinations([seg(bad)]) == [], bad


def test_filter_drops_too_fast(pipe):
    # 200 chars over 1s = 200 chars/sec >> 30 threshold
    assert pipe.filter_hallucinations([seg("я" * 200, 0.0, 1.0)]) == []


def test_filter_drops_short_suspicious(pipe):
    # duration < 0.8 and len < 4
    assert pipe.filter_hallucinations([seg("эээ", 0.0, 0.5)]) == []


# ── combine (transcript + diarization timeline) ─────────────────────────────
def test_combine_groups_by_speaker_via_overlap(pipe):
    segments = [
        seg("привет", 0.0, 2.0),
        seg("как дела", 2.0, 4.0),
        seg("отлично", 4.0, 6.0),
    ]
    timeline = [(0.0, 4.0, "SPEAKER_00"), (4.0, 6.0, "SPEAKER_01")]
    out, label_map = pipe.combine(segments, timeline)
    assert "**[Спикер 1]**: привет как дела" in out   # friendly relabel of SPEAKER_00
    assert "**[Спикер 2]**: отлично" in out
    assert out.count("**[Спикер ") == 2
    assert label_map == {"SPEAKER_00": "Спикер 1", "SPEAKER_01": "Спикер 2"}


def test_combine_empty_timeline_returns_none(pipe):
    assert pipe.combine([seg("x")], []) == (None, {})


def test_combine_unknown_when_no_overlap(pipe):
    out, _label_map = pipe.combine([seg("hi", 100.0, 101.0)], [(0.0, 5.0, "SPEAKER_00")])
    assert "**[Неизвестно]**: hi" == out


# ── add_timestamps ──────────────────────────────────────────────────────────
def test_add_timestamps_format(pipe):
    out = pipe.add_timestamps([seg("первая", 0, 1), seg("вторая", 65, 70)])
    assert out == "[00:00] первая\n[01:05] вторая"


# ── note assembly ───────────────────────────────────────────────────────────
def test_add_audio_link_inserts_after_frontmatter(pipe):
    note = "---\ntype: meeting\n---\n\n# Встреча\n\ntext"
    out = pipe.add_audio_link(note, "meeting-x.wav")
    assert "![[meeting-x.wav]]" in out
    # link section sits after the closing frontmatter, before the heading body
    fm_end = out.index("---", out.index("---") + 3)
    assert out.index("![[meeting-x.wav]]") > fm_end


def test_add_audio_link_no_frontmatter_prepends(pipe):
    out = pipe.add_audio_link("# Встреча\n\ntext", "a.wav")
    assert out.startswith("\n## 🎵 Аудио запись")
    assert "![[a.wav]]" in out


def test_add_transcript_appends_details(pipe):
    out = pipe.add_transcript("# note", "полный текст тут")
    assert "<details>" in out and "полный текст тут" in out
    assert "## 📄 Полный транскрипт" in out


def test_basic_note_has_frontmatter_and_heading(pipe):
    n = pipe.basic_note("транскрипт")
    assert n.startswith("---\ntype: meeting")
    assert "# Встреча" in n


# ── summarize (mock LM Studio over requests) ────────────────────────────────
def install_fake_requests(monkeypatch, *, status=200, payload=None, raise_exc=None):
    fake = types.ModuleType("requests")
    calls = {}

    class Resp:
        status_code = status
        def json(self):
            return payload

    def post(url, json=None, timeout=None):
        calls["url"] = url
        calls["json"] = json
        if raise_exc:
            raise raise_exc
        return Resp()

    fake.post = post
    monkeypatch.setitem(sys.modules, "requests", fake)
    return calls


def test_summarize_success_returns_content(monkeypatch, pipe):
    payload = {"choices": [{"message": {"content": "СВОДКА"}}]}
    calls = install_fake_requests(monkeypatch, payload=payload)
    out = pipe.summarize("транскрипт", "сделай сводку")
    assert out == "СВОДКА"
    # user prompt forwarded verbatim into the request body
    user_msg = calls["json"]["messages"][1]["content"]
    assert "сделай сводку" in user_msg
    assert "транскрипт" in user_msg


def test_summarize_empty_content_returns_none_not_reasoning(monkeypatch, pipe):
    # reasoning_content is NEVER used as the summary body (per backend.py:507-508 comment).
    # When only reasoning_content is present (content absent/empty), summarize must return None.
    payload = {"choices": [{"message": {"reasoning_content": "РАЗМЫШЛЕНИЕ"}}]}
    install_fake_requests(monkeypatch, payload=payload)
    assert pipe.summarize("t", "p") is None


def test_summarize_non_200_returns_none(monkeypatch, pipe):
    install_fake_requests(monkeypatch, status=500, payload={})
    assert pipe.summarize("t", "p") is None


def test_summarize_no_choices_returns_none(monkeypatch, pipe):
    install_fake_requests(monkeypatch, payload={"choices": []})
    assert pipe.summarize("t", "p") is None


def test_summarize_swallows_exception(monkeypatch, pipe):
    install_fake_requests(monkeypatch, raise_exc=ConnectionError("LM Studio down"))
    assert pipe.summarize("t", "p") is None


# ── list_devices / find_device_index (mock pyaudio) ─────────────────────────
class FakePyAudio:
    def __init__(self, devices, default_index=0):
        self._devs = devices
        self._default = default_index
    def get_device_count(self):
        return len(self._devs)
    def get_device_info_by_index(self, i):
        return self._devs[i]
    def get_default_input_device_info(self):
        return {"index": self._default}
    def terminate(self):
        pass


def install_fake_pyaudio(monkeypatch, devices, default_index=0):
    fake = types.ModuleType("pyaudio")
    fake.PyAudio = lambda: FakePyAudio(devices, default_index)
    fake.paInt16 = 8
    monkeypatch.setitem(sys.modules, "pyaudio", fake)


def test_list_devices_filters_inputs_and_flags(monkeypatch):
    devs = [
        {"name": "MacBook Mic", "maxInputChannels": 1},
        {"name": "Speakers", "maxInputChannels": 0},          # output only -> excluded
        {"name": "Meeting Recorder Input", "maxInputChannels": 3},
    ]
    install_fake_pyaudio(monkeypatch, devs, default_index=0)
    out = backend.list_devices()
    names = [d["name"] for d in out]
    assert "Speakers" not in names
    assert len(out) == 2
    mri = next(d for d in out if d["name"] == "Meeting Recorder Input")
    assert mri["preferred"] is True and mri["index"] == 2
    assert next(d for d in out if d["name"] == "MacBook Mic")["default"] is True


def make_wav(path, seconds=0.2, rate=16000):
    import wave as wavemod
    with wavemod.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"\x00\x00" * int(rate * seconds))


def make_wav_from_samples(path, samples, rate, channels=1):
    """Write int16 PCM `samples` (already interleaved if multi-channel) to a WAV file."""
    import wave as wavemod
    with wavemod.open(str(path), "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(samples.astype("<i2").tobytes())


def make_offset_pair(tmp_path, shift_ms, late, mic_rate=44100, sys_rate=16000,
                      mic_channels=1, seed=42, dur_s=2.5):
    """Build a (mic.wav, system.wav) pair that share the same underlying noise content
    but were resampled from a common source to their own native rates/channel counts,
    with one track missing its first `shift_ms` of real-world audio (the "started
    late" model — see design doc §3). Used to exercise estimate_start_offset_ms with
    a known, verifiable ground-truth offset."""
    import numpy as np
    from scipy.signal import resample_poly
    rng = np.random.default_rng(seed)
    base_rate = 48000
    base = rng.standard_normal(int(base_rate * (dur_s + shift_ms / 1000 + 0.5)))
    mic_full = resample_poly(base, mic_rate, base_rate)
    sys_full = resample_poly(base, sys_rate, base_rate)
    mic_shift = int(round(shift_ms / 1000 * mic_rate)) if late == "mic" else 0
    sys_shift = int(round(shift_ms / 1000 * sys_rate)) if late == "system" else 0
    mic_track = mic_full[mic_shift:mic_shift + int(mic_rate * dur_s)]
    sys_track = sys_full[sys_shift:sys_shift + int(sys_rate * dur_s)]

    def to_int16(x):
        peak = np.max(np.abs(x)) + 1e-9
        return (x / peak * 30000).astype("<i2")

    mic16, sys16 = to_int16(mic_track), to_int16(sys_track)
    if mic_channels == 2:
        stereo = np.empty(mic16.size * 2, dtype="<i2")
        stereo[0::2] = mic16
        stereo[1::2] = mic16
        mic16 = stereo

    mic_path, sys_path = tmp_path / "mic.wav", tmp_path / "system.wav"
    make_wav_from_samples(mic_path, mic16, mic_rate, mic_channels)
    make_wav_from_samples(sys_path, sys16, sys_rate, 1)
    return mic_path, sys_path


def test_parse_frontmatter():
    fm = backend._parse_frontmatter('---\ntitle: "Тема"\ntemplate: "X"\nlanguage: "ru"\n---\nbody')
    assert fm["title"] == "Тема" and fm["template"] == "X" and fm["language"] == "ru"
    assert backend._parse_frontmatter("no frontmatter") == {}


def test_find_audio_strips_lang_suffix():
    files = ["meeting-s-en.md", "meeting-s.wav"]
    assert backend._find_audio("meeting-s-en.md", files) == "meeting-s.wav"
    assert backend._find_audio("meeting-s.md", ["meeting-s.md"]) is None


def test_set_frontmatter_multi_and_skip_empty(pipe):
    n = pipe.set_frontmatter("# x", {"title": "T", "template": "Tmpl", "language": "ru"})
    assert 'title: "T"' in n and 'template: "Tmpl"' in n and 'language: "ru"' in n
    assert pipe.set_frontmatter("# x", {"title": "", "template": ""}) == "# x"


def test_index_reconcile_add_then_drop(tmp_path):
    out = tmp_path / "vault"; out.mkdir()
    db = str(tmp_path / "i.db")
    (out / "meeting-2026-01-01-1000.md").write_text(
        '---\ntitle: "A"\ntemplate: "Митинг"\nlanguage: "ru"\n---\n# x', encoding="utf-8")
    (out / "meeting-2026-01-01-1000.wav").write_bytes(b"x" * 50)
    conn = backend._db_connect(db)
    backend._reconcile(conn, str(out))
    items = backend._db_list(conn)
    assert len(items) == 1
    assert items[0]["title"] == "A" and items[0]["template"] == "Митинг"
    assert items[0]["stamp"] == "2026-01-01-1000"
    assert items[0]["audio"].endswith("meeting-2026-01-01-1000.wav")
    # delete the note → reconcile drops the stale row (md is source of truth)
    (out / "meeting-2026-01-01-1000.md").unlink()
    backend._reconcile(conn, str(out))
    assert backend._db_list(conn) == []
    conn.close()


def test_db_connect_sets_busy_timeout(tmp_path):
    # A manual reindex and a background auto-index can still overlap briefly (the
    # in-flight guard lives in main.js, not here) — busy_timeout makes a concurrent
    # writer wait for the lock instead of failing with SQLITE_BUSY.
    db = str(tmp_path / "i.db")
    conn = backend._db_connect(db)
    timeout_ms = conn.execute("PRAGMA busy_timeout").fetchone()[0]
    conn.close()
    assert timeout_ms == 10000


def test_process_records_template_in_index_and_frontmatter(monkeypatch, tmp_path):
    out = tmp_path / "v"
    db = str(tmp_path / "i.db")
    src = tmp_path / "in.wav"; src.write_bytes(b"x")
    p = backend.Pipeline(out_dir=str(out), diarize=False, template="Митинг", db_path=db, language="ru")
    monkeypatch.setattr(p, "convert_to_mono", lambda f: f)
    monkeypatch.setattr(p, "remove_silence_vad", lambda f: (f, None))
    monkeypatch.setattr(p, "transcribe", lambda f: {"segments": [seg("hi", 0, 2)], "text": "x"})
    monkeypatch.setattr(p, "summarize", lambda t, pr: None)
    capture(p.process, str(src), "prompt")
    conn = backend._db_connect(db)
    items = backend._db_list(conn)
    conn.close()
    assert len(items) == 1 and items[0]["template"] == "Митинг"
    note = list(out.glob("*.md"))[0].read_text(encoding="utf-8")
    assert 'template: "Митинг"' in note  # frontmatter is the rebuildable source of truth


def test_cmd_classify_valid_category(monkeypatch, tmp_path):
    note = tmp_path / "n.md"; note.write_text("проект лендинг к марту", encoding="utf-8")
    install_fake_requests(monkeypatch, payload={"choices": [{"message": {
        "content": '{"category":"projects","project":"Лендинг"}'}}]})
    ev = [e for e in capture(backend.cmd_classify, str(note)) if e["event"] == "classified"][0]
    assert ev["category"] == "projects" and ev["project"] == "Лендинг"


def test_cmd_classify_rejects_bad_category(monkeypatch, tmp_path):
    # Design decision: invalid LLM category must emit "error", NOT be normalized to a default.
    # backend.py:1004-1014: invalid cc → continue (skip) → cat stays empty → emit("error", ...)
    note = tmp_path / "n.md"; note.write_text("x", encoding="utf-8")
    install_fake_requests(monkeypatch, payload={"choices": [{"message": {
        "content": '{"category":"WEIRD","project":"P"}'}}]})
    events = capture(backend.cmd_classify, str(note))
    assert any(e["event"] == "error" for e in events), f"expected error event, got: {events}"


def test_cmd_preflight_emits_checks():
    ev = capture(backend.cmd_preflight)[0]
    assert ev["event"] == "preflight"
    assert ev["ffmpeg"] is True                       # ffmpeg present in this env
    assert "whisper_cached" in ev and "hf_token" in ev


# ── model inventory: cmd_models_status (settings "Модели" — cache-inspection ONLY, no network) ──
def _set_model_paths(monkeypatch, tmp_path, *, whisper=False, vad=False, pyannote_ids=()):
    """Point backend's model-cache constants at tmp_path so tests never touch the real
    ~/.cache. whisper/vad: create the cached artifact iff True. pyannote_ids: which of
    the 3 sub-repo dirs to pre-create (all three are required for diarization "cached").
    Returns (whisper_dir, vad_jit, vad_repo_dir)."""
    whisper_dir = tmp_path / "whisper_dir"
    vad_repo = tmp_path / "vad_repo"
    vad_jit = vad_repo / "silero_vad.jit"
    monkeypatch.setattr(backend, "_WHISPER_MODEL_DIR", whisper_dir)
    monkeypatch.setattr(backend, "_VAD_JIT_PATH", vad_jit)
    monkeypatch.setattr(backend, "_VAD_REPO_DIR", vad_repo)
    monkeypatch.setattr(backend, "_hf_cache_dir",
                         lambda repo_id: tmp_path / "hf" / repo_id.replace("/", "--"))
    if whisper:
        whisper_dir.mkdir(parents=True, exist_ok=True)
    if vad:
        vad_jit.parent.mkdir(parents=True, exist_ok=True)
        vad_jit.write_bytes(b"x")
    for repo_id in pyannote_ids:
        (tmp_path / "hf" / repo_id.replace("/", "--")).mkdir(parents=True, exist_ok=True)
    return whisper_dir, vad_jit, vad_repo


def test_cmd_models_status_all_cached_never_locked(monkeypatch, tmp_path):
    _set_model_paths(monkeypatch, tmp_path, whisper=True, vad=True,
                      pyannote_ids=backend._PYANNOTE_REPO_IDS)
    monkeypatch.delenv("HF_TOKEN", raising=False)
    ev = capture(backend.cmd_models_status)[0]
    assert ev["event"] == "models"
    by_id = {it["id"]: it for it in ev["items"]}
    assert by_id["whisper"]["cached"] is True
    assert by_id["vad"]["cached"] is True
    assert by_id["diarization"]["cached"] is True
    assert by_id["diarization"]["locked"] is False  # cached ⇒ never locked, token irrelevant now


def test_cmd_models_status_none_cached_no_token_locks_diarization_only(monkeypatch, tmp_path):
    _set_model_paths(monkeypatch, tmp_path)  # nothing created
    monkeypatch.delenv("HF_TOKEN", raising=False)
    ev = capture(backend.cmd_models_status)[0]
    by_id = {it["id"]: it for it in ev["items"]}
    assert by_id["whisper"] == {"id": "whisper", "label": "MLX Whisper (large-v3-turbo)",
                                 "size_mb": 1500, "needs_token": False, "cached": False, "locked": False}
    assert by_id["vad"]["cached"] is False and by_id["vad"]["locked"] is False
    assert by_id["diarization"]["cached"] is False and by_id["diarization"]["locked"] is True


def test_cmd_models_status_none_cached_with_token_unlocks_diarization(monkeypatch, tmp_path):
    _set_model_paths(monkeypatch, tmp_path)
    monkeypatch.setenv("HF_TOKEN", "hf_faketoken")
    ev = capture(backend.cmd_models_status)[0]
    by_id = {it["id"]: it for it in ev["items"]}
    assert by_id["diarization"]["cached"] is False
    assert by_id["diarization"]["locked"] is False  # token present ⇒ not locked, just needed


def test_cmd_models_status_diarization_needs_all_three_subrepos(monkeypatch, tmp_path):
    # only the top pipeline repo present, segmentation/wespeaker missing → still "needed",
    # not "cached" — a partial-set check would wrongly report this as fully cached.
    _set_model_paths(monkeypatch, tmp_path, pyannote_ids=["pyannote/speaker-diarization-3.1"])
    monkeypatch.setenv("HF_TOKEN", "hf_faketoken")
    ev = capture(backend.cmd_models_status)[0]
    by_id = {it["id"]: it for it in ev["items"]}
    assert by_id["diarization"]["cached"] is False


# ── model inventory: cmd_download_models (mocked huggingface_hub/torch — never real network) ──
def install_fake_hf_hub(monkeypatch, *, raise_for=None, raise_exc=None):
    """raise_for: a repo_id (or iterable of repo_ids) whose snapshot_download call
    raises raise_exc (default: a fake GatedRepoError). Everything else succeeds.
    Returns (calls, FakeGatedRepoError) — calls['snapshot'] records every call."""
    calls = {"snapshot": []}
    fake = types.ModuleType("huggingface_hub")
    fake_errors = types.ModuleType("huggingface_hub.errors")

    class FakeGatedRepoError(Exception):
        pass
    fake_errors.GatedRepoError = FakeGatedRepoError

    raise_set = {raise_for} if isinstance(raise_for, str) else set(raise_for or [])

    def snapshot_download(repo_id, token=None, **kwargs):
        calls["snapshot"].append({"repo_id": repo_id, "token": token})
        if repo_id in raise_set:
            raise raise_exc or FakeGatedRepoError(f"gated: {repo_id}")
        return f"/fake/cache/{repo_id}"

    fake.snapshot_download = snapshot_download
    fake.errors = fake_errors
    monkeypatch.setitem(sys.modules, "huggingface_hub", fake)
    monkeypatch.setitem(sys.modules, "huggingface_hub.errors", fake_errors)
    return calls, FakeGatedRepoError


def install_fake_torch_hub(monkeypatch, *, raise_exc=None):
    calls = {"load": []}
    fake = types.ModuleType("torch")
    fake_hub = types.ModuleType("torch.hub")

    def load(repo_or_dir, model, **kwargs):
        calls["load"].append({"repo_or_dir": repo_or_dir, "model": model})
        if raise_exc:
            raise raise_exc
        return ("fake_model", ("get_speech_timestamps", "save_audio", "read_audio", None, "collect_chunks"))

    fake_hub.load = load
    fake.hub = fake_hub
    monkeypatch.setitem(sys.modules, "torch", fake)
    return calls


def test_cmd_download_models_success_downloads_everything_missing(monkeypatch, tmp_path):
    _set_model_paths(monkeypatch, tmp_path)  # nothing cached
    monkeypatch.setenv("HF_TOKEN", "hf_faketoken")
    hf_calls, _ = install_fake_hf_hub(monkeypatch)
    torch_calls = install_fake_torch_hub(monkeypatch)

    events = capture(backend.cmd_download_models)
    ends = {e["stage"]: e for e in events if e["event"] == "stage_end"}
    assert ends["model:whisper"]["status"] == "ok"
    assert ends["model:vad"]["status"] == "ok"
    assert ends["model:diarization"]["status"] == "ok"
    assert [c["repo_id"] for c in hf_calls["snapshot"]] == [
        backend._WHISPER_REPO_ID, *backend._PYANNOTE_REPO_IDS
    ]
    assert torch_calls["load"][0]["repo_or_dir"] == "snakers4/silero-vad"


def test_cmd_download_models_skips_already_cached_model(monkeypatch, tmp_path):
    _set_model_paths(monkeypatch, tmp_path, whisper=True)
    monkeypatch.setenv("HF_TOKEN", "hf_faketoken")
    hf_calls, _ = install_fake_hf_hub(monkeypatch)
    install_fake_torch_hub(monkeypatch)

    events = capture(backend.cmd_download_models)
    ends = {e["stage"]: e for e in events if e["event"] == "stage_end"}
    assert ends["model:whisper"]["status"] == "skip"
    assert all(c["repo_id"] != backend._WHISPER_REPO_ID for c in hf_calls["snapshot"])


def test_cmd_download_models_gated_repo_error_is_actionable_and_batch_continues(monkeypatch, tmp_path):
    _set_model_paths(monkeypatch, tmp_path)
    monkeypatch.setenv("HF_TOKEN", "hf_faketoken")
    install_fake_hf_hub(monkeypatch, raise_for=backend._WHISPER_REPO_ID)
    torch_calls = install_fake_torch_hub(monkeypatch)

    events = capture(backend.cmd_download_models)
    ends = {e["stage"]: e for e in events if e["event"] == "stage_end"}
    assert ends["model:whisper"]["status"] == "fail"
    assert "huggingface.co" in ends["model:whisper"]["msg"]
    # one failing model must not abort the batch — vad still attempted right after it
    assert ends["model:vad"]["status"] == "ok"
    assert torch_calls["load"], "vad download was never attempted after whisper failed"


def test_cmd_download_models_generic_exception_continues_batch(monkeypatch, tmp_path):
    _set_model_paths(monkeypatch, tmp_path)
    monkeypatch.setenv("HF_TOKEN", "hf_faketoken")
    install_fake_hf_hub(monkeypatch, raise_for=backend._WHISPER_REPO_ID,
                         raise_exc=ConnectionError("нет сети"))
    install_fake_torch_hub(monkeypatch)

    events = capture(backend.cmd_download_models)
    ends = {e["stage"]: e for e in events if e["event"] == "stage_end"}
    assert ends["model:whisper"]["status"] == "fail"
    assert ends["model:whisper"]["msg"] == "нет сети"
    assert ends["model:vad"]["status"] == "ok"
    assert ends["model:diarization"]["status"] == "ok"


def test_cmd_download_models_diarization_without_token_fails_without_touching_network(monkeypatch, tmp_path):
    _set_model_paths(monkeypatch, tmp_path)
    monkeypatch.delenv("HF_TOKEN", raising=False)
    hf_calls, _ = install_fake_hf_hub(monkeypatch)
    install_fake_torch_hub(monkeypatch)

    events = capture(backend.cmd_download_models)
    ends = {e["stage"]: e for e in events if e["event"] == "stage_end"}
    assert ends["model:diarization"]["status"] == "fail"
    assert "HF_TOKEN" in ends["model:diarization"]["msg"]
    # never actually attempted a network call for the gated repos without a token
    assert all(c["repo_id"] not in backend._PYANNOTE_REPO_IDS for c in hf_calls["snapshot"])
    assert ends["model:whisper"]["status"] == "ok"
    assert ends["model:vad"]["status"] == "ok"


def test_cmd_download_models_only_filter_restricts_to_named_model(monkeypatch, tmp_path):
    _set_model_paths(monkeypatch, tmp_path)
    monkeypatch.setenv("HF_TOKEN", "hf_faketoken")
    install_fake_hf_hub(monkeypatch)
    install_fake_torch_hub(monkeypatch)

    events = capture(backend.cmd_download_models, only="vad")
    stages = {e["stage"] for e in events if e["event"] in ("stage", "stage_end")}
    assert stages == {"model:vad"}


def test_cmd_download_models_vad_corrupt_partial_dir_is_wiped_before_retry(monkeypatch, tmp_path):
    # dir present (leftover from a killed prior attempt) but the .jit file missing —
    # torch.hub.load's own cache check is dir-existence-only, so our download flow
    # must wipe the corrupt dir itself before re-fetching (backend.py's _download_model).
    whisper_dir, vad_jit, vad_repo = _set_model_paths(
        monkeypatch, tmp_path, whisper=True, pyannote_ids=backend._PYANNOTE_REPO_IDS)
    monkeypatch.setenv("HF_TOKEN", "hf_faketoken")
    vad_repo.mkdir(parents=True, exist_ok=True)
    (vad_repo / "leftover.txt").write_text("partial junk from a killed download")
    assert vad_repo.exists() and not vad_jit.exists()

    install_fake_hf_hub(monkeypatch)
    torch_calls = install_fake_torch_hub(monkeypatch)

    events = capture(backend.cmd_download_models)
    ends = {e["stage"]: e for e in events if e["event"] == "stage_end"}
    assert ends["model:vad"]["status"] == "ok"
    assert not vad_repo.exists(), "corrupt partial dir should have been wiped before re-fetching"
    assert torch_calls["load"]


def test_set_title_injects_into_frontmatter(pipe):
    n = pipe.set_title("---\ntype: meeting\n---\n\n# Body", "Релиз v2")
    assert 'title: "Релиз v2"' in n
    assert n.startswith("---\n")


def test_set_title_creates_frontmatter_when_absent(pipe):
    n = pipe.set_title("# No frontmatter", "Тема")
    assert n.startswith('---\ntitle: "Тема"\n---')


def test_set_title_empty_is_noop(pipe):
    assert pipe.set_title("# x", "") == "# x"


def test_generate_title_uses_llm(monkeypatch, pipe):
    install_fake_requests(monkeypatch, payload={"choices": [{"message": {"content": '"Синк по релизу"\n'}}]})
    assert pipe.generate_title("транскрипт") == "Синк по релизу"  # quotes + newline stripped


def test_generate_title_empty_on_failure(monkeypatch, pipe):
    install_fake_requests(monkeypatch, status=500, payload={})
    assert pipe.generate_title("t") == ""


def test_generate_title_cleans_quotes_and_hashes(monkeypatch, pipe):
    install_fake_requests(monkeypatch, payload={"choices": [{"message": {"content": '  "## Релиз v2"  \n'}}]})
    assert pipe.generate_title("t") == "Релиз v2"


def test_generate_title_falls_back_to_reasoning(monkeypatch, pipe):
    # reasoning model: empty content, answer buried as last quoted phrase in reasoning_content
    install_fake_requests(monkeypatch, payload={"choices": [{"message": {
        "content": "", "reasoning_content": 'думаю...\nFinal choice: "Синк по релизу"'}}]})
    assert pipe.generate_title("t") == "Синк по релизу"


def test_infer_speaker_names_filters_labels_and_empties(monkeypatch, pipe):
    install_fake_requests(monkeypatch, payload={"choices": [{"message": {
        "content": '{"Спикер 1": "Алексей", "Спикер 2": "", "Спикер 9": "Икс"}'}}]})
    t = "**[Спикер 1]**: привет\n\n**[Спикер 2]**: пока"
    out = pipe.infer_speaker_names(t)
    assert out == {"Спикер 1": "Алексей"}  # empty dropped, label not in transcript dropped


def test_infer_speaker_names_no_labels_no_call(pipe):
    assert pipe.infer_speaker_names("обычный текст без меток") == {}


# ── extract_actions (action items / decisions structured LLM call) ─────────────
def test_extract_actions_happy_path(monkeypatch, pipe):
    payload = {"choices": [{"message": {"content":
        '{"items":[{"what":"отправить отчёт","who":"Алексей","due":"пятница"},'
        '{"what":"без срока и ответственного"}],'
        '"decisions":["перенести релиз на март"]}'}}]}
    install_fake_requests(monkeypatch, payload=payload)
    out = pipe.extract_actions("транскрипт встречи")
    assert out == {
        "items": [
            {"what": "отправить отчёт", "who": "Алексей", "due": "пятница"},
            {"what": "без срока и ответственного", "who": "", "due": ""},
        ],
        "decisions": ["перенести релиз на март"],
    }


def test_extract_actions_wrapped_in_prose_and_fence(monkeypatch, pipe):
    # model wraps the JSON in a markdown fence + surrounding prose — must still parse
    # (regular non-nested regexes used elsewhere in this file can't handle this shape).
    content = (
        "Вот извлечённые пункты:\n```json\n"
        '{"items":[{"what":"созвониться с клиентом","who":"","due":""}],"decisions":[]}'
        "\n```\nНадеюсь, помогло!"
    )
    install_fake_requests(monkeypatch, payload={"choices": [{"message": {"content": content}}]})
    out = pipe.extract_actions("транскрипт")
    assert out == {"items": [{"what": "созвониться с клиентом", "who": "", "due": ""}], "decisions": []}


def test_extract_actions_empty_lists_returns_empty_dict_shape(monkeypatch, pipe):
    install_fake_requests(monkeypatch, payload={"choices": [{"message": {
        "content": '{"items":[],"decisions":[]}'}}]})
    assert pipe.extract_actions("транскрипт") == {"items": [], "decisions": []}


def test_extract_actions_malformed_output_degrades_to_empty(monkeypatch, pipe):
    # no JSON at all — reasoning model rambled, nothing to salvage
    install_fake_requests(monkeypatch, payload={"choices": [{"message": {
        "content": "Хм, дайте подумать... кажется тут не было явных задач."}}]})
    assert pipe.extract_actions("транскрипт") == {}


def test_extract_actions_empty_content_returns_empty(monkeypatch, pipe):
    install_fake_requests(monkeypatch, payload={"choices": [{"message": {"content": ""}}]})
    assert pipe.extract_actions("транскрипт") == {}


def test_extract_actions_non_200_returns_empty(monkeypatch, pipe):
    install_fake_requests(monkeypatch, status=500, payload={})
    assert pipe.extract_actions("транскрипт") == {}


def test_extract_actions_swallows_exception(monkeypatch, pipe):
    install_fake_requests(monkeypatch, raise_exc=RuntimeError("boom"))
    assert pipe.extract_actions("транскрипт") == {}


# ── add_actions_section (note body assembly) ────────────────────────────────────
def test_add_actions_section_renders_checklist_and_decisions(pipe):
    actions = {
        "items": [
            {"what": "отправить отчёт", "who": "Алексей", "due": "пятница"},
            {"what": "без деталей", "who": "", "due": ""},
        ],
        "decisions": ["перенести релиз на март"],
    }
    out = pipe.add_actions_section("# note", actions)
    assert "## Действия" in out
    assert "- [ ] отправить отчёт — Алексей (срок: пятница)" in out
    assert "- [ ] без деталей" in out
    assert "— " not in out.split("без деталей")[1].split("\n")[0]  # empty who/due omitted
    assert "**Решения:**" in out
    assert "- перенести релиз на март" in out


def test_add_actions_section_empty_is_noop(pipe):
    assert pipe.add_actions_section("# note", {}) == "# note"
    assert pipe.add_actions_section("# note", {"items": [], "decisions": []}) == "# note"
    assert pipe.add_actions_section("# note", None) == "# note"


def test_build_mix_filter_single_no_filter():
    assert backend.build_mix_filter(1, [0]) == (None, None)


def test_build_mix_filter_two_no_delay():
    fc, m = backend.build_mix_filter(2, [0, 0])
    assert "amix=inputs=2:duration=longest:normalize=0[a]" in fc
    assert "adelay" not in fc and m == "[a]"


def test_build_mix_filter_delays_later_track():
    fc, m = backend.build_mix_filter(2, [0, 500])  # system (input 1) started later
    assert "[1:a]adelay=500|500[d1]" in fc
    assert "[0:a][d1]amix=inputs=2" in fc and m == "[a]"


def test_cmd_mix_two_tracks(tmp_path):
    mic, sysf, out = tmp_path / "mic.wav", tmp_path / "system.wav", tmp_path / "mixed.wav"
    make_wav(mic); make_wav(sysf)
    events = capture(backend.cmd_mix, str(mic), str(sysf), str(out))
    assert any(e["event"] == "mixed" and e["tracks"] == 2 for e in events)
    assert out.exists() and out.stat().st_size > 44


def test_cmd_mix_single_track(tmp_path):
    sysf, out = tmp_path / "system.wav", tmp_path / "mixed.wav"
    make_wav(sysf)
    events = capture(backend.cmd_mix, None, str(sysf), str(out))
    assert any(e["event"] == "mixed" and e["tracks"] == 1 for e in events)
    assert out.exists()


def test_cmd_mix_no_tracks_errors(tmp_path):
    events = capture(backend.cmd_mix, None, None, str(tmp_path / "mixed.wav"))
    assert any(e["event"] == "error" for e in events)


def test_cmd_mix_ignores_empty_files(tmp_path):
    # a header-only / empty file (≤44 bytes) must not count as a track
    empty = tmp_path / "mic.wav"
    empty.write_bytes(b"RIFF")  # 4 bytes
    sysf, out = tmp_path / "system.wav", tmp_path / "mixed.wav"
    make_wav(sysf)
    events = capture(backend.cmd_mix, str(empty), str(sysf), str(out))
    assert any(e["event"] == "mixed" and e["tracks"] == 1 for e in events)


# ── _normalized_xcorr_peak (pure helper, synthetic arrays) ─────────────────────
def test_normalized_xcorr_peak_recovers_positive_shift():
    import numpy as np
    rng = np.random.default_rng(42)
    shared = rng.standard_normal(2000)
    shift = 137
    early, late = shared[:1500], shared[shift:shift + 1500]
    lag, conf = backend._normalized_xcorr_peak(early, late, max_lag=500)
    assert lag == shift
    assert conf > 0.5


def test_normalized_xcorr_peak_recovers_negative_shift():
    import numpy as np
    rng = np.random.default_rng(42)
    shared = rng.standard_normal(2000)
    shift = 137
    early, late = shared[:1500], shared[shift:shift + 1500]
    # swapping a/b flips the sign of the recovered lag
    lag, conf = backend._normalized_xcorr_peak(late, early, max_lag=500)
    assert lag == -shift
    assert conf > 0.5


def test_normalized_xcorr_peak_uncorrelated_below_threshold():
    import numpy as np
    rng = np.random.default_rng(7)
    a = rng.standard_normal(1500)
    b = rng.standard_normal(1500)
    _, conf = backend._normalized_xcorr_peak(a, b, max_lag=500)
    assert conf < backend._XCORR_MIN_CONFIDENCE


def test_normalized_xcorr_peak_all_zero_no_divide_by_zero():
    import numpy as np
    lag, conf = backend._normalized_xcorr_peak(np.zeros(500), np.zeros(500), max_lag=100)
    assert lag == 0 and conf == 0.0


def test_normalized_xcorr_peak_shift_beyond_max_lag_stays_bounded():
    import numpy as np
    rng = np.random.default_rng(3)
    shared = rng.standard_normal(3000)
    shift = 1000  # far outside max_lag below
    early, late = shared[:1500], shared[shift:shift + 1500]
    lag, _ = backend._normalized_xcorr_peak(early, late, max_lag=100)
    assert abs(lag) <= 100  # bounded to the search window, never crashes


# ── estimate_start_offset_ms (I/O boundary, synthetic WAVs with real ground truth) ──
def test_estimate_start_offset_ms_recovers_system_late(tmp_path):
    # mic stereo@44100 vs system mono@16000 — differing rate AND channel count,
    # per design doc §3 test plan
    mic, sysf = make_offset_pair(tmp_path, shift_ms=200, late="system", mic_channels=2)
    md, sd, conf = backend.estimate_start_offset_ms(str(mic), str(sysf))
    assert (md, sd) == (0, 200)
    assert conf > backend._XCORR_MIN_CONFIDENCE


def test_estimate_start_offset_ms_recovers_mic_late(tmp_path):
    mic, sysf = make_offset_pair(tmp_path, shift_ms=150, late="mic")
    md, sd, conf = backend.estimate_start_offset_ms(str(mic), str(sysf))
    assert (md, sd) == (150, 0)
    assert conf > backend._XCORR_MIN_CONFIDENCE


def test_estimate_start_offset_ms_uncorrelated_falls_back(tmp_path):
    import numpy as np
    rng = np.random.default_rng(9)
    mic16 = (rng.standard_normal(16000 * 2) * 3000).astype("<i2")
    sys16 = (rng.standard_normal(16000 * 2) * 3000).astype("<i2")  # independent noise
    mic, sysf = tmp_path / "mic.wav", tmp_path / "system.wav"
    make_wav_from_samples(mic, mic16, 16000, 1)
    make_wav_from_samples(sysf, sys16, 16000, 1)
    md, sd, conf = backend.estimate_start_offset_ms(str(mic), str(sysf))
    assert (md, sd) == (0, 0)
    assert conf < backend._XCORR_MIN_CONFIDENCE


def test_estimate_start_offset_ms_too_short_falls_back(tmp_path):
    mic, sysf = tmp_path / "mic.wav", tmp_path / "system.wav"
    make_wav(mic, seconds=0.3, rate=16000)  # well under the 1s-post-decimation guard
    make_wav(sysf, seconds=0.3, rate=16000)
    assert backend.estimate_start_offset_ms(str(mic), str(sysf)) == (0, 0, 0.0)


def test_estimate_start_offset_ms_import_error_falls_back(monkeypatch, tmp_path):
    mic, sysf = tmp_path / "mic.wav", tmp_path / "system.wav"
    make_wav(mic, seconds=0.3)
    make_wav(sysf, seconds=0.3)
    import builtins
    real_import = builtins.__import__

    def fake_import(name, *a, **k):
        if name.split(".")[0] in ("numpy", "scipy"):
            raise ImportError(f"simulated missing {name}")
        return real_import(name, *a, **k)

    monkeypatch.setattr(builtins, "__import__", fake_import)
    assert backend.estimate_start_offset_ms(str(mic), str(sysf)) == (0, 0, 0.0)


# ── cmd_mix auto-alignment integration (mocked ffmpeg subprocess) ──────────────
def test_cmd_mix_silent_inputs_no_adelay(tmp_path, monkeypatch):
    # characterization test: silent tracks → zero-norm confidence → no adelay applied,
    # keeping the 4 pre-existing silent-WAV mix tests' behavior an explicit invariant
    import subprocess
    mic, sysf, out = tmp_path / "mic.wav", tmp_path / "system.wav", tmp_path / "mixed.wav"
    make_wav(mic, seconds=2.0)
    make_wav(sysf, seconds=2.0)
    captured = {}

    def fake_run(cmd, **kw):
        captured["cmd"] = cmd
        return types.SimpleNamespace(returncode=0)

    monkeypatch.setattr(subprocess, "run", fake_run)
    events = capture(backend.cmd_mix, str(mic), str(sysf), str(out))
    assert any(e["event"] == "mixed" and e["tracks"] == 2 for e in events)
    fc = captured["cmd"][captured["cmd"].index("-filter_complex") + 1]
    assert "adelay" not in fc


def test_cmd_mix_auto_detects_real_offset(tmp_path, monkeypatch):
    import subprocess
    mic, sysf = make_offset_pair(tmp_path, shift_ms=200, late="system")
    out = tmp_path / "mixed.wav"
    captured = {}

    def fake_run(cmd, **kw):
        captured["cmd"] = cmd
        return types.SimpleNamespace(returncode=0)

    monkeypatch.setattr(subprocess, "run", fake_run)
    capture(backend.cmd_mix, str(mic), str(sysf), str(out))
    fc = captured["cmd"][captured["cmd"].index("-filter_complex") + 1]
    assert "[1:a]adelay=200|200[d1]" in fc  # system (input 1) delayed by the detected offset


def test_cmd_mix_explicit_delay_skips_auto_detect(tmp_path, monkeypatch):
    # explicit CLI override (nonzero mic_delay/sys_delay) must bypass auto-detect
    # entirely — even though these tracks share real, correlatable content
    import subprocess
    mic, sysf = make_offset_pair(tmp_path, shift_ms=200, late="system")
    out = tmp_path / "mixed.wav"
    captured = {}

    def fake_run(cmd, **kw):
        captured["cmd"] = cmd
        return types.SimpleNamespace(returncode=0)

    monkeypatch.setattr(subprocess, "run", fake_run)
    events = capture(backend.cmd_mix, str(mic), str(sysf), str(out), mic_delay=250, sys_delay=0)
    fc = captured["cmd"][captured["cmd"].index("-filter_complex") + 1]
    assert "[0:a]adelay=250|250[d0]" in fc  # explicit override applied, not the auto-detected 200ms
    assert not any("Автовыравнивание" in e.get("msg", "") for e in events if e["event"] == "log")


# ── auto-«Я» author-speaker detection (Chunk 3, design doc variant b) ──────────

# ── _shift_chunks (pure helper) ─────────────────────────────────────────────
def test_shift_chunks_mid_track_shift():
    chunks = [{"start": 1000, "end": 2000}]
    out = backend._shift_chunks(chunks, delay_ms=100, rate=1000, max_len=10000)
    assert out == [{"start": 900, "end": 1900}]


def test_shift_chunks_clips_past_start():
    chunks = [{"start": 50, "end": 150}]
    out = backend._shift_chunks(chunks, delay_ms=100, rate=1000, max_len=10000)
    assert out == [{"start": 0, "end": 50}]


def test_shift_chunks_clips_past_end():
    chunks = [{"start": 9000, "end": 9500}]
    out = backend._shift_chunks(chunks, delay_ms=-600, rate=1000, max_len=10000)
    assert out == [{"start": 9600, "end": 10000}]


def test_shift_chunks_fully_out_of_range_dropped():
    chunks = [{"start": 0, "end": 50}]
    out = backend._shift_chunks(chunks, delay_ms=1000, rate=1000, max_len=10000)
    assert out == []


# ── _collect_chunks_np (pure helper — numpy analogue of silero's collect_chunks) ──
def test_collect_chunks_np_concatenates_in_order():
    import numpy as np
    samples = np.arange(20, dtype=np.float64)
    out = backend._collect_chunks_np([{"start": 0, "end": 3}, {"start": 10, "end": 13}], samples)
    assert list(out) == [0, 1, 2, 10, 11, 12]


def test_collect_chunks_np_empty_chunks_returns_empty_array():
    import numpy as np
    out = backend._collect_chunks_np([], np.arange(10, dtype=np.float64))
    assert len(out) == 0


# ── compute_speaker_dominance (pure helper) ─────────────────────────────────
def test_compute_speaker_dominance_mic_dominant_segment():
    import numpy as np
    rate = 1000
    mic = np.ones(5000) * 1.0
    sysd = np.zeros(5000)
    scores = backend.compute_speaker_dominance([(1.0, 3.0, "SPEAKER_00")], mic, sysd, rate=rate)
    assert scores["SPEAKER_00"]["mic_ratio"] > 0.99
    assert scores["SPEAKER_00"]["duration_s"] == pytest.approx(2.0)


def test_compute_speaker_dominance_system_dominant_segment():
    import numpy as np
    rate = 1000
    mic = np.zeros(5000)
    sysd = np.ones(5000) * 1.0
    scores = backend.compute_speaker_dominance([(1.0, 3.0, "SPEAKER_00")], mic, sysd, rate=rate)
    assert scores["SPEAKER_00"]["mic_ratio"] < 0.01


def test_compute_speaker_dominance_silent_segment_neutral_no_divide_by_zero():
    import numpy as np
    rate = 1000
    mic = np.zeros(5000)
    sysd = np.zeros(5000)
    scores = backend.compute_speaker_dominance([(1.0, 3.0, "SPEAKER_00")], mic, sysd, rate=rate)
    assert scores["SPEAKER_00"]["mic_ratio"] == 0.5
    assert scores["SPEAKER_00"]["duration_s"] == pytest.approx(2.0)


def test_compute_speaker_dominance_duration_weighting():
    import numpy as np
    rate = 1000
    # segment A: 1s, mic loud / system silent (ratio 1.0); segment B: 4s, mic == system (ratio 0.5)
    mic = np.concatenate([np.ones(1000) * 2.0, np.ones(4000) * 1.0])
    sysd = np.concatenate([np.zeros(1000), np.ones(4000) * 1.0])
    timeline = [(0.0, 1.0, "SPEAKER_00"), (1.0, 5.0, "SPEAKER_00")]
    scores = backend.compute_speaker_dominance(timeline, mic, sysd, rate=rate)
    # weighted mean = (1.0*1 + 0.5*4) / 5 = 0.6
    assert scores["SPEAKER_00"]["mic_ratio"] == pytest.approx(0.6)
    assert scores["SPEAKER_00"]["duration_s"] == pytest.approx(5.0)


# ── pick_author_label (pure helper) ─────────────────────────────────────────
def test_pick_author_label_clear_winner():
    scores = {"SPEAKER_00": {"mic_ratio": 0.9, "duration_s": 10.0},
              "SPEAKER_01": {"mic_ratio": 0.2, "duration_s": 10.0}}
    assert backend.pick_author_label(scores) == "SPEAKER_00"


def test_pick_author_label_tie_between_top_two_returns_none():
    scores = {"SPEAKER_00": {"mic_ratio": 0.80, "duration_s": 10.0},
              "SPEAKER_01": {"mic_ratio": 0.75, "duration_s": 10.0}}  # margin 0.05 < default 0.15
    assert backend.pick_author_label(scores) is None


def test_pick_author_label_below_min_ratio_returns_none():
    scores = {"SPEAKER_00": {"mic_ratio": 0.5, "duration_s": 10.0},   # below default 0.65
              "SPEAKER_01": {"mic_ratio": 0.1, "duration_s": 10.0}}
    assert backend.pick_author_label(scores) is None


def test_pick_author_label_winner_too_short_returns_none():
    scores = {"SPEAKER_00": {"mic_ratio": 0.9, "duration_s": 1.0},    # below default 3.0s
              "SPEAKER_01": {"mic_ratio": 0.2, "duration_s": 10.0}}
    assert backend.pick_author_label(scores) is None


def test_pick_author_label_empty_scores_returns_none():
    assert backend.pick_author_label({}) is None


# ── detect_author_speaker (Pipeline orchestration method) ───────────────────
def test_detect_author_speaker_missing_mic_file_returns_none(tmp_path, pipe):
    sysf = tmp_path / "system.wav"
    make_wav(sysf, seconds=2.0)
    timeline = [(0.0, 2.0, "SPEAKER_00"), (2.0, 4.0, "SPEAKER_01")]
    assert pipe.detect_author_speaker(str(tmp_path / "missing-mic.wav"), str(sysf), None, timeline, {}) is None


def test_detect_author_speaker_missing_system_file_returns_none(tmp_path, pipe):
    mic = tmp_path / "mic.wav"
    make_wav(mic, seconds=2.0)
    timeline = [(0.0, 2.0, "SPEAKER_00"), (2.0, 4.0, "SPEAKER_01")]
    assert pipe.detect_author_speaker(str(mic), str(tmp_path / "missing-sys.wav"), None, timeline, {}) is None


def test_detect_author_speaker_single_speaker_returns_none(tmp_path, pipe):
    mic, sysf = tmp_path / "mic.wav", tmp_path / "system.wav"
    make_wav(mic, seconds=2.0)
    make_wav(sysf, seconds=2.0)
    timeline = [(0.0, 2.0, "SPEAKER_00")]  # only one distinct label — no contrast possible
    assert pipe.detect_author_speaker(str(mic), str(sysf), None, timeline, {}) is None


def test_detect_author_speaker_vad_collapse_picks_mic_dominant_speaker(monkeypatch, tmp_path, pipe):
    # no mix-time delay — isolates the _shift_chunks/_collect_chunks_np collapse logic
    monkeypatch.setattr(backend, "estimate_start_offset_ms", lambda m, s: (0, 0, 1.0))
    import numpy as np
    rate = 16000
    loud = (np.ones(4 * rate) * 5000).astype("<i2")
    quiet = np.zeros(4 * rate, dtype="<i2")
    gap = np.zeros(2 * rate, dtype="<i2")
    # raw layout: [0,4s) SPEAKER_00 region, [4,6s) VAD-removed silence gap, [6,10s) SPEAKER_01 region
    mic_samples = np.concatenate([loud, gap, quiet])
    sys_samples = np.concatenate([quiet, gap, loud])
    mic_path, sys_path = tmp_path / "mic.wav", tmp_path / "system.wav"
    make_wav_from_samples(mic_path, mic_samples, rate, 1)
    make_wav_from_samples(sys_path, sys_samples, rate, 1)
    vad_chunks = [{"start": 0, "end": 4 * rate}, {"start": 6 * rate, "end": 10 * rate}]
    timeline = [(0.0, 4.0, "SPEAKER_00"), (4.0, 8.0, "SPEAKER_01")]  # collapsed timebase
    label_map = {"SPEAKER_00": "Спикер 1", "SPEAKER_01": "Спикер 2"}
    winner = pipe.detect_author_speaker(str(mic_path), str(sys_path), vad_chunks, timeline, label_map)
    assert winner == "Спикер 1"


def test_detect_author_speaker_no_vad_uses_full_track_delay_offset(monkeypatch, tmp_path, pipe):
    # vad_chunks=None (VAD skipped/failed) — timeline is wall-clock, mic_delay applied as
    # a plain leading-silence offset instead of a chunk-based collapse.
    monkeypatch.setattr(backend, "estimate_start_offset_ms", lambda m, s: (1000, 0, 1.0))
    import numpy as np
    rate = 16000
    loud = (np.ones(3 * rate) * 5000).astype("<i2")
    mic_samples = np.concatenate([loud, np.zeros(6 * rate, dtype="<i2")])
    sys_samples = np.concatenate([np.zeros(5 * rate, dtype="<i2"), (np.ones(4 * rate) * 5000).astype("<i2")])
    mic_path, sys_path = tmp_path / "mic.wav", tmp_path / "system.wav"
    make_wav_from_samples(mic_path, mic_samples, rate, 1)
    make_wav_from_samples(sys_path, sys_samples, rate, 1)
    timeline = [(0.0, 4.0, "SPEAKER_00"), (5.0, 9.0, "SPEAKER_01")]
    label_map = {"SPEAKER_00": "Спикер 1", "SPEAKER_01": "Спикер 2"}
    winner = pipe.detect_author_speaker(str(mic_path), str(sys_path), None, timeline, label_map)
    assert winner == "Спикер 1"


# ── process() integration: cache resume + speakers merge ────────────────────
def test_process_existing_cache_without_vad_map_skips_recompute_no_crash(monkeypatch, tmp_path):
    """A cache_dir created before this feature has mono.wav but no vad_map.json —
    resuming from it must not crash and must pass vad_chunks=None (no recompute)."""
    cache = tmp_path / "cache"
    cache.mkdir()
    (cache / "mono.wav").write_bytes(b"x")
    pipe = backend.Pipeline(out_dir=str(tmp_path / "v"), diarize=True, cache_dir=str(cache))
    monkeypatch.setattr(pipe, "transcribe", lambda f: {"segments": [seg("hi", 0, 2)], "text": "hi"})
    monkeypatch.setattr(pipe, "diarize", lambda f: [(0.0, 1.0, "SPEAKER_00"), (1.0, 2.0, "SPEAKER_01")])
    monkeypatch.setattr(pipe, "combine", lambda segs, tl: (
        "**[Спикер 1]**: hi", {"SPEAKER_00": "Спикер 1", "SPEAKER_01": "Спикер 2"}))
    monkeypatch.setattr(pipe, "summarize", lambda t, p: None)
    monkeypatch.setattr(pipe, "generate_title", lambda t: "")
    monkeypatch.setattr(pipe, "infer_speaker_names", lambda t: {})
    monkeypatch.setattr(pipe, "extract_actions", lambda t: {})
    captured = {}

    def fake_detect(mic_file, system_file, vad_chunks, timeline, label_map):
        captured["vad_chunks"] = vad_chunks
        return None

    monkeypatch.setattr(pipe, "detect_author_speaker", fake_detect)
    src = tmp_path / "in.wav"; src.write_bytes(b"x")
    mic = tmp_path / "mic.wav"; mic.write_bytes(b"x" * 100)
    sysf = tmp_path / "system.wav"; sysf.write_bytes(b"x" * 100)
    events = capture(pipe.process, str(src), "prompt", mic_file=str(mic), system_file=str(sysf))
    assert any(e["event"] == "done" for e in events)
    assert "vad_chunks" in captured, "detect_author_speaker should still be invoked"
    assert captured["vad_chunks"] is None


def test_process_vad_map_cache_roundtrip_reuses_vad_chunks(monkeypatch, tmp_path):
    cache = tmp_path / "cache"
    pipe = backend.Pipeline(out_dir=str(tmp_path / "v"), diarize=True, cache_dir=str(cache))
    calls = {"vad": 0, "detect_vad_chunks": []}
    monkeypatch.setattr(pipe, "convert_to_mono", lambda f: f)

    def fake_vad(f):
        calls["vad"] += 1
        return f, [{"start": 0, "end": 16000}]

    monkeypatch.setattr(pipe, "remove_silence_vad", fake_vad)
    monkeypatch.setattr(pipe, "transcribe", lambda f: {"segments": [seg("hi", 0, 2)], "text": "hi"})
    monkeypatch.setattr(pipe, "diarize", lambda f: [(0.0, 1.0, "SPEAKER_00"), (1.0, 2.0, "SPEAKER_01")])
    monkeypatch.setattr(pipe, "combine", lambda segs, tl: (
        "**[Спикер 1]**: hi", {"SPEAKER_00": "Спикер 1", "SPEAKER_01": "Спикер 2"}))
    monkeypatch.setattr(pipe, "summarize", lambda t, p: None)
    monkeypatch.setattr(pipe, "generate_title", lambda t: "")
    monkeypatch.setattr(pipe, "infer_speaker_names", lambda t: {})
    monkeypatch.setattr(pipe, "extract_actions", lambda t: {})

    def fake_detect(mic_file, system_file, vad_chunks, timeline, label_map):
        calls["detect_vad_chunks"].append(vad_chunks)
        return "Спикер 1" if vad_chunks else None

    monkeypatch.setattr(pipe, "detect_author_speaker", fake_detect)
    src = tmp_path / "in.wav"; src.write_bytes(b"x")
    mic = tmp_path / "mic.wav"; mic.write_bytes(b"x" * 100)
    sysf = tmp_path / "system.wav"; sysf.write_bytes(b"x" * 100)

    events1 = capture(pipe.process, str(src), "prompt", mic_file=str(mic), system_file=str(sysf))
    events2 = capture(pipe.process, str(src), "prompt", mic_file=str(mic), system_file=str(sysf))

    assert calls["vad"] == 1, "second run should hit the mono.wav/vad_map.json cache, not recompute VAD"
    assert calls["detect_vad_chunks"] == [[{"start": 0, "end": 16000}], [{"start": 0, "end": 16000}]]
    done1 = [e for e in events1 if e["event"] == "done"][0]
    done2 = [e for e in events2 if e["event"] == "done"][0]
    assert done1["speakers"]["Спикер 1"] == pipe.AUTHOR_NAME == done2["speakers"]["Спикер 1"]


def _mock_pipe_with_auto_label(monkeypatch, out_dir, inferred_speakers, do_summary=True, auto_label="Спикер 1"):
    pipe = backend.Pipeline(out_dir=out_dir, diarize=True, do_summary=do_summary, author_name="Артемий")
    monkeypatch.setattr(pipe, "convert_to_mono", lambda f: f)
    monkeypatch.setattr(pipe, "remove_silence_vad", lambda f: (f, None))
    monkeypatch.setattr(pipe, "transcribe", lambda f: {"segments": [seg("hi", 0, 2)], "text": "hi"})
    monkeypatch.setattr(pipe, "diarize", lambda f: [(0.0, 1.0, "SPEAKER_00"), (1.0, 2.0, "SPEAKER_01")])
    monkeypatch.setattr(pipe, "combine", lambda segs, tl: (
        "**[Спикер 1]**: hi\n\n**[Спикер 2]**: pa",
        {"SPEAKER_00": "Спикер 1", "SPEAKER_01": "Спикер 2"}))
    monkeypatch.setattr(pipe, "detect_author_speaker", lambda *a, **k: auto_label)
    monkeypatch.setattr(pipe, "summarize", lambda t, p: "# Сводка\n\n" + "итог " * 30)
    monkeypatch.setattr(pipe, "generate_title", lambda t: "Тест")
    monkeypatch.setattr(pipe, "infer_speaker_names", lambda t: inferred_speakers)
    monkeypatch.setattr(pipe, "extract_actions", lambda t: {})
    return pipe


def test_process_auto_label_setdefault_does_not_clobber_llm_name(monkeypatch, tmp_path):
    pipe = _mock_pipe_with_auto_label(monkeypatch, str(tmp_path / "v"),
                                       inferred_speakers={"Спикер 1": "Алексей"})
    src = tmp_path / "in.wav"; src.write_bytes(b"x")
    mic = tmp_path / "mic.wav"; mic.write_bytes(b"x" * 100)
    sysf = tmp_path / "system.wav"; sysf.write_bytes(b"x" * 100)
    events = capture(pipe.process, str(src), "prompt", mic_file=str(mic), system_file=str(sysf))
    done = [e for e in events if e["event"] == "done"][0]
    assert done["speakers"]["Спикер 1"] == "Алексей"  # LLM name wins, not clobbered by the auto label


def test_process_auto_label_fills_missing_llm_name(monkeypatch, tmp_path):
    pipe = _mock_pipe_with_auto_label(monkeypatch, str(tmp_path / "v"), inferred_speakers={})
    src = tmp_path / "in.wav"; src.write_bytes(b"x")
    mic = tmp_path / "mic.wav"; mic.write_bytes(b"x" * 100)
    sysf = tmp_path / "system.wav"; sysf.write_bytes(b"x" * 100)
    events = capture(pipe.process, str(src), "prompt", mic_file=str(mic), system_file=str(sysf))
    done = [e for e in events if e["event"] == "done"][0]
    assert done["speakers"]["Спикер 1"] == "Артемий"


def test_process_auto_label_applies_without_llm_summary(monkeypatch, tmp_path):
    pipe = _mock_pipe_with_auto_label(monkeypatch, str(tmp_path / "v"), inferred_speakers={}, do_summary=False)
    src = tmp_path / "in.wav"; src.write_bytes(b"x")
    mic = tmp_path / "mic.wav"; mic.write_bytes(b"x" * 100)
    sysf = tmp_path / "system.wav"; sysf.write_bytes(b"x" * 100)
    events = capture(pipe.process, str(src), "prompt", mic_file=str(mic), system_file=str(sysf))
    done = [e for e in events if e["event"] == "done"][0]
    assert done["speakers"]["Спикер 1"] == "Артемий"


def test_find_device_index_matches_substring(monkeypatch):
    devs = [
        {"name": "MacBook Mic", "maxInputChannels": 1},
        {"name": "Meeting Recorder Input", "maxInputChannels": 3},
    ]
    pa = FakePyAudio(devs)
    assert backend.find_device_index(pa, "meeting recorder") == 1
    assert backend.find_device_index(pa, "nonexistent") is None


# ── cmd_process prompt fallback ─────────────────────────────────────────────
def test_cmd_process_uses_default_prompt_when_file_blank(monkeypatch, tmp_path):
    captured = {}

    def fake_process(self, audio, prompt, keep_audio_in_obsidian=True, mic_file=None, system_file=None):
        captured["prompt"] = prompt

    monkeypatch.setattr(backend.Pipeline, "process", fake_process)

    blank = tmp_path / "p.txt"
    blank.write_text("   \n")
    args = types.SimpleNamespace(
        prompt_file=str(blank), out_dir=str(tmp_path), engine="mlx",
        diarize=False, infile="x.wav", keep_audio=False, cache_dir=None,
        language="ru", glossary="", summarize=True, template="", db=None,
        mic=None, system=None, author_name="Автор")
    backend.cmd_process(args)
    assert "краткую структурированную сводку" in captured["prompt"]


def test_cmd_process_forwards_user_prompt(monkeypatch, tmp_path):
    captured = {}
    monkeypatch.setattr(backend.Pipeline, "process",
                        lambda self, a, p, keep_audio_in_obsidian=True, mic_file=None, system_file=None: captured.update(p=p))
    pf = tmp_path / "p.txt"
    pf.write_text("МОЙ КАСТОМНЫЙ ПРОМПТ")
    args = types.SimpleNamespace(
        prompt_file=str(pf), out_dir=str(tmp_path), engine="mlx",
        diarize=True, infile="x.wav", keep_audio=False, cache_dir=None,
        language="ru", glossary="", summarize=True, template="", db=None,
        mic=None, system=None, author_name="Автор")
    backend.cmd_process(args)
    assert captured["p"] == "МОЙ КАСТОМНЫЙ ПРОМПТ"


# ── diarization HF_TOKEN guard (critic CRITICAL fix) ────────────────────────
def test_diarize_skipped_without_hf_token(pipe):
    pipe.HF_TOKEN = None
    # returns None before importing pyannote/torch — no heavy deps touched
    assert pipe.diarize("whatever.wav") is None


# ── process() wiring, heavy methods mocked (critic HIGH/MEDIUM fixes) ───────
def _mock_pipe(monkeypatch, out_dir, transcribe_ret, summary_ret):
    pipe = backend.Pipeline(out_dir=out_dir, diarize=False)
    monkeypatch.setattr(pipe, "convert_to_mono", lambda f: f)
    monkeypatch.setattr(pipe, "remove_silence_vad", lambda f: (f, None))
    monkeypatch.setattr(pipe, "transcribe", lambda f: transcribe_ret)
    monkeypatch.setattr(pipe, "summarize", lambda t, p: summary_ret)
    monkeypatch.setattr(pipe, "generate_title", lambda t: "")           # no live LLM in tests
    monkeypatch.setattr(pipe, "infer_speaker_names", lambda t: {})
    monkeypatch.setattr(pipe, "extract_actions", lambda t: {})
    return pipe


def test_process_preserves_source_extension(monkeypatch, tmp_path):
    src = tmp_path / "input.m4a"
    src.write_bytes(b"FAKEAUDIO")
    vault = tmp_path / "vault"
    long_summary = "# Сводка\n\n" + ("итог " * 30)
    pipe = _mock_pipe(
        monkeypatch, str(vault),
        {"segments": [seg("привет команда", 0, 3)], "text": "привет команда"},
        long_summary)
    events = capture(pipe.process, str(src), "мой промпт")
    done = [e for e in events if e["event"] == "done"][0]
    assert done["audio"].endswith(".m4a")            # extension preserved, not forced .wav
    assert Path(done["audio"]).exists()              # copied into vault
    assert Path(done["note"]).exists()
    assert "привет команда" in done["transcript"]
    assert done["summary"].startswith("# Сводка")
    # every stage reported ok; diarize skipped (disabled)
    ends = {e["stage"]: e["status"] for e in events if e["event"] == "stage_end"}
    assert ends["transcribe"] == "ok"
    assert ends["llm"] == "ok"
    assert ends["save"] == "ok"
    assert ends["diarize"] == "skip"


def test_process_marks_llm_failed_when_no_summary(monkeypatch, tmp_path):
    # transcript fine, but LM Studio gives nothing → llm stage must be 'fail', still done
    src = tmp_path / "in.wav"
    src.write_bytes(b"x")
    pipe = _mock_pipe(
        monkeypatch, str(tmp_path / "v"),
        {"segments": [seg("какой-то текст встречи", 0, 4)], "text": "x"}, None)
    events = capture(pipe.process, str(src), "p")
    ends = {e["stage"]: e["status"] for e in events if e["event"] == "stage_end"}
    assert ends["transcribe"] == "ok"
    assert ends["llm"] == "fail"            # the bug the user reported: no longer shows green
    assert "done" in [e["event"] for e in events]


def test_cache_resume_skips_transcribe_on_rerun(monkeypatch, tmp_path):
    src = tmp_path / "in.wav"
    src.write_bytes(b"x")
    cache = tmp_path / "cache"
    calls = {"n": 0}

    def fake_transcribe(self, f):
        calls["n"] += 1
        return {"segments": [seg("кэш тест встречи", 0, 3)], "text": "x"}

    monkeypatch.setattr(backend.Pipeline, "transcribe", fake_transcribe)

    def fresh_pipe():
        p = backend.Pipeline(out_dir=str(tmp_path / "v"), diarize=False, cache_dir=str(cache))
        monkeypatch.setattr(p, "convert_to_mono", lambda f: f)
        monkeypatch.setattr(p, "remove_silence_vad", lambda f: (f, None))
        monkeypatch.setattr(p, "summarize", lambda t, pr: None)
        return p

    capture(fresh_pipe().process, str(src), "p")          # first run → transcribes + caches
    events = capture(fresh_pipe().process, str(src), "p")  # second run → resumes from cache

    assert calls["n"] == 1  # transcribe ran ONCE; rerun used the cache
    ends = {e["stage"]: e for e in events if e["event"] == "stage_end"}
    assert "кеша" in ends["transcribe"]["msg"]
    assert "done" in [e["event"] for e in events]


def test_cache_write_atomic_roundtrip(tmp_path):
    p = tmp_path / "x.json"
    backend.Pipeline._cache_write(p, {"a": 1, "ru": "текст"})
    assert backend.Pipeline._cache_read(p) == {"a": 1, "ru": "текст"}
    assert not (tmp_path / "x.json.tmp").exists()  # no leftover tmp


def test_cache_read_busts_corrupt_file(tmp_path):
    p = tmp_path / "transcribe.json"
    p.write_text("{half-written, not valid", encoding="utf-8")  # simulate kill mid-write
    assert backend.Pipeline._cache_read(p) is None
    assert not p.exists()  # corrupt entry deleted so the stage recomputes


def test_corrupt_cache_triggers_recompute(monkeypatch, tmp_path):
    src = tmp_path / "in.wav"
    src.write_bytes(b"x")
    cache = tmp_path / "cache"
    cache.mkdir()
    calls = {"n": 0}
    monkeypatch.setattr(backend.Pipeline, "transcribe",
                        lambda self, f: (calls.__setitem__("n", calls["n"] + 1)
                                         or {"segments": [seg("ок", 0, 2)], "text": "x"}))
    (cache / "transcribe.json").write_text("CORRUPT", encoding="utf-8")
    p = backend.Pipeline(out_dir=str(tmp_path / "v"), diarize=False, cache_dir=str(cache))
    monkeypatch.setattr(p, "convert_to_mono", lambda f: f)
    monkeypatch.setattr(p, "remove_silence_vad", lambda f: (f, None))
    monkeypatch.setattr(p, "summarize", lambda t, pr: None)
    capture(p.process, str(src), "prompt")
    assert calls["n"] == 1  # corrupt cache was busted → transcription actually ran


def test_transcript_only_skips_llm(monkeypatch, tmp_path):
    src = tmp_path / "in.wav"
    src.write_bytes(b"x")
    summarize_calls = {"n": 0}
    p = backend.Pipeline(out_dir=str(tmp_path / "v"), diarize=False, do_summary=False)
    monkeypatch.setattr(p, "convert_to_mono", lambda f: f)
    monkeypatch.setattr(p, "remove_silence_vad", lambda f: (f, None))
    monkeypatch.setattr(p, "transcribe", lambda f: {"segments": [seg("текст встречи", 0, 4)], "text": "x"})
    monkeypatch.setattr(p, "summarize", lambda t, pr: summarize_calls.__setitem__("n", 1))
    events = capture(p.process, str(src), "prompt")
    ends = {e["stage"]: e for e in events if e["event"] == "stage_end"}
    assert ends["llm"]["status"] == "skip"
    assert summarize_calls["n"] == 0   # LLM never called
    done = [e for e in events if e["event"] == "done"][0]
    assert "текст встречи" in done["transcript"]


def test_language_passed_to_cache_filename(tmp_path, monkeypatch):
    # en and ru transcripts cache to separate files (no cross-language reuse)
    p = backend.Pipeline(out_dir=str(tmp_path / "v"), diarize=False,
                         cache_dir=str(tmp_path / "c"), language="en")
    assert p._cache("transcribe-en.json").name == "transcribe-en.json"


# ── glossary → Whisper initial_prompt + cache key ───────────────────────────
def install_fake_mlx_whisper(monkeypatch):
    fake = types.ModuleType("mlx_whisper")
    calls = {}

    def transcribe(audio, **kwargs):
        calls["audio"] = audio
        calls["kwargs"] = kwargs
        return {"segments": [], "text": ""}

    fake.transcribe = transcribe
    monkeypatch.setitem(sys.modules, "mlx_whisper", fake)
    return calls


def test_empty_glossary_leaves_initial_prompt_unchanged(monkeypatch, tmp_path):
    calls = install_fake_mlx_whisper(monkeypatch)
    p = backend.Pipeline(out_dir=str(tmp_path / "v"), diarize=False, language="ru")
    p.transcribe("mono.wav")
    assert calls["kwargs"]["initial_prompt"] == backend.Pipeline.CONTEXT_PROMPT_RU


def test_glossary_appended_to_initial_prompt(monkeypatch, tmp_path):
    calls = install_fake_mlx_whisper(monkeypatch)
    p = backend.Pipeline(out_dir=str(tmp_path / "v"), diarize=False, language="ru",
                         glossary="Иван Петров, Mindbox\nClickHouse")
    p.transcribe("mono.wav")
    prompt = calls["kwargs"]["initial_prompt"]
    assert backend.Pipeline.CONTEXT_PROMPT_RU in prompt
    assert "Термины: Иван Петров, Mindbox, ClickHouse." in prompt


def test_glossary_alone_used_when_language_auto(monkeypatch, tmp_path):
    # auto → no language-biased context prompt, so glossary is the whole initial_prompt
    calls = install_fake_mlx_whisper(monkeypatch)
    p = backend.Pipeline(out_dir=str(tmp_path / "v"), diarize=False, language="auto",
                         glossary="Kubernetes")
    p.transcribe("mono.wav")
    assert calls["kwargs"]["initial_prompt"] == "Термины: Kubernetes."


def test_glossary_blank_terms_ignored():
    p = backend.Pipeline(out_dir="/tmp/mr-test-out", diarize=False, glossary=" , \n ,")
    assert p._glossary_prompt() is None
    assert p._glossary_cache_suffix() == ""


def test_glossary_empty_cache_suffix_is_blank(tmp_path):
    p = backend.Pipeline(out_dir=str(tmp_path / "v"), diarize=False, language="ru")
    assert p._glossary_cache_suffix() == ""
    assert f"transcribe-{p.LANGUAGE}{p._glossary_cache_suffix()}.json" == "transcribe-ru.json"


def test_glossary_cache_suffix_deterministic_and_distinguishing(tmp_path):
    p1 = backend.Pipeline(out_dir=str(tmp_path / "v"), diarize=False, language="ru",
                          glossary="Иван, Mindbox")
    p2 = backend.Pipeline(out_dir=str(tmp_path / "v"), diarize=False, language="ru",
                          glossary="Иван, Mindbox")
    p3 = backend.Pipeline(out_dir=str(tmp_path / "v"), diarize=False, language="ru",
                          glossary="Другие термины")
    assert p1._glossary_cache_suffix() != ""
    assert p1._glossary_cache_suffix() == p2._glossary_cache_suffix()  # same glossary → same key
    assert p1._glossary_cache_suffix() != p3._glossary_cache_suffix()  # different glossary → different key


def test_glossary_change_busts_transcribe_cache(monkeypatch, tmp_path):
    # mirrors test_cache_resume_skips_transcribe_on_rerun, but changes glossary between
    # runs — a stale cached transcript must NOT be served across a glossary change.
    src = tmp_path / "in.wav"
    src.write_bytes(b"x")
    cache = tmp_path / "cache"
    calls = {"n": 0}

    def fake_transcribe(self, f):
        calls["n"] += 1
        return {"segments": [seg("кэш тест встречи", 0, 3)], "text": "x"}

    monkeypatch.setattr(backend.Pipeline, "transcribe", fake_transcribe)

    def mk(glossary):
        p = backend.Pipeline(out_dir=str(tmp_path / "v"), diarize=False, cache_dir=str(cache),
                             glossary=glossary)
        monkeypatch.setattr(p, "convert_to_mono", lambda f: f)
        monkeypatch.setattr(p, "remove_silence_vad", lambda f: (f, None))
        monkeypatch.setattr(p, "summarize", lambda t, pr: None)
        # non-empty glossary now flows through the `correct` stage's Stage-2 LLM
        # call; stub it out (real localhost:1234 would hit CI network timeouts) —
        # this test is only about the transcribe cache key, not correction.
        monkeypatch.setattr(p, "correct_glossary_llm", lambda segs, terms: (segs, 0))
        return p

    capture(mk("").process, str(src), "p")         # baseline run, no glossary
    capture(mk("Mindbox").process, str(src), "p")  # glossary changed → must not reuse baseline cache

    assert calls["n"] == 2  # transcribe ran again — the glossary change invalidated the cache key


def test_cmd_process_forwards_glossary_to_pipeline(monkeypatch, tmp_path):
    captured = {}
    orig_init = backend.Pipeline.__init__

    def spy_init(self, *a, **kw):
        captured["glossary"] = kw.get("glossary")
        orig_init(self, *a, **kw)

    monkeypatch.setattr(backend.Pipeline, "__init__", spy_init)
    monkeypatch.setattr(backend.Pipeline, "process",
                        lambda self, a, p, keep_audio_in_obsidian=True, mic_file=None, system_file=None: None)
    args = types.SimpleNamespace(
        prompt_file=None, out_dir=str(tmp_path), engine="mlx",
        diarize=False, infile="x.wav", keep_audio=False, cache_dir=None,
        language="ru", glossary="Иван Петров, Mindbox", summarize=True, template="", db=None,
        mic=None, system=None, author_name="Автор")
    backend.cmd_process(args)
    assert captured["glossary"] == "Иван Петров, Mindbox"


def test_copy_atomic_roundtrip_no_tmp_left(tmp_path):
    src = tmp_path / "s.bin"; src.write_bytes(b"meeting-audio" * 50)
    dst = tmp_path / "d.wav"
    backend.Pipeline._copy_atomic(str(src), str(dst))
    assert dst.read_bytes() == b"meeting-audio" * 50
    assert not (tmp_path / "d.wav.tmp").exists()  # atomic: no leftover temp


def test_process_language_suffix_keeps_notes_separate(monkeypatch, tmp_path):
    src = tmp_path / "in.wav"; src.write_bytes(b"x")

    def mk(lang):
        p = backend.Pipeline(out_dir=str(tmp_path / "v"), diarize=False, language=lang)
        monkeypatch.setattr(p, "convert_to_mono", lambda f: f)
        monkeypatch.setattr(p, "remove_silence_vad", lambda f: (f, None))
        monkeypatch.setattr(p, "transcribe", lambda f: {"segments": [seg("hi", 0, 2)], "text": "x"})
        monkeypatch.setattr(p, "summarize", lambda t, pr: None)
        return p

    en_note = [e for e in capture(mk("en").process, str(src), "p") if e["event"] == "done"][0]["note"]
    ru_note = [e for e in capture(mk("ru").process, str(src), "p") if e["event"] == "done"][0]["note"]
    assert en_note.endswith("-en.md")                  # en note distinct
    assert ru_note.endswith(".md") and "-en" not in ru_note  # ru note not overwritten by en


def test_process_survives_failed_transcription(monkeypatch, tmp_path):
    # transcribe() returns None → must not AttributeError, must still emit done
    src = tmp_path / "in.wav"
    src.write_bytes(b"x")
    pipe = _mock_pipe(monkeypatch, str(tmp_path / "v"), None, None)
    events = capture(pipe.process, str(src), "p")
    kinds = [e["event"] for e in events]
    assert "done" in kinds
    assert "error" not in kinds
    ends = {e["stage"]: e["status"] for e in events if e["event"] == "stage_end"}
    assert ends["transcribe"] == "fail"     # no segments → red
    assert ends["llm"] == "fail"


# ── RAG helpers ─────────────────────────────────────────────────────────────

def install_fake_requests_rag(monkeypatch, *, get_payload=None, post_payload=None,
                               embed_payload=None, post_raise=None, get_raise=None):
    """More capable fake that handles both GET and POST for RAG tests.

    get_payload   : returned for every GET (e.g. /v1/models response)
    embed_payload : returned for POST /v1/embeddings  (takes priority over post_payload)
    post_payload  : returned for all other POST calls (e.g. /v1/chat/completions)
    post_raise    : raise this exception on chat POST
    get_raise     : raise this exception on GET
    """
    import struct
    fake = types.ModuleType("requests")
    calls = {"post_urls": [], "get_urls": [], "post_jsons": []}

    class Resp:
        def __init__(self, status, payload):
            self.status_code = status
            self._payload = payload
        def json(self):
            return self._payload

    def get(url, timeout=None):
        calls["get_urls"].append(url)
        if get_raise:
            raise get_raise
        return Resp(200, get_payload or {})

    def post(url, json=None, timeout=None):
        calls["post_urls"].append(url)
        calls["post_jsons"].append(json)
        if post_raise:
            raise post_raise
        if embed_payload is not None and "embeddings" in url:
            return Resp(200, embed_payload)
        return Resp(200, post_payload or {})

    fake.get = get
    fake.post = post
    monkeypatch.setitem(sys.modules, "requests", fake)
    return calls


def _make_embed_payload(n_vecs=1, dim=4):
    """Build a fake /v1/embeddings response with unit-vector embeddings."""
    import struct, math
    # create a simple unit vector [1,0,0,0]
    data = []
    for i in range(n_vecs):
        vec = [0.0] * dim
        vec[i % dim] = 1.0
        data.append({"embedding": vec, "index": i})
    return {"data": data}


def _make_fake_vault(tmp_path, notes):
    """Write .md files into tmp_path/vault and return the vault path.
    notes: list of (filename, content) tuples."""
    vault = tmp_path / "vault"
    vault.mkdir()
    for name, content in notes:
        (vault / name).write_text(content, encoding="utf-8")
    return vault


def test_rag_chunk_text_basic():
    text = "a" * 5000
    chunks = backend._rag_chunk_text(text, chunk_chars=2000, overlap_chars=200)
    assert len(chunks) >= 2
    for idx, c in chunks:
        assert len(c) <= 2000
    # overlap: second chunk starts before first ends
    assert chunks[1][1][:100] == text[1800:1900]  # overlap of 200 chars


def test_rag_chunk_text_short_note():
    chunks = backend._rag_chunk_text("short note", chunk_chars=2000, overlap_chars=200)
    assert len(chunks) == 1
    assert chunks[0] == (0, "short note")


def test_rag_chunk_text_empty():
    assert backend._rag_chunk_text("") == []
    assert backend._rag_chunk_text("   ") == []


def test_rag_cosine_identical():
    import struct
    v = struct.pack("4f", 1.0, 0.0, 0.0, 0.0)
    assert abs(backend._rag_cosine(v, v) - 1.0) < 1e-6


def test_rag_cosine_orthogonal():
    import struct
    a = struct.pack("4f", 1.0, 0.0, 0.0, 0.0)
    b = struct.pack("4f", 0.0, 1.0, 0.0, 0.0)
    assert abs(backend._rag_cosine(a, b)) < 1e-6


def test_rag_cosine_zero_vector():
    import struct
    z = struct.pack("4f", 0.0, 0.0, 0.0, 0.0)
    v = struct.pack("4f", 1.0, 0.0, 0.0, 0.0)
    assert backend._rag_cosine(z, v) == 0.0


def test_rag_db_ensure_creates_tables(tmp_path):
    import sqlite3
    db = str(tmp_path / "r.db")
    conn = backend._db_connect(db)
    backend._rag_db_ensure(conn)
    tables = {r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' OR type='shadow'").fetchall()}
    assert "chunks" in tables
    conn.close()


def test_cmd_index_writes_chunks_and_skips_unchanged(monkeypatch, tmp_path):
    """First index run writes chunks; second run with same mtime skips the note."""
    vault = _make_fake_vault(tmp_path, [
        ("note1.md",
         '---\ntitle: "Встреча"\ndate: "2026-01-01"\n---\n\nОбсудили релиз и дорожную карту.\n'),
    ])
    db = str(tmp_path / "rag.db")

    models_payload = {"data": [{"id": "text-embedding-all-minilm-v2"}]}
    embed_payload = _make_embed_payload(n_vecs=1, dim=4)
    chat_payload = {"choices": [{"message": {"content": "Ответ"}}]}

    calls = install_fake_requests_rag(
        monkeypatch,
        get_payload=models_payload,
        embed_payload=embed_payload,
        post_payload=chat_payload,
    )

    events = capture(backend.cmd_index, str(vault), db)
    indexed_ev = [e for e in events if e["event"] == "indexed"][0]
    assert indexed_ev["indexed"] == 1
    assert indexed_ev["skipped"] == 0

    # Verify chunks were written
    import sqlite3
    conn = sqlite3.connect(db)
    rows = conn.execute("SELECT note_path, idx FROM chunks").fetchall()
    conn.close()
    assert len(rows) >= 1
    assert rows[0][0].endswith("note1.md")

    # Second run — mtime unchanged → skipped
    events2 = capture(backend.cmd_index, str(vault), db)
    indexed_ev2 = [e for e in events2 if e["event"] == "indexed"][0]
    assert indexed_ev2["indexed"] == 0
    assert indexed_ev2["skipped"] == 1


def test_cmd_index_removes_deleted_note(monkeypatch, tmp_path):
    """After a note is deleted from disk, re-indexing removes its chunks."""
    vault = _make_fake_vault(tmp_path, [
        ("note_del.md", '---\ntitle: "Удалённая"\ndate: "2026-01-02"\n---\n\nТекст который потом удалим.\n'),
    ])
    db = str(tmp_path / "rag.db")

    models_payload = {"data": [{"id": "text-embedding-all-minilm-v2"}]}
    embed_payload = _make_embed_payload(n_vecs=1, dim=4)

    install_fake_requests_rag(monkeypatch, get_payload=models_payload, embed_payload=embed_payload)
    capture(backend.cmd_index, str(vault), db)

    # Confirm indexed
    import sqlite3
    conn = sqlite3.connect(db)
    assert conn.execute("SELECT COUNT(*) FROM chunks").fetchone()[0] >= 1
    conn.close()

    # Delete the note and re-index
    (vault / "note_del.md").unlink()
    install_fake_requests_rag(monkeypatch, get_payload=models_payload, embed_payload=embed_payload)
    events = capture(backend.cmd_index, str(vault), db)
    removed_ev = [e for e in events if e["event"] == "indexed"][0]
    assert removed_ev["removed"] == 1

    conn = sqlite3.connect(db)
    assert conn.execute("SELECT COUNT(*) FROM chunks").fetchone()[0] == 0
    conn.close()


def test_cmd_index_logs_fts_optimize_failure(monkeypatch, tmp_path):
    """FTS5 'optimize' failing must stay non-fatal (indexing still completes) but must
    now be logged instead of silently swallowed by the bare `except Exception: pass`."""
    vault = _make_fake_vault(tmp_path, [
        ("note1.md", '---\ntitle: "Встреча"\ndate: "2026-01-01"\n---\n\nТекст заметки.\n'),
    ])
    db = str(tmp_path / "rag.db")

    models_payload = {"data": [{"id": "text-embedding-all-minilm-v2"}]}
    embed_payload = _make_embed_payload(n_vecs=1, dim=4)
    install_fake_requests_rag(monkeypatch, get_payload=models_payload, embed_payload=embed_payload)

    # sqlite3.Connection is an immutable C type — its methods can't be monkeypatched
    # in place, so wrap the real connection instead and patch the connect() factory.
    import sqlite3
    real_connect = sqlite3.connect

    class _FlakyConn:
        def __init__(self, real_conn):
            self._real = real_conn

        def execute(self, sql, *a, **k):
            if "optimize" in sql:
                raise sqlite3.OperationalError("simulated optimize failure")
            return self._real.execute(sql, *a, **k)

        def __getattr__(self, name):
            return getattr(self._real, name)

    monkeypatch.setattr(sqlite3, "connect", lambda *a, **k: _FlakyConn(real_connect(*a, **k)))

    events = capture(backend.cmd_index, str(vault), db)

    # Non-fatal: the run still finishes and reports its summary.
    indexed_events = [e for e in events if e["event"] == "indexed"]
    assert len(indexed_events) == 1

    # But the failure must now surface as a log line, not disappear silently.
    log_msgs = [e["msg"] for e in events if e["event"] == "log"]
    assert any("optimize" in m.lower() for m in log_msgs), \
        f"expected a log line mentioning the optimize failure, got: {log_msgs}"


def test_cmd_search_short_circuit_no_matches(monkeypatch, tmp_path):
    """No FTS hits + best cosine < threshold → found=False, LLM NOT called."""
    vault = _make_fake_vault(tmp_path, [])
    db = str(tmp_path / "rag.db")

    # Index is empty; we still need embed model discovery + query embedding
    models_payload = {"data": [{"id": "text-embedding-all-minilm-v2"}]}
    embed_payload = _make_embed_payload(n_vecs=1, dim=4)
    chat_payload = {"choices": [{"message": {"content": "ЭТО НЕ ДОЛЖНО ВЫЗВАТЬСЯ"}}]}

    calls = install_fake_requests_rag(
        monkeypatch,
        get_payload=models_payload,
        embed_payload=embed_payload,
        post_payload=chat_payload,
    )

    # Pre-create the DB so _rag_db_ensure doesn't fail
    conn = backend._db_connect(db)
    backend._rag_db_ensure(conn)
    conn.close()

    events = capture(backend.cmd_search, str(vault), db, "нерелевантный запрос xyz")
    result = [e for e in events if e["event"] == "search_result"][0]

    assert result["found"] is False
    assert result["answer"] == backend._RAG_NOT_FOUND
    assert result["citations"] == []

    # LLM (chat completions) must NOT have been called
    chat_calls = [u for u in calls["post_urls"] if "chat" in u]
    assert chat_calls == [], f"LLM was called unexpectedly: {chat_calls}"


def test_cmd_search_happy_path(monkeypatch, tmp_path):
    """Relevant chunk present → LLM called → found=True, citations populated."""
    import struct

    vault = _make_fake_vault(tmp_path, [
        ("meeting-2026-06-01.md",
         '---\ntitle: "Планирование спринта"\ndate: "2026-06-01"\n---\n\n'
         'Обсудили задачи на следующий спринт. Решили добавить RAG-поиск.\n'),
    ])
    db = str(tmp_path / "rag.db")
    models_payload = {"data": [{"id": "text-embedding-all-minilm-v2"}]}

    # Use a 4-dim space. Index note with vec [1,0,0,0], query also [1,0,0,0] → cosine=1.0
    note_emb = _make_embed_payload(n_vecs=1, dim=4)   # [1,0,0,0]
    query_emb = _make_embed_payload(n_vecs=1, dim=4)  # same → cosine=1.0
    answer_text = "RAG-поиск запланирован на следующий спринт [2026-06-01 · Планирование спринта]."

    # Index the note first (uses embed_payload for note chunks)
    install_fake_requests_rag(monkeypatch, get_payload=models_payload, embed_payload=note_emb)
    capture(backend.cmd_index, str(vault), db)

    # Now search — embed_payload returns same unit vec as query → cosine=1.0 > threshold
    install_fake_requests_rag(
        monkeypatch,
        get_payload=models_payload,
        embed_payload=query_emb,
        post_payload={"choices": [{"message": {"content": answer_text}}]},
    )
    events = capture(backend.cmd_search, str(vault), db, "что решили про RAG")
    result = [e for e in events if e["event"] == "search_result"][0]

    assert result["found"] is True
    assert result["answer"] == answer_text
    assert len(result["citations"]) >= 1
    assert result["citations"][0]["date"] == "2026-06-01"
    assert result["citations"][0]["title"] == "Планирование спринта"


def test_cmd_search_via_messages_single_turn(monkeypatch, tmp_path):
    """--messages with a single user turn is identical to --query (no rewrite LLM call)."""
    import struct

    vault = _make_fake_vault(tmp_path, [
        ("meeting-2026-06-10.md",
         '---\ntitle: "Синк по релизу"\ndate: "2026-06-10"\n---\n\nРешили выпустить v2 в июле.\n'),
    ])
    db = str(tmp_path / "rag.db")
    models_payload = {"data": [{"id": "text-embedding-all-minilm-v2"}]}
    embed_payload = _make_embed_payload(n_vecs=1, dim=4)
    answer_text = "v2 запланирован на июль [2026-06-10 · Синк по релизу]."

    # Index the vault
    install_fake_requests_rag(monkeypatch, get_payload=models_payload, embed_payload=embed_payload)
    capture(backend.cmd_index, str(vault), db)

    calls = install_fake_requests_rag(
        monkeypatch,
        get_payload=models_payload,
        embed_payload=embed_payload,
        post_payload={"choices": [{"message": {"content": answer_text}}]},
    )
    messages = [{"role": "user", "content": "когда выходит v2"}]
    events = capture(backend.cmd_search, str(vault), db, messages=messages)
    result = [e for e in events if e["event"] == "search_result"][0]

    assert result["found"] is True
    assert result["answer"] == answer_text
    # Single turn → NO rewrite call (only embed GET + query embed POST + answer POST)
    chat_calls = [u for u in calls["post_urls"] if "chat" in u]
    assert len(chat_calls) == 1, f"single-turn must make exactly 1 chat call (answer), got: {chat_calls}"


def test_cmd_search_multi_turn_fires_rewrite(monkeypatch, tmp_path):
    """Multi-turn conversation triggers the query-rewrite LLM call before retrieval."""
    import struct

    vault = _make_fake_vault(tmp_path, [
        ("meeting-2026-07-01.md",
         '---\ntitle: "1-1 с Петей"\ndate: "2026-07-01"\n---\n\nОбсудили задачи на спринт.\n'),
    ])
    db = str(tmp_path / "rag.db")
    models_payload = {"data": [{"id": "text-embedding-all-minilm-v2"}]}
    embed_payload = _make_embed_payload(n_vecs=1, dim=4)
    rewrite_text = "задачи спринта с Петей"
    answer_text = "Задачи спринта обсуждались [2026-07-01 · 1-1 с Петей]."

    # Index the vault
    install_fake_requests_rag(monkeypatch, get_payload=models_payload, embed_payload=embed_payload)
    capture(backend.cmd_index, str(vault), db)

    # For multi-turn: first chat POST = rewrite, second chat POST = answer
    post_responses = iter([
        {"choices": [{"message": {"content": rewrite_text}}]},     # rewrite call
        {"choices": [{"message": {"content": answer_text}}]},       # answer call
    ])

    import types as _types
    fake = _types.ModuleType("requests")
    calls = {"post_urls": [], "get_urls": [], "post_jsons": []}

    class Resp:
        def __init__(self, status, payload):
            self.status_code = status
            self._payload = payload
        def json(self):
            return self._payload

    def _get(url, timeout=None):
        calls["get_urls"].append(url)
        return Resp(200, models_payload)

    def _post(url, json=None, timeout=None):
        calls["post_urls"].append(url)
        calls["post_jsons"].append(json)
        if "embeddings" in url:
            return Resp(200, embed_payload)
        return Resp(200, next(post_responses))

    fake.get = _get
    fake.post = _post
    monkeypatch.setitem(__import__("sys").modules, "requests", fake)

    messages = [
        {"role": "user", "content": "что обсуждали с Петей?"},
        {"role": "assistant", "content": "Обсуждали задачи на спринт."},
        {"role": "user", "content": "а конкретнее"},
    ]
    events = capture(backend.cmd_search, str(vault), db, messages=messages)
    result = [e for e in events if e["event"] == "search_result"][0]

    assert result["found"] is True
    assert result["answer"] == answer_text
    # Must have made exactly 2 chat calls: rewrite + answer
    chat_calls = [u for u in calls["post_urls"] if "chat" in u]
    assert len(chat_calls) == 2, f"multi-turn must make 2 chat calls (rewrite + answer), got: {chat_calls}"
    # Verify the first chat call (rewrite) contained the conversation history
    rewrite_body = calls["post_jsons"][[i for i, u in enumerate(calls["post_urls"]) if "chat" in u][0]]
    rewrite_msgs = rewrite_body.get("messages", [])
    user_content = " ".join(m.get("content", "") for m in rewrite_msgs)
    assert "что обсуждали с Петей" in user_content or "а конкретнее" in user_content


def test_cmd_search_multi_turn_short_circuit_no_answer_call(monkeypatch, tmp_path):
    """Multi-turn: rewrite may fire but empty retrieval short-circuits before answer call."""
    vault = _make_fake_vault(tmp_path, [])
    db = str(tmp_path / "rag.db")
    models_payload = {"data": [{"id": "text-embedding-all-minilm-v2"}]}
    embed_payload = _make_embed_payload(n_vecs=1, dim=4)
    rewrite_text = "какой-то переформулированный запрос"

    conn = backend._db_connect(db)
    backend._rag_db_ensure(conn)
    conn.close()

    post_call_count = {"n": 0}

    import types as _types
    fake = _types.ModuleType("requests")

    class Resp:
        def __init__(self, p):
            self.status_code = 200
            self._p = p
        def json(self):
            return self._p

    def _get(url, timeout=None):
        return Resp(models_payload)

    def _post(url, json=None, timeout=None):
        post_call_count["n"] += 1
        if "embeddings" in url:
            return Resp(embed_payload)
        # Only the rewrite call should reach here (answer call must be short-circuited)
        return Resp({"choices": [{"message": {"content": rewrite_text}}]})

    fake.get = _get
    fake.post = _post
    monkeypatch.setitem(__import__("sys").modules, "requests", fake)

    messages = [
        {"role": "user", "content": "первый вопрос"},
        {"role": "assistant", "content": "Первый ответ."},
        {"role": "user", "content": "второй вопрос xyz_notexist"},
    ]
    events = capture(backend.cmd_search, str(vault), db, messages=messages)
    result = [e for e in events if e["event"] == "search_result"][0]

    # Short-circuit after empty retrieval → found=False
    assert result["found"] is False
    assert result["answer"] == backend._RAG_NOT_FOUND
    assert result["citations"] == []
    # Rewrite fires (1 chat POST) but answer does NOT (total chat posts = 1)
    assert post_call_count["n"] <= 2, \
        f"at most 2 POSTs expected (1 rewrite + 1 embed), got {post_call_count['n']}"


def test_cmd_search_embeddings_unavailable_no_crash(monkeypatch, tmp_path):
    """When no embedding model is available, cmd_search must not crash and must return
    a search_result event.  It may short-circuit (found=False) if neither FTS nor vector
    finds anything — that is acceptable degraded behaviour.  The important invariant is:
    (a) no unhandled exception, (b) exactly one search_result event emitted,
    (c) LLM is NOT called when there are no candidates (short-circuit fires).
    """
    vault = _make_fake_vault(tmp_path, [
        ("note_fts.md",
         '---\ntitle: "FTS тест"\ndate: "2026-05-01"\n---\n\nОбсудили дорожную карту.\n'),
    ])
    db = str(tmp_path / "rag.db")

    # Pre-create an empty RAG db so cmd_search doesn't fail on missing tables
    conn = backend._db_connect(db)
    backend._rag_db_ensure(conn)
    conn.close()

    # Search with no embedding model and empty db → must short-circuit cleanly
    install_fake_requests_rag(
        monkeypatch,
        get_payload={"data": []},          # no embed model → query_emb=None
        embed_payload={"data": []},
        post_payload={"choices": [{"message": {"content": "SHOULD NOT BE CALLED"}}]},
    )
    calls = install_fake_requests_rag(
        monkeypatch,
        get_payload={"data": []},
        embed_payload={"data": []},
        post_payload={"choices": [{"message": {"content": "SHOULD NOT BE CALLED"}}]},
    )
    events = capture(backend.cmd_search, str(vault), db, "дорожная карта")
    results = [e for e in events if e["event"] == "search_result"]
    assert len(results) == 1, f"expected 1 search_result event, got: {events}"
    result = results[0]
    # Short-circuit: no matches → found=False, no LLM call
    assert result["found"] is False
    assert result["answer"] == backend._RAG_NOT_FOUND
    assert result["citations"] == []
    chat_calls = [u for u in calls["post_urls"] if "chat" in u]
    assert chat_calls == [], f"LLM must not be called on empty result set: {chat_calls}"


def test_fts_query_with_quote_in_token_does_not_break_retrieval(monkeypatch, tmp_path):
    """A query token containing a literal double-quote must not produce a malformed FTS5
    phrase.  Before the fix the f'"{w}"' builder left the inner quote bare → MATCH raised
    → fts_keys silently emptied.  After the fix (w.replace('"', '""')) the quote is
    escaped and FTS still returns the chunk matched by the valid adjacent token."""
    vault = _make_fake_vault(tmp_path, [
        ("meeting-fts-quote.md",
         '---\ntitle: "Тест кавычки"\ndate: "2026-06-01"\n---\n\nОбсудили релиз дорожная.\n'),
    ])
    db = str(tmp_path / "rag.db")

    models_payload = {"data": [{"id": "text-embedding-all-minilm-v2"}]}
    embed_payload = _make_embed_payload(n_vecs=1, dim=4)

    # Index the vault (without embedding model — we only care about FTS here)
    install_fake_requests_rag(monkeypatch, get_payload=models_payload, embed_payload=embed_payload)
    capture(backend.cmd_index, str(vault), db)

    # Search with a query that contains a token with a literal double-quote.
    # "дорожная" is a real word in the note; 'bad"token' contains the hazardous quote.
    # With the fix both tokens are safely escaped; FTS matches "дорожная" and returns
    # the chunk — fts_keys is non-empty, _rag_retrieve does NOT short-circuit.
    conn = backend._db_connect(db)
    backend._rag_db_ensure(conn)

    # Disable embeddings so the result depends solely on the FTS path.
    install_fake_requests_rag(
        monkeypatch,
        get_payload={"data": []},   # no embed model → query_emb=None
        embed_payload={"data": []},
    )

    candidates, short_circuit = backend._rag_retrieve(conn, 'bad"token дорожная', None)
    conn.close()

    # FTS matched "дорожная" → at least one candidate, NOT short-circuited
    assert not short_circuit, "FTS retrieval short-circuited unexpectedly (quote escaping broken?)"
    assert len(candidates) >= 1, "expected at least one FTS candidate for 'дорожная'"


# ── speakers frontmatter write + RAG citation ────────────────────────────────

def _mock_pipe_diarized(monkeypatch, out_dir, formatted_transcript, inferred_speakers):
    """Like _mock_pipe but with diarization enabled and controllable speaker data."""
    pipe = backend.Pipeline(out_dir=out_dir, diarize=True)
    monkeypatch.setattr(pipe, "convert_to_mono", lambda f: f)
    monkeypatch.setattr(pipe, "remove_silence_vad", lambda f: (f, None))
    monkeypatch.setattr(pipe, "transcribe",
                        lambda f: {"segments": [seg("hi", 0, 2)], "text": "hi"})
    monkeypatch.setattr(pipe, "diarize", lambda f: [{"start": 0, "end": 2, "speaker": "SPEAKER_00"}])
    monkeypatch.setattr(pipe, "combine", lambda segs, tl: (formatted_transcript, {}))
    monkeypatch.setattr(pipe, "summarize", lambda t, p: "# Сводка\n\n" + "итог " * 30)
    monkeypatch.setattr(pipe, "generate_title", lambda t: "Тестовая встреча")
    monkeypatch.setattr(pipe, "infer_speaker_names", lambda t: inferred_speakers)
    monkeypatch.setattr(pipe, "extract_actions", lambda t: {})
    return pipe


def test_process_writes_inferred_speaker_names_to_frontmatter(monkeypatch, tmp_path):
    """process() with inferred speaker names writes a non-empty speakers frontmatter key."""
    formatted = "**[Спикер 1]**: привет\n\n**[Спикер 2]**: пока"
    inferred = {"Спикер 1": "Алексей", "Спикер 2": "Мария"}
    pipe = _mock_pipe_diarized(monkeypatch, str(tmp_path / "v"), formatted, inferred)
    src = tmp_path / "in.wav"; src.write_bytes(b"x")
    capture(pipe.process, str(src), "prompt")
    note_text = list((tmp_path / "v").glob("*.md"))[0].read_text(encoding="utf-8")
    # Both inferred names must appear in the speakers frontmatter key
    assert 'speakers: "Алексей, Мария"' in note_text or 'speakers: "Мария, Алексей"' in note_text


def test_process_writes_raw_labels_when_no_names_inferred(monkeypatch, tmp_path):
    """process() with diarization but no inferred names writes raw speaker labels."""
    formatted = "**[Спикер 1]**: привет\n\n**[Спикер 2]**: пока"
    pipe = _mock_pipe_diarized(monkeypatch, str(tmp_path / "v"), formatted, {})
    src = tmp_path / "in.wav"; src.write_bytes(b"x")
    capture(pipe.process, str(src), "prompt")
    note_text = list((tmp_path / "v").glob("*.md"))[0].read_text(encoding="utf-8")
    # Raw labels must be present in the speakers frontmatter key
    assert 'speakers: "' in note_text
    assert "Спикер 1" in note_text or "Спикер 2" in note_text


def test_process_no_diarization_omits_speakers_key(monkeypatch, tmp_path):
    """process() without diarization must not write a speakers frontmatter key."""
    src = tmp_path / "in.wav"; src.write_bytes(b"x")
    pipe = _mock_pipe(monkeypatch, str(tmp_path / "v"),
                      {"segments": [seg("hi", 0, 2)], "text": "hi"}, None)
    capture(pipe.process, str(src), "prompt")
    note_text = list((tmp_path / "v").glob("*.md"))[0].read_text(encoding="utf-8")
    assert "speakers:" not in note_text


# ── process() ↔ action items wiring (note section + done payload) ──────────────
def test_process_appends_actions_section_and_done_payload(monkeypatch, tmp_path):
    """extract_actions() result must land in the note's '## Действия' section AND
    the done event's actions payload (backend.py process(): meta stage + add_actions_section)."""
    src = tmp_path / "in.wav"; src.write_bytes(b"x")
    long_summary = "# Сводка\n\n" + ("итог " * 30)
    pipe = _mock_pipe(
        monkeypatch, str(tmp_path / "v"),
        {"segments": [seg("обсудили план", 0, 3)], "text": "обсудили план"},
        long_summary)
    fake_actions = {
        "items": [{"what": "подготовить презентацию", "who": "Мария", "due": "среда"}],
        "decisions": ["перенести встречу на вторник"],
    }
    monkeypatch.setattr(pipe, "extract_actions", lambda t: fake_actions)
    events = capture(pipe.process, str(src), "prompt")
    done = [e for e in events if e["event"] == "done"][0]
    assert done["actions"] == fake_actions
    note_text = list((tmp_path / "v").glob("*.md"))[0].read_text(encoding="utf-8")
    assert "## Действия" in note_text
    assert "- [ ] подготовить презентацию — Мария (срок: среда)" in note_text
    assert "**Решения:**" in note_text
    assert "- перенести встречу на вторник" in note_text
    # actions section sits above the transcript section
    assert note_text.index("## Действия") < note_text.index("## 📄 Полный транскрипт")


def test_process_no_summary_mode_skips_actions_call(monkeypatch, tmp_path):
    """noSummary mode (do_summary=False): no extract_actions call, no section, empty done payload."""
    src = tmp_path / "in.wav"; src.write_bytes(b"x")
    calls = {"n": 0}
    p = backend.Pipeline(out_dir=str(tmp_path / "v"), diarize=False, do_summary=False)
    monkeypatch.setattr(p, "convert_to_mono", lambda f: f)
    monkeypatch.setattr(p, "remove_silence_vad", lambda f: (f, None))
    monkeypatch.setattr(p, "transcribe", lambda f: {"segments": [seg("текст встречи", 0, 4)], "text": "x"})
    monkeypatch.setattr(p, "extract_actions", lambda t: calls.__setitem__("n", calls["n"] + 1))
    events = capture(p.process, str(src), "prompt")
    assert calls["n"] == 0  # actions LLM call never made in transcript-only mode
    done = [e for e in events if e["event"] == "done"][0]
    assert done["actions"] == {}
    note_text = list((tmp_path / "v").glob("*.md"))[0].read_text(encoding="utf-8")
    assert "## Действия" not in note_text


def test_process_malformed_actions_output_degrades_without_crash(monkeypatch, tmp_path):
    """extract_actions() returning {} (malformed LLM JSON) → no section, no crash, done still emitted."""
    src = tmp_path / "in.wav"; src.write_bytes(b"x")
    long_summary = "# Сводка\n\n" + ("итог " * 30)
    pipe = _mock_pipe(
        monkeypatch, str(tmp_path / "v"),
        {"segments": [seg("обсудили план", 0, 3)], "text": "обсудили план"},
        long_summary)
    # extract_actions already degrades internally on bad LLM output to {}; simulate that here
    monkeypatch.setattr(pipe, "extract_actions", lambda t: {})
    events = capture(pipe.process, str(src), "prompt")
    assert "error" not in [e["event"] for e in events]
    done = [e for e in events if e["event"] == "done"][0]
    assert done["actions"] == {}
    note_text = list((tmp_path / "v").glob("*.md"))[0].read_text(encoding="utf-8")
    assert "## Действия" not in note_text


def test_cmd_search_citation_includes_speakers(monkeypatch, tmp_path):
    """After indexing a note with speakers frontmatter, _rag_retrieve returns non-empty speakers."""
    vault = _make_fake_vault(tmp_path, [
        ("meeting-2026-06-15.md",
         '---\ntitle: "Синк команды"\ndate: "2026-06-15"\nspeakers: "Алексей, Мария"\n---\n\n'
         'Обсудили дорожную карту продукта на квартал.\n'),
    ])
    db = str(tmp_path / "rag.db")
    models_payload = {"data": [{"id": "text-embedding-all-minilm-v2"}]}
    embed_payload = _make_embed_payload(n_vecs=1, dim=4)

    install_fake_requests_rag(monkeypatch, get_payload=models_payload, embed_payload=embed_payload)
    capture(backend.cmd_index, str(vault), db)

    conn = backend._db_connect(db)
    backend._rag_db_ensure(conn)
    # same unit vec for query → cosine=1.0 → top result
    install_fake_requests_rag(monkeypatch, get_payload=models_payload, embed_payload=embed_payload)
    candidates, short_circuit = backend._rag_retrieve(conn, "дорожная карта", None)
    conn.close()

    assert not short_circuit
    assert len(candidates) >= 1
    assert candidates[0]["speakers"] == "Алексей, Мария"


# ── fuzzy_correct — Stage 1 of glossary correction (deterministic, no LLM) ──
def test_fuzzy_correct_replaces_close_cyrillic_misrecognition():
    text, reps = backend.fuzzy_correct("Слово Онтон тут", ["Антон"])
    assert text == "Слово Антон тут"
    assert reps == [{"from": "Онтон", "to": "Антон"}]


def test_fuzzy_correct_keeps_surrounding_punctuation_around_replaced_token():
    text, reps = backend.fuzzy_correct("Позвал Онтон, потом ушёл.", ["Антон"])
    assert text == "Позвал Антон, потом ушёл."
    assert reps == [{"from": "Онтон", "to": "Антон"}]


def test_fuzzy_correct_declined_correct_form_not_flattened_to_nominative():
    # "Антона" is a correctly-spelled genitive/accusative of "Антон" — must be
    # left exactly as-is, never "corrected" down to the nominative term.
    text, reps = backend.fuzzy_correct("Встретил Антона вчера", ["Антон"])
    assert text == "Встретил Антона вчера"
    assert reps == []


def test_fuzzy_correct_leaves_distant_unrelated_word_untouched():
    text, reps = backend.fuzzy_correct("Взял стол вчера", ["Антон"])
    assert text == "Взял стол вчера"
    assert reps == []


def test_fuzzy_correct_matches_latin_term_from_cyrillic_phonetic_spelling():
    text, reps = backend.fuzzy_correct("Напиши мне в слэк", ["Slack"])
    assert text == "Напиши мне в Slack"
    assert reps == [{"from": "слэк", "to": "Slack"}]


def test_fuzzy_correct_threshold_boundary_accepts_distance_equal_to_threshold():
    # "Database" is 8 chars (>5) → threshold=2; "Dotobase" differs by exactly 2 substitutions.
    text, reps = backend.fuzzy_correct("Открыл Dotobase утром", ["Database"])
    assert text == "Открыл Database утром"
    assert reps == [{"from": "Dotobase", "to": "Database"}]


def test_fuzzy_correct_threshold_boundary_rejects_distance_one_past_threshold():
    # same term, one substitution further away (3 vs threshold=2) → left untouched.
    text, reps = backend.fuzzy_correct("Открыл Dotobasa утром", ["Database"])
    assert text == "Открыл Dotobasa утром"
    assert reps == []


def test_fuzzy_correct_garbled_and_declined_token_conservatively_left_untouched_v1():
    # "Онтона" is BOTH a misrecognition (Онтон≠Антон) AND declined (nominative+"а").
    # v1 rule: fuzzy_correct only checks whole-token distance (no stem/suffix
    # splitting) — that distance (2) exceeds the <=5-char threshold (1), so the
    # token is conservatively left as-is rather than guessed at. Stage 2's LLM
    # pass (gate_llm_correction) is the one that may resolve this case instead.
    text, reps = backend.fuzzy_correct("Встретил Онтона вчера", ["Антон"])
    assert text == "Встретил Онтона вчера"
    assert reps == []


def test_fuzzy_correct_accepts_segment_list_and_returns_same_shape():
    segs = [{"text": "Позвал Онтон", "start": 0, "end": 2}]
    out, reps = backend.fuzzy_correct(segs, ["Антон"])
    assert out == [{"text": "Позвал Антон", "start": 0, "end": 2}]
    assert reps == [{"from": "Онтон", "to": "Антон"}]


def test_fuzzy_correct_empty_terms_is_noop_passthrough():
    text, reps = backend.fuzzy_correct("Онтон тут", [])
    assert text == "Онтон тут"
    assert reps == []


# ── gate_llm_correction — Stage 2 diff-gate over an LLM's proposed fix ──────
def test_gate_accepts_close_replacement_matching_glossary_term():
    out = backend.gate_llm_correction(
        "Позвал Онтон на встречу", "Позвал Антон на встречу", ["Антон"])
    assert out == "Позвал Антон на встречу"


def test_gate_rejects_unrelated_rewrite_keeps_original():
    original = "Позвал стол на встречу"
    out = backend.gate_llm_correction(original, "Позвал диван на встречу", ["Антон"])
    assert out == original


def test_gate_accepts_declined_form_insertion():
    # old token is BOTH misrecognized and declined; new token is the term's
    # declined form — gate must accept it even though fuzzy_correct (Stage 1,
    # conservative) would have left "Онтона" untouched.
    out = backend.gate_llm_correction(
        "Встретил Онтона вчера", "Встретил Антона вчера", ["Антон"])
    assert out == "Встретил Антона вчера"


def test_gate_discards_whole_chunk_on_wild_length_divergence():
    original = "Короткий текст тут"
    corrected = ("Совершенно другой и значительно более длинный текст, "
                 "который был придуман целиком заново без всякой связи с оригиналом")
    out = backend.gate_llm_correction(original, corrected, ["Антон"])
    assert out == original


def test_gate_discards_whole_chunk_on_too_many_token_changes():
    # 3 of 5 tokens rewritten (60% > the 30% cap) at matching character length
    # (so this isolates the token-change-ratio guard from the length-delta one).
    original = "слово слово слово слово слово"
    corrected = "текст текст текст слово слово"
    out = backend.gate_llm_correction(original, corrected, ["Антон"])
    assert out == original


def test_gate_rejects_inserted_token_but_still_accepts_valid_replacement_in_same_chunk():
    original = "Позвал Онтон на большую встречу вчера"
    corrected = "Позвал Антон на очень большую встречу вчера"  # +"очень" inserted
    out = backend.gate_llm_correction(original, corrected, ["Антон"])
    # the valid term fix is kept, the inserted word is dropped — output token
    # count stays exactly equal to the original's.
    assert out == "Позвал Антон на большую встречу вчера"
    assert len(out.split()) == len(original.split())


def test_gate_empty_terms_is_noop_passthrough():
    original = "Позвал Онтон на встречу"
    assert backend.gate_llm_correction(original, "Позвал Антон на встречу", []) == original


# ── correct_glossary_llm (Stage 2 I/O) + the `correct` pipeline stage ───────
def test_correct_glossary_llm_applies_accepted_correction_to_matching_segment(monkeypatch, pipe):
    payload = {"choices": [{"message": {"content": "Позвал Антон на встречу"}}]}
    install_fake_requests(monkeypatch, payload=payload)
    segs = [seg("Позвал Онтон на встречу", 0, 3)]
    new_segs, count = pipe.correct_glossary_llm(segs, ["Антон"])
    assert new_segs[0]["text"] == "Позвал Антон на встречу"
    assert count == 1


def test_correct_glossary_llm_redistributes_correction_across_multiple_segments(monkeypatch, pipe):
    payload = {"choices": [{"message": {"content": "Всем привет тут Антон говорит"}}]}
    install_fake_requests(monkeypatch, payload=payload)
    segs = [seg("Всем привет тут", 0, 2), seg("Онтон говорит", 2, 4)]
    new_segs, count = pipe.correct_glossary_llm(segs, ["Антон"])
    assert new_segs[0]["text"] == "Всем привет тут"
    assert new_segs[1]["text"] == "Антон говорит"
    assert count == 1


def test_correct_glossary_llm_returns_none_and_logs_when_requests_raises(monkeypatch, pipe):
    install_fake_requests(monkeypatch, raise_exc=ConnectionError("LM Studio down"))
    segs = [seg("привет Онтон тут", 0, 3)]
    assert pipe.correct_glossary_llm(segs, ["Антон"]) == (None, 0)
    events = capture(pipe.correct_glossary_llm, segs, ["Антон"])
    logs = [e["msg"] for e in events if e["event"] == "log"]
    assert any("LLM недоступен" in m for m in logs)


def test_correct_stage_skipped_when_glossary_empty_byte_identical_no_llm_call(monkeypatch, tmp_path):
    src = tmp_path / "in.wav"; src.write_bytes(b"x")
    calls = {"n": 0}
    p = backend.Pipeline(out_dir=str(tmp_path / "v"), diarize=False, glossary="")
    monkeypatch.setattr(p, "convert_to_mono", lambda f: f)
    monkeypatch.setattr(p, "remove_silence_vad", lambda f: (f, None))
    monkeypatch.setattr(p, "transcribe", lambda f: {"segments": [seg("привет Онтон встреча", 0, 3)], "text": "x"})
    monkeypatch.setattr(p, "summarize", lambda t, pr: None)
    monkeypatch.setattr(p, "correct_glossary_llm",
                         lambda segs, terms: calls.__setitem__("n", calls["n"] + 1) or (segs, 0))
    events = capture(p.process, str(src), "prompt")
    ends = {e["stage"]: e for e in events if e["event"] == "stage_end"}
    assert ends["correct"]["status"] == "skip"
    done = [e for e in events if e["event"] == "done"][0]
    assert "Онтон" in done["transcript"]   # untouched — glossary empty, correction never ran
    assert calls["n"] == 0                 # Stage-2 LLM never invoked


def test_correct_stage_degrades_to_stage1_only_when_llm_down(monkeypatch, tmp_path):
    src = tmp_path / "in.wav"; src.write_bytes(b"x")
    p = backend.Pipeline(out_dir=str(tmp_path / "v"), diarize=False, glossary="Антон")
    monkeypatch.setattr(p, "convert_to_mono", lambda f: f)
    monkeypatch.setattr(p, "remove_silence_vad", lambda f: (f, None))
    monkeypatch.setattr(p, "transcribe", lambda f: {"segments": [seg("привет Онтон тут", 0, 3)], "text": "x"})
    monkeypatch.setattr(p, "summarize", lambda t, pr: None)
    monkeypatch.setattr(p, "correct_glossary_llm", lambda segs, terms: (None, 0))  # LM Studio down
    events = capture(p.process, str(src), "prompt")
    ends = {e["stage"]: e for e in events if e["event"] == "stage_end"}
    assert ends["correct"]["status"] == "fail"
    done = [e for e in events if e["event"] == "done"][0]
    assert "Антон" in done["transcript"]        # Stage-1 fuzzy fix still applied
    assert "Онтон" not in done["transcript"]


def test_correct_stage_cache_honored_on_retry_skips_llm_recompute(monkeypatch, tmp_path):
    src = tmp_path / "in.wav"; src.write_bytes(b"x")
    cache = tmp_path / "cache"
    llm_calls = {"n": 0}

    def fake_correct_llm(self, segs, terms):
        llm_calls["n"] += 1
        return segs, 0

    monkeypatch.setattr(backend.Pipeline, "correct_glossary_llm", fake_correct_llm)

    def fresh_pipe():
        p = backend.Pipeline(out_dir=str(tmp_path / "v"), diarize=False,
                              cache_dir=str(cache), glossary="Антон")
        monkeypatch.setattr(p, "convert_to_mono", lambda f: f)
        monkeypatch.setattr(p, "remove_silence_vad", lambda f: (f, None))
        monkeypatch.setattr(p, "transcribe", lambda f: {"segments": [seg("привет Онтон тут", 0, 3)], "text": "x"})
        monkeypatch.setattr(p, "summarize", lambda t, pr: None)
        return p

    capture(fresh_pipe().process, str(src), "p")           # first run → corrects + caches
    events = capture(fresh_pipe().process, str(src), "p")  # retry, same cache_dir → resumes from cache

    assert llm_calls["n"] == 1  # Stage-2 LLM ran ONCE; the retry reused the cache
    ends = {e["stage"]: e for e in events if e["event"] == "stage_end"}
    assert "из кеша" in ends["correct"]["msg"]


# ── critic follow-up fixes ──────────────────────────────────────────────────

# BLOCKER 1 — Stage-1 fuzzy was ungated for short terms: "Дан" (distance-1 from
# the common word "дам") used to misfire. Terms ≤3 chars now require an exact
# (post-translit) match — no fuzz budget.
def test_fuzzy_correct_short_term_distance_one_does_not_misfire_on_unrelated_word():
    text, reps = backend.fuzzy_correct("Я вам дам ответ", ["Дан"])
    assert text == "Я вам дам ответ"
    assert reps == []


def test_fuzzy_correct_short_term_still_matches_on_exact_form():
    text, reps = backend.fuzzy_correct("Позвал Дан вчера", ["Дан"])
    assert text == "Позвал Дан вчера"  # already correct — untouched, no replacement logged
    assert reps == []


def test_gate_short_term_distance_one_rewrite_rejected_as_unrelated():
    original = "Я вам дам ответ"
    out = backend.gate_llm_correction(original, "Я вам Дан ответ", ["Дан"])
    assert out == original


def test_fuzzy_correct_onton_to_anton_still_works_after_threshold_tightening():
    # the happy path the tightened threshold must not break (5-char term keeps ±1).
    text, reps = backend.fuzzy_correct("Слово Онтон тут", ["Антон"])
    assert text == "Слово Антон тут"
    assert reps == [{"from": "Онтон", "to": "Антон"}]


# BLOCKER 2 — multi-word glossary terms ("Иван Петров") now match across a run
# of consecutive tokens (n-gram window), in both fuzzy_correct and the gate.
def test_fuzzy_correct_multiword_term_matches_across_consecutive_tokens():
    text, reps = backend.fuzzy_correct("Встретил иван питров вчера", ["Иван Петров"])
    assert text == "Встретил Иван Петров вчера"
    assert reps == [{"from": "иван питров", "to": "Иван Петров"}]


def test_fuzzy_correct_single_token_terms_unaffected_by_multiword_glossary_entries():
    text, reps = backend.fuzzy_correct("Слово Онтон тут", ["Иван Петров", "Антон"])
    assert text == "Слово Антон тут"
    assert reps == [{"from": "Онтон", "to": "Антон"}]


def test_gate_accepts_multiword_term_correction():
    out = backend.gate_llm_correction(
        "Встретил иван питров вчера", "Встретил Иван Петров вчера", ["Иван Петров"])
    assert out == "Встретил Иван Петров вчера"


def test_gate_single_token_term_unaffected_by_multiword_glossary_entries():
    out = backend.gate_llm_correction(
        "Позвал Онтон на встречу", "Позвал Антон на встречу", ["Иван Петров", "Антон"])
    assert out == "Позвал Антон на встречу"


# MAJOR — declension guard now checks a whitelist of actual Russian case-ending
# suffixes, not "any ≤3 chars": "Антонов" is a different name (built with the
# possessive/surname suffix "-ов"), not a declined "Антон".
def test_term_or_declined_form_accepts_whitelisted_case_endings():
    assert backend._term_or_declined_form("Антона", ["Антон"]) == "Антон"
    assert backend._term_or_declined_form("Антону", ["Антон"]) == "Антон"
    assert backend._term_or_declined_form("Антоном", ["Антон"]) == "Антон"


def test_term_or_declined_form_rejects_surname_forming_suffix():
    assert backend._term_or_declined_form("Антонов", ["Антон"]) is None


def test_gate_rejects_surname_like_suffix_not_a_real_declension():
    original = "Позвал Онтон на встречу"
    out = backend.gate_llm_correction(original, "Позвал Антонов на встречу", ["Антон"])
    assert out == original  # "Антонов" is a different word — not accepted


def test_gate_accepts_genuine_case_ending_declension():
    out = backend.gate_llm_correction(
        "Встретил Онтона вчера", "Встретил Антона вчера", ["Антон"])
    assert out == "Встретил Антона вчера"


# MINOR — gate must transplant the validated core onto the ORIGINAL token's own
# punctuation, never the LLM's punctuation choice.
def test_gate_transplants_validated_core_onto_original_punctuation():
    original = "Написал ему в слэк."
    corrected = "Написал ему в Slack!"
    out = backend.gate_llm_correction(original, corrected, ["Slack"])
    assert out == "Написал ему в Slack."  # keeps ORIGINAL's ".", drops the LLM's "!"


# MINOR — correct-cache staleness vs a recomputed transcribe cache: if transcribe's
# own cache is busted and reruns with DIFFERENT segments, a surviving (now stale)
# correct-cache entry must be detected and recomputed, not served blindly.
def test_correct_cache_recomputes_when_transcribe_output_changes_underneath_it(monkeypatch, tmp_path):
    cache = tmp_path / "cache"
    src = tmp_path / "in.wav"; src.write_bytes(b"x")
    llm_calls = {"n": 0}

    def fake_correct_llm(self, segs, terms):
        llm_calls["n"] += 1
        return segs, 0

    monkeypatch.setattr(backend.Pipeline, "correct_glossary_llm", fake_correct_llm)

    def mk():
        p = backend.Pipeline(out_dir=str(tmp_path / "v"), diarize=False,
                              cache_dir=str(cache), glossary="Антон")
        monkeypatch.setattr(p, "convert_to_mono", lambda f: f)
        monkeypatch.setattr(p, "remove_silence_vad", lambda f: (f, None))
        monkeypatch.setattr(p, "summarize", lambda t, pr: None)
        return p

    p1 = mk()
    monkeypatch.setattr(p1, "transcribe", lambda f: {"segments": [seg("привет Онтон первый", 0, 3)], "text": "x"})
    capture(p1.process, str(src), "p")  # caches transcribe.json AND correct.json for this transcript

    # bust ONLY the transcribe cache (real path via the Pipeline's own _cache(),
    # not hand-reconstructed — avoids a filename mismatch missing the real file)
    tj = p1._cache(f"transcribe-{p1.LANGUAGE}{p1._glossary_cache_suffix()}.json")
    tj.write_text("CORRUPT", encoding="utf-8")

    p2 = mk()
    monkeypatch.setattr(p2, "transcribe",
                         lambda f: {"segments": [seg("привет Онтон совершенно другой текст", 0, 3)], "text": "x"})
    events = capture(p2.process, str(src), "p")  # transcribe reruns with DIFFERENT segments

    assert llm_calls["n"] == 2  # correct recomputed, not served stale
    ends = {e["stage"]: e for e in events if e["event"] == "stage_end"}
    assert "из кеша" not in ends["correct"]["msg"]
    done = [e for e in events if e["event"] == "done"][0]
    assert "совершенно другой текст" in done["transcript"]  # fresh content, not the stale run's
