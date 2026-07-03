# HANDOFF — состояние на 2026-07-03

Electron-приложение записи встреч: mic+system (AudioTee) / импорт → `backend.py` (JSON-stdout): mono/VAD → MLX Whisper → **коррекция терминов** → pyannote → LLM-сводка (LM Studio `:1234`) → `.md` в Obsidian. Архитектура и хранение — см. README.md. Три вида: 🎙 Запись · 📚 История · 🗂 PARA.

## Что доехало до main (сессия 2026-06-30…07-03, `main` = `48bf317`)

- **RAG-чат по vault** (вкладка PARA → Поиск, вход также из Истории «💬 Спросить»): гибрид FTS5 + вектор (LM Studio `/v1/embeddings`) + RRF; multi-turn с историей (query-rewrite на follow-up'ах); ответы с цитатами `[дата · заголовок]`; «Не нашёл…» + short-circuit без LLM на пустом ретриве; degraded-бейдж когда embedding-модель не загружена (keyword-only).
- **Авто-индекс** vault после успешного `process` (in-flight guard, ручной «Переиндексировать» серилизован тем же редьюсером; sqlite busy_timeout=10000).
- **Action items**: LLM-вызов после сводки → секция `## Действия` в заметке + вкладка «Действия» в результате. Скип в transcript-only.
- **Коррекция транскриптов** (этап `correct`, «Коррекция терминов»): (1) фаззи-замена по глоссарию — транслит-aware Levenshtein, ≤3-символьные термины только exact, склонённые формы не сплющиваются; (2) LLM-проход чанками с дифф-гейтом — только фонетически близкие замены, whitelist русских падежных окончаний, пунктуация оригинала; >20% дельта → чанк отбрасывается. Пустой глоссарий = этап пропущен. Свой кеш `correct-<lang><suffix>.json` с hash-валидацией против пересобранного transcribe-кеша.
- **Глоссарий** (textarea в настройках): термины → Whisper `initial_prompt` + вход обоих этапов коррекции; меняет cache-suffix транскрипции.
- **authorName** (дефолт «Автор») + кнопка «это я» в переименовании спикеров; `speakers` пишется в frontmatter и синкается при rename.
- Copy-кнопки (активная вкладка результата, ответы чата), disk-guard (<1 ГиБ отказ записи, <3 ГиБ warn), 4 старых stale-теста починены.

## Тесты

`npm test` = JS `node --test` (82/82) + PY pytest (154/154, sub-second). Всё замокано — **живой e2e RAG/коррекции не прогонялся** (решение владельца: первый реальный запуск = smoke). Если сьют внезапно стал на порядок медленнее — ищи неза-моканный сетевой вызов (`--durations`), уже наступали.

## Решения владельца (2026-06-30)

- Live-транскрипт при записи — **не нужен** (VU достаточно).
- Календарь-интеграция — **выкинута**.
- Live smoke — пропущен сознательно.
- Невалидная PARA-категория от LLM → `error`-событие, не нормализация.
- `reasoning_content` в тело заметки — никогда (строгий контракт `summarize`); для schema-валидируемого JSON salvage допустим.

## Хвосты (TODO.md — источник правды)

- Минорки критик-ревью: скрытый накапливающийся `#paraReindexLog`; degraded-бейдж на точном string-match лога backend↔main.js (реворд молча сломает); авто-индекс-процесс не убивается в `before-quit`; `optimize`-фейл FTS5 глотается молча.
- Auto-«Я» из mic-дорожки — заблокировано VAD time-warp (нужна рекомпозиция ts + mic.wav в process + энергокорреляция).
- Mix mic/system offset — нужна PCM кросс-корреляция.

## Git / процесс

- Remote `ArtemiiF/MeetingRecorder` (private, solo). `main` = origin/main = `48bf317`. Локальные фича-ветки стека можно прюнить — всё в main.
- Push в main разрешён владельцем для этого репо (private solo) **только через критик-гейт**: критик по `git diff origin/main...HEAD` → marker `printf 'verdict: approve\ndiff-sha256: %s\n'` где sha = `printf '%s' "$(git diff origin/main...HEAD)" | sha256sum` (именно через `printf '%s'` — прямой pipe оставляет \n → mismatch) → push отдельной командой.
- Фиксы предсуществующих поломок — отдельным чанком от фичи (урок сессии: бандл 4 тест-фиксов в фича-коммит дал красную соседнюю ветку).

## Окружение

- macOS: `timeout` НЕТ (только `gtimeout`); pytest через `../venv/bin/python -m pytest tests/ -q`.
- LM Studio `:1234`: reasoning-модель (max_tokens ≥1500-2500, см. k2-lmstudio-reasoning-tokens) + **embedding-модель** (id содержит «embed») для векторной половины поиска; без неё — keyword-only + warn в preflight/чате.
- Preflight-панель проверяет LM Studio / разрешения / ffmpeg / модель / HF-токен / embedding.
