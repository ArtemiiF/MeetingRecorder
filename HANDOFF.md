# HANDOFF — состояние на 2026-07-03 (вечер)

Electron-приложение записи встреч: mic+system (AudioTee) / импорт → `backend.py` (JSON-stdout): mono/VAD → MLX Whisper → коррекция терминов → pyannote → LLM-сводка (LM Studio `:1234`) → `.md` в Obsidian. Архитектура и хранение — см. README.md. Три вида: 🎙 Запись · 📚 История · 🗂 PARA.

## Что доехало до main (сессия «добить хвосты» 2026-07-03, `main` = `385ae7d`)

Три чанка, каждый своей веткой через критик-гейт:

- **4 минорки критик-ревью** (`d8c33c8` + `554b4b1`): cap 300 строк у `#paraReindexLog`; тест-замок на string-match degraded-бейджа backend.py↔main.js (реворд теперь валит тест); kill авто-индекс-процесса в `before-quit` + guard от respawn queued-рана при выходе (`quitting`-флаг); лог `optimize`-фейла FTS5 вместо молчаливого pass.
- **Mix start-offset alignment** (`468ade2`): PCM кросс-корреляция mic/system в `cmd_mix` — `estimate_start_offset_ms` (scipy fft-correlate, окно 15 c, decimate до 4 кГц, поиск ±3 c), результат напрямую в `delays` → `build_mix_filter` → ffmpeg `adelay` позже стартовавшей дорожке (CLI-флаги `--mic-delay-ms`/`--sys-delay-ms` — ручной override, nonzero отключает авто-детект). Lazy-import scipy/numpy → no-shift при ImportError; порог уверенности `_XCORR_MIN_CONFIDENCE=0.15` → no-shift с логом. Гейт: авто-детект только когда CLI-делеи не заданы. Timestamp-подход НЕ использовать — уже пробовался и откачен (см. коммент main.js у spawn record: pyaudio startup jitter).
- **Auto-«Я» из mic-дорожки** (`385ae7d`, разблокирован VAD time-warp): VAD chunk-карта сохраняется в `vad_map.json` (сайдкар в cache_dir, вне hash-валидации этапов); mic/system схлопываются той же картой в timeline диаризации (`_shift_chunks` + `_collect_chunks_np`, numpy-native — без torch.hub); per-сегмент RMS → `compute_speaker_dominance` (duration-weighted mic-ratio) → `pick_author_label` (min_ratio + margin + min_duration, ≥2 спикеров) → `speakers.setdefault(label, authorName)` в meta-этапе — LLM-имя и ручной rename не перетираются. Плюмбинг: `p_proc --mic/--system/--author-name`, renderer шлёт их только в record-режиме — import/transcript-only/diarize-off byte-identical прежнему поведению. Старые кеши без vad_map.json → скип с логом, без пересчёта.

## Тесты

`npm test` = JS `node --test` (86/86) + PY pytest (193/193). Всё замокано — живой e2e RAG/коррекции/auto-«Я» не гонялся; первый реальный запуск = smoke + калибровка порогов auto-«Я» (лог пишет per-label mic_ratio/duration — по нему тюнить `_AUTHOR_MIN_*`).

## Решения владельца (2026-06-30, действуют)

- Live-транскрипт при записи — не нужен. Календарь — выкинут. Live smoke — сознательно пропущен.
- Невалидная PARA-категория от LLM → `error`, не нормализация.
- `reasoning_content` в тело заметки — никогда; для schema-валидируемого JSON salvage допустим.

## Хвосты (TODO.md — источник правды)

- Не-блокеры критик-гейтов 2026-07-03: VAD-ветка auto-«Я» при nonzero delay клипует граничный chunk у нуля (дрейф ≤ delay на границе, fails safe) — покрыть nonzero-delay тестом при калибровке; `_read_mono_decimated` читает 8-бит WAV как int8 (по спеке unsigned) — латентно, приложение пишет только 16-бит.
- Отложено владельцем: см. TODO.md.

## Git / процесс

- Remote `ArtemiiF/MeetingRecorder` (private, solo). `main` = origin/main = `385ae7d`. Фича-ветки сессии можно прюнить.
- Push в main разрешён владельцем **только через критик-гейт**: критик по `git diff origin/main...HEAD` → marker `printf 'verdict: approve\ndiff-sha256: %s\n'` где sha = `printf '%s' "$(git diff origin/main...HEAD)" | sha256sum` (именно `printf '%s'` — прямой pipe оставляет \n → mismatch) → push отдельной командой. Marker одноразовый, TTL 300 c.
- Agent-report'ы (`.claude/agent-reports/`) — untracked, в коммиты не включать.
- Фиксы предсуществующих поломок — отдельным чанком от фичи.

## Окружение

- macOS: `timeout` НЕТ (только `gtimeout`); pytest через `../venv/bin/python -m pytest tests/ -q`; venv: numpy 2.4.4, scipy 1.17.1.
- LM Studio `:1234`: reasoning-модель (max_tokens ≥1500-2500) + embedding-модель для вектора; без неё keyword-only + warn.
- Preflight-панель проверяет LM Studio / разрешения / ffmpeg / модель / HF-токен / embedding.
