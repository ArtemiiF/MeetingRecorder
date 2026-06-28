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
    out = pipe.combine(segments, timeline)
    assert "**[Спикер 1]**: привет как дела" in out   # friendly relabel of SPEAKER_00
    assert "**[Спикер 2]**: отлично" in out
    assert out.count("**[Спикер ") == 2


def test_combine_empty_timeline_returns_none(pipe):
    assert pipe.combine([seg("x")], []) is None


def test_combine_unknown_when_no_overlap(pipe):
    out = pipe.combine([seg("hi", 100.0, 101.0)], [(0.0, 5.0, "SPEAKER_00")])
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


def test_summarize_falls_back_to_reasoning_content(monkeypatch, pipe):
    payload = {"choices": [{"message": {"reasoning_content": "РАЗМЫШЛЕНИЕ"}}]}
    install_fake_requests(monkeypatch, payload=payload)
    assert pipe.summarize("t", "p") == "РАЗМЫШЛЕНИЕ"


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


def test_process_records_template_in_index_and_frontmatter(monkeypatch, tmp_path):
    out = tmp_path / "v"
    db = str(tmp_path / "i.db")
    src = tmp_path / "in.wav"; src.write_bytes(b"x")
    p = backend.Pipeline(out_dir=str(out), diarize=False, template="Митинг", db_path=db, language="ru")
    monkeypatch.setattr(p, "convert_to_mono", lambda f: f)
    monkeypatch.setattr(p, "remove_silence_vad", lambda f: f)
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


def test_cmd_classify_normalizes_bad_category(monkeypatch, tmp_path):
    note = tmp_path / "n.md"; note.write_text("x", encoding="utf-8")
    install_fake_requests(monkeypatch, payload={"choices": [{"message": {
        "content": '{"category":"WEIRD","project":"P"}'}}]})
    ev = [e for e in capture(backend.cmd_classify, str(note)) if e["event"] == "classified"][0]
    assert ev["category"] == "resources"  # invalid → safe default


def test_cmd_preflight_emits_checks():
    ev = capture(backend.cmd_preflight)[0]
    assert ev["event"] == "preflight"
    assert ev["ffmpeg"] is True                       # ffmpeg present in this env
    assert "whisper_cached" in ev and "hf_token" in ev


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

    def fake_process(self, audio, prompt, keep_audio_in_obsidian=True):
        captured["prompt"] = prompt

    monkeypatch.setattr(backend.Pipeline, "process", fake_process)

    blank = tmp_path / "p.txt"
    blank.write_text("   \n")
    args = types.SimpleNamespace(
        prompt_file=str(blank), out_dir=str(tmp_path), engine="mlx",
        diarize=False, infile="x.wav", keep_audio=False, cache_dir=None,
        language="ru", summarize=True, template="", db=None)
    backend.cmd_process(args)
    assert "краткую структурированную сводку" in captured["prompt"]


def test_cmd_process_forwards_user_prompt(monkeypatch, tmp_path):
    captured = {}
    monkeypatch.setattr(backend.Pipeline, "process",
                        lambda self, a, p, keep_audio_in_obsidian=True: captured.update(p=p))
    pf = tmp_path / "p.txt"
    pf.write_text("МОЙ КАСТОМНЫЙ ПРОМПТ")
    args = types.SimpleNamespace(
        prompt_file=str(pf), out_dir=str(tmp_path), engine="mlx",
        diarize=True, infile="x.wav", keep_audio=False, cache_dir=None,
        language="ru", summarize=True, template="", db=None)
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
    monkeypatch.setattr(pipe, "remove_silence_vad", lambda f: f)
    monkeypatch.setattr(pipe, "transcribe", lambda f: transcribe_ret)
    monkeypatch.setattr(pipe, "summarize", lambda t, p: summary_ret)
    monkeypatch.setattr(pipe, "generate_title", lambda t: "")           # no live LLM in tests
    monkeypatch.setattr(pipe, "infer_speaker_names", lambda t: {})
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
        monkeypatch.setattr(p, "remove_silence_vad", lambda f: f)
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
    monkeypatch.setattr(p, "remove_silence_vad", lambda f: f)
    monkeypatch.setattr(p, "summarize", lambda t, pr: None)
    capture(p.process, str(src), "prompt")
    assert calls["n"] == 1  # corrupt cache was busted → transcription actually ran


def test_transcript_only_skips_llm(monkeypatch, tmp_path):
    src = tmp_path / "in.wav"
    src.write_bytes(b"x")
    summarize_calls = {"n": 0}
    p = backend.Pipeline(out_dir=str(tmp_path / "v"), diarize=False, do_summary=False)
    monkeypatch.setattr(p, "convert_to_mono", lambda f: f)
    monkeypatch.setattr(p, "remove_silence_vad", lambda f: f)
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
        monkeypatch.setattr(p, "remove_silence_vad", lambda f: f)
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
