#!/usr/bin/env python3
"""
Meeting Recorder backend — driven by the Electron GUI.

Protocol: every line printed to stdout is ONE json object terminated by \n.
  {"event": "...", ...}
Events:
  log       {"msg": str}                       human-readable progress line
  stage     {"stage": str, "msg": str}         pipeline stage marker
  devices   {"devices": [{"index", "name", "channels", "default"}]}
  elapsed   {"seconds": int}                    recording tick
  recorded  {"file": str, "size_mb": float}     recording finalized
  done      {"note": str, "audio": str, "transcript": str, "summary": str,
             "actions": {"items": [{"what","who","due"}], "decisions": [str]}}
  error     {"msg": str}

Commands (argv[1]):
  devices                          → emit one `devices` event, exit
  record  --out FILE [--device N]  → record until 'stop\n' arrives on stdin
  process --in FILE --prompt-file F [--diarize true|false] [--out-dir DIR]
                                       [--engine mlx|whisper] [--keep-audio true|false]
"""
import sys
import os
import json
import time
import wave
import threading
import argparse
import warnings
from datetime import datetime
from pathlib import Path

warnings.filterwarnings("ignore", category=UserWarning)


_CURRENT_STAGE = "general"  # which stage subsequent log() lines belong to


def emit(event, **kwargs):
    """Print one json line to stdout and flush."""
    payload = {"event": event}
    payload.update(kwargs)
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def log(msg):
    emit("log", msg=str(msg), stage=_CURRENT_STAGE)


def stage(name, msg):
    """Mark a pipeline stage as started; later log() lines are tagged with it."""
    global _CURRENT_STAGE
    _CURRENT_STAGE = name
    emit("stage", stage=name, msg=str(msg))


def stage_end(name, status, msg=""):
    """Report a stage outcome. status ∈ 'ok' | 'fail' | 'skip'."""
    emit("stage_end", stage=name, status=status, msg=str(msg))


# ──────────────────────────────────────────────────────────────────────────
# Recording (mic + system audio via the "Meeting Recorder Input" aggregate)
# ──────────────────────────────────────────────────────────────────────────
DEVICE_NAME = "Meeting Recorder Input"
CHUNK = 1024
RECORD_CHANNELS = 2
RECORD_RATE = 44100


def list_devices():
    import pyaudio
    pa = pyaudio.PyAudio()
    devices = []
    try:
        default_idx = pa.get_default_input_device_info().get("index", -1)
    except Exception:
        default_idx = -1
    for i in range(pa.get_device_count()):
        info = pa.get_device_info_by_index(i)
        if info["maxInputChannels"] > 0:
            devices.append({
                "index": i,
                "name": info["name"],
                "channels": int(info["maxInputChannels"]),
                "default": i == default_idx,
                "preferred": DEVICE_NAME.lower() in info["name"].lower(),
            })
    pa.terminate()
    return devices


def find_device_index(pa, want):
    for i in range(pa.get_device_count()):
        info = pa.get_device_info_by_index(i)
        if want.lower() in info["name"].lower() and info["maxInputChannels"] > 0:
            return i
    return None


def cmd_record(out_path, device_index):
    import pyaudio
    pa = pyaudio.PyAudio()

    # System audio is captured separately (AudioTee, Core Audio tap); here we record
    # ONLY the microphone. No virtual device / aggregate — just the chosen or default mic.
    if device_index is None:
        log("Записываю микрофон (устройство по умолчанию)")
    else:
        info = pa.get_device_info_by_index(device_index)
        log(f"Записываю микрофон: '{info['name']}'")

    # honour the device's real channel count + native sample rate.
    channels = RECORD_CHANNELS
    rate = RECORD_RATE
    try:
        probe_idx = device_index if device_index is not None else \
            pa.get_default_input_device_info().get("index")
        info = pa.get_device_info_by_index(probe_idx)
        channels = min(2, int(info["maxInputChannels"])) or RECORD_CHANNELS
        rate = int(info.get("defaultSampleRate") or RECORD_RATE)
    except Exception:
        pass

    try:
        stream = pa.open(
            format=pyaudio.paInt16,
            channels=channels,
            rate=rate,
            input=True,
            input_device_index=device_index,
            frames_per_buffer=CHUNK,
        )
    except Exception as e:
        emit("error", msg=f"Не удалось открыть аудиопоток: {e}")
        pa.terminate()
        return

    stop_flag = {"stop": False}

    def stdin_watcher():
        for line in sys.stdin:
            if line.strip().lower() == "stop":
                stop_flag["stop"] = True
                break

    watcher = threading.Thread(target=stdin_watcher, daemon=True)
    watcher.start()

    try:
        import audioop
    except Exception:
        audioop = None

    frames = []
    start = time.time()
    last_tick = -1
    last_level = 0.0
    log("🔴 Запись началась")

    try:
        while not stop_flag["stop"]:
            data = stream.read(CHUNK, exception_on_overflow=False)
            frames.append(data)
            now = time.time()
            elapsed = int(now - start)
            if elapsed != last_tick:
                last_tick = elapsed
                emit("elapsed", seconds=elapsed)
            if audioop and now - last_level >= 0.1:  # ~10 Hz VU level
                last_level = now
                try:
                    emit("level", source="mic", level=min(1.0, audioop.rms(data, 2) / 4000.0))
                except Exception:
                    pass
    finally:
        stream.stop_stream()
        stream.close()
        pa.terminate()

    if not frames:
        emit("error", msg="Нет записанных данных")
        return

    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    wf = wave.open(out_path, "wb")
    wf.setnchannels(channels)
    wf.setsampwidth(2)  # paInt16
    wf.setframerate(rate)
    wf.writeframes(b"".join(frames))
    wf.close()

    size_mb = Path(out_path).stat().st_size / (1024 * 1024)
    log(f"💾 Аудио сохранено: {size_mb:.1f} MB")
    emit("recorded", file=out_path, size_mb=round(size_mb, 2))


# ──────────────────────────────────────────────────────────────────────────
# Glossary-based transcript correction — pure helpers (no I/O, unit-testable).
# Two stages compose around these: a deterministic fuzzy pass (fuzzy_correct)
# and an LLM pass whose reply is validated token-by-token before acceptance
# (gate_llm_correction). The I/O side (LM Studio call, chunking) lives on
# Pipeline.correct_glossary_llm.
# ──────────────────────────────────────────────────────────────────────────
_PUNCT_CHARS = ".,!?;:\"'«»()[]{}—–-…"

# Chunk size for correct_glossary_llm's LM Studio requests. A separate constant
# from the RAG search chunker's _RAG_CHUNK_CHARS (same numeric value today, but
# the two are tuned for different jobs — RAG chunks are embedded independently,
# correction chunks must reassemble exactly onto segment boundaries) so tuning
# one doesn't silently retune the other.
_CORRECT_CHUNK_CHARS = 2000


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


