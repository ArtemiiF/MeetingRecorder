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
             "actions": {"items": [{"what","who","due"}], "decisions": [str]},
             "suggestions": [str],                      glossary term candidates
             "glossary_usage": {term_lower: count}}      per-term fires THIS run only
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
import signal
import threading
import argparse
import warnings
from datetime import datetime
from pathlib import Path

# Pure-logic core (no fs/network/subprocess/sqlite/emit-log) — sibling module,
# ships alongside backend.py in both dev and packaged layouts (see package.json's
# build.extraResources). See backend_core.py's own docstring for the full list.
from backend_core import (
    _base_stamp,
    _llm_correct_budget,
    fuzzy_correct,
    gate_llm_correction,
    _diff_term_hits,
    _term_or_declined_form,
    _segments_text_hash,
    _shift_chunks,
    compute_speaker_dominance,
    pick_author_label,
    _normalized_xcorr_peak,
    str2bool,
    combine,
    add_timestamps,
)

warnings.filterwarnings("ignore", category=UserWarning)


# ──────────────────────────────────────────────────────────────────────────
# Event-name contract (M4 arch-audit) — single source of truth shared with
# main.js's lib/events.js (see that file's own comment for the full picture).
# Loaded once at import time from the repo-root events.json; emit() below
# asserts every event name it ever sends is a member of this set, so a
# typo/rename here fails LOUDLY at runtime instead of silently drifting out of
# sync with main.js's dispatch. The cross-lock test (tests/test_backend.py)
# checks the OTHER direction: every EVENTS.* constant main.js's dispatch
# actually references resolves to a name present in this same events.json.
def _load_event_names():
    contract_path = Path(__file__).parent / "events.json"
    try:
        data = json.loads(contract_path.read_text(encoding="utf-8"))
        return frozenset(data["events"])
    except Exception:
        # A missing/corrupt contract file must not crash the whole backend —
        # None disables emit()'s assertion below (an empty frozenset would
        # reject EVERY event) rather than break every single command; the
        # cross-lock test still catches a missing/corrupt file directly.
        return None


EVENT_NAMES = _load_event_names()

_CURRENT_STAGE = "general"  # which stage subsequent log() lines belong to


def emit(event, **kwargs):
    """Print one json line to stdout and flush."""
    assert EVENT_NAMES is None or event in EVENT_NAMES, (
        f"unknown event name {event!r} — not in events.json contract (M4 arch-audit)"
    )
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


# Chunk size for correct_glossary_llm's LM Studio requests (I/O side — the
# pure glossary-correction helpers this used to sit next to now live in
# backend_core.py: _llm_correct_budget, fuzzy_correct, gate_llm_correction,
# _diff_term_hits, etc.). A separate constant from the RAG search chunker's
# _RAG_CHUNK_CHARS (same numeric value today, but the two are tuned for
# different jobs — RAG chunks are embedded independently, correction chunks
# must reassemble exactly onto segment boundaries) so tuning one doesn't
# silently retune the other.
_CORRECT_CHUNK_CHARS = 2000


