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
    monkeypatch.setattr(pipe, "remove_silence_vad", lambda f: f)
    monkeypatch.setattr(pipe, "transcribe",
                        lambda f: {"segments": [seg("hi", 0, 2)], "text": "hi"})
    monkeypatch.setattr(pipe, "diarize", lambda f: [{"start": 0, "end": 2, "speaker": "SPEAKER_00"}])
    monkeypatch.setattr(pipe, "combine", lambda segs, tl: formatted_transcript)
    monkeypatch.setattr(pipe, "summarize", lambda t, p: "# Сводка\n\n" + "итог " * 30)
    monkeypatch.setattr(pipe, "generate_title", lambda t: "Тестовая встреча")
    monkeypatch.setattr(pipe, "infer_speaker_names", lambda t: inferred_speakers)
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
