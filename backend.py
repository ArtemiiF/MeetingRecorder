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
  done      {"note": str, "audio": str, "transcript": str, "summary": str}
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
# Processing pipeline (refactored from meeting_simple_v9.py)
# ──────────────────────────────────────────────────────────────────────────
class Pipeline:
    def __init__(self, out_dir, engine="mlx", diarize=True, cache_dir=None,
                 language="ru", do_summary=True, template="", db_path=None):
        self.TEMPLATE = template
        self.db_path = db_path
        self.OBSIDIAN_PATH = Path(out_dir)
        self.LMSTUDIO_API = "http://localhost:1234/v1/chat/completions"
        self.TRANSCRIPTION_ENGINE = engine
        self.WHISPER_MODEL = "medium"
        self.USE_DIARIZATION = diarize
        self.LANGUAGE = language          # "ru" | "en" | "auto"
        self.DO_SUMMARY = do_summary
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

    def _whisper_lang(self):
        # mlx/whisper take None for auto-detect
        return None if self.LANGUAGE == "auto" else self.LANGUAGE

    def _context_prompt(self):
        if self.LANGUAGE == "ru":
            return self.CONTEXT_PROMPT_RU
        if self.LANGUAGE == "en":
            return self.CONTEXT_PROMPT_EN
        return None  # auto → no language-biased prompt

    def transcribe(self, mono_audio):
        result = None
        lang = self._whisper_lang()
        prompt = self._context_prompt()
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
        tj = self._cache(f"transcribe-{self.LANGUAGE}.json")  # transcript depends on language
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
        if self.DO_SUMMARY and (summary or formatted):
            if summary:
                log("Генерирую заголовок…")
                title = self.generate_title(transcript_for_llm)
            if formatted:
                log("Определяю имена спикеров…")
                speakers = self.infer_speaker_names(transcript_for_llm)
            stage_end("meta", "ok", title or f"{len(speakers)} имён")
        else:
            stage_end("meta", "skip", "нужен LLM")
        # record title + which template (preset) was used + language in frontmatter
        note = self.set_frontmatter(note, {
            "title": title, "template": self.TEMPLATE, "language": self.LANGUAGE})

        note = self.add_audio_link(note, audio_basename)
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
             speakers=speakers)


def cmd_process(args):
    prompt = Path(args.prompt_file).read_text(encoding="utf-8") if args.prompt_file else ""
    if not prompt.strip():
        prompt = "Сделай краткую структурированную сводку этой встречи в Markdown."
    pipe = Pipeline(out_dir=args.out_dir, engine=args.engine, diarize=args.diarize,
                    cache_dir=args.cache_dir, language=args.language, do_summary=args.summarize,
                    template=args.template, db_path=args.db)
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
    p_proc.add_argument("--summarize", type=str2bool, default=True)
    p_proc.add_argument("--template", default="")
    p_proc.add_argument("--db", default=None)

    p_hist = sub.add_parser("history")
    p_hist.add_argument("--out-dir", dest="out_dir", default=default_obsidian)
    p_hist.add_argument("--db", required=True)

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


if __name__ == "__main__":
    main()