# ──────────────────────────────────────────────────────────────────────────
# Processing pipeline (refactored from meeting_simple_v9.py)
# ──────────────────────────────────────────────────────────────────────────
class Pipeline:
    def __init__(self, out_dir, engine="mlx", diarize=True, cache_dir=None,
                 language="ru", do_summary=True, template="", db_path=None, glossary="",
                 author_name="Автор", fast_model="", glossary_usage=None, main_model=""):
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
        # Cumulative {term_lower: fire_count} from past runs (renderer-persisted) — used
        # ONLY to order _build_initial_prompt's terms before the token-budget truncation
        # (most-used survive a tight budget); never mutated here. Empty/None → today's
        # behaviour, byte-identical (see _build_initial_prompt).
        self.GLOSSARY_USAGE = glossary_usage or {}
        self.AUTHOR_NAME = author_name    # display name seeded for the auto-detected mic-dominant speaker
        # Overrides the loaded LM Studio model for MECHANICAL calls only (glossary
        # correction, title, glossary suggestions) — see correct_glossary_llm/
        # generate_title/suggest_glossary_terms. Empty = omit "model" from the
        # request body, LM Studio uses whatever's loaded (today's behaviour).
        # summarize() and every other LLM call deliberately never read this —
        # the reasoning summary stays on the default loaded model.
        self.FAST_MODEL = fast_model
        # Overrides the loaded LM Studio model for SUBSTANTIVE calls (summary, speaker-
        # inference, action-item extraction) — see summarize/infer_speaker_names/
        # extract_actions. Empty = omit "model" from the request body, LM Studio uses
        # whatever's loaded — today's behaviour, including the reasoning-model summary
        # with thinking, is byte-identical when this is empty (regression lock, mirrors
        # FAST_MODEL's own empty-string contract). Mechanical calls (correct/title/
        # suggest) never read this — they stay on FAST_MODEL exclusively.
        self.MAIN_MODEL = main_model
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
        """Returns (vad_file, vad_chunks). vad_chunks is the raw speech-timestamp map
        (samples @16kHz, pre-collapse) — persisted by the caller as vad_map.json so the
        auto-«Я» author-detection stage can later re-derive the same collapse for
        mic.wav/system.wav (see detect_author_speaker). None when VAD found nothing
        or failed — the original (uncollapsed) audio_file is returned in that case."""
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
                return audio_file, None
            speech = collect_chunks(ts, wav)
            vad_file = audio_file.replace(".wav", "_vad.wav")
            save_audio(vad_file, speech, sampling_rate=16000)
            log(f"✅ Тишина удалена: {len(wav)/16000:.1f}с → {len(speech)/16000:.1f}с")
            vad_chunks = [{"start": int(t["start"]), "end": int(t["end"])} for t in ts]
            return vad_file, vad_chunks
        except Exception as e:
            log(f"⚠️ VAD не сработал: {e}")
            return audio_file, None

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
    # "suggest" stage (see suggest_glossary_terms) — extraction hint only; every
    # candidate is re-validated against the transcript and the glossary in code.
    SUGGEST_SYSTEM_PROMPT = (
        "Ты извлекаешь из транскрипта встречи кандидатов для словаря терминов, "
        "которые помогают распознаванию речи. Извлеки до 20 терминов: имена людей, "
        "названия продуктов/инструментов/компаний, повторяющиеся доменные термины. "
        "Не выдумывай — только то, что явно есть в тексте. Ответь строго списком "
        "терминов через запятую, без нумерации и пояснений."
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

    # Whisper's `initial_prompt` window holds only the LAST ~224 tokens of the
    # string — anything earlier is silently dropped by the decoder. Token count
    # is estimated with a conservative chars/3 heuristic (no tokenizer dependency
    # pulled in just for this): real BPE tokenizers average ~4 chars/token for
    # English and fewer for Cyrillic, so chars/3 over-counts tokens and errs
    # toward dropping too much glossary rather than risking silent eviction of
    # the context prompt.
    _INITIAL_PROMPT_TOKEN_BUDGET = 224

    @staticmethod
    def _estimate_tokens(text):
        if not text:
            return 0
        return -(-len(text) // 3)  # ceil(len/3) without importing math

    def _build_initial_prompt(self):
        """Compose Whisper's initial_prompt from the context prompt + glossary,
        capped to _INITIAL_PROMPT_TOKEN_BUDGET tokens so nothing is silently
        evicted. Context prompt has priority and is never truncated; if it alone
        already meets/exceeds the budget, the glossary is dropped entirely.
        Otherwise glossary terms are dropped from the END of the list until the
        combined prompt fits — so ordering the list well matters. When usage data
        is available (self.GLOSSARY_USAGE), terms are sorted by fire count
        DESCENDING first (Python's sort is stable, so ties — including "never
        fired", count 0 — keep the glossary's own order); a truncation then drops
        the LEAST-used terms rather than an arbitrary tail. No usage data →
        today's order, byte-identical."""
        context = self._context_prompt()
        terms = self._glossary_terms()
        if not terms:
            return context
        if context and self._estimate_tokens(context) >= self._INITIAL_PROMPT_TOKEN_BUDGET:
            return context
        if self.GLOSSARY_USAGE:
            terms = sorted(terms, key=lambda t: -self.GLOSSARY_USAGE.get(t.lower(), 0))
        kept = list(terms)
        while kept:
            glossary_prompt = "Термины: " + ", ".join(kept) + "."
            candidate = f"{context} {glossary_prompt}" if context else glossary_prompt
            if self._estimate_tokens(candidate) <= self._INITIAL_PROMPT_TOKEN_BUDGET:
                return candidate
            kept.pop()
        return context

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
        prompt = self._build_initial_prompt()
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
                max_tokens, timeout = _llm_correct_budget(len(chunk))
                payload = {
                    "messages": [
                        {"role": "system", "content": sys_msg},
                        {"role": "user", "content": chunk},
                    ],
                    "temperature": 0.0, "max_tokens": max_tokens,
                }
                if self.FAST_MODEL:
                    payload["model"] = self.FAST_MODEL
                resp = requests.post(self.LMSTUDIO_API, json=payload, timeout=timeout)
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
        except requests.exceptions.Timeout:
            log(f"⚠️ LLM не ответил за {timeout:.0f}с — коррекция терминов только по словарю")
            return None, 0
        except requests.exceptions.ConnectionError as e:
            log(f"⚠️ LLM недоступен — коррекция терминов только по словарю: {e}")
            return None, 0
        except Exception as e:
            log(f"⚠️ LLM недоступен — коррекция терминов только по словарю: {e}")
            return None, 0
        return new_segments, accepted

    # ── glossary auto-enrichment: "suggest" stage ───────────────────────────
    def suggest_glossary_terms(self, transcript, existing_terms):
        """LLM pass over the FINAL corrected transcript, extracting up to 20
        candidate glossary terms (people names, product/tool/company names,
        recurring domain terms) that feed the "Предложения" inbox on the
        Словарь tab. The LLM output is only a hint — every candidate is
        re-validated in code before being returned:
          - must actually occur in the transcript (case-insensitive substring
            match) — blocks LLM invention;
          - must not already be covered by the glossary, exactly or as a
            whitelisted declined form (_term_or_declined_form, same guard
            fuzzy_correct uses);
          - longer than 2 characters;
          - deduped, capped at 20.
        On any LM Studio failure (unreachable, non-200, empty reply) this
        degrades to an empty list and logs a warning — mirrors
        correct_glossary_llm's degrade-and-log pattern — and never raises, so
        the pipeline always completes."""
        if not transcript or not transcript.strip():
            return []
        import re
        import requests
        try:
            payload = {
                "messages": [
                    {"role": "system", "content": self.SUGGEST_SYSTEM_PROMPT},
                    {"role": "user", "content": f"ТРАНСКРИПТ:\n{transcript[:8000]}"},
                ],
                "temperature": 0.1, "max_tokens": 2500,
            }
            if self.FAST_MODEL:
                payload["model"] = self.FAST_MODEL
            resp = requests.post(self.LMSTUDIO_API, json=payload, timeout=120)
            if resp.status_code != 200:
                log(f"⚠️ LM Studio HTTP {resp.status_code} — предложения словаря пропущены")
                return []
            msg = (resp.json().get("choices") or [{}])[0].get("message", {})
            raw = (msg.get("content") or "") or (msg.get("reasoning_content") or "")
            if not raw.strip():
                return []
        except Exception as e:
            log(f"⚠️ LLM недоступен — предложения словаря пропущены: {e}")
            return []

        candidates = [t.strip() for t in re.split(r"[,\n]+", raw) if t.strip()]
        lower_transcript = transcript.lower()
        seen, out = set(), []
        for cand in candidates:
            low = cand.lower()
            if low not in lower_transcript:
                continue  # hard gate: LLM invented a term not actually in the transcript
            if _term_or_declined_form(cand, existing_terms) is not None:
                continue  # already covered by the glossary (exact or declined form)
            if low in seen or len(cand) <= 2:
                continue
            seen.add(low)
            out.append(cand)
            if len(out) >= 20:
                break
        return out

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

    # Never touches self (verified in the #32 architecture audit) — the actual
    # implementation moved to backend_core.combine (pure-core extraction);
    # this stays a staticmethod delegate so `pipe.combine(...)` call sites and
    # existing tests keep working unmodified.
    combine = staticmethod(combine)

    # ── auto-«Я»: detect which diarized speaker is the recording author ────────
    def detect_author_speaker(self, mic_file, system_file, vad_chunks, timeline, label_map):
        """Guess which diarization label is the author, from the mic track's OWN
        activity: whichever label claims most of the mic track's total energy is
        the one wearing this mic (see compute_speaker_dominance's mic_share). Does
        NOT compare against the system track — the system track can also carry the
        author's voice (call echo/mix), which is why a mic-vs-system ratio fails on
        real conferencing audio. Orchestration only (I/O + logging) — all decisions
        are delegated to the pure helpers above. Returns a FRIENDLY label (via
        label_map) or None; never mutates `speakers` itself — that merge happens in
        process()."""
        def nonempty(p):
            return bool(p) and Path(p).exists() and Path(p).stat().st_size > 44  # WAV header alone is 44 bytes

        if not nonempty(mic_file) or not nonempty(system_file):
            log("Авто-«Я»: mic/system дорожка недоступна — пропуск")
            return None

        # Same call cmd_mix made at mix-time (mic_delay=sys_delay=0 defaults) —
        # deterministic given the same two files, see estimate_start_offset_ms.
        mic_delay_ms, sys_delay_ms, _ = estimate_start_offset_ms(mic_file, system_file)

        def full_track(path):
            with wave.open(str(path), "rb") as w:
                duration_s = w.getnframes() / float(w.getframerate())
            return _read_mono_decimated(path, duration_s + 1.0, 16000)

        try:
            mic_raw = full_track(mic_file)
            sys_raw = full_track(system_file)
        except Exception as e:
            log(f"Авто-«Я»: ошибка чтения WAV ({e}) — пропуск")
            return None

        if vad_chunks:
            # Same chunk list used to collapse `mono`, shifted per-track by that
            # track's own mix-time delay — lands mic/system in mono's exact
            # collapsed timebase (see _shift_chunks docstring).
            mic_chunks = _shift_chunks(vad_chunks, mic_delay_ms, 16000, len(mic_raw))
            sys_chunks = _shift_chunks(vad_chunks, sys_delay_ms, 16000, len(sys_raw))
            mic_collapsed = _collect_chunks_np(mic_chunks, mic_raw)
            sys_collapsed = _collect_chunks_np(sys_chunks, sys_raw)
        else:
            # VAD was skipped/failed -> mono was never collapsed -> timeline is
            # already wall-clock. Align the raw tracks with a plain leading-silence
            # offset instead (no collapse needed).
            import numpy as np
            mic_pad = int(round(mic_delay_ms * 16000 / 1000))
            sys_pad = int(round(sys_delay_ms * 16000 / 1000))
            mic_collapsed = np.concatenate([np.zeros(mic_pad), mic_raw]) if mic_pad else mic_raw
            sys_collapsed = np.concatenate([np.zeros(sys_pad), sys_raw]) if sys_pad else sys_raw

        scores = compute_speaker_dominance(timeline, mic_collapsed, sys_collapsed, rate=16000)
        for label, s in scores.items():
            log(f"Авто-«Я»: {label} mic_share={s['mic_share']:.2f} mic_level={s['mic_level']:.1f} "
                f"mic_ratio={s['mic_ratio']:.2f} длительность={s['duration_s']:.1f}с")
        winner = pick_author_label(scores)
        if not winner:
            log("Авто-«Я»: неоднозначно/нет уверенного лидера — метка не проставлена")
            return None
        friendly = label_map.get(winner, winner)
        log(f"Авто-«Я»: спикер «{friendly}» определён как автор (доминирование по mic_share)")
        return friendly

    # Never touches self — moved to backend_core.add_timestamps; staticmethod
    # delegate keeps `pipe.add_timestamps(...)` call sites unchanged.
    add_timestamps = staticmethod(add_timestamps)

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
            payload = {
                "messages": [
                    {"role": "system", "content": sys_msg},
                    {"role": "user", "content": user_msg},
                ],
                # reasoning model needs headroom to think AND emit the note; a low
                # cap truncates mid-thought (finish=length) and leaves content empty.
                "temperature": 0.3, "max_tokens": 16000,
            }
            if self.MAIN_MODEL:
                payload["model"] = self.MAIN_MODEL
            resp = requests.post(self.LMSTUDIO_API, json=payload, timeout=300)
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
            system_prompt = "Ты даёшь короткие заголовки встреч. Ответь только заголовком."
            # Pin the title's language to the pipeline's transcription language — otherwise
            # the LLM tends to mirror whatever language its own instructions are written in
            # (Russian), producing a Russian title even for an English-language meeting.
            # "auto" has no fixed language to pin to — leave the prompt as before.
            if self.LANGUAGE == "ru":
                system_prompt += " Ответь на русском языке."
            elif self.LANGUAGE == "en":
                system_prompt += " Answer in English."
            payload = {
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content":
                        f"Дай очень короткий заголовок (3–6 слов, без кавычек, одной строкой) "
                        f"для этой встречи:\n\n{transcript[:3000]}"},
                ],
                "temperature": 0.3, "max_tokens": 2500,
            }
            if self.FAST_MODEL:
                payload["model"] = self.FAST_MODEL
            resp = requests.post(self.LMSTUDIO_API, json=payload, timeout=120)
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
            payload = {
                "messages": [
                    {"role": "system", "content": "Ты определяешь реальные имена спикеров. Отвечай только JSON."},
                    {"role": "user", "content":
                        f"Метки спикеров: {', '.join(labels)}. Определи реальное имя каждого ТОЛЬКО "
                        f"если явно следует из текста (представился / обратились по имени), иначе пустая строка. "
                        f'Ответь JSON-объектом, напр. {{"Спикер 1": "Алексей", "Спикер 2": ""}}.\n\n'
                        f"ТРАНСКРИПТ:\n{transcript[:4000]}"},
                ],
                "temperature": 0.1, "max_tokens": 2500,
            }
            if self.MAIN_MODEL:
                payload["model"] = self.MAIN_MODEL
            resp = requests.post(self.LMSTUDIO_API, json=payload, timeout=120)
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
            payload = {
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
            }
            if self.MAIN_MODEL:
                payload["model"] = self.MAIN_MODEL
            resp = requests.post(self.LMSTUDIO_API, json=payload, timeout=180)
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
    def process(self, audio_file, user_prompt, keep_audio_in_obsidian=True,
                mic_file=None, system_file=None, origin=None, version=None):
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
        vad_map_cache = self._cache("vad_map.json")
        if mono_cache and mono_cache.exists():
            mono = str(mono_cache)
            # existing caches from before this feature never wrote vad_map.json —
            # vad_chunks stays None, auto-«Я» silently skips, nothing recomputes.
            vad_chunks = None
            if vad_map_cache and vad_map_cache.exists():
                vad_chunks = (self._cache_read(vad_map_cache) or {}).get("chunks")
            stage_end("convert", "ok", "из кеша")
        else:
            mono = self.convert_to_mono(audio_file)
            mono, vad_chunks = self.remove_silence_vad(mono)
            if vad_map_cache:
                try:
                    self._cache_write(vad_map_cache, {"chunks": vad_chunks})
                except Exception:
                    pass
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
        # Per-term fire counts for THIS run, merged across stage1 (fuzzy_correct) and
        # stage2 (LLM, via _diff_term_hits) — feeds the done-payload's glossary_usage
        # field (see emit("done", ...) below), which the renderer accumulates across
        # runs and later feeds back as glossary_usage on the NEXT run's Pipeline, to
        # order _build_initial_prompt's truncation by actual usage.
        glossary_hits = []
        if not terms or not segments:
            stage_end("correct", "skip", "глоссарий пуст" if not terms else "нет сегментов")
        else:
            cj = self._cache(f"correct-{self.LANGUAGE}{self._glossary_cache_suffix()}.json")
            # correct's cache file is independent of transcribe's (tj) — if tj gets
            # busted/recomputed with DIFFERENT segments while cj survives untouched,
            # a plain cache-hit here would silently serve corrected text for the
            # WRONG transcript. Guard with a hash of the pre-correction segments.
            input_hash = _segments_text_hash(segments)
            # A cache hit is only honored when the LLM pass actually succeeded
            # (llm_ok) — a transient timeout/outage must not lock a degraded,
            # dictionary-only result in forever; missing key (pre-existing
            # caches from before this field existed) is treated as not-ok too,
            # so old caches recompute once rather than being trusted blindly.
            cached_c = self._cache_read(cj) if (cj and cj.exists()) else None
            if cached_c and cached_c.get("input_hash") == input_hash and cached_c.get("llm_ok") is True:
                segments, transcript = cached_c["segments"], cached_c["transcript"]
                glossary_hits = cached_c.get("term_hits", [])
                stage_end("correct", "ok", f"{cached_c.get('count', 0)} терминов (из кеша)")
            else:
                segments, stage1_reps = fuzzy_correct(segments, terms)
                pre_llm_segments = segments
                llm_segments, llm_count = self.correct_glossary_llm(segments, terms)
                total = len(stage1_reps)
                llm_ok = llm_segments is not None
                llm_hits = []
                if llm_ok:
                    for before, after in zip(pre_llm_segments, llm_segments):
                        llm_hits.extend(_diff_term_hits((before.get("text") or "").split(),
                                                          (after.get("text") or "").split(), terms))
                    segments = llm_segments
                    total += llm_count
                glossary_hits = stage1_reps + llm_hits
                transcript = " ".join(s["text"].strip() for s in segments if s["text"].strip())
                log(f"✅ Исправлено терминов: {total}")
                if cj:
                    self._cache_write(cj, {"segments": segments, "transcript": transcript,
                                            "count": total, "input_hash": input_hash,
                                            "llm_ok": llm_ok, "term_hits": glossary_hits})
                if not llm_ok:
                    stage_end("correct", "fail", f"LLM недоступен — {total} по словарю")
                else:
                    stage_end("correct", "ok", f"Исправлено терминов: {total}")

        # ── 3. diarize (cache: diarize.json) ──────────────────────────────
        formatted = None
        label_map = {}
        auto_label = None
        dj = self._cache("diarize.json")
        if self.USE_DIARIZATION and segments:
            stage("diarize", "Определение спикеров")
            cached_d = self._cache_read(dj) if (dj and dj.exists()) else None
            if cached_d:
                timeline = cached_d["timeline"]
                formatted, label_map = self.combine(segments, timeline)
                stage_end("diarize", "ok", "из кеша")
            else:
                timeline = self.diarize(mono)
                if timeline:
                    if dj:
                        self._cache_write(dj, {"timeline": timeline})
                    formatted, label_map = self.combine(segments, timeline)
                    stage_end("diarize", "ok")
                else:
                    stage_end("diarize", "fail", "недоступна — спикеры по таймкодам")
            if formatted and mic_file and system_file:
                auto_label = self.detect_author_speaker(mic_file, system_file, vad_chunks, timeline, label_map)
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

        # ── 4b. glossary term suggestions (cache: suggest-<lang><glossary-suffix>.json) ──
        # Independent of DO_SUMMARY (unlike the meta stage below) — runs whenever an
        # LLM is reachable, since a transcript-only run still benefits from glossary
        # suggestions. Cache key mirrors correct's: language + glossary suffix (a
        # suggestion set depends on what's already in the glossary) PLUS a hash of
        # the transcript text itself, since — unlike correct — a glossary change
        # alone doesn't bound every way this stage's input can change (formatted vs.
        # plain transcript, diarization differences) while the suffix stays equal.
        stage("suggest", "Предложения словаря")
        sj = self._cache(f"suggest-{self.LANGUAGE}{self._glossary_cache_suffix()}.json")
        import hashlib
        suggest_input_hash = hashlib.sha1(transcript_for_llm.encode("utf-8")).hexdigest()[:12]
        cached_s = self._cache_read(sj) if (sj and sj.exists()) else None
        if cached_s and cached_s.get("input_hash") == suggest_input_hash:
            suggestions = cached_s.get("terms", [])
            stage_end("suggest", "ok", f"{len(suggestions)} кандидатов (из кеша)")
        else:
            suggestions = self.suggest_glossary_terms(transcript_for_llm, terms)
            if sj:
                self._cache_write(sj, {"terms": suggestions, "input_hash": suggest_input_hash})
            stage_end("suggest", "ok", f"{len(suggestions)} кандидатов" if suggestions else "нет кандидатов")

        # ── 4c. metadata: topical title + inferred speaker names (extra LLM calls) ──
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
        # auto-«Я»: seed the mic-dominant speaker's display name, but never clobber an
        # LLM-inferred real name for that same label — setdefault, not assignment.
        # Fires even with DO_SUMMARY off, since this needs no LLM call.
        if auto_label:
            speakers.setdefault(auto_label, self.AUTHOR_NAME)
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
        # note-origin typing: a mic/system track means this came from a live recording,
        # regardless of what the caller passed as `origin` — that param only disambiguates
        # a plain import (batch vs single file), which has no mic/system track at all.
        source = "recording" if (mic_file or system_file) else (origin or "")
        # record title + which template (preset) was used + language in frontmatter.
        # `version` (History "Переобработать" — note versioning by template) is set
        # ONLY when the caller passes one — the very first processing of a recording
        # (record-tab/import run) never does, so that note stays byte-identical to
        # today (implicitly "version 1", same convention the DB/renderer use for a
        # missing key — see _reconcile/main.js's list-history default below).
        frontmatter_fields = {
            "title": title, "template": self.TEMPLATE, "language": self.LANGUAGE,
            "speakers": speakers_str, "source": source}
        if version is not None:
            frontmatter_fields["version"] = version
        note = self.set_frontmatter(note, frontmatter_fields)

        note = self.add_audio_link(note, audio_basename)
        note = self.add_actions_section(note, actions)
        note = self.add_transcript(note, transcript_for_llm)

        # ── 5. save ───────────────────────────────────────────────────────
        stage("save", "Сохранение заметки")
        # language suffix so switching ru→en on the same source keeps both notes
        lang_suffix = "" if self.LANGUAGE == "ru" else f"-{self.LANGUAGE}"
        # `version is not None` ⇒ a deliberate История reprocess (see frontmatter above).
        # This must NEVER reuse the plain meeting-<timestamp>[-lang].md path — not even
        # when the caller's own per-template version number happens to be 1 (a template
        # that's never been used for this recording before, picked fresh from the
        # История template picker): that plain path already belongs to whichever
        # template was used at first-processing time, and a filename carries no
        # template info, so reusing it would silently clobber that other template's
        # note — exactly the bug this feature exists to fix. Instead mint a monotonic
        # revision index (`-r<seq>`) by scanning the vault for this timestamp —
        # globally unique across every template's versions of this recording,
        # independent of the caller-supplied per-template version number (which is
        # display-only, carried in frontmatter's `version` key above). A sanitized/
        # translit template token was considered instead of a bare index, but template
        # names can hold spaces/cyrillic/punctuation — unsafe for a filesystem path —
        # so a plain monotonic counter is the least-fragile choice.
        if version is not None:
            rev_re = _re.compile(rf"^meeting-{_re.escape(timestamp)}(?:-[a-z]+)?-r(\d+)\.md$")
            seq = 0
            for f in self.OBSIDIAN_PATH.glob(f"meeting-{timestamp}*-r*.md"):
                m = rev_re.match(f.name)
                if m:
                    seq = max(seq, int(m.group(1)))
            stamp_suffix = f"{lang_suffix}-r{seq + 1}"
        else:
            stamp_suffix = lang_suffix
        note_path = self.OBSIDIAN_PATH / f"meeting-{timestamp}{stamp_suffix}.md"
        note_path.write_text(note, encoding="utf-8")
        log(f"✅ Заметка сохранена: {note_path}")
        # update the derived SQLite index
        if self.db_path:
            try:
                conn = _db_connect(self.db_path)
                _db_upsert(conn, {
                    "note": str(note_path), "stamp": f"{timestamp}{stamp_suffix}",
                    "title": title, "template": self.TEMPLATE, "language": self.LANGUAGE,
                    "date": datetime.now().strftime("%Y-%m-%d"),
                    "audio": str(vault_audio if keep_audio_in_obsidian else audio_file),
                    "mtime": note_path.stat().st_mtime, "source": source,
                    "version": version if isinstance(version, int) and version > 0 else 1})
                conn.close()
            except Exception as e:
                log(f"⚠️ Индекс не обновлён: {e}")
        stage_end("save", "ok")

        # {term_lower: count}, THIS run only — the renderer merges it into its own
        # cumulative glossaryUsage store (see mergeGlossaryUsage in renderer.js) and
        # feeds that cumulative map back as --glossary-usage-file on the next run.
        glossary_usage = {}
        for hit in glossary_hits:
            key = (hit.get("to") or "").strip().lower()
            if key:
                glossary_usage[key] = glossary_usage.get(key, 0) + 1

        emit("done",
             note=str(note_path),
             audio=str(vault_audio if keep_audio_in_obsidian else audio_file),
             transcript=transcript_for_llm,
             summary=summary,
             title=title,
             speakers=speakers,
             actions=actions,
             suggestions=suggestions,
             glossary_usage=glossary_usage)


