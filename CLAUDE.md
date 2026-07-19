# CLAUDE.md — Meeting Recorder

## Архитектура (один абзац)

Electron: `main.js` (main-процесс, IPC-хендлеры, запись/микс аудио, установка бэкенда) ↔ `preload.js` (contextBridge → `window.api`) ↔ `renderer/` (UI, вкладки Запись/История/PARA/Словарь/Промпты). Тяжёлый пайплайн (whisper/VAD/диаризация/LLM-сводка) — отдельный процесс `backend.py`, общается с main.js через **JSON-построчно в stdout** (`{"event": "<name>", ...}`), имена событий — контракт `events.json` (см. ниже). Источник правды по заметкам — `.md`-файлы в vault'е (Obsidian/PARA), `index.db` (SQLite) — производный поисковый индекс, пересобираемый из `.md`, не хранилище истины.

## Тесты: layout + команды

- `npm test` — JS (`node --test tests/mainutil.test.js tests/renderer.test.js`) + PY (`pytest tests/`). Оба набора мокают внешние side-effects (subprocess/ffmpeg/electron) — быстрые, без реального аудио/сети.
- `npm run test:js` / `npm run test:py` — по отдельности.
- `npm run test:e2e` (`e2e/boot.test.js`) — **отдельно**, не входит в `npm test`. Гоняет собранный `.app`, не dev-чекаут: `npx electron-builder --mac --arm64 --dir` → `dist/mac-arm64/Meeting Recorder.app`, драйвер playwright-core `_electron.launch`. Изолированный userData через `MEETING_RECORDER_USER_DATA` (main.js) — без него читает/пишет реальный userData разработчика. Ловит целый класс asar-паковочных багов (main-процесс падает на require() ДО первого окна) — юнит/интеграционные тесты этого не видят, т.к. никогда не запускают реальный `.app`.
- CI: `.github/workflows/ci.yml` — `js-tests`/`py-tests` (ubuntu, параллельно) + `e2e-boot` (macos-14, собирает `--dir` и гоняет `test:e2e`) + `check-version`/`release` (мержи в main с новой версией).

## Жёсткие конвенции

- **Чистые хелперы → `lib/mainutil.js`** с side-effects через параметры (не читают `app`/`process.resourcesPath` изнутри — принимают их аргументами), чтобы оставаться юнит-тестируемыми под голым `node --test` (main.js `require("electron")` и не грузится headless).
- **Пути от рендерера → containment.** Любой путь, пришедший из renderer/IPC-аргумента, проверять через `isPathInsideRoots` (lib/mainutil.js) перед файловой операцией — никогда не доверять напрямую.
- **Имена событий — ТОЛЬКО через контракт `events.json`.** Никогда не строковый литерал в main.js/backend.py. `lib/events.js` (main.js) и `EVENT_NAMES` (backend.py) оба грузят один и тот же `events.json`; `tests/test_backend.py` держит cross-lock тест между сторонами. Новое событие — сначала строка в `events.json`, потом `EVENTS.X`/использование.
- **Asar-правило: каждый рантайм-путь packaged-aware.** Использовать паттерн `resolveResourcePath`/`resolveAudioTeeBin`/`resolveAssetPath` (lib/mainutil.js) — не голый `__dirname`/относительный путь. Файл, перечисленный ОДНОВРЕМЕННО и в `build.files`, и в `build.extraResources` (package.json), **молча выпадает из `app.asar`** (A/B-верифицировано 2026-07-19 — ровно так упал v1.4.5: `events.json` отсутствовал в asar, main-процесс падал на `require()` до первого окна, а все 903 юнит/интеграционных теста были зелёными). `lib/events.js`'s `CONTRACT_CANDIDATES`-фолбэк — образец фикса для этого класса; `e2e/boot.test.js` — регрессионный тест на класс целиком.
- **TDD для агентов:** написать тест → подтвердить RED → реализовать → подтвердить GREEN. Для e2e/boot-тестов RED — обязательно воспроизвести конкретный баг (не просто «тест не проходит»), не только «зелёный after the fact».

## Коммиты / ветки

Conventional commits (`type(scope): description`), без `Co-Authored-By`. PR-флоу — `main` защищён (см. `.github/workflows/ci.yml` required checks), пуш в `main` напрямую запрещён.
