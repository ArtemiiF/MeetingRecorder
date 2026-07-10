# TODO

## Инцидент 2026-07-10 (диагностирован, не чинен)
- **Гонка стоп-записи ↔ обработка**: 25-мин запись → в пайплайн попало 0.4с (mono-кеш 12КБ при живом mixed 48МБ); стоп и старт обработки в одну секунду — mixed.wav, видимо, дописывался. Guard: pending-▶ (и «Обработать все») не активировать до подтверждённой финализации mixed (файл закрыт + размер стабилен), или манифест-append строго после close. Диагностика в HANDOFF.

## Не-блокеры критик-гейтов (2026-07-10, PR #11-#13)
- `removeGlossaryTerm` не чистит `glossaryCategories[low]` удалённого термина — сироты копятся в presets.json безгранично (рендер не задет; suggestions/dismissed капятся, категории — нет). Чистить при удалении.
- `classify-glossary-terms` IPC без guard'а на `installBackendProc`/`updateProc` (паттерн para-extract) — клик мид-установки даст «нет ответа» вместо честного «дождитесь». Выровнять с start-recording-гейтами.
- Двойной клик по «📋 Путь»/copy-кнопкам внутри окна фидбека клоберит захваченный текст (предсуществующий паттерн copyToClipboard) — кнопка залипает на «✓ Скопировано». Косметика.

## Не-блокеры критик-гейтов (2026-07-07, упаковка .app)
- Install atomic-rename: краш/kill между `rename(BACKEND_ENV→BACKEND_ENV.old)` и `rename(staging→BACKEND_ENV)` стрендит рабочий env в `.old`, новый в staging — ни один не на `BACKEND_ENV` (резолвится SAFE: absent→venv, но юзер теряет установку). `.old` чистится только на старте след. установки, НЕ на launch и НЕ в `uninstall-backend` → ~1.3ГБ может залипнуть. Чистить `.old` в uninstall + на launch.
- pip-стадия НЕ hash-pinned (`--find-links … -r requirements.txt` без `--require-hashes`; requirements без хешей) — стандартный pip-over-TLS trust; python-build-standalone+ffmpeg ЗAheshированы. `--require-hashes` для 107 транзитивных деп — непропорционально, оставлено сознательно.
- Нет иконки .app — дефолтная Electron (сделать assets/icon.icns + `mac.icon`).
- pyaudio wheel привязан к arm64/py3.11 — при апгрейде Python или pyaudio пересобирать delocate-wheel (build-time: brew portaudio + delocate).

## Не-блокеры критик-гейтов (2026-07-06, фича pending-recordings)
- Синхронный reject-путь `processAudio` (`{ok:false}` «Обработка уже идёт» при renderer `state.processing=false` — desync main↔renderer) зовёт `finishProcessing`, но НЕ `finishPendingItem` → строка застревает `status:running` (ни reprocess, ни delete). Low-reach (гейты `state.recording||state.processing` закрывают почти все окна), предсуществующая форма. Обернуть reject в `finishPendingItem` при случае.

## Не-блокеры критик-гейтов (2026-07-06, вечер — хвосты)
- backend: `_glossary_prompt` осиротел в прод-пути (`transcribe` зовёт `_build_initial_prompt`; единственный вызов — тест) + формат «Термины: …» продублирован в `_build_initial_prompt` — DRY-дрейф при смене формата. Слить при случае.
- PARA inbox: catch в `refreshParaInbox` полностью тихий — упавший fetch не даёт пользователю сигнала (inbox пустой/стейл без объяснения); ретрай при следующем входе есть.
- PARA inbox: нет in-flight guard — быстрый re-entry (inbox→search→inbox) во время первого fetch даёт конкурентные fetch (benign: last-write-wins, innerHTML переписывается).
- PARA «разобрать все»: компенсирующий re-enable кнопок строк не в `finally` — throw вне внутреннего try (напр. `it.title` на undefined) оставляет кнопки disabled навсегда до перезахода (низкий риск: refresh disabled мид-батч).
- PARA reverse race (предсуществующий): ручной «Разложить» уже in-flight при старте «Разобрать все» не блокируется — та же заметка может уехать дважды.
- Батч retry: ⏹ во время row-retry не сбрасывает `queueSingleRetry` (bounded: все стартовые пути чистят флаг); retry середины + ⏹ + глобальный ↻ каскадит по уже-терминальным элементам (resume-from-cache, не деструктивно); canceled-строка теряет row-↻ (остаётся глобальный); `{ok:false}` из processAudio оставляет строку 🔵 (предсуществующая форма, есть и в startQueueRun).
- main.js: обратный гейт НЕ добавлен — старт записи во время активного model-download разрешён (блокировать живую встречу ради фонового скачивания — продуктовое решение за владельцем); контеншн-гейт полу-enforced.