def cmd_process(args):
    prompt = Path(args.prompt_file).read_text(encoding="utf-8") if args.prompt_file else ""
    if not prompt.strip():
        prompt = "Сделай краткую структурированную сводку этой встречи в Markdown."
    glossary_usage = {}
    if args.glossary_usage_file:
        try:
            glossary_usage = json.loads(Path(args.glossary_usage_file).read_text(encoding="utf-8"))
        except Exception:
            glossary_usage = {}
    pipe = Pipeline(out_dir=args.out_dir, engine=args.engine, diarize=args.diarize,
                    cache_dir=args.cache_dir, language=args.language, do_summary=args.summarize,
                    template=args.template, db_path=args.db, glossary=args.glossary,
                    author_name=args.author_name, fast_model=args.fast_model,
                    glossary_usage=glossary_usage, main_model=args.main_model)
    try:
        pipe.process(args.infile, prompt, keep_audio_in_obsidian=args.keep_audio,
                     mic_file=args.mic, system_file=args.system, origin=args.origin,
                     version=args.version)
    except Exception as e:
        import traceback
        emit("error", msg=f"{e}")
        sys.stderr.write(traceback.format_exc())


# Confidence threshold for the PCM cross-correlation auto-alignment below (§ estimate_start_offset_ms).
# HYPO default, not empirically calibrated against real recordings — see TODO.md history.
_XCORR_MIN_CONFIDENCE = 0.15