# ──────────────────────────────────────────────────────────────────────────
# Processing pipeline (refactored from meeting_simple_v9.py)
# ──────────────────────────────────────────────────────────────────────────
class Pipeline:
    def __init__(self, out_dir, engine="mlx", diarize=True, cache_dir=None,
                 language="ru", do_summary=True, template="", db_path=None, glossary=""):
        self.TEMPLATE = template
        self.db_path = db_path
        self.OBSIDIAN_PATH = Path(out_dir)
        self.LMSTUDIO_API = "http://localhost:1234/v1/chat/completions"
        self.TRANSCRIPTION_ENGINE = engine
        self.WHISPER_MODEL = "medium"
        self.USE_DIARIZATION = diarize
        self.LANGUAGE = language          # "ru" | "en" | "auto"
        self.DO_SUMMARY = do_summary
        self.GLOSSARY = glossary          # comma/newline-separated terms biasing Whisper initial_prompt
        self.HF_TOKEN = os.environ.get("HF_TOKEN")
        # cache for resumable stages (heavy work — convert/transcribe/diarize).
        self.cache_dir = Path(cache_dir) if cache_dir else None
        if self.cache_dir:
            self.cache_dir.mkdir(parents=True, exist_ok=True)
            for stray in self.cache_dir.glob("*.tmp"):  # crash leftovers from atomic writes
                try:
                    stray.unlink()
                except Exception:
                    pass

    def _cache(self, name):
        return (self.cache_dir / name) if self.cache_dir else None

    @staticmethod
    def _cache_write(path, obj):
        """Atomic JSON cache write: tmp + os.replace, so a kill mid-write
        never leaves a half-written file that resume would load as valid."""
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_text(json.dumps(obj, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, path)

    @staticmethod
    def _copy_atomic(src, dst):
        """Copy a binary file atomically (tmp sibling + os.replace) so a kill
        mid-copy never leaves a truncated file that later looks valid."""
        import shutil
        dst = Path(dst)
        tmp = dst.with_suffix(dst.suffix + ".tmp")
        shutil.copy2(src, tmp)
        os.replace(tmp, dst)

    @staticmethod
    def _cache_read(path):
        """Read a JSON cache entry; on any corruption delete it and return None
        so the stage recomputes instead of crashing/serving garbage."""
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            try:
                path.unlink()
            except Exception:
                pass
            return None

    # ── audio prep ────────────────────────────────────────────────────────
    def convert_to_mono(self, audio_file):
        import shutil
        import subprocess
        mono_file = audio_file.replace(".wav", "_mono.wav")
        if not audio_file.endswith(".wav"):
            mono_file = audio_file + "_mono.wav"
        ffmpeg = shutil.which("ffmpeg")
        if not ffmpeg:
            log("⚠️ ffmpeg не найден — пропускаю конвертацию")
            return audio_file
        try:
            subprocess.run(
                [ffmpeg, "-i", audio_file, "-ac", "1", "-ar", "16000", "-y", mono_file],
                check=True, capture_output=True,
            )
            log("✅ Сконвертировано в моно 16kHz")
            return mono_file
        except Exception as e:
            log(f"⚠️ ffmpeg ошибка: {e}")
            return audio_file

    def remove_silence_vad(self, audio_file):
        try:
            import torch
            log("🔇 Удаляю тишину (Silero VAD)...")
            model, utils = torch.hub.load(
                repo_or_dir="snakers4/silero-vad", model="silero_vad", force_reload=False
            )
            (get_speech_timestamps, save_audio, read_audio, _, collect_chunks) = utils
            wav = read_audio(audio_file, sampling_rate=16000)
            ts = get_speech_timestamps(
                wav, model, sampling_rate=16000, threshold=0.5,
                min_speech_duration_ms=250, min_silence_duration_ms=100,
            )
            if not ts:
                log("⚠️ Речь не обнаружена VAD")
                return audio_file
            speech = collect_chunks(ts, wav)
            vad_file = audio_file.replace(".wav", "_vad.wav")
            save_audio(vad_file, speech, sampling_rate=16000)
            log(f"✅ Тишина удалена: {len(wav)/16000:.1f}с → {len(speech)/16000:.1f}с")
            return vad_file
        except Exception as e:
            log(f"⚠️ VAD не сработал: {e}")
            return audio_file

    # ── transcription ─────────────────────────────────────────────────────
    CONTEXT_PROMPT_RU = (
        "Деловая встреча на русском языке с несколькими участниками. "
        "Могут использоваться английские термины: meeting, deadline, API, pipeline, "
        "deploy, feedback, team, project, call, sync, update, sprint, backlog, roadmap, "
        "feature, bug, fix, release, commit, merge, review, approve, email, chat, slack, "
        "zoom, calendar. Сохраняй английские слова как есть."
    )
    CONTEXT_PROMPT_EN = (
        "A business meeting with several participants. Technical terms may be used: "
        "API, pipeline, deploy, sprint, backlog, roadmap, release, commit, merge, review."
    )
    # Stage 2 of glossary correction (see correct_glossary_llm) — {terms} filled per call.
    CORRECT_SYSTEM_PROMPT = (
        "В тексте — расшифровка речи. Словарь правильных терминов: {terms}. "
        "Исправь ТОЛЬКО неверно распознанные слова из словаря (имена, термины). "
        "Верни текст без других изменений."
    )

    def _whisper_lang(self):
        # mlx/whisper take None for auto-detect
        return None if self.LANGUAGE == "auto" else self.LANGUAGE

    def _context_prompt(self):
        if self.LANGUAGE == "ru":
            return self.CONTEXT_PROMPT_RU
        if self.LANGUAGE == "en":
            return self.CONTEXT_PROMPT_EN
        return None  # auto → no language-biased prompt

    def _glossary_terms(self):
        if not self.GLOSSARY:
            return []
        import re
        return [t.strip() for t in re.split(r"[,\n]+", self.GLOSSARY) if t.strip()]

    def _glossary_prompt(self):
        terms = self._glossary_terms()
        if not terms:
            return None
        return "Термины: " + ", ".join(terms) + "."

    def _glossary_cache_suffix(self):
        # cache key must change whenever the glossary changes (or stale transcripts
        # would be served) — canonicalized so cosmetic separator differences that
        # yield the same term list don't cause needless cache misses.
        terms = self._glossary_terms()
        if not terms:
            return ""
        import hashlib
        h = hashlib.sha1(", ".join(terms).encode("utf-8")).hexdigest()[:8]
        return f"-g{h}"

    def transcribe(self, mono_audio):
        result = None
        lang = self._whisper_lang()
        prompt = self._context_prompt()
        glossary_prompt = self._glossary_prompt()
        if glossary_prompt:
            prompt = f"{prompt} {glossary_prompt}" if prompt else glossary_prompt
        if self.TRANSCRIPTION_ENGINE == "mlx":
            try:
                import mlx_whisper
                log(f"Транскрибирую через MLX Whisper (lang={self.LANGUAGE})")
                result = mlx_whisper.transcribe(
                    mono_audio,
                    path_or_hf_repo="mlx-community/whisper-large-v3-turbo",
                    language=lang, word_timestamps=True,
                    initial_prompt=prompt, temperature=0.0,
                    condition_on_previous_text=False, verbose=False,
                )
                for seg in result.get("segments", []):
                    seg.setdefault("no_speech_prob", 0.0)
            except ImportError:
                log("⚠️ MLX не установлен — переключаюсь на openai-whisper")
                self.TRANSCRIPTION_ENGINE = "whisper"
            except Exception as e:
                log(f"⚠️ MLX ошибка: {e} — переключаюсь на openai-whisper")
                self.TRANSCRIPTION_ENGINE = "whisper"

        if self.TRANSCRIPTION_ENGINE == "whisper":
            try:
                import whisper
                log(f"Транскрибирую через Whisper ({self.WHISPER_MODEL}, lang={self.LANGUAGE})")
                model = whisper.load_model(self.WHISPER_MODEL)
                result = model.transcribe(
                    mono_audio, language=lang, task="transcribe", verbose=False, fp16=False,
                    initial_prompt=prompt, word_timestamps=True, temperature=0.0,
                    condition_on_previous_text=False, compression_ratio_threshold=2.4,
                    logprob_threshold=-1.0, no_speech_threshold=0.6,
                )
            except Exception as e:
                log(f"❌ Транскрипция не удалась: {e}")
                return None
        return result

    # ── glossary correction, stage 2: LLM pass, diff-gated ─────────────────
    def correct_glossary_llm(self, segments, terms):
        """Stage 2 of glossary correction (see module-level fuzzy_correct for
        Stage 1). Groups consecutive segments into ~_CORRECT_CHUNK_CHARS windows —
        chunk boundaries always fall on segment boundaries, never mid-word — and
        asks LM Studio to fix ONLY glossary terms in each window. The reply is
        validated with gate_llm_correction before acceptance; because the gate
        preserves each chunk's token COUNT, an accepted chunk's words can be
        redistributed back onto the original per-segment boundaries by word
        count alone. Returns (new_segments, accepted_count).

        On any LM Studio failure the WHOLE pass aborts and returns (None, 0) —
        mirrors summarize()'s degrade-and-log pattern — so the caller falls back
        to the Stage-1-only result instead of a half-corrected transcript."""
        if not terms or not segments:
            return segments, 0
        import requests
        sys_msg = self.CORRECT_SYSTEM_PROMPT.format(terms=", ".join(terms))

        groups, cur, cur_len = [], [], 0
        for i, s in enumerate(segments):
            t = (s.get("text") or "").strip()
            if cur and cur_len + len(t) > _CORRECT_CHUNK_CHARS:
                groups.append(cur)
                cur, cur_len = [], 0
            cur.append(i)
            cur_len += len(t) + 1
        if cur:
            groups.append(cur)

        new_segments = [dict(s) for s in segments]
        accepted = 0
        try:
            for idx_group in groups:
                texts = [(new_segments[i].get("text") or "").strip() for i in idx_group]
                word_counts = [len(t.split()) for t in texts]
                chunk = " ".join(texts)
                if not chunk.strip():
                    continue
                resp = requests.post(self.LMSTUDIO_API, json={
                    "messages": [
                        {"role": "system", "content": sys_msg},
                        {"role": "user", "content": chunk},
                    ],
                    "temperature": 0.0, "max_tokens": 4000,
                }, timeout=120)
                if resp.status_code != 200:
                    continue
                msg = (resp.json().get("choices") or [{}])[0].get("message", {})
                raw = (msg.get("content") or "") or (msg.get("reasoning_content") or "")
                if not raw.strip():
                    continue
                gated_tokens = gate_llm_correction(chunk, raw, terms).split()
                if len(gated_tokens) != sum(word_counts):
                    continue  # safety net — gate() should already guarantee this
                orig_tokens = chunk.split()
                accepted += sum(1 for a, b in zip(orig_tokens, gated_tokens) if a != b)
                pos = 0
                for local_i, i in enumerate(idx_group):
                    n = word_counts[local_i]
                    new_segments[i]["text"] = " ".join(gated_tokens[pos:pos + n])
                    pos += n
        except Exception as e:
            log(f"⚠️ LLM недоступен — коррекция терминов только по словарю: {e}")
            return None, 0
        return new_segments, accepted

    def filter_hallucinations(self, segments):
        import re
        filtered = []
        for i, seg in enumerate(segments):
            text = seg["text"].strip()
            if not text or len(text) < 2:
                continue
            if re.search(r"(\w{1,4})[,\s\-]+(?:\1[,\s\-]+){3,}", text.lower()):
                continue
            if re.search(r"([а-яёa-z]{1,2})\1{6,}", text.lower()):
                continue
            words = text.lower().split()
            if len(words) > 5 and len(set(words)) / len(words) < 0.3:
                continue
            patterns = [r"продолжение следует", r"подписыва", r"субтитры", r"перевод",
                        r"озвучка", r"до новых встреч", r"спасибо что смотрите"]
            if any(re.search(p, text.lower()) for p in patterns):
                continue
            dur = seg["end"] - seg["start"]
            if dur > 0.3 and len(text) / dur > 30:
                continue
            if dur < 0.8 and len(text) < 4:
                continue
            filtered.append(seg)
        removed = len(segments) - len(filtered)
        if removed > 0:
            log(f"✅ Отфильтровано {removed}/{len(segments)} артефактов")
        return filtered

    # ── diarization ─────────────────────────────────────────────────────────
    def diarize(self, audio_file):
        try:
            if not self.HF_TOKEN:
                log("⚠️ HF_TOKEN не задан (env) — диаризация пропущена")
                return None
            from pyannote.audio import Pipeline as PyannotePipeline
            import torch
            log("🎙 Анализирую голоса спикеров (pyannote)...")
            with wave.open(audio_file, "rb") as wf:
                duration = wf.getnframes() / wf.getframerate()
                if duration < 1.0 or wf.getnchannels() != 1:
                    log("⚠️ Аудио непригодно для диаризации (нужно >1с, моно)")
                    return None
            pipe = PyannotePipeline.from_pretrained(
                "pyannote/speaker-diarization-3.1", token=self.HF_TOKEN
            )
            if torch.backends.mps.is_available():
                pipe.to(torch.device("mps"))
                log("   Использую M3 GPU (mps)")
            result = pipe(audio_file)
            speakers, timeline = set(), []
            diar = getattr(result, "speaker_diarization", result)
            if hasattr(diar, "itertracks"):
                for turn, _track, spk in diar.itertracks(yield_label=True):
                    speakers.add(spk)
                    timeline.append((turn.start, turn.end, spk))
            if not timeline:
                log("⚠️ Спикеры не извлечены")
                return None
            log(f"✅ Спикеров: {len(speakers)}, сегментов: {len(timeline)}")
            return timeline
        except Exception as e:
            log(f"⚠️ Диаризация не сработала: {e}")
            return None

    def combine(self, segments, timeline):
        if not timeline:
            return None
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
        return "\n\n".join(result) if result else None

    def add_timestamps(self, segments):
        out = []
        for seg in segments:
            start = int(seg["start"])
            out.append(f"[{start//60:02d}:{start%60:02d}] {seg['text'].strip()}")
        return "\n".join(out)

    # ── LLM summary with the user's custom prompt ─────────────────────────
    def summarize(self, transcript, user_prompt):
        import requests
        try:
            sys_msg = ("Ты помощник для обработки расшифровок встреч. "
                       "Отвечай в Markdown. Сохраняй английские термины как есть.")
            user_msg = (
                f"{user_prompt.strip()}\n\n"
                f"Сегодняшняя дата: {datetime.now().strftime('%Y-%m-%d')}\n\n"
                f"ТРАНСКРИПТ ВСТРЕЧИ:\n{transcript}"
            )
            resp = requests.post(
                self.LMSTUDIO_API,
                json={
                    "messages": [
                        {"role": "system", "content": sys_msg},
                        {"role": "user", "content": user_msg},
                    ],
                    # reasoning model needs headroom to think AND emit the note; a low
                    # cap truncates mid-thought (finish=length) and leaves content empty.
                    "temperature": 0.3, "max_tokens": 16000,
                },
                timeout=300,
            )
            if resp.status_code != 200:
                log(f"⚠️ LM Studio HTTP {resp.status_code}")
                return None
            data = resp.json()
            choices = data.get("choices") or []
            if not choices:
                return None
            msg = choices[0].get("message", {})
            # NEVER fall back to reasoning_content — it is raw chain-of-thought and would
            # become the note body. Empty content = failed summary, handle upstream.
            content = (msg.get("content") or "").strip()
            if content:
                log(f"✅ LLM ответил ({len(content)} символов)")
            return content or None
        except Exception as e:
            log(f"⚠️ LLM ошибка (LM Studio запущен?): {e}")
            return None

    # ── note assembly ─────────────────────────────────────────────────────
    def generate_title(self, transcript):
        """Short topical title via a tiny LLM call (for note frontmatter + history label).
        NB: reasoning models burn output tokens 'thinking' before emitting content, so a
        small max_tokens yields finish_reason=length with empty content — needs headroom."""
        import requests
        import re
        try:
            resp = requests.post(self.LMSTUDIO_API, json={
                "messages": [
                    {"role": "system", "content": "Ты даёшь короткие заголовки встреч. Ответь только заголовком."},
                    {"role": "user", "content":
                        f"Дай очень короткий заголовок (3–6 слов, без кавычек, одной строкой) "
                        f"для этой встречи:\n\n{transcript[:3000]}"},
                ],
                "temperature": 0.3, "max_tokens": 2500,
            }, timeout=120)
            if resp.status_code == 200:
                msg = (resp.json().get("choices") or [{}])[0].get("message", {})
                c = (msg.get("content") or "").strip()
                if not c:
                    # reasoning ran long (finish=length): salvage from reasoning_content —
                    # the answer is usually the last quoted phrase or last line.
                    rc = (msg.get("reasoning_content") or "").strip()
                    quoted = re.findall(r'"([^"]{3,80})"', rc)
                    c = quoted[-1] if quoted else next(
                        (l.strip() for l in reversed(rc.splitlines()) if l.strip()), "")
                line = next((l.strip() for l in reversed(c.splitlines()) if l.strip()), "")
                return line.strip('"').lstrip("#").strip()[:80]
        except Exception:
            pass
        return ""

    def infer_speaker_names(self, transcript):
        """Guess real names for diarized speaker labels from the transcript (only when
        clearly stated — introduced themselves / addressed by name). Returns {label: name}."""
        import requests
        import re
        import json
        labels = sorted(set(re.findall(r"\*\*\[([^\]]+)\]\*\*", transcript)))
        if not labels:
            return {}
        try:
            resp = requests.post(self.LMSTUDIO_API, json={
                "messages": [
                    {"role": "system", "content": "Ты определяешь реальные имена спикеров. Отвечай только JSON."},
                    {"role": "user", "content":
                        f"Метки спикеров: {', '.join(labels)}. Определи реальное имя каждого ТОЛЬКО "
                        f"если явно следует из текста (представился / обратились по имени), иначе пустая строка. "
                        f'Ответь JSON-объектом, напр. {{"Спикер 1": "Алексей", "Спикер 2": ""}}.\n\n'
                        f"ТРАНСКРИПТ:\n{transcript[:4000]}"},
                ],
                "temperature": 0.1, "max_tokens": 2500,
            }, timeout=120)
            if resp.status_code == 200:
                msg = (resp.json().get("choices") or [{}])[0].get("message", {})
                c = (msg.get("content") or "") or (msg.get("reasoning_content") or "")
                m = re.search(r"\{[^{}]*\}", c, re.S)
                if m:
                    data = json.loads(m.group(0))
                    return {k: str(v).strip() for k, v in data.items()
                            if k in labels and str(v).strip()}
        except Exception:
            pass
        return {}

    @staticmethod
    def _extract_json_object(text):
        """Locate the first syntactically valid JSON *object* in text. Unlike the
        single-level scans used by infer_speaker_names/cmd_classify (`\\{[^{}]*\\}`,
        which cannot match nested braces), this brace-balances so a structure like
        {"items":[{"what":...}], "decisions":[...]} still parses. Tolerates a
        ```json ... ``` fence and surrounding prose. Returns a dict or None."""
        import re
        fenced = re.search(r"```(?:json)?\s*(\{.*\})\s*```", text, re.S)
        candidates = [fenced.group(1)] if fenced else []
        for start, ch in enumerate(text):
            if ch != "{":
                continue
            depth = 0
            for i in range(start, len(text)):
                if text[i] == "{":
                    depth += 1
                elif text[i] == "}":
                    depth -= 1
                    if depth == 0:
                        candidates.append(text[start:i + 1])
                        break
        for cand in candidates:
            try:
                data = json.loads(cand)
            except Exception:
                continue
            if isinstance(data, dict):
                return data
        return None

    def extract_actions(self, transcript):
        """Extract action items / decisions / follow-ups from the meeting transcript
        via one structured JSON LLM call. Same JSON-snippet contract as
        infer_speaker_names/cmd_classify (content, falling back to reasoning_content —
        safe here because the result is schema-validated, not echoed verbatim like
        summarize()'s note body). Malformed/empty output degrades to {} — no note
        section, no crash."""
        import requests
        try:
            resp = requests.post(self.LMSTUDIO_API, json={
                "messages": [
                    {"role": "system", "content":
                        "Ты извлекаешь из транскрипта встречи задачи, договорённости и решения. "
                        "Отвечай только JSON."},
                    {"role": "user", "content":
                        "Извлеки из транскрипта конкретные действия/договорённости и принятые "
                        "решения. Ничего не выдумывай — только то, что явно есть в тексте. "
                        'Ответь строго JSON: {"items":[{"what":"что сделать",'
                        '"who":"кто (или пустая строка)","due":"срок (или пустая строка)"}],'
                        '"decisions":["принятое решение", ...]}. '
                        "Если пунктов нет — пустые списки.\n\n"
                        f"ТРАНСКРИПТ:\n{transcript[:8000]}"},
                ],
                "temperature": 0.1, "max_tokens": 4000,
            }, timeout=180)
            if resp.status_code != 200:
                return {}
            msg = (resp.json().get("choices") or [{}])[0].get("message", {})
            c = (msg.get("content") or "") or (msg.get("reasoning_content") or "")
            if not c.strip():
                return {}
            data = self._extract_json_object(c)
            if not isinstance(data, dict):
                return {}
            items = []
            for it in (data.get("items") or []):
                if not isinstance(it, dict):
                    continue
                what = str(it.get("what", "")).strip()
                if not what:
                    continue
                items.append({
                    "what": what,
                    "who": str(it.get("who", "")).strip(),
                    "due": str(it.get("due", "")).strip(),
                })
            decisions = [str(d).strip() for d in (data.get("decisions") or []) if str(d).strip()]
            return {"items": items, "decisions": decisions}
        except Exception as e:
            log(f"⚠️ Извлечение действий не удалось: {e}")
            return {}

    def set_frontmatter(self, note, fields):
        """Inject key: "value" pairs into the note's YAML frontmatter (create if absent).
        Empty values skipped. Source of truth for the SQLite index is this frontmatter."""
        pairs = [(k, str(v).replace('"', "").replace("\n", " ").strip())
                 for k, v in fields.items() if v]
        if not pairs:
            return note
        block = "".join(f'{k}: "{v}"\n' for k, v in pairs)
        lines = note.split("\n")
        if lines and lines[0].strip() == "---":
            return lines[0] + "\n" + block + "\n".join(lines[1:])
        return f"---\n{block}---\n\n" + note

    def set_title(self, note, title):
        return self.set_frontmatter(note, {"title": title})

    def headline_note(self):
        d = datetime.now()
        return (f"---\ntype: meeting\ndate: {d.strftime('%Y-%m-%d')}\ntags: #meeting\n---\n\n"
                f"# Встреча {d.strftime('%d.%m.%Y')}\n")

    def basic_note(self, transcript):
        d = datetime.now()
        return (f"---\ntype: meeting\ndate: {d.strftime('%Y-%m-%d')}\ntags: #meeting\n---\n\n"
                f"# Встреча {d.strftime('%d.%m.%Y')}\n\n"
                f"## 📝 Сводка\n\n*LLM-обработка недоступна (LM Studio не отвечает).*\n")

    def add_audio_link(self, note, audio_filename):
        section = f"\n## 🎵 Аудио запись\n\n![[{audio_filename}]]\n\n---\n"
        lines = note.split("\n")
        if lines and lines[0].strip() == "---":
            for i in range(1, len(lines)):
                if lines[i].strip() == "---":
                    end = i + 1
                    return "\n".join(lines[:end]) + "\n" + section + "\n".join(lines[end:])
        return section + note

    def add_actions_section(self, note, actions):
        """Append a '## Действия' checklist section (items + decisions) to the note
        body, above the transcript. actions: {"items":[{what,who,due}], "decisions":[...]}.
        Empty/missing → no-op (no empty section, no error)."""
        items = (actions or {}).get("items") or []
        decisions = (actions or {}).get("decisions") or []
        if not items and not decisions:
            return note
        lines = ["\n\n## Действия\n"]
        for it in items:
            who = f" — {it['who']}" if it.get("who") else ""
            due = f" (срок: {it['due']})" if it.get("due") else ""
            lines.append(f"- [ ] {it['what']}{who}{due}")
        if decisions:
            lines.append("\n**Решения:**")
            for d in decisions:
                lines.append(f"- {d}")
        return note + "\n".join(lines) + "\n"

    def add_transcript(self, note, transcript):
        return note + (
            "\n\n---\n\n## 📄 Полный транскрипт\n\n"
            "<details>\n<summary>Показать весь текст</summary>\n\n"
            f"{transcript}\n\n</details>\n"
        )

    # ── main entry ──────────────────────────────────────────────────────────
    def process(self, audio_file, user_prompt, keep_audio_in_obsidian=True):
        self.OBSIDIAN_PATH.mkdir(parents=True, exist_ok=True)
        timestamp = datetime.now().strftime("%Y-%m-%d-%H%M%S")  # seconds → no same-minute collision

        # Reuse a stable stamp across re-runs of the SAME source (cached) so Retry/Fresh
        # overwrite one note + one audio file instead of piling up duplicates per run.
        stamp_file = self._cache("stamp.txt")
        if stamp_file:
            if stamp_file.exists():
                timestamp = stamp_file.read_text(encoding="utf-8").strip() or timestamp
            else:
                stamp_file.write_text(timestamp, encoding="utf-8")

        # Preserve the source extension so e.g. an .m4a import is not mislabeled as .wav.
        src_suffix = Path(audio_file).suffix.lower() or ".wav"
        audio_basename = f"meeting-{timestamp}{src_suffix}"
        vault_audio = self.OBSIDIAN_PATH / audio_basename

        import shutil

        # ── 1. prep audio (cache: mono.wav) ───────────────────────────────
        stage("convert", "Подготовка аудио")
        # copy source into vault only once (skip if already there from a previous run)
        if keep_audio_in_obsidian and not vault_audio.exists() \
                and Path(audio_file).resolve() != vault_audio.resolve():
            try:
                self._copy_atomic(audio_file, vault_audio)
            except Exception as e:
                log(f"⚠️ Не скопировал аудио в Obsidian: {e}")
        mono_cache = self._cache("mono.wav")
        if mono_cache and mono_cache.exists():
            mono = str(mono_cache)
            stage_end("convert", "ok", "из кеша")
        else:
            mono = self.convert_to_mono(audio_file)
            mono = self.remove_silence_vad(mono)
            if mono_cache:
                try:
                    self._copy_atomic(mono, mono_cache)
                    mono = str(mono_cache)
                except Exception:
                    pass
            stage_end("convert", "ok")

        # ── 2. transcribe (cache: transcribe.json) ────────────────────────
        stage("transcribe", "Транскрибация")
        tj = self._cache(f"transcribe-{self.LANGUAGE}{self._glossary_cache_suffix()}.json")  # depends on language + glossary
        cached_t = self._cache_read(tj) if (tj and tj.exists()) else None
        if cached_t:
            segments, transcript = cached_t["segments"], cached_t["transcript"]
            stage_end("transcribe", "ok", f"{len(segments)} сегм. (из кеша)")
        else:
            result = self.transcribe(mono) or {}
            segments = self.filter_hallucinations(result.get("segments", []))
            if segments:
                transcript = " ".join(s["text"].strip() for s in segments if s["text"].strip())
                log(f"✅ Транскрипт: {len(transcript)} символов, {len(segments)} сегментов")
                if tj:
                    self._cache_write(tj, {"segments": segments, "transcript": transcript})
                stage_end("transcribe", "ok", f"{len(segments)} сегментов")
            else:
                transcript = result.get("text", "").strip() or "[пусто после фильтрации]"
                log("⚠️ Сегментов нет — транскрипция пустая/неудачная")
                stage_end("transcribe", "fail", "нет сегментов после фильтрации")

        # ── 2b. correct (cache: correct-<lang><glossary-suffix>.json) ─────
        # Own cache file rather than folding into transcribe's — mirrors the
        # diarize stage right below (own stage, own cache, consumes the prior
        # stage's already-loaded segments) instead of entangling two stages'
        # worth of logging inside transcribe()'s cache-hit/cache-miss branches.
        stage("correct", "Коррекция терминов")
        terms = self._glossary_terms()
        if not terms or not segments:
            stage_end("correct", "skip", "глоссарий пуст" if not terms else "нет сегментов")
        else:
            cj = self._cache(f"correct-{self.LANGUAGE}{self._glossary_cache_suffix()}.json")
            # correct's cache file is independent of transcribe's (tj) — if tj gets
            # busted/recomputed with DIFFERENT segments while cj survives untouched,
            # a plain cache-hit here would silently serve corrected text for the
            # WRONG transcript. Guard with a hash of the pre-correction segments.
            input_hash = _segments_text_hash(segments)
            cached_c = self._cache_read(cj) if (cj and cj.exists()) else None
            if cached_c and cached_c.get("input_hash") == input_hash:
                segments, transcript = cached_c["segments"], cached_c["transcript"]
                stage_end("correct", "ok", f"{cached_c.get('count', 0)} терминов (из кеша)")
            else:
                segments, stage1_reps = fuzzy_correct(segments, terms)
                llm_segments, llm_count = self.correct_glossary_llm(segments, terms)
                total = len(stage1_reps)
                if llm_segments is not None:
                    segments = llm_segments
                    total += llm_count
                transcript = " ".join(s["text"].strip() for s in segments if s["text"].strip())
                log(f"✅ Исправлено терминов: {total}")
                if cj:
                    self._cache_write(cj, {"segments": segments, "transcript": transcript,
                                            "count": total, "input_hash": input_hash})
                if llm_segments is None:
                    stage_end("correct", "fail", f"LLM недоступен — {total} по словарю")
                else:
                    stage_end("correct", "ok", f"Исправлено терминов: {total}")

        # ── 3. diarize (cache: diarize.json) ──────────────────────────────
        formatted = None
        dj = self._cache("diarize.json")
        if self.USE_DIARIZATION and segments:
            stage("diarize", "Определение спикеров")
            cached_d = self._cache_read(dj) if (dj and dj.exists()) else None
            if cached_d:
                timeline = cached_d["timeline"]
                formatted = self.combine(segments, timeline)
                stage_end("diarize", "ok", "из кеша")
            else:
                timeline = self.diarize(mono)
                if timeline:
                    if dj:
                        self._cache_write(dj, {"timeline": timeline})
                    formatted = self.combine(segments, timeline)
                    stage_end("diarize", "ok")
                else:
                    stage_end("diarize", "fail", "недоступна — спикеры по таймкодам")
        else:
            reason = "выключено" if not self.USE_DIARIZATION else "нет сегментов"
            stage_end("diarize", "skip", reason)
        if not formatted and segments:
            formatted = self.add_timestamps(segments)
        transcript_for_llm = formatted or transcript

        # ── 4. LLM summary ────────────────────────────────────────────────
        stage("llm", "Сводка через LLM")
        if not self.DO_SUMMARY:
            note = self.headline_note()
            summary = ""
            stage_end("llm", "skip", "сводка выключена — только транскрипт")
        else:
            summary = self.summarize(transcript_for_llm, user_prompt)
            if summary and len(summary) > 80:
                note = summary
                stage_end("llm", "ok", f"{len(summary)} символов")
            else:
                note = self.basic_note(transcript_for_llm)
                summary = summary or ""
                stage_end("llm", "fail", "LM Studio не ответил — заметка без сводки")

        # ── 4b. metadata: topical title + inferred speaker names (extra LLM calls) ──
        stage("meta", "Заголовок и спикеры")
        title = ""
        speakers = {}
        actions = {}
        if self.DO_SUMMARY and (summary or formatted):
            if summary:
                log("Генерирую заголовок…")
                title = self.generate_title(transcript_for_llm)
                log("Извлекаю действия и решения…")
                actions = self.extract_actions(transcript_for_llm)
            if formatted:
                log("Определяю имена спикеров…")
                speakers = self.infer_speaker_names(transcript_for_llm)
            stage_end("meta", "ok", title or f"{len(speakers)} имён")
        else:
            stage_end("meta", "skip", "нужен LLM")
        # Build speakers display string for frontmatter:
        # - if LLM inferred names: use the inferred display names (dict values)
        # - if diarization ran but no names inferred: use the raw speaker labels
        # - if no diarization: empty (set_frontmatter skips empty values)
        import re as _re
        if speakers:
            speakers_str = ", ".join(speakers.values())
        elif formatted:
            _labels = sorted(set(_re.findall(r"\*\*\[([^\]]+)\]\*\*", formatted)))
            speakers_str = ", ".join(_labels)
        else:
            speakers_str = ""
        # record title + which template (preset) was used + language in frontmatter
        note = self.set_frontmatter(note, {
            "title": title, "template": self.TEMPLATE, "language": self.LANGUAGE,
            "speakers": speakers_str})

        note = self.add_audio_link(note, audio_basename)
        note = self.add_actions_section(note, actions)
        note = self.add_transcript(note, transcript_for_llm)

        # ── 5. save ───────────────────────────────────────────────────────
        stage("save", "Сохранение заметки")
        # language suffix so switching ru→en on the same source keeps both notes
        lang_suffix = "" if self.LANGUAGE == "ru" else f"-{self.LANGUAGE}"
        note_path = self.OBSIDIAN_PATH / f"meeting-{timestamp}{lang_suffix}.md"
        note_path.write_text(note, encoding="utf-8")
        log(f"✅ Заметка сохранена: {note_path}")
        # update the derived SQLite index
        if self.db_path:
            try:
                conn = _db_connect(self.db_path)
                _db_upsert(conn, {
                    "note": str(note_path), "stamp": f"{timestamp}{lang_suffix}",
                    "title": title, "template": self.TEMPLATE, "language": self.LANGUAGE,
                    "date": datetime.now().strftime("%Y-%m-%d"),
                    "audio": str(vault_audio if keep_audio_in_obsidian else audio_file),
                    "mtime": note_path.stat().st_mtime})
                conn.close()
            except Exception as e:
                log(f"⚠️ Индекс не обновлён: {e}")
        stage_end("save", "ok")

        emit("done",
             note=str(note_path),
             audio=str(vault_audio if keep_audio_in_obsidian else audio_file),
             transcript=transcript_for_llm,
             summary=summary,
             title=title,
             speakers=speakers,
             actions=actions)


def cmd_process(args):
    prompt = Path(args.prompt_file).read_text(encoding="utf-8") if args.prompt_file else ""
    if not prompt.strip():
        prompt = "Сделай краткую структурированную сводку этой встречи в Markdown."
    pipe = Pipeline(out_dir=args.out_dir, engine=args.engine, diarize=args.diarize,
                    cache_dir=args.cache_dir, language=args.language, do_summary=args.summarize,
                    template=args.template, db_path=args.db, glossary=args.glossary)
    try:
        pipe.process(args.infile, prompt, keep_audio_in_obsidian=args.keep_audio)
    except Exception as e:
        import traceback
        emit("error", msg=f"{e}")
        sys.stderr.write(traceback.format_exc())


def build_mix_filter(n, delays_ms):
    """Build the ffmpeg -filter_complex graph for n inputs (1 or 2) with optional
    per-input leading-silence delay (ms) to align tracks that started at different
    real times. Returns (filter_complex|None, map_label|None). None,None = no filter."""
    if n == 1:
        return (None, None)  # single track → nothing to align
    parts, labels = [], []
    for i in range(2):
        d = int(delays_ms[i]) if i < len(delays_ms) else 0
        if d > 0:
            parts.append(f"[{i}:a]adelay={d}|{d}[d{i}]")
            labels.append(f"[d{i}]")
        else:
            labels.append(f"[{i}:a]")
    parts.append(f"{labels[0]}{labels[1]}amix=inputs=2:duration=longest:normalize=0[a]")
    return (";".join(parts), "[a]")


def cmd_mix(mic, system, out, mic_delay=0, sys_delay=0):
    """Mix mic.wav + system.wav → mono 16k mixed.wav (ffmpeg amix).
    Delays the later-started track by its measured offset. One track → plain re-encode."""
    import shutil
    import subprocess
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        emit("error", msg="ffmpeg не найден")
        return
    # WAV header alone is 44 bytes — anything ≤44 is effectively empty.
    tracks = [(p, d) for p, d in ((mic, mic_delay), (system, sys_delay))
              if p and Path(p).exists() and Path(p).stat().st_size > 44]
    if not tracks:
        emit("error", msg="Нет входных дорожек для микса")
        return
    inputs = [t[0] for t in tracks]
    delays = [max(0, int(t[1])) for t in tracks]
    Path(out).parent.mkdir(parents=True, exist_ok=True)
    try:
        if len(inputs) == 1:
            log("Микс: одна дорожка — простая перекодировка")
            subprocess.run([ffmpeg, "-y", "-i", inputs[0], "-ac", "1", "-ar", "16000", out],
                           check=True, capture_output=True)
        else:
            fc, mapl = build_mix_filter(2, delays)
            log(f"Микс mic + system (amix, delays={delays}мс)")
            subprocess.run([ffmpeg, "-y", "-i", inputs[0], "-i", inputs[1],
                            "-filter_complex", fc, "-map", mapl,
                            "-ac", "1", "-ar", "16000", out],
                           check=True, capture_output=True)
        emit("mixed", file=out, tracks=len(inputs))
    except subprocess.CalledProcessError as e:
        err = e.stderr.decode(errors="ignore")[-300:] if e.stderr else str(e)
        emit("error", msg=f"ffmpeg mix: {err}")


# ──────────────────────────────────────────────────────────────────────────
# SQLite index — DERIVED from note frontmatter (md remains the source of truth).
# Self-healing: reconcile() adds notes found on disk, drops rows for deleted notes.
# ──────────────────────────────────────────────────────────────────────────
_DB_COLS = ["note", "stamp", "title", "template", "language", "date", "audio", "mtime"]
_NOTE_LANGS = {"en", "auto"}
_AUDIO_EXT = {".wav", ".mp3", ".m4a", ".aac", ".flac", ".ogg", ".mp4", ".mov"}


def _db_connect(db_path):
    import sqlite3
    Path(db_path).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    # A manual reindex and a background auto-index can still overlap briefly (the
    # in-flight guard lives in main.js, not here); busy_timeout makes an unlucky
    # concurrent writer wait for the lock instead of failing with SQLITE_BUSY.
    conn.execute("PRAGMA busy_timeout=10000")
    conn.execute("""CREATE TABLE IF NOT EXISTS meetings(
        note TEXT PRIMARY KEY, stamp TEXT, title TEXT, template TEXT,
        language TEXT, date TEXT, audio TEXT, mtime REAL)""")
    return conn


def _db_upsert(conn, row):
    conn.execute("""INSERT INTO meetings(note,stamp,title,template,language,date,audio,mtime)
        VALUES(:note,:stamp,:title,:template,:language,:date,:audio,:mtime)
        ON CONFLICT(note) DO UPDATE SET stamp=:stamp,title=:title,template=:template,
        language=:language,date=:date,audio=:audio,mtime=:mtime""", row)
    conn.commit()


def _parse_frontmatter(text):
    import re
    out = {}
    if not text.startswith("---"):
        return out
    end = text.find("\n---", 3)
    if end < 0:
        return out
    for line in text[3:end].splitlines():
        m = re.match(r'^(\w+):\s*"?(.*?)"?\s*$', line)
        if m:
            out[m.group(1)] = m.group(2)
    return out


def _find_audio(note_name, files):
    import re
    stem = note_name[:-3]  # strip .md
    m = re.match(r"^(.*)-([a-z]{2,4})$", stem)
    astem = m.group(1) if (m and m.group(2) in _NOTE_LANGS) else stem
    for f in files:
        if f != note_name and f.startswith(astem + ".") and Path(f).suffix.lower() in _AUDIO_EXT:
            return f
    return None


def _reconcile(conn, out_dir):
    out = Path(out_dir)
    files = [p.name for p in out.iterdir()] if out.exists() else []
    md = [f for f in files if f.startswith("meeting-") and f.endswith(".md")]
    md_paths = {str(out / f) for f in md}
    for (note,) in conn.execute("SELECT note FROM meetings").fetchall():
        if note not in md_paths:  # note deleted in Obsidian → drop stale row
            conn.execute("DELETE FROM meetings WHERE note=?", (note,))
    for f in md:
        note_path = str(out / f)
        mtime = (out / f).stat().st_mtime
        cur = conn.execute("SELECT mtime FROM meetings WHERE note=?", (note_path,)).fetchone()
        if cur and abs(cur[0] - mtime) < 0.001:
            continue  # unchanged
        fm = _parse_frontmatter((out / f).read_text(encoding="utf-8", errors="ignore")[:2048])
        audio = _find_audio(f, files)
        _db_upsert(conn, {
            "note": note_path, "stamp": f[len("meeting-"):-3], "title": fm.get("title", ""),
            "template": fm.get("template", ""), "language": fm.get("language", ""),
            "date": fm.get("date", ""), "audio": str(out / audio) if audio else None,
            "mtime": mtime})
    conn.commit()


def _db_list(conn, limit=200):
    rows = conn.execute(
        f"SELECT {','.join(_DB_COLS)} FROM meetings ORDER BY mtime DESC LIMIT ?", (limit,)
    ).fetchall()
    return [dict(zip(_DB_COLS, r)) for r in rows]


def cmd_history(out_dir, db_path):
    conn = _db_connect(db_path)
    _reconcile(conn, out_dir)
    items = _db_list(conn)
    conn.close()
    emit("history", items=items)


def cmd_classify(note_path, existing_json=""):
    """Classify a meeting note into a PARA category + project name via the LLM.
    existing_json: optional JSON {category: [project names]} of accumulators that already
    exist — the model is told to REUSE a matching one instead of inventing a sibling,
    which is what fights the 'one topic scattered across 5 files' fragmentation."""
    import requests
    import re
    import json
    try:
        text = Path(note_path).read_text(encoding="utf-8", errors="ignore")[:4000]
    except Exception as e:
        emit("error", msg=f"Не прочитал заметку: {e}")
        return
    existing_block = ""
    try:
        existing = json.loads(existing_json) if existing_json else {}
    except Exception:
        existing = {}
    if existing:
        lines = [f"- {c}: {', '.join(names)}" for c, names in existing.items() if names]
        if lines:
            existing_block = (
                "\nУЖЕ СУЩЕСТВУЮТ накопители (category: имена):\n" + "\n".join(lines) +
                "\nЕсли заметка относится к одному из них — верни ТОЧНО эту category и "
                "project (имя из списка дословно). Только если ничего не подходит — новый project.\n")
    try:
        resp = requests.post("http://localhost:1234/v1/chat/completions", json={
            "messages": [
                {"role": "system", "content": "Ты раскладываешь заметки по методу PARA. Отвечай только JSON."},
                {"role": "user", "content":
                    "Классифицируй заметку встречи по PARA:\n"
                    "- projects: активная задача с целью/дедлайном\n"
                    "- areas: постоянная зона ответственности\n"
                    "- resources: тема/референс на будущее\n"
                    "- archives: неактуальное/завершённое\n"
                    + existing_block +
                    'Ответь JSON: {"category":"projects|areas|resources|archives","project":"короткое имя 2-4 слова"}.\n\n'
                    f"ЗАМЕТКА:\n{text}"},
            ],
            "temperature": 0.2, "max_tokens": 2500,
        }, timeout=120)
        if resp.status_code == 200:
            msg = (resp.json().get("choices") or [{}])[0].get("message", {})
            c = (msg.get("content") or "") or (msg.get("reasoning_content") or "")
            # The model may echo the prompt's TEMPLATE json ({"category":"projects|areas|
            # resources|archives","project":"короткое имя 2-4 слова"}) inside its reasoning.
            # Scan ALL json objects, take the LAST whose category is a real single value —
            # the template's pipe-category fails that test, so it is skipped automatically.
            VALID = ("projects", "areas", "resources", "archives")
            PLACEHOLDER = "короткое имя 2-4 слова"
            cat, project = "", ""
            for cand in reversed(re.findall(r"\{[^{}]*\}", c, re.S)):
                try:
                    data = json.loads(cand)
                except Exception:
                    continue
                cc = str(data.get("category", "")).lower().strip()
                if cc not in VALID:
                    continue  # skips the pipe-template "projects|areas|..."
                cat = cc
                pp = str(data.get("project", "")).strip()
                project = "" if pp.lower() == PLACEHOLDER else pp
                break
            if cat:
                emit("classified", note=note_path, category=cat, project=project[:60])
                return
        emit("error", msg="LLM не вернул классификацию (LM Studio запущен?)")
    except Exception as e:
        emit("error", msg=f"Классификация не удалась: {e}")


def cmd_extract(note_path):
    """Distil a meeting note into structured knowledge sections (темы / факты /
    обсуждения / инсайты / договорённости / прочее) that get appended into a living
    accumulator file (e.g. «1-1 с Имя.md»). Returns ready Markdown, no date heading —
    the caller stamps the date. Reasoning models burn the token budget on 'thinking'
    so content can come back empty → salvage from reasoning_content."""
    import requests
    import re
    try:
        text = Path(note_path).read_text(encoding="utf-8", errors="ignore")
    except Exception as e:
        emit("error", msg=f"Не прочитал заметку: {e}")
        return
    # Strip noise that the model otherwise echoes verbatim instead of distilling:
    # YAML frontmatter, the audio-link block, and any leaked "Thinking Process" preamble.
    text = re.sub(r"^---\n.*?\n---\n", "", text, count=1, flags=re.S)
    text = re.sub(r"##\s*🎵.*?(?=\n#|\Z)", "", text, flags=re.S)
    text = re.sub(r"(?is)thinking process:.*?(?=\n#{1,3}\s|\Z)", "", text)
    text = text.strip()[:8000]
    try:
        resp = requests.post("http://localhost:1234/v1/chat/completions", json={
            "messages": [
                {"role": "system", "content":
                    "Ты извлекаешь из заметки встречи структурированную выжимку. "
                    "Только Markdown с заданными секциями. Без вступлений и заключений. "
                    "НЕ копируй заметку, её frontmatter или существующие заголовки — "
                    "только перечисленные секции. Ничего не выдумывай."},
                {"role": "user", "content":
                    "Извлеки выжимку. Используй ТОЛЬКО эти секции третьего уровня "
                    "(### …), пустые — пропускай целиком:\n"
                    "### Темы\n### Факты\n### Обсуждения\n### Инсайты\n"
                    "### Договорённости\n### Прочее\n"
                    "Внутри секций — маркированные списки. Не повторяй текст заметки "
                    "дословно, переформулируй кратко. Сохраняй имена и английские "
                    "термины как есть.\n\nЗАМЕТКА:\n" + text},
            ],
            # reasoning model needs headroom for the full think-then-answer: a low cap
            # truncates (finish=length) mid-thought and leaves content empty. Keep this
            # >= the model's output cap configured in LM Studio.
            "temperature": 0.2, "max_tokens": 16000,
        }, timeout=300)
        if resp.status_code == 200:
            msg = (resp.json().get("choices") or [{}])[0].get("message", {})
            content = (msg.get("content") or "").strip()
            # normalize LaTeX arrows the model emits ($\rightarrow$, $\to$) → plain →
            content = re.sub(r"\$\s*\\(?:rightarrow|to)\s*\$", "→", content)
            # NEVER fall back to reasoning_content here: it is raw chain-of-thought and
            # would pollute the accumulator. Empty content = failure, surface it.
            if content:
                emit("extracted", note=note_path, content=content)
                return
        emit("error", msg="LLM не вернул выжимку (пустой content — модель ушла в reasoning?)")
    except Exception as e:
        emit("error", msg=f"Извлечение не удалось: {e}")


# ──────────────────────────────────────────────────────────────────────────
# RAG helpers: index + search commands (local hybrid PARA/Obsidian search)
# ──────────────────────────────────────────────────────────────────────────

_RAG_BASE_URL     = "http://localhost:1234"
_RAG_CHUNK_CHARS  = 2000   # ~500 tokens (4 chars/token heuristic)
_RAG_OVERLAP_CHARS = 200   # ~50 tokens overlap between windows
_RAG_RRF_K        = 60     # Reciprocal Rank Fusion k constant
_RAG_COSINE_THRESH = 0.25  # min cosine to proceed to LLM
_RAG_TOP_N        = 10     # how many vector candidates to retrieve
_RAG_CONTEXT_BUDGET = 24000  # ~6000 tokens of context chars for the LLM prompt
_RAG_NOT_FOUND    = "Не нашёл по этому вопросу записей в заметках."


def _rag_db_ensure(conn):
    """Create (if absent) the chunks table and its FTS5 mirror on the given connection."""
    conn.execute("""CREATE TABLE IF NOT EXISTS chunks(
        note_path TEXT NOT NULL,
        idx       INTEGER NOT NULL,
        text      TEXT,
        date      TEXT,
        title     TEXT,
        speakers  TEXT,
        mtime     REAL,
        embedding BLOB,
        PRIMARY KEY(note_path, idx))""")
    # Standalone FTS5 table — stores note_path+idx (UNINDEXED) as lookup keys
    # plus the chunk text for full-text search.  Standalone (no content=) avoids
    # external-content-table issues with sqlite's default isolation_level.
    try:
        conn.execute("""CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts
            USING fts5(note_path UNINDEXED, idx UNINDEXED, text)""")
    except Exception:
        # FTS5 not compiled into this sqlite build — degrade to FTS-less mode
        pass
    conn.commit()


def _rag_discover_embed_model(base_url):
    """GET /v1/models, return first model id containing 'embed', or None."""
    import requests
    try:
        resp = requests.get(f"{base_url}/v1/models", timeout=10)
        if resp.status_code != 200:
            return None
        models = resp.json().get("data") or []
        for m in models:
            mid = (m.get("id") or "").lower()
            if "embed" in mid:
                return m["id"]
    except Exception:
        pass
    return None


def _rag_embed(texts, base_url, model):
    """Embed a list of strings via LM Studio embeddings endpoint.
    Returns list of raw float bytes (one per input) or None on failure."""
    import requests
    import struct
    if not texts:
        return []
    try:
        resp = requests.post(
            f"{base_url}/v1/embeddings",
            json={"model": model, "input": texts},
            timeout=120,
        )
        if resp.status_code != 200:
            return None
        data = resp.json().get("data") or []
        if len(data) != len(texts):
            return None
        result = []
        for item in data:
            vec = item.get("embedding") or []
            result.append(struct.pack(f"{len(vec)}f", *vec))
        return result
    except Exception:
        return None


def _rag_cosine(blob_a, blob_b):
    """Cosine similarity between two float32 byte blobs. Pure Python, no numpy."""
    import struct
    n = len(blob_a) // 4
    if n == 0 or len(blob_b) // 4 != n:
        return 0.0
    a = struct.unpack(f"{n}f", blob_a)
    b = struct.unpack(f"{n}f", blob_b)
    dot = sum(x * y for x, y in zip(a, b))
    na  = sum(x * x for x in a) ** 0.5
    nb  = sum(x * x for x in b) ** 0.5
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


def _rag_chunk_text(text, chunk_chars=_RAG_CHUNK_CHARS, overlap_chars=_RAG_OVERLAP_CHARS):
    """Split text into overlapping windows of ~chunk_chars each.
    Returns list of (idx, chunk_text) tuples."""
    text = text.strip()
    if not text:
        return []
    chunks = []
    start = 0
    idx = 0
    while start < len(text):
        end = start + chunk_chars
        chunk = text[start:end].strip()
        if chunk:
            chunks.append((idx, chunk))
            idx += 1
        if end >= len(text):
            break
        start = end - overlap_chars
    return chunks


def _rag_walk_vault(root):
    """Yield Path objects for every .md file under root."""
    root = Path(root)
    if not root.exists():
        return
    for p in root.rglob("*.md"):
        yield p


def _rag_note_body(text):
    """Return the body of a note with YAML frontmatter stripped."""
    if text.startswith("---"):
        end = text.find("\n---", 3)
        if end >= 0:
            return text[end + 4:].lstrip()
    return text


def cmd_index(root, db_path, embed_model=None):
    """Walk vault, chunk notes, embed and upsert into index.db."""
    import requests
    conn = _db_connect(db_path)
    _rag_db_ensure(conn)

    # Discover embedding model if not given
    model = embed_model or _rag_discover_embed_model(_RAG_BASE_URL)
    if not model:
        emit("error", msg="Embedding-модель не найдена в LM Studio. Убедитесь что модель загружена (имя должно содержать 'embed').")
        conn.close()
        return

    log(f"Модель эмбеддингов: {model}")

    # Snapshot of currently known note_paths in DB
    known = {row[0] for row in conn.execute("SELECT DISTINCT note_path FROM chunks").fetchall()}

    indexed = 0
    skipped = 0
    removed = 0

    md_paths_on_disk = set()
    notes = list(_rag_walk_vault(root))
    total = len(notes)
    log(f"Найдено {total} заметок в хранилище")

    for i, p in enumerate(notes):
        note_path = str(p)
        md_paths_on_disk.add(note_path)

        try:
            mtime = p.stat().st_mtime
        except Exception:
            continue

        # Skip if mtime unchanged (already indexed)
        cur = conn.execute(
            "SELECT mtime FROM chunks WHERE note_path=? LIMIT 1", (note_path,)
        ).fetchone()
        if cur and abs(cur[0] - mtime) < 0.001:
            skipped += 1
            continue

        try:
            text = p.read_text(encoding="utf-8", errors="ignore")
        except Exception:
            continue

        fm = _parse_frontmatter(text)
        body = _rag_note_body(text)
        date = fm.get("date", "")
        title = fm.get("title", "")
        speakers = fm.get("speakers", "")

        raw_chunks = _rag_chunk_text(body)
        if not raw_chunks:
            skipped += 1
            continue

        chunk_texts = [c for _, c in raw_chunks]
        embeddings = _rag_embed(chunk_texts, _RAG_BASE_URL, model)
        if embeddings is None:
            emit("error", msg=f"Не удалось получить эмбеддинги для {p.name} — LM Studio недоступен?")
            conn.close()
            return

        # Delete old chunks (and FTS rows) for this note before upserting
        conn.execute("DELETE FROM chunks WHERE note_path=?", (note_path,))
        try:
            conn.execute("DELETE FROM chunks_fts WHERE note_path=?", (note_path,))
        except Exception:
            pass

        for (idx, chunk_text), emb_blob in zip(raw_chunks, embeddings):
            conn.execute(
                """INSERT INTO chunks(note_path, idx, text, date, title, speakers, mtime, embedding)
                   VALUES(?,?,?,?,?,?,?,?)
                   ON CONFLICT(note_path, idx) DO UPDATE SET
                     text=excluded.text, date=excluded.date, title=excluded.title,
                     speakers=excluded.speakers, mtime=excluded.mtime, embedding=excluded.embedding""",
                (note_path, idx, chunk_text, date, title, speakers, mtime, emb_blob))
            try:
                conn.execute(
                    "INSERT INTO chunks_fts(note_path, idx, text) VALUES(?,?,?)",
                    (note_path, idx, chunk_text))
            except Exception:
                pass

        conn.commit()
        indexed += 1
        if (i + 1) % 10 == 0 or i + 1 == total:
            log(f"Проиндексировано {indexed}/{total - skipped}")

    # Remove chunks for notes no longer on disk
    for note_path in known - md_paths_on_disk:
        conn.execute("DELETE FROM chunks WHERE note_path=?", (note_path,))
        try:
            conn.execute("DELETE FROM chunks_fts WHERE note_path=?", (note_path,))
        except Exception:
            pass
        conn.commit()
        removed += 1

    # Flush FTS5 pending writes into a searchable segment (automerge may leave
    # new inserts in a write-buffer that answers SELECT * but not MATCH queries
    # until the segments are merged; optimize forces an immediate merge).
    try:
        conn.execute("INSERT INTO chunks_fts(chunks_fts) VALUES('optimize')")
        conn.commit()
    except Exception:
        pass

    conn.close()
    emit("indexed", indexed=indexed, skipped=skipped, removed=removed)


def _rag_retrieve(conn, retrieval_query, embed_model):
    """Execute hybrid FTS+vector retrieval for retrieval_query.
    Returns (candidates, short_circuit) where short_circuit=True means no results found.
    candidates is a list of chunk dicts: {note_path, idx, text, date, title, speakers}.
    conn is NOT closed here — caller owns lifecycle."""
    import requests

    # ── 1. Embed retrieval query ──────────────────────────────────────────
    model = embed_model or _rag_discover_embed_model(_RAG_BASE_URL)
    query_emb = None
    if model:
        embs = _rag_embed([retrieval_query], _RAG_BASE_URL, model)
        if embs:
            query_emb = embs[0]
    else:
        log("Embedding-модель недоступна — поиск только по ключевым словам")

    # ── 2a. FTS keyword retrieval ─────────────────────────────────────────
    fts_keys = []
    try:
        fts_query = " OR ".join(
            '"' + w.replace('"', '""') + '"' for w in retrieval_query.split() if len(w) > 1
        ) or retrieval_query
        rows = conn.execute(
            "SELECT note_path, idx FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY rank LIMIT ?",
            (fts_query, _RAG_TOP_N * 2),
        ).fetchall()
        fts_keys = [(r[0], r[1]) for r in rows]
    except Exception:
        fts_keys = []

    # ── 2b. Vector top-N ─────────────────────────────────────────────────
    vec_keys = []
    best_cosine = 0.0
    if query_emb:
        all_rows = conn.execute(
            "SELECT note_path, idx, embedding FROM chunks WHERE embedding IS NOT NULL"
        ).fetchall()
        scored = []
        for note_path, idx, emb_blob in all_rows:
            if emb_blob:
                score = _rag_cosine(query_emb, emb_blob)
                scored.append((score, note_path, idx))
        scored.sort(reverse=True)
        if scored:
            best_cosine = scored[0][0]
        vec_keys = [(np, ix) for _, np, ix in scored[:_RAG_TOP_N]]

    # ── 3. Short-circuit ─────────────────────────────────────────────────
    if not fts_keys and best_cosine < _RAG_COSINE_THRESH:
        return [], True

    # ── 4. RRF merge ─────────────────────────────────────────────────────
    def _rrf_score(rank):
        return 1.0 / (_RAG_RRF_K + rank + 1)

    rrf = {}
    for rank, key in enumerate(fts_keys):
        rrf[key] = rrf.get(key, 0.0) + _rrf_score(rank)
    for rank, key in enumerate(vec_keys):
        rrf[key] = rrf.get(key, 0.0) + _rrf_score(rank)

    ranked_keys = sorted(rrf, key=lambda k: rrf[k], reverse=True)

    # Fetch chunk data for ranked (note_path, idx) keys
    candidates = []
    for note_path, idx in ranked_keys:
        row = conn.execute(
            "SELECT note_path, idx, text, date, title, speakers FROM chunks"
            " WHERE note_path=? AND idx=?",
            (note_path, idx),
        ).fetchone()
        if row:
            candidates.append({
                "note_path": row[0], "idx": row[1], "text": row[2],
                "date": row[3] or "", "title": row[4] or "", "speakers": row[5] or "",
            })

    return candidates, False


def cmd_search(root, db_path, query=None, embed_model=None, messages=None):
    """Hybrid RAG search over indexed vault with optional conversation history.

    Input:
      messages  — list of {"role":"user"|"assistant","content":"..."} in chronological order.
                  The last item must be a user message (the current question).
      query     — legacy shorthand; internally normalised to a one-message list.

    If there is prior conversation (> 1 user message OR any assistant turn) a single
    LLM call condenses the history into a standalone retrieval query.  With a single
    user message and no prior turns the query is used verbatim — no extra LLM call.

    Returns found/answer/citations JSON event.
    """
    import requests
    import json as _json

    # ── 0. Normalise input to a messages list ─────────────────────────────
    if messages is None:
        if query is None:
            emit("error", msg="cmd_search: either --query or --messages is required")
            return
        messages = [{"role": "user", "content": query}]
    elif isinstance(messages, str):
        messages = _json.loads(messages)

    # Latest user message drives everything
    user_messages = [m for m in messages if m.get("role") == "user"]
    if not user_messages:
        emit("error", msg="cmd_search: messages must contain at least one user turn")
        return
    latest_user_content = user_messages[-1]["content"]

    # Determine whether there is prior conversation context
    has_prior_context = len(messages) > 1  # any prior turn (user or assistant)

    conn = _db_connect(db_path)
    _rag_db_ensure(conn)

    # ── 1. History-aware query rewrite (only when there is prior context) ─
    # Single user message with no prior turns → use it verbatim (save tokens).
    # With prior context → one LLM call condenses history+latest into a standalone query.
    if has_prior_context:
        retrieval_query = latest_user_content  # fallback in case rewrite fails
        try:
            # Build a compact history summary for the condensation prompt.
            history_text = ""
            for m in messages:
                role = m.get("role", "user")
                content = m.get("content", "").strip()
                history_text += f"[{role}]: {content}\n"
            resp = requests.post(
                f"{_RAG_BASE_URL}/v1/chat/completions",
                json={
                    "messages": [
                        {"role": "system", "content":
                            "Ты помогаешь переформулировать вопрос для поиска. "
                            "Верни ТОЛЬКО переформулированный поисковый запрос, без пояснений."},
                        {"role": "user", "content":
                            "Перефразируй последний вопрос пользователя в самостоятельный "
                            "поисковый запрос с учётом контекста диалога. "
                            "Верни ТОЛЬКО запрос, без пояснений.\n\n"
                            f"ДИАЛОГ:\n{history_text}"},
                    ],
                    "temperature": 0.1,
                    # reasoning models need headroom; k2-lmstudio-reasoning-tokens rule
                    "max_tokens": 2500,
                },
                timeout=60,
            )
            if resp.status_code == 200:
                choices = resp.json().get("choices") or []
                if choices:
                    rewritten = (choices[0].get("message", {}).get("content") or "").strip()
                    # NEVER fall back to reasoning_content — keep it search-query only
                    if rewritten:
                        retrieval_query = rewritten
        except Exception:
            pass  # rewrite failed → fall back to verbatim latest user content
    else:
        retrieval_query = latest_user_content

    # ── 2. Retrieve via existing hybrid FTS+vector+RRF pipeline ──────────
    candidates, short_circuit = _rag_retrieve(conn, retrieval_query, embed_model)
    conn.close()

    if short_circuit or not candidates:
        emit("search_result", found=False, answer=_RAG_NOT_FOUND, citations=[])
        return

    # ── 3. Build context under token budget ──────────────────────────────
    context_parts = []
    context_chars = 0
    seen_notes = []
    seen_note_paths = set()

    for chunk in candidates:
        header = f"[{chunk['date']} · {chunk['title']}]"
        if chunk["speakers"]:
            header += f" · {chunk['speakers']}"
        part = f"{header}\n{chunk['text']}"
        if context_chars + len(part) > _RAG_CONTEXT_BUDGET:
            break
        context_parts.append(part)
        context_chars += len(part)
        if chunk["note_path"] not in seen_note_paths:
            seen_note_paths.add(chunk["note_path"])
            seen_notes.append({
                "date": chunk["date"],
                "title": chunk["title"],
                "note_path": chunk["note_path"],
            })

    if not context_parts:
        emit("search_result", found=False, answer=_RAG_NOT_FOUND, citations=[])
        return

    # ── 4. Build answer LLM call with full conversation history ──────────
    sys_msg = (
        "Ты отвечаешь СТРОГО по предоставленным фрагментам встреч. "
        "Каждое утверждение сопровождай ссылкой [дата · заголовок]. "
        "Если в фрагментах нет ответа — ответь ровно: «" + _RAG_NOT_FOUND + "» Не выдумывай."
    )
    chunks_block = "Фрагменты встреч:\n" + "\n\n---\n".join(context_parts)

    # Inject retrieved chunks into the last user message so the model sees both
    # the conversation history AND the grounding context in a single coherent thread.
    llm_messages = [{"role": "system", "content": sys_msg}]
    for m in messages[:-1]:
        llm_messages.append({"role": m["role"], "content": m["content"]})
    last_content = latest_user_content + "\n\n" + chunks_block
    llm_messages.append({"role": "user", "content": last_content})

    # ── 5. Call LM Studio chat ────────────────────────────────────────────
    answer = None
    try:
        resp = requests.post(
            f"{_RAG_BASE_URL}/v1/chat/completions",
            json={
                "messages": llm_messages,
                "temperature": 0.2,
                "max_tokens": 4096,
            },
            timeout=300,
        )
        if resp.status_code == 200:
            data = resp.json()
            choices = data.get("choices") or []
            if choices:
                msg = choices[0].get("message", {})
                # Per backend.py:507-512 contract: NEVER fall back to reasoning_content
                content = (msg.get("content") or "").strip()
                if content:
                    answer = content
    except Exception as e:
        emit("error", msg=f"RAG LLM ошибка: {e}")
        return

    if answer is None:
        emit("error", msg="LLM не вернул ответ на поисковый запрос (LM Studio запущен?)")
        return

    found = answer.strip() != _RAG_NOT_FOUND
    emit("search_result", found=found, answer=answer, citations=seen_notes)


def cmd_preflight():
    """Readiness checks the GUI shows before recording (cheap, no network from here)."""
    import shutil
    model_dir = Path.home() / ".cache/huggingface/hub/models--mlx-community--whisper-large-v3-turbo"
    emit("preflight",
         ffmpeg=shutil.which("ffmpeg") is not None,
         whisper_cached=model_dir.exists(),
         hf_token=bool(os.environ.get("HF_TOKEN")))


def str2bool(v):
    return str(v).lower() in ("1", "true", "yes", "on")


def main():
    default_obsidian = str(Path.home() / "Documents/Obsidian/Meetings")

    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("devices")
    sub.add_parser("preflight")

    p_cls = sub.add_parser("classify")
    p_cls.add_argument("--note", required=True)
    p_cls.add_argument("--existing", default="")  # JSON {category: [names]} for reuse

    p_ext = sub.add_parser("extract")
    p_ext.add_argument("--note", required=True)

    p_rec = sub.add_parser("record")  # microphone only
    p_rec.add_argument("--out", required=True)
    p_rec.add_argument("--device", type=int, default=None)

    p_mix = sub.add_parser("mix")
    p_mix.add_argument("--mic", default=None)
    p_mix.add_argument("--system", default=None)
    p_mix.add_argument("--out", required=True)
    p_mix.add_argument("--mic-delay-ms", dest="mic_delay", type=int, default=0)
    p_mix.add_argument("--sys-delay-ms", dest="sys_delay", type=int, default=0)

    p_proc = sub.add_parser("process")
    p_proc.add_argument("--in", dest="infile", required=True)
    p_proc.add_argument("--prompt-file", dest="prompt_file", default=None)
    p_proc.add_argument("--diarize", type=str2bool, default=True)
    p_proc.add_argument("--out-dir", dest="out_dir", default=default_obsidian)
    p_proc.add_argument("--engine", default="mlx")
    p_proc.add_argument("--keep-audio", dest="keep_audio", type=str2bool, default=True)
    p_proc.add_argument("--cache-dir", dest="cache_dir", default=None)
    p_proc.add_argument("--language", default="ru")  # ru | en | auto
    p_proc.add_argument("--glossary", default="")  # comma/newline-separated terms → Whisper initial_prompt
    p_proc.add_argument("--summarize", type=str2bool, default=True)
    p_proc.add_argument("--template", default="")
    p_proc.add_argument("--db", default=None)

    p_hist = sub.add_parser("history")
    p_hist.add_argument("--out-dir", dest="out_dir", default=default_obsidian)
    p_hist.add_argument("--db", required=True)

    p_idx = sub.add_parser("index")
    p_idx.add_argument("--root", required=True)
    p_idx.add_argument("--db", required=True)
    p_idx.add_argument("--embed-model", dest="embed_model", default=None)

    p_srch = sub.add_parser("search")
    p_srch.add_argument("--root", required=True)
    p_srch.add_argument("--db", required=True)
    # --query is the legacy single-question shorthand; --messages is the multi-turn form.
    # Exactly one of them must be supplied (enforced at call time in cmd_search).
    p_srch.add_argument("--query", default=None)
    p_srch.add_argument("--messages", default=None,
                        help="JSON array of {role,content} objects, last item is newest user msg")
    p_srch.add_argument("--embed-model", dest="embed_model", default=None)

    args = parser.parse_args()

    if args.cmd == "devices":
        emit("devices", devices=list_devices())
    elif args.cmd == "preflight":
        cmd_preflight()
    elif args.cmd == "classify":
        cmd_classify(args.note, args.existing)
    elif args.cmd == "extract":
        cmd_extract(args.note)
    elif args.cmd == "history":
        cmd_history(args.out_dir, args.db)
    elif args.cmd == "record":
        cmd_record(args.out, args.device)
    elif args.cmd == "mix":
        cmd_mix(args.mic, args.system, args.out, args.mic_delay, args.sys_delay)
    elif args.cmd == "process":
        cmd_process(args)
    elif args.cmd == "index":
        cmd_index(args.root, args.db, args.embed_model)
    elif args.cmd == "search":
        cmd_search(args.root, args.db, query=args.query,
                   embed_model=args.embed_model, messages=args.messages)


if __name__ == "__main__":
    main()