## Не-блокеры критик-гейтов (2026-07-03)
- Auto-«Я», VAD-ветка при nonzero delay: `_shift_chunks` клипует граничный chunk у нуля — дрейф схлопнутой дорожки от timeline ≤ delay на этой границе (fails safe: эвристика с порогами). Добавить nonzero-delay интеграционный тест при калибровке порогов на реальной записи.
- Пороги auto-«Я» (`_AUTHOR_MIN_RATIO`/`_MARGIN`/`_DURATION`) и `_XCORR_MIN_CONFIDENCE=0.15` — HYPO-дефолты, не валидированы на реальной записи; лог auto-«Я» пишет per-label mic_ratio/duration — калибровать по первому smoke.
- Deviation-2 допущения model-download (torch.hub кеш-хит по существованию директории; pyannote тянет ровно 3 суб-репо) — ASSOC, не проверены на живой сети; проверить при первом холодном скачивании.
- `ruStem` prefix-match расширяет выдачу на запросах 1-3 буквы (инкрементальный поиск — приемлемо, для осведомлённости).
- История: renderRail рендерит все заметки O(n) без виртуализации — деградация на тысячах заметок (кап снят по решению владельца).
- Чат: degraded-бейдж по-прежнему на string-match backend↔main.js (тест-замок есть с 2026-07-03).

## Фича 2026-07-06 (ветка feat-pending-recordings, `68aac2d`)
Персист-очередь записей: запись → стоп → записи копятся в `state.pendingRecordings` (единый источник правды, single-slot удалён), ждут обработки; переживают перезапуск (аудио в `APP_DIR/recordings/<id>/`, манифест `pending.json` atomic; на старте `list-pending-recordings` восстанавливает, дропает пропавшие файлы). Обработка per-row ▶ / «Обработать все» (один слот procProc); успех → `remove-pending-recording`, фейл → остаётся. **Ревёрт гейта `0a79d98`** (по решению владельца): запись разрешена во время обработки — recBtn больше не disabled от `state.processing`, `toggleRecording` не делает early-return; хардварный мьютекс (2 записи разом) + download×запись остаются. id = `<displayStamp>-<rand4>` (dir==manifest id, коллизии по секунде исключены).

## Закрыто 2026-07-06 (вечер, ветки todo-*)
initial_prompt cap (контекст приоритетен, глоссарий режется с хвоста, эвристика ceil(chars/3)) · int8→uint8 8-бит WAV + центрирование · `.get` в autouse-фикстуре · suggest-эвикшн (новые выживают) · комментарий glossaryDismissed · recBtn-гейт мид-батч (позже ревёрнут фичей pending-recordings) · paraInboxLoaded после fetch · PARA row-disable на батч · download×запись взаимоисключение · reset: пресеты до saveToken · батч retry per-element (row-↻ на 🔴, без каскада).

## Отложено по решению владельца (2026-06-30)
- Live-транскрипт во время записи — не нужен (VU-индикатора достаточно).
- Календарь-интеграция (title+участники) — выкинута.
- Live smoke RAG на реальной LM Studio — пропущен; первый реальный запуск = smoke (теперь покрывает также: коррекцию, auto-«Я», скачивание моделей, батч-импорт, reset, пороги).