def _read_mono_decimated(path, max_seconds, target_rate):
    """Read up to `max_seconds` of audio from a WAV file, downmix to mono (average
    channels) if needed, and resample to `target_rate` Hz. Never assumes the file's
    channel count or sample rate — both are read from the WAV header (mic is 1 or 2ch,
    device-dependent rate; system.wav is fixed mono/16000, but this stays generic).
    Returns a 1-D numpy float64 array."""
    import numpy as np
    from fractions import Fraction
    from scipy.signal import resample_poly

    with wave.open(str(path), "rb") as w:
        rate = w.getframerate()
        channels = w.getnchannels()
        sampwidth = w.getsampwidth()
        n_frames = min(w.getnframes(), int(max_seconds * rate))
        raw = w.readframes(n_frames)

    # PCM-8 is unsigned (0..255) per the WAV spec, unlike PCM-16/32 which are
    # signed — read it as uint8 and center on 128 so it lands on the same
    # zero-centered convention int16/int32 already have (downstream math here
    # — cross-correlation, RMS — assumes zero-centered samples).
    dtype = {1: np.uint8, 2: np.int16, 4: np.int32}.get(sampwidth)
    if dtype is None:
        raise ValueError(f"unsupported sample width: {sampwidth}")
    samples = np.frombuffer(raw, dtype=dtype).astype(np.float64)
    if dtype is np.uint8:
        samples -= 128.0
    if channels > 1:
        samples = samples.reshape(-1, channels).mean(axis=1)

    if samples.size > 0 and rate != target_rate:
        frac = Fraction(target_rate, rate).limit_denominator(1000)
        samples = resample_poly(samples, frac.numerator, frac.denominator)

    return samples


def _collect_chunks_np(chunks, samples):
    """Concatenate the given {start,end} sample-index slices from `samples` in order.
    Equivalent to silero-vad's own `collect_chunks`, but operating on a plain numpy
    array — this module reads mic/system tracks via `_read_mono_decimated` (numpy),
    not torch tensors, so reusing silero's tensor-only helper here would mean loading
    the whole VAD model via torch.hub just to concatenate slices. Pure, no I/O."""
    import numpy as np
    if not chunks:
        return np.array([], dtype=np.float64)
    return np.concatenate([samples[c["start"]:c["end"]] for c in chunks])


def estimate_start_offset_ms(mic_path, system_path, max_offset_ms=3000, corr_window_s=15,
                              target_rate=4000, min_confidence=_XCORR_MIN_CONFIDENCE):
    """Estimate the (mic_delay_ms, sys_delay_ms) pair that aligns two independently-
    started recordings via PCM cross-correlation on speaker→mic leakage, plus a
    confidence score. Fails safe: numpy/scipy missing, unreadable WAVs, too-short
    audio, or low confidence all fall back to (0, 0, confidence) — i.e. today's
    zero-delay behavior — and each path logs which one was taken."""
    try:
        import numpy  # noqa: F401  (availability probe; actual use is in the helpers above)
        import scipy.signal  # noqa: F401
    except ImportError as e:
        log(f"Автовыравнивание (xcorr): numpy/scipy недоступны ({e}) — без сдвига")
        return 0, 0, 0.0

    read_seconds = corr_window_s + max_offset_ms / 1000.0
    try:
        mic = _read_mono_decimated(mic_path, read_seconds, target_rate)
        system = _read_mono_decimated(system_path, read_seconds, target_rate)
    except Exception as e:
        log(f"Автовыравнивание (xcorr): ошибка чтения WAV ({e}) — без сдвига")
        return 0, 0, 0.0

    min_samples = int(1.0 * target_rate)  # minimum-length guard: <1s post-decimation is degenerate
    if len(mic) < min_samples or len(system) < min_samples:
        log("Автовыравнивание (xcorr): дорожка короче 1с после децимации — без сдвига")
        return 0, 0, 0.0

    max_lag = int(max_offset_ms * target_rate / 1000)
    lag, confidence = _normalized_xcorr_peak(mic, system, max_lag)

    if confidence < min_confidence:
        log(f"Автовыравнивание (xcorr): низкая уверенность ({confidence:.2f}) — без сдвига")
        return 0, 0, confidence

    mic_delay_ms = round(max(0, -lag) * 1000 / target_rate)
    sys_delay_ms = round(max(0, lag) * 1000 / target_rate)
    log(f"Автовыравнивание (xcorr): delays=[{mic_delay_ms}, {sys_delay_ms}]мс, confidence={confidence:.2f}")
    return mic_delay_ms, sys_delay_ms, confidence


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
    if len(inputs) == 2 and mic_delay == 0 and sys_delay == 0:
        # auto-detect only when caller didn't explicitly request a delay (tests/manual override)
        md, sd, _ = estimate_start_offset_ms(inputs[0], inputs[1])
        delays = [md, sd]
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
_DB_COLS = ["note", "stamp", "title", "template", "language", "date", "audio", "mtime", "source", "version"]
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
        language TEXT, date TEXT, audio TEXT, mtime REAL, source TEXT, version INTEGER)""")
    # index.db predates the `source` column (note-origin typing) — ALTER TABLE an
    # existing on-disk DB rather than force a rebuild. index.db is rebuildable
    # (derived from frontmatter, see cmd_history/_reconcile), so deleting it also
    # works as a manual fallback if this guarded migration is ever skipped.
    try:
        conn.execute("ALTER TABLE meetings ADD COLUMN source TEXT")
        conn.commit()
    except Exception:
        pass  # column already exists
    # index.db predates the `version` column (note versioning by template on
    # reprocess) — same guarded-migration rationale as `source` above.
    try:
        conn.execute("ALTER TABLE meetings ADD COLUMN version INTEGER")
        conn.commit()
    except Exception:
        pass  # column already exists
    return conn


def _db_upsert(conn, row):
    conn.execute("""INSERT INTO meetings(note,stamp,title,template,language,date,audio,mtime,source,version)
        VALUES(:note,:stamp,:title,:template,:language,:date,:audio,:mtime,:source,:version)
        ON CONFLICT(note) DO UPDATE SET stamp=:stamp,title=:title,template=:template,
        language=:language,date=:date,audio=:audio,mtime=:mtime,source=:source,version=:version""", row)
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
    stem = note_name[:-3]  # strip .md
    # A versioned reprocess note still shares its audio with the original recording —
    # _base_stamp strips the `-r<seq>`/language suffixes to recover the base
    # "meeting-<timestamp>" stem the audio was actually saved under.
    astem = _base_stamp(stem)
    for f in files:
        if f != note_name and f.startswith(astem + ".") and Path(f).suffix.lower() in _AUDIO_EXT:
            return f
    return None


def _wav_duration_s(path):
    """Best-effort WAV duration in seconds via the stdlib `wave` module header only — no
    ffprobe dependency, no full-file read (wave.open reads just the RIFF/fmt/data header).
    None on any parse failure (corrupt/truncated file, or non-WAV content despite the
    extension)."""
    try:
        with wave.open(path, "rb") as w:
            rate = w.getframerate()
            if not rate:
                return None
            return w.getnframes() / rate
    except Exception:
        return None


def _scan_audio_inventory(out_dir):
    """Single os.scandir pass over out_dir (the same dir notes/audio land in) building an
    inventory of every audio file physically present, regardless of whether any surviving
    note still references it — an audio file whose last note was deleted (orphan) is
    otherwise completely invisible to _reconcile, which only ever globs `.md` files (see
    histmap4x analyzer report, Q5/constraint (a)). Each entry's base_stamp uses the same
    _base_stamp() helper _find_audio/_reconcile use, so a renderer can pair an orphan (or
    any) audio entry with its note row(s) by equality on base_stamp."""
    out = Path(out_dir)
    if not out.exists():
        return []
    audios = []
    try:
        entries = list(os.scandir(out))
    except OSError:
        return []
    for entry in entries:
        name = entry.name
        if name.startswith("."):  # .obsidian/.trash-style dotfiles/dotdirs — never audio
            continue
        try:
            if not entry.is_file():
                continue
        except OSError:
            continue  # vanished mid-scan
        suffix = Path(name).suffix.lower()
        if suffix not in _AUDIO_EXT:
            continue
        stem = name[:-len(suffix)]
        if stem.startswith("meeting-"):
            stem = stem[len("meeting-"):]
        try:
            st = entry.stat()
        except OSError:
            continue  # vanished mid-scan
        path = str(out / name)
        audios.append({
            "base_stamp": _base_stamp(stem),
            "path": path,
            "size": st.st_size,
            "mtime": st.st_mtime,
            "duration_s": _wav_duration_s(path) if suffix == ".wav" else None,
        })
    return audios


def _iter_vault_notes(vault_root, skip_dir=None):
    """os.walk vault_root for meeting-*.md files (PARA-filed notes live anywhere under
    the vault, not just out_dir). Skips hidden dirs (.obsidian, .trash, ...) and, if
    skip_dir is given, prunes that subtree entirely — it's already covered by the plain
    out_dir scan in _reconcile, so walking into it again would just be wasted work over
    a potentially large vault. Yields absolute path strings."""
    import os
    root = Path(vault_root)
    if not root.exists():
        return
    skip_resolved = None
    if skip_dir is not None:
        try:
            skip_resolved = str(Path(skip_dir).resolve())
        except Exception:
            skip_resolved = str(Path(skip_dir))
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        if skip_resolved is not None:
            try:
                cur_resolved = str(Path(dirpath).resolve())
            except Exception:
                cur_resolved = dirpath
            if cur_resolved == skip_resolved:
                dirnames[:] = []  # don't descend — out_dir's own scan already covers it
                continue
        for f in filenames:
            if f.startswith("meeting-") and f.endswith(".md"):
                yield str(Path(dirpath) / f)


def _reconcile(conn, out_dir, vault_root=None):
    out = Path(out_dir)
    files = [p.name for p in out.iterdir()] if out.exists() else []
    md = [f for f in files if f.startswith("meeting-") and f.endswith(".md")]
    # stamp (parsed from filename) is the identity used to merge the out_dir scan with
    # the (optional) recursive vault scan below — a note keeps ONE row across a PARA move
    # (old path deleted, new path upserted) instead of the move producing a duplicate.
    # out_dir entries take priority: they're the canonical "not yet filed" location, and
    # skip_dir pruning above already keeps the vault scan from re-finding them anyway.
    chosen = {}
    for f in md:
        chosen[f[len("meeting-"):-3]] = str(out / f)
    if vault_root:
        for note_path in _iter_vault_notes(vault_root, skip_dir=out_dir):
            stamp = Path(note_path).name[len("meeting-"):-3]
            chosen.setdefault(stamp, note_path)
    md_paths = set(chosen.values())
    for (note,) in conn.execute("SELECT note FROM meetings").fetchall():
        if note not in md_paths:  # note deleted (or moved away and re-found above) → drop stale row
            conn.execute("DELETE FROM meetings WHERE note=?", (note,))
    for stamp, note_path in chosen.items():
        p = Path(note_path)
        try:
            mtime = p.stat().st_mtime
        except Exception:
            continue  # vanished between scan and stat
        cur = conn.execute("SELECT mtime FROM meetings WHERE note=?", (note_path,)).fetchone()
        if cur and abs(cur[0] - mtime) < 0.001:
            continue  # unchanged
        fm = _parse_frontmatter(p.read_text(encoding="utf-8", errors="ignore")[:2048])
        # _find_audio only makes sense for out_dir-adjacent files (files list is out_dir-
        # scoped); a note already filed elsewhere in the vault keeps whatever audio link
        # it had (frontmatter carries no audio path), matching current out_dir-only lookup.
        audio = _find_audio(p.name, files) if p.parent == out else None
        # A missing/garbled `version` key (absent on every pre-this-feature note, and on
        # the very first processing of any new one) defaults to 1 — same convention
        # main.js's list-history mapping uses for the same missing-key case.
        try:
            file_version = int(fm.get("version") or 1)
        except (TypeError, ValueError):
            file_version = 1
        _db_upsert(conn, {
            "note": note_path, "stamp": stamp, "title": fm.get("title", ""),
            "template": fm.get("template", ""), "language": fm.get("language", ""),
            "date": fm.get("date", ""), "audio": str(out / audio) if audio else None,
            "mtime": mtime, "source": fm.get("source", ""), "version": file_version})
    conn.commit()


def _db_list(conn, limit=None):
    # stamp = recording time (filename timestamp), not mtime — mtime is bumped by
    # post-hoc edits (e.g. rename-speakers rewrites the note file), which would
    # otherwise reshuffle the rail out of recording order. No LIMIT: owner wants
    # every note in the vault, not just the most recent 200.
    query = f"SELECT {','.join(_DB_COLS)} FROM meetings ORDER BY stamp DESC"
    if limit:
        rows = conn.execute(query + " LIMIT ?", (limit,)).fetchall()
    else:
        rows = conn.execute(query).fetchall()
    return [dict(zip(_DB_COLS, r)) for r in rows]


def cmd_history(out_dir, db_path, vault_root=None):
    # L9 arch-audit: the pending-recordings merge (kind:"pending" synthetic rows,
    # --pending-file/_load_pending_manifest/_parse_any_stamp) was retired as dead
    # code — main.js's renderer already filtered every kind:"pending" row out
    # everywhere it consumed list-history's result (buildRecordings/nextVersionFor),
    # never rendering them; still-pending recordings are tracked and merged into
    # the rail entirely client-side via state.pendingRecordings instead.
    conn = _db_connect(db_path)
    _reconcile(conn, out_dir, vault_root)
    items = _db_list(conn)
    conn.close()
    for it in items:
        it["base_stamp"] = _base_stamp(it["stamp"])
    audios = _scan_audio_inventory(out_dir)
    emit("history", items=items, audios=audios)


def cmd_classify(note_path, existing_json="", main_model="", language=""):
    """Classify a meeting note into a PARA category + project name via the LLM.
    existing_json: optional JSON {category: [project names]} of accumulators that already
    exist — the model is told to REUSE a matching one instead of inventing a sibling,
    which is what fights the 'one topic scattered across 5 files' fragmentation.

    For category=="projects" also asks the LLM for a `kind` sub-classification
    (ux-para-batch T4-T6, folder-hierarchy filing): one_to_one (+ person) for a
    recurring 1:1 with a named person, mission_daily (+ mission) for a recurring
    "миссия" daily-sync, else other. language mirrors generate_title's own ru/en pin
    (backend.py's Pipeline.generate_title) — otherwise the model tends to answer in
    whatever language its own instructions are written in (Russian) regardless of the
    meeting's actual language."""
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
        system_msg = "Ты раскладываешь заметки по методу PARA. Отвечай только JSON."
        if language == "ru":
            system_msg += " Отвечай на русском языке (project/person/mission — тоже по-русски)."
        elif language == "en":
            system_msg += " Answer in English."
        payload = {
            "messages": [
                {"role": "system", "content": system_msg},
                {"role": "user", "content":
                    "Классифицируй заметку встречи по PARA:\n"
                    "- projects: активная задача с целью/дедлайном. Если это регулярная личная "
                    "встреча один-на-один с конкретным человеком — kind=\"one_to_one\" и укажи "
                    "person (имя этого человека). Если это часть повторяющейся инициативы "
                    "(«миссии») с ежедневными синками — kind=\"mission_daily\" и укажи mission "
                    "(короткое название миссии). Иначе kind=\"other\".\n"
                    "- areas: постоянная зона ответственности\n"
                    "- resources: тема/референс на будущее\n"
                    "- archives: неактуальное/завершённое\n"
                    + existing_block +
                    'Ответь JSON: {"category":"projects|areas|resources|archives","project":"короткое имя 2-4 слова",'
                    '"kind":"one_to_one|mission_daily|other","person":"имя (только если kind=one_to_one)",'
                    '"mission":"название миссии (только если kind=mission_daily)"}.\n\n'
                    f"ЗАМЕТКА:\n{text}"},
            ],
            "temperature": 0.2, "max_tokens": 2500,
        }
        if main_model:
            payload["model"] = main_model
        resp = requests.post("http://localhost:1234/v1/chat/completions", json=payload, timeout=120)
        if resp.status_code == 200:
            msg = (resp.json().get("choices") or [{}])[0].get("message", {})
            c = (msg.get("content") or "") or (msg.get("reasoning_content") or "")
            # The model may echo the prompt's TEMPLATE json ({"category":"projects|areas|
            # resources|archives","project":"короткое имя 2-4 слова", ...}) inside its
            # reasoning. Scan ALL json objects, take the LAST whose category is a real
            # single value — the template's pipe-category fails that test, so it is
            # skipped automatically.
            VALID = ("projects", "areas", "resources", "archives")
            VALID_KIND = ("one_to_one", "mission_daily", "other")
            PLACEHOLDER = "короткое имя 2-4 слова"
            cat, project, kind, person, mission = "", "", "", "", ""
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
                kk = str(data.get("kind", "")).lower().strip()
                kind = kk if kk in VALID_KIND else "other"
                person = str(data.get("person", "")).strip()
                mission = str(data.get("mission", "")).strip()
                break
            if cat:
                # Hard code gate (mirrors the category gate above / the PR #13 pattern:
                # inventions dropped, unknown → other) — kind/person/mission only ever
                # mean something for category=="projects", and a claimed one_to_one/
                # mission_daily without its required name is downgraded to "other"
                # rather than trusted as-is.
                if cat != "projects":
                    kind, person, mission = "", "", ""
                else:
                    if kind == "one_to_one" and not person:
                        kind = "other"
                    if kind == "mission_daily" and not mission:
                        kind = "other"
                if kind != "one_to_one":
                    person = ""
                if kind != "mission_daily":
                    mission = ""
                emit("classified", note=note_path, category=cat, project=project[:60],
                     kind=kind, person=person[:60], mission=mission[:60])
                return
        emit("error", msg="LLM не вернул классификацию (LM Studio запущен?)")
    except Exception as e:
        emit("error", msg=f"Классификация не удалась: {e}")


# Fixed glossary-category buckets ("папочки") for the Словарь tab's «Мои» section —
# a small FIXED set (not free-form tags), matching the Otter-style precedent behind
# this feature. Provisional taxonomy: derived from the owner's own examples (имена →
# Люди, технические → Термины/Продукты и инструменты); "кулинария" wasn't promoted to
# its own bucket — Другое catches whatever doesn't fit. Kept in sync BY HAND with the
# identical JS list in renderer.js (GLOSSARY_CATEGORIES) — the two never share a
# runtime, so there is no single source of truth to import from here.
GLOSSARY_TERM_CATEGORIES = ("Люди", "Продукты и инструменты", "Термины", "Другое")
GLOSSARY_TERM_CATEGORY_OTHER = "Другое"


def cmd_classify_terms(terms_file, fast_model=""):
    """LLM pass that sorts a batch of "Мои" glossary terms into the fixed category
    buckets (see GLOSSARY_TERM_CATEGORIES) for the Словарь tab's «Разложить по
    категориям» button. terms_file: path to a JSON list of terms (as typed into the
    glossary, not lowercased). Emits `classified-terms` with `categories`, a
    {term_lower: category} map — same shape/casing as the renderer's persisted
    state.glossaryCategories, so the caller can merge it straight in.

    Strict code-gate on the LLM's answer (mirrors suggest_glossary_terms's own
    invention-guard):
      - a returned key that isn't (case-insensitively) one of the INPUT terms is
        dropped outright — the model doesn't get to invent/rename terms;
      - a category outside the fixed set is coerced to «Другое» rather than kept
        verbatim or dropped, so a wobbly LLM answer never crashes the batch.

    Degrades to an honest `error` event (never raises) on: unreadable/malformed
    terms_file, LM Studio unreachable, non-200, empty reply, or a reply with no
    parseable JSON object — mirrors suggest_glossary_terms's "LM down → log and
    return safely" pattern, adapted to this command's own event protocol."""
    import re
    import requests
    try:
        raw = Path(terms_file).read_text(encoding="utf-8")
        terms = json.loads(raw)
        if not isinstance(terms, list):
            raise ValueError("terms file must contain a JSON list")
    except Exception as e:
        emit("error", msg=f"Не прочитал файл терминов: {e}")
        return

    terms = [str(t).strip() for t in terms if str(t).strip()]
    if not terms:
        emit("classified-terms", categories={})
        return
    valid_lower = {t.lower() for t in terms}

    try:
        payload = {
            "messages": [
                {"role": "system", "content":
                    "Ты раскладываешь термины словаря по категориям для распознавания речи. "
                    "Категории: Люди (имена людей), Продукты и инструменты (названия "
                    "продуктов/инструментов/компаний), Термины (доменные/технические термины), "
                    "Другое (всё остальное). Классифицируй ТОЛЬКО термины из списка — не "
                    "выдумывай новые и не переименовывай их. Ответь строго JSON-объектом "
                    '{"термин": "категория"}, без пояснений и без markdown.'},
                {"role": "user", "content": "ТЕРМИНЫ:\n" + ", ".join(terms)},
            ],
            "temperature": 0.1, "max_tokens": 2500,
        }
        if fast_model:
            payload["model"] = fast_model
        resp = requests.post("http://localhost:1234/v1/chat/completions", json=payload, timeout=120)
        if resp.status_code != 200:
            emit("error", msg=f"LM Studio HTTP {resp.status_code} — разбор по категориям недоступен")
            return
        msg = (resp.json().get("choices") or [{}])[0].get("message", {})
        content = (msg.get("content") or "") or (msg.get("reasoning_content") or "")
        if not content.strip():
            emit("error", msg="LLM не вернул ответ — разбор по категориям недоступен")
            return
    except Exception as e:
        emit("error", msg=f"LLM недоступен — разбор по категориям недоступен: {e}")
        return

    m = re.search(r"\{.*\}", content, re.S)
    if not m:
        emit("error", msg="LLM вернул не-JSON ответ — разбор по категориям недоступен")
        return
    try:
        parsed = json.loads(m.group(0))
    except Exception:
        emit("error", msg="LLM вернул некорректный JSON — разбор по категориям недоступен")
        return
    if not isinstance(parsed, dict):
        emit("error", msg="LLM вернул не объект — разбор по категориям недоступен")
        return

    result = {}
    for term, cat in parsed.items():
        low = str(term).strip().lower()
        if low not in valid_lower:
            continue  # hard gate: LLM invented/renamed a term not in the input batch
        cat = str(cat).strip()
        result[low] = cat if cat in GLOSSARY_TERM_CATEGORIES else GLOSSARY_TERM_CATEGORY_OTHER
    emit("classified-terms", categories=result)


def cmd_extract(note_path):
    """Distil a meeting note into structured knowledge sections (темы / факты /
    обсуждения / инсайты / договорённости / прочее). Historically this fed a living
    per-project accumulator file (e.g. «1-1 с Имя.md») that main.js's para-file handler
    appended it into; since the ux-para-batch folder-hierarchy filing change, para-file
    moves the RAW note itself instead and no longer writes this extract anywhere — the
    renderer still calls this first (para-extract IPC) and gates filing on it succeeding,
    so it's kept as-is here (unaffected either way: the LLM is never told about an
    accumulator, see the prompt below). Returns ready Markdown, no date heading. Reasoning
    models burn the token budget on 'thinking' so content can come back empty → salvage
    from reasoning_content."""
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
    except Exception as e:
        log(f"⚠️ FTS5 optimize не удался: {e}")

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


def cmd_search(root, db_path, query=None, embed_model=None, messages=None, main_model=""):
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
        answer_payload = {
            "messages": llm_messages,
            "temperature": 0.2,
            "max_tokens": 4096,
        }
        if main_model:
            answer_payload["model"] = main_model
        resp = requests.post(
            f"{_RAG_BASE_URL}/v1/chat/completions",
            json=answer_payload,
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
    emit("preflight",
         ffmpeg=shutil.which("ffmpeg") is not None,
         whisper_cached=_WHISPER_MODEL_DIR.exists(),
         hf_token=bool(os.environ.get("HF_TOKEN")))


# ──────────────────────────────────────────────────────────────────────────
# Model inventory — settings "Модели" section (cache-inspection + on-demand
# pre-download for the offline pipeline's ML models). LLM/embedding model are
# LM Studio's concern and already surfaced separately by cmd_preflight above.
# ──────────────────────────────────────────────────────────────────────────
_WHISPER_REPO_ID = "mlx-community/whisper-large-v3-turbo"
_WHISPER_MODEL_DIR = Path.home() / ".cache/huggingface/hub/models--mlx-community--whisper-large-v3-turbo"
_VAD_JIT_PATH = Path.home() / ".cache/torch/hub/snakers4_silero-vad_master/src/silero_vad/data/silero_vad.jit"
_VAD_REPO_DIR = Path.home() / ".cache/torch/hub/snakers4_silero-vad_master"
# All three must be present for diarization to actually work — pyannote's own
# config.yaml (read directly on this machine) declares the segmentation +
# wespeaker sub-models the top pipeline repo pulls in.
_PYANNOTE_REPO_IDS = [
    "pyannote/speaker-diarization-3.1",
    "pyannote/segmentation-3.0",
    "pyannote/wespeaker-voxceleb-resnet34-LM",
]


def _hf_cache_dir(repo_id):
    return Path.home() / ".cache/huggingface/hub" / ("models--" + repo_id.replace("/", "--"))


# needs_token is a structural property of the model (pyannote's repos require
# accepting gated-repo terms no matter what) — NOT whether a token happens to
# be configured right now. Whether the row should show 🔒 (locked) is computed
# per-call in cmd_models_status from the live HF_TOKEN env var, same source
# cmd_preflight already reads.
MODEL_SPECS = [
    {"id": "whisper", "label": "MLX Whisper (large-v3-turbo)", "size_mb": 1500, "needs_token": False},
    {"id": "vad", "label": "Silero VAD", "size_mb": 35, "needs_token": False},
    {"id": "diarization", "label": "Диаризация (pyannote)", "size_mb": 31, "needs_token": True},
]


def _model_cached(model_id):
    """Precise per-model cache check — a dir-only check would report "cached"
    on a partial/interrupted download, so each model checks the specific file
    (VAD) or full set of sub-repo dirs (diarization) it actually needs."""
    if model_id == "whisper":
        return _WHISPER_MODEL_DIR.exists()
    if model_id == "vad":
        return _VAD_JIT_PATH.exists()
    if model_id == "diarization":
        return all(_hf_cache_dir(r).exists() for r in _PYANNOTE_REPO_IDS)
    return False


def cmd_models_status():
    """Cache-inspection ONLY — no network, mirrors cmd_preflight's contract.
    Emits one `models` event with a list of per-model status dicts."""
    has_token = bool(os.environ.get("HF_TOKEN"))
    items = []
    for spec in MODEL_SPECS:
        cached = _model_cached(spec["id"])
        locked = spec["needs_token"] and not cached and not has_token
        items.append({**spec, "cached": cached, "locked": locked})
    emit("models", items=items)


# ── byte-level download progress ────────────────────────────────────────────
# huggingface_hub 1.10.2's snapshot_download exposes exactly one progress hook:
# tqdm_class. Its own docstring: "Passed argument must inherit from tqdm.auto.
# tqdm or at least mimic its behavior" — and it's genuinely used in TWO roles
# internally (see huggingface_hub._snapshot_download):
#   1. The outer "Fetching N files" bar, driven via tqdm.contrib.concurrent.
#      thread_map — needs the FULL tqdm interface (set_lock/get_lock
#      classmethods, iterator-wrapping constructor). A minimal duck-typed stub
#      crashes here (AttributeError: no set_lock) — confirmed against a real
#      snapshot_download() call, not just by reading the source.
#   2. ONE aggregate "bytes downloaded" bar that snapshot_download creates
#      itself and forwards every per-file update()/`.total +=` into via its
#      internal _AggregatedTqdm relay — the ONLY instance created with
#      unit="B" (role 1 counts files, not bytes); this is the one we want
#      progress events from.
# torch.hub (VAD) has no equivalent hook at all — stays coarse stage/stage_end,
# matching its small ~35MB size.
try:
    # tqdm is an unconditional dependency of huggingface_hub (tqdm>=4.42.1 in its
    # own requirements), so it's guaranteed present whenever huggingface_hub is —
    # but backend.py itself must stay importable even on the bare "python3"
    # fallback used before the backend/ML stack is installed (see main.js), where
    # NEITHER package exists yet. Every other huggingface_hub/torch import in this
    # file is already deferred into the function that needs it for the same
    # reason; this one can't be (it's a base class), so it's guarded instead.
    from tqdm.auto import tqdm as _TqdmBase
except ImportError:
    _TqdmBase = object  # _ProgressTqdm is only ever instantiated from _download_model's
    # whisper/diarization branches, which already require huggingface_hub (and
    # therefore tqdm) to be importable to get that far — this fallback just keeps
    # unrelated commands (preflight/devices/models/etc.) from crashing at import time.

_PROGRESS_EMIT_STEP_BYTES = 2 * 1024 * 1024  # throttle: at most ~1 event / 2MB


class _ProgressTqdm(_TqdmBase):
    """See module note above. disable is forced True — no terminal/stderr bar
    (backend.py's stdout is a strict one-json-per-line protocol; a live
    \\r-updating bar spammed to a piped, non-tty stderr is just noise). A
    disabled tqdm's own update()/__iter__ skip counting entirely (tqdm.std
    short-circuits on `self.disable`), so the bytes-bar role counts here
    explicitly, under a lock — _AggregatedTqdm.update() can be called from any
    of snapshot_download's parallel file-download worker threads
    (max_workers=8)."""

    model_id = None  # set by _download_model right before each snapshot_download call
    # NOT named `_lock` — that's a real tqdm classvar (see tqdm.std.tqdm.set_lock/
    # get_lock), and thread_map's ensure_lock() reassigns tqdm_class._lock around
    # the outer "Fetching N files" bar. A same-named attribute here would collide
    # with that mechanism instead of being an independent mutex.
    _emit_lock = threading.Lock()

    def __init__(self, *args, **kwargs):
        is_bytes_bar = kwargs.get("unit") == "B"
        kwargs["disable"] = True
        super().__init__(*args, **kwargs)
        self._is_bytes_bar = is_bytes_bar
        self._last_emit = 0

    def update(self, n=1):
        if n:
            with _ProgressTqdm._emit_lock:
                self.n += n
                downloaded, total = self.n, self.total or 0
            if self._is_bytes_bar and (downloaded - self._last_emit >= _PROGRESS_EMIT_STEP_BYTES
                                        or (total and downloaded >= total)):
                self._last_emit = downloaded
                try:
                    emit("model-progress", id=_ProgressTqdm.model_id, downloaded=downloaded, total=total)
                except Exception:
                    pass  # progress reporting is best-effort — must never abort the actual download
        super().update(n)  # no-op while disabled (tqdm.std short-circuits) — kept for forward-compat


# ── partial-download cleanup (cancel/failure) ───────────────────────────────
def _cache_dirs_for(model_id):
    """Cache dir(s) whose mere existence _model_cached treats as "done" for
    this model. A canceled or failed download must remove ALL of these —
    otherwise a partial dir survives and the next status check (or the setup
    wall) reads the model as already cached."""
    if model_id == "whisper":
        return [_WHISPER_MODEL_DIR]
    if model_id == "diarization":
        return [_hf_cache_dir(r) for r in _PYANNOTE_REPO_IDS]
    return []


def _cleanup_partial_download(model_id):
    import shutil
    for d in _cache_dirs_for(model_id):
        shutil.rmtree(d, ignore_errors=True)


_DOWNLOADING_MODEL_ID = None  # model currently mid-download, for the SIGTERM handler below


def _handle_download_sigterm(signum, frame):
    """main.js's cancel-model-download IPC kills this process with SIGTERM
    (main.js's cancel-model-download handler). Without a handler the process
    just dies mid-transfer, leaving the partial cache dir in place — which
    _model_cached would then misreport as fully cached on the next check."""
    if _DOWNLOADING_MODEL_ID:
        _cleanup_partial_download(_DOWNLOADING_MODEL_ID)
    sys.exit(143)  # 128 + SIGTERM, conventional exit code for a signal-terminated process


def _download_model(model_id):
    """Download one model's weights. Raises on failure (caller catches)."""
    if model_id == "whisper":
        from huggingface_hub import snapshot_download
        _ProgressTqdm.model_id = model_id
        snapshot_download(repo_id=_WHISPER_REPO_ID, tqdm_class=_ProgressTqdm)
    elif model_id == "vad":
        import torch
        # Corrupt-dir edge case: a crash/SIGTERM mid-download can leave the repo
        # dir present but the .jit file missing/truncated. torch.hub.load keys
        # its cache-hit decision on dir existence, not content-completeness, so
        # a corrupt partial dir would be silently treated as "already there."
        # Dir-exists-but-file-missing ⇒ treat as corrupt, wipe and re-fetch.
        if _VAD_REPO_DIR.exists() and not _VAD_JIT_PATH.exists():
            import shutil
            shutil.rmtree(_VAD_REPO_DIR, ignore_errors=True)
        torch.hub.load(repo_or_dir="snakers4/silero-vad", model="silero_vad", force_reload=False)
    elif model_id == "diarization":
        from huggingface_hub import snapshot_download
        hf_token = os.environ.get("HF_TOKEN")
        if not hf_token:
            raise RuntimeError("нужен HF-токен (переменная HF_TOKEN) — диаризация не скачана")
        # Each repo is its own snapshot_download() call → its own fresh bytes-bar
        # (0-100% per sub-repo, not one combined bar across all three); acceptable
        # given diarization's total size here is tiny (~31MB across all 3).
        _ProgressTqdm.model_id = model_id
        for repo_id in _PYANNOTE_REPO_IDS:
            snapshot_download(repo_id=repo_id, token=hf_token, tqdm_class=_ProgressTqdm)
    else:
        raise ValueError(f"неизвестная модель: {model_id}")


def cmd_download_models(only=None):
    """Download whatever's missing from MODEL_SPECS (or just `only`, a
    comma-separated id list). One failing model must not abort the batch —
    same pattern as diarize()/remove_silence_vad() not aborting the audio
    pipeline (backend.py:614-643,838-871)."""
    from huggingface_hub.errors import GatedRepoError

    global _DOWNLOADING_MODEL_ID
    signal.signal(signal.SIGTERM, _handle_download_sigterm)

    wanted = set(only.split(",")) if only else None
    for spec in MODEL_SPECS:
        model_id = spec["id"]
        if wanted is not None and model_id not in wanted:
            continue
        stage_name = f"model:{model_id}"
        stage(stage_name, f"Скачиваю {spec['label']} (~{spec['size_mb']} МБ)…")
        _DOWNLOADING_MODEL_ID = model_id
        try:
            if _model_cached(model_id):
                stage_end(stage_name, "skip", "уже скачано")
                continue
            _download_model(model_id)
            stage_end(stage_name, "ok", "Скачано")
        except GatedRepoError as e:
            _cleanup_partial_download(model_id)
            stage_end(stage_name, "fail",
                      f"Токен есть, но доступ к репозиторию не выдан — прими условия на huggingface.co ({e})")
        except Exception as e:
            _cleanup_partial_download(model_id)
            stage_end(stage_name, "fail", str(e))
            # continue to the next model — one failure must not abort the batch
        finally:
            _DOWNLOADING_MODEL_ID = None


def main():
    default_obsidian = str(Path.home() / "Documents/Obsidian/Meetings")

    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("devices")
    sub.add_parser("preflight")
    sub.add_parser("models")

    p_dlm = sub.add_parser("download-models")
    p_dlm.add_argument("--only", default=None)  # comma-separated model ids; omit = all missing

    p_cls = sub.add_parser("classify")
    p_cls.add_argument("--note", required=True)
    p_cls.add_argument("--existing", default="")  # JSON {category: [names]} for reuse
    # Main model override for this substantive task — see Pipeline.MAIN_MODEL.
    p_cls.add_argument("--main-model", dest="main_model", default="")
    # Language pin for project/person/mission text (T7, ux-para-batch) — mirrors
    # generate_title's own ru/en pin (Pipeline.generate_title).
    p_cls.add_argument("--language", default="")

    p_ext = sub.add_parser("extract")
    p_ext.add_argument("--note", required=True)

    p_clst = sub.add_parser("classify-terms")
    p_clst.add_argument("--terms-file", dest="terms_file", required=True)
    p_clst.add_argument("--fast-model", dest="fast_model", default="")

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
    # JSON {term_lower: count} file — cumulative usage from previous runs (renderer-
    # persisted); orders _build_initial_prompt's terms before budget truncation. Same
    # file-based plumbing as --prompt-file (avoids CLI arg length/escaping concerns).
    p_proc.add_argument("--glossary-usage-file", dest="glossary_usage_file", default=None)
    p_proc.add_argument("--summarize", type=str2bool, default=True)
    p_proc.add_argument("--template", default="")
    p_proc.add_argument("--db", default=None)
    p_proc.add_argument("--mic", default=None)  # mic.wav, for auto-«Я» author-speaker detection
    p_proc.add_argument("--system", default=None)  # system.wav, ditto
    p_proc.add_argument("--author-name", dest="author_name", default="Автор")
    p_proc.add_argument("--origin", choices=["batch", "file"], default=None)  # ignored when --mic/--system given (recording wins)
    # Note versioning by template on reprocess (История "Переобработать" only) — the
    # renderer computes the next per-template version number and sends it ONLY for a
    # deliberate История reprocess; a plain record/import run never sends this, so the
    # default (None) preserves today's behaviour exactly (see Pipeline.process).
    p_proc.add_argument("--version", type=int, default=None)
    # Fast model for mechanical LLM calls only (correct/title/suggest) — see Pipeline.FAST_MODEL.
    p_proc.add_argument("--fast-model", dest="fast_model", default="")
    # Main model for substantive LLM calls (summary/speaker-inference/actions) — see
    # Pipeline.MAIN_MODEL. Empty → omit "model" entirely, today's behaviour (including the
    # reasoning-model summary with thinking) preserved byte-identical.
    p_proc.add_argument("--main-model", dest="main_model", default="")

    p_hist = sub.add_parser("history")
    p_hist.add_argument("--out-dir", dest="out_dir", default=default_obsidian)
    p_hist.add_argument("--db", required=True)
    # optional PARA vault root — when given, История also picks up notes that were
    # filed (moved) out of out_dir, instead of dropping them the moment they're filed.
    p_hist.add_argument("--vault-root", dest="vault_root", default=None)

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
    # Main model override for the answer LLM call only — see Pipeline.MAIN_MODEL.
    p_srch.add_argument("--main-model", dest="main_model", default="")

    args = parser.parse_args()

    if args.cmd == "devices":
        emit("devices", devices=list_devices())
    elif args.cmd == "preflight":
        cmd_preflight()
    elif args.cmd == "models":
        cmd_models_status()
    elif args.cmd == "download-models":
        cmd_download_models(args.only)
    elif args.cmd == "classify":
        cmd_classify(args.note, args.existing, args.main_model, args.language)
    elif args.cmd == "extract":
        cmd_extract(args.note)
    elif args.cmd == "classify-terms":
        cmd_classify_terms(args.terms_file, args.fast_model)
    elif args.cmd == "history":
        cmd_history(args.out_dir, args.db, args.vault_root)
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
                   embed_model=args.embed_model, messages=args.messages,
                   main_model=args.main_model)


if __name__ == "__main__":
    main()
