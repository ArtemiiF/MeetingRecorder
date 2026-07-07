# HANDOFF — состояние на 2026-07-08

Electron-приложение записи встреч: mic+system (AudioTee) / импорт → `backend.py` (JSON-stdout): mono/VAD → MLX Whisper → коррекция терминов → pyannote → LLM-сводка (LM Studio `:1234`) → `.md` в Obsidian. Архитектура и хранение — см. README.md. Четыре вида: 🎙 Запись · 📚 История · 🗂 PARA · 📖 Словарь.

## ⚠️ Репо ПУБЛИЧНЫЙ + новый git-процесс (2026-07-08)

- `ArtemiiF/MeetingRecorder` — **публичный** (решение владельца, ради автообновлялки без токена), MIT LICENSE. Старый приватный переименован в `MeetingRecorder-private` (бэкап со старой историей).
- История переписана filter-repo: автор всех коммитов `Artemii <a.filanovskii@yandex.ru>` (прецедент reflectory), Co-Authored-By вырезан. **Новые коммиты: тот же автор (git config локально стоит), НИКОГДА не добавлять Co-Authored-By-трейлер** — решение владельца.
- **Прямой push в main агенту ЗАПРЕЩЁН** (owner-solo-private delegation отменилась на public). Флоу: ветка → критик-гейт → push ветки → PR → владелец мержит сам. Прецедент: PR #1.
- Секурити-скан истории перед публикацией: чисто (presets/index.db/.secret/записи никогда не трекались, секрет-паттернов нет).

## Сессия 2026-07-07/08 — LLM-фиксы, История, fast-model, автообновлялка

- **Коррекция терминов** (`68744b6`): юзер поймал «LLM недоступен» — реально `Read timed out (120s)`. Замеры на живом LM Studio: gemma-4-26b (reasoning) на 1712-символьном чанке жжёт ВСЁ на thinking (4000 cap → 157с, reasoning 3997/3999; 16000 cap → 457с, reasoning 15997, content=0 — спираль НЕ заканчивается, бюджет не лечит). Фикс: `_llm_correct_budget(chunk_len)` — max_tokens = 4000 + ceil(chars/3) (floor = измеренный минимум), timeout = 30 + max_tokens/15 (rate 15 tok/s консервативно от измеренных 25); except разведён Timeout/ConnectionError/generic; correct-кеш пишет `llm_ok` — degraded-результат больше НЕ залипает (missing key у старых кешей → recompute).
- **Быстрая модель для механики** (`83e7644`): настройка «Модель для быстрых задач» (presets `fastModel`, пусто = загруженная модель) → поле `model` в запросах ТОЛЬКО correct/suggest/title; summarize/chat/PARA нетронуты (thinking остаётся для сводки — решение владельца). Замер `google/gemma-3-4b` (скачана владельцем): 6.2с тёплый, finish=stop, реальный контент — ~70× быстрее 26b. Qwen не трогать (решение владельца).
- **История + pending** (`41c5f20`+`b94bff2`): pending-записи мерджатся в Историю НА БЭКЕНДЕ (cmd_history `--pending-file`, синтетические строки kind:"pending", хронологический мердж двух форматов stamp через `_parse_any_stamp`); ▶/✕ и «Обработать все» в ленте, поверх фильтров (решение владельца); блок из карточки Запись удалён, мёртвая большая «▶ Обработать» скрыта вне import-режима. Типизация заметок: frontmatter `source` recording/batch/file (новый `--origin`), legacy без поля → бейдж ❓ unknown (решение владельца); DB-колонка source через guarded ALTER TABLE.
- **Автообновлялка** (PR #1, `a499af7`): секция «Обновления» в настройках — check releases/latest (без токена), semver-сравнение (mainutil), скачивание с прогрессом/отменой, `ditto -xk` → `xattr -dr quarantine` → swap через `.old` с откатом → relaunch. Гонка данных закрыта 2 слоями (критик-fix): обратные guard'ы (запись/обработка/модели/бэкенд отказывают при updateProc) + пере-проверка занятости перед swap. EXDEV (другой том) → откат + честное сообщение. Только packaged; чистка `.old`/updates на старте. Bootstrap: v1.0.0 обновлялку не содержит — одна ручная переустановка.
- **Релиз v1.0.0 перенесён** в публичный репо (ассеты скачаны из private, пересозданы).

## Упаковка в .app + установка бэкенда по кнопке (2026-07-07)

Решение владельца: **тонкая .app**, тяжёлый Python-бэкенд НЕ бандлится, а ставится по кнопке в `userData` на машине юзера. Цель — самодостаточный arm64 .app на другой Mac; подпись ad-hoc (без Apple Developer).

- **requirements.txt** (`b5682da`): pip freeze venv, 107 пакетов, py3.11.15. `openai-whisper` свапнут git→PyPI `==20250625` (убрал требование git при установке). pytest оставлен (dev-only, тримить потом).
- **Кнопка «Установить бэкенд»** (`b5682da`, секция «Бэкенд» в настройках, sibling «Модели»): качает python-build-standalone (arm64 CPython 3.11.15, sha256-пин) + статичный arm64 ffmpeg (sha256-пин) → `pip install --find-links vendor/wheels -r requirements.txt` со стримом прогресса. **Атомарно**: весь стек ставится в `BACKEND_ENV_STAGING`, `fs.rename` на `BACKEND_ENV` только после pip+маркера — partial/cancel никогда не виден как installed (это был blocker критика). `backendAvailable()`/`pythonBin()`/preflight/status все **marker-gated** (единый источник правды, не existence). IPC install/cancel/status/uninstall, busy-guard vs запись/обработка/скачивание. Полная чистая установка проверена живьём (симуляция чистого Mac, brew срезан, exit 0, всё импортится).
- **PyAudio** (`b5682da`, `vendor/wheels/pyaudio-0.2.14-cp311-cp311-macosx_11_0_arm64.whl`): у PyAudio нет macOS-wheel на PyPI (только Windows+sdist, компилится против системного portaudio). Решение: собран delocate-wheel с вшитым `libportaudio.2.dylib` (`@loader_path/.dylibs/`, ноль homebrew-ссылок), ретаргечен на big_sur bottle → тег `macosx_11_0` (работает на macOS 11+). Ставится из локального wheel — ни компилятора, ни brew на машине юзера.
- **electron-builder** (`ee85c03`, `26.15.3` пин): mac dmg+zip arm64, ad-hoc `identity:"-"` + `hardenedRuntime`. `build/entitlements.mac.plist` (`device.audio-input` + `disable-library-validation`) на `mac.entitlements` И `entitlementsInherit`; Info.plist `NSMicrophoneUsageDescription`+`NSAudioCaptureUsageDescription` через extendInfo. `extraResources`: backend.py+requirements.txt+vendor/wheels; `asarUnpack` audiotee bin. **Баг #9529** (ad-hoc ломает mic на v26.0.13+) решён через правильные entitlements (hardened runtime требует audio-input на main+helpers), НЕ через afterSign-хак/пин старой версии. Два packaged-бага пойманы прогоном бинаря: `WRITABLE_DIR` (presets/db/recordings/.secret уезжали в read-only asar — теперь userData при packaged, APP_DIR в dev) + spawn `cwd` (asar-virtual APP_DIR → `ENOTDIR`, чинено на `dirname(BACKEND)`). Билд: `npx electron-builder --mac --arm64`; `dist/` в .gitignore.

### Кнопки разрешений в Preflight (`545a0d7`)
Preflight-панель: у строки Микрофон — кнопка «Разрешить» (`systemPreferences.askForMediaAccess("microphone")` — нативный промпт при not-determined; после → refresh) / «Открыть настройки» при denied|restricted (диплинк `Privacy_Microphone`). У Системного звука — «Открыть настройки» (диплинк `Privacy_ScreenCapture`; программного промпта у AudioTee-категории нет). IPC `request-mic-access`/`open-privacy-settings` (target валидируется, non-darwin→true). macOS TCC программно НЕ выдаётся — кнопки только вызывают промпт/ведут в Настройки.

### Setup-стена (`95dd80d`)
Жёсткий гейт: пока НЕ (бэкенд установлен И whisper+vad в кеше) — full-cover overlay `#setupGate` (шаги «Установить бэкенд» → «Скачать модели» с прогрессом, реюз install/download-флоу), нормальный UI перекрыт. Готовность через `app-readiness` IPC: `backendAvailable()` + кеш whisper/vad проверяется **Node fs** (НЕ спавн python — до установки его нет), пути зеркалят backend.py `_model_cached` (coupling: менять оба). Диаризация НЕ в стене (опциональна, gated) — гейчится per-run в process-audio (diarize=true + нет pyannote → отказ). **Fail-closed**: `#setupGate` по умолчанию видим, скрывается только на confirmed-ready; ошибка IPC оставляет стену (не открывает приложение). Триггеры пере-проверки: boot / focus / после install-closed / после download-closed. Скачивание из стены scoped `["whisper","vad"]` (не тянет pyannote даже при токене). Тесты: path-exactness (падает при дрейфе путей), 4-state predicate, show/hide, fail-closed, diarize-гейт.

### Фиксы live-теста (`c39bd83`)
- **Двойной keychain-промпт** на старте: `loadToken` дёргал `safeStorage` дважды (get-presets + preflight). Фикс: module-кеш токена + `encryptionAvailable()`, `loadToken` short-circuit на `!fs.existsSync(SECRET_FILE)` (fresh без токена → keychain не трогается вообще). Один промпт при смене подписи (ad-hoc rebuild) — неизбежен, для стабильного .app «Always Allow» разово.
- **Прогресс скачивания моделей**: байт-прогресс % / МБ через `snapshot_download(tqdm_class=_ProgressTqdm)` (реальный `tqdm.auto.tqdm` subclass — HF юзает tqdm_class двуролево, дак-стаб падает на `set_lock`; эмит только для bytes-бара `unit=="B"`, throttle, emit в try/except, `_emit_lock` не путать с tqdm `_lock`). VAD (torch.hub) — грубо (мелкий). UI: %/МБ в стене + «Модели».
- **Отмена скачивания**: кнопки в стене + настройках → существующий cancel IPC. **Чистка частичной модели авторитетно на стороне родителя** (main.js close-handler после смерти дочернего: `cleanupPartialModelCache(inFlightModelId)` при canceled||code≠0) — гонки нет (worker-тредов уже нет), пути single-sourced из тех же хелперов что readiness → после отмены whisper-папки нет → `_model_cached`=false → стена НЕ снимается ложно. `inFlightModelId` = модель со `stage` без `stage_end` (завершённые не трогаются). Backend SIGTERM-cleanup остаётся best-effort.

### Фиксы live-теста #2 (2026-07-07)
- **Keychain-промпт каждый запуск даже без токена** (`5a87f55`): `isEncryptionAvailable()` дёргался на старте в `loadPresetsData` (для `secretEncrypted`). Фикс: gate `token ? encryptionAvailable() : false` на обоих return-путях — без `.secret` `safeStorage` не трогается вообще → ноль промптов. С токеном — один промпт/запуск (ad-hoc не закрепляет «Always Allow», неизбежно). Диагностика: на fresh не было ни `.secret` ни presets, промпт всё равно → значит `isEncryptionAvailable`, не `loadToken`.
- **Системный звук не писался в упакованном .app** (`dac47d6`, ПОДТВЕРЖДЕНО на рантайме): AudioTee спавнил бинарь по asar-относительному пути (`join(__dirname,"../bin/audiotee")` внутри app.asar), полагаясь на авто-редирект Electron в .unpacked. Диагностика: и dev-, и packaged-бинарь standalone дают реальный PCM (не тишина) → OS/бинарь/TCC ок, баг в интеграции. Фикс: явный `binaryPath` в `new AudioTee({binaryPath})` — packaged `resourcesPath/app.asar.unpacked/node_modules/audiotee/bin/audiotee`, dev `APP_DIR/...` (helper `resolveAudioTeeBin`, mainutil). Опция называется именно `binaryPath` (проверено в audiotee dist/index.js:84). Плюс `[audiotee]` console-логи (binaryPath + error/log events) для будущей диагностики.
- **Ссылка «Где взять токен?»** (`b710274`): у поля HF-токена подсказка + линк на huggingface.co/settings/tokens. Generic `open-external` IPC (https-only гейт — renderer не может открыть произвольную схему), `openExternal` в preload.
- **Трей-иконка не видна в упакованном .app** (`28566c1`, ПОДТВЕРЖДЕНО на рантайме): `createTray` грузил PNG через `nativeImage.createFromPath(APP_DIR/assets/...)` = asar-путь → пустая иконка → невидимый трей (тот же класс, что audiotee). Hidden Bar исключён (не запущен). Фикс: helper `resolveAssetPath` (mainutil) — packaged `resourcesPath/app.asar.unpacked/assets/trayTemplate.png`, dev `APP_DIR/assets/...`; `asarUnpack` добавлен `assets/trayTemplate*.png` (и @2x — retina-сиблинг тоже реальным файлом); `if(icon.isEmpty()) console.error` для диагностики. **Общий урок вынесен в G-правило** `g-electron-asar-path-audit` (general-rules.md, reflect-session): при упаковке Electron dev-first аудитить все `__dirname`/APP_DIR рантайм-пути ДО сборки.
- **safeStorage/keychain на ad-hoc**: `isEncryptionAvailable()` возвращает false в упакованном ad-hoc .app → токен хранится base64 (варнинг в UI, честный fallback). Не баг — корень тот же (нет стабильной keychain-идентичности без Developer ID). HF read-токен, локально, в `.secret` (не в git) — риск низкий. Владелец решил оставить (пункт 1).

## Релиз v1.0.0 (GitHub Release)
`gh release create v1.0.0` на `main` (`28566c1`), приватный репо → виден только владельцу. Вложения: `Meeting Recorder-1.0.0-arm64.dmg` + `.zip` (~98МБ). Заметки: требования (arm64, LM Studio, интернет на первый запуск), шаги установки (drag→Gatekeeper right-click Open→setup-стена→разрешения), ad-hoc-ограничения, sha256 dmg (`1f08a601…`). URL: https://github.com/ArtemiiF/MeetingRecorder/releases/tag/v1.0.0. Скачать: `gh release download v1.0.0 -R ArtemiiF/MeetingRecorder`. Следующая версия: bump `version` в package.json → пересборка → `gh release create vX.Y.Z`.

### Ручной smoke упаковки (НЕ проверено автоматом)
- Выдача TCC mic при первом запуске (системный звук — ПОДТВЕРЖДЁН рабочим после binaryPath-фикса на реальном прогоне 2026-07-07).
- Полный флоу «Установить бэкенд» на чистой машине (~1.3ГБ download).
- Gatekeeper: non-notarized .app даст «приложение повреждено/неизвестный разработчик» — правый клик → Открыть (снять quarantine), неизбежно без платного Developer ID.
- Нет иконки — ships с дефолтной Electron (follow-up).

## Фича: персист-очередь записей (`68aac2d`, ветка feat-pending-recordings)

Запись → стоп → снова запись, не обрабатывая → записи копятся и ждут (раньше single-slot `recordedFile` перезаписывался — вторая запись теряла первую из UI).

- **Единый источник правды** `state.pendingRecordings` — весь single-slot record-путь (`recordedFile`/`recordedMic`/`recordedSystem`/`recordedId`) удалён; `recorded`-хендлер ТОЛЬКО append + render (не трогает `state.processing`/`setProcessingUI`/log — иначе завершение записи рвало бы live-run соседней обработки, это был blocker критика, унифицировано и залочено тестом).
- **Персист через перезапуск**: аудио пишется сразу в `APP_DIR/recordings/<id>/` (постоянно, НЕ подметаемый TMP_DIR; кеш-резюме остаётся в TMP_DIR), манифест `recordings/pending.json` (writeJsonAtomic). На старте `list-pending-recordings` восстанавливает очередь и дропает записи с пропавшими файлами. IPC `remove-pending-recording` (delete dir + entry) для ✕ и после успешной обработки.
- **Обработка**: per-row ▶ / «Обработать все» через единственный слот procProc (mirror import-очереди); успех → remove из манифеста (уже в Истории), фейл → остаётся для retry.
- **Ревёрт гейта `0a79d98`** (по решению владельца): запись разрешена во время обработки — recBtn не disabled от `state.processing`, `toggleRecording` без early-return. Хардварный мьютекс (2 записи разом, main.js) + download×запись — на месте. id = `<displayStamp>-<rand4>` (dir и manifest id равны, коллизии по секунде исключены).
- Минор (TODO): sync reject-путь processAudio оставляет строку `running` при desync main↔renderer (low-reach).

## Что доехало до main (сессия 2026-07-06 вечер) — хвосты TODO

Четыре кода-чанка, каждый своей веткой через критик-гейт (все approve):

- **backend-минорки** (`7c8da45`): cap Whisper `initial_prompt` — `_build_initial_prompt()`: бюджет 224 токена (эвристика ceil(chars/3), без токенизатора), контекст никогда не режется, глоссарий дропается с хвоста списка (user-термины в голове выживают), контекст ≥ бюджета → глоссарий целиком в дроп; 8-бит WAV int8→uint8 + центрирование −128 (PCM-8 unsigned по спеке); autouse-фикстура стабит и `requests.get` (503). `_glossary_prompt` остался (жив только тестом) — см. TODO.
- **renderer-минорки** (`0a79d98`): suggest-эвикшн `slice(-CAP)` (новые выживают); комментарий glossaryDismissed; `toggleRecording` no-op на старт при `state.processing` (кнопка+tray), stop не блокируется; `paraInboxLoaded` после успешного fetch (упавший — ретрай при входе); PARA row-кнопки глобально disabled на «разобрать все» + re-enable недошедших при cancel.
- **main.js-минорки** (`365e6a1`): `download-models` отказывает при `recordProc || tee` («Дождитесь окончания записи»); reset-app: `writeJsonAtomic` ДО `saveToken("")` — disk-full больше не стирает токен без сброса пресетов. Обратный гейт (старт записи при активном скачивании) НЕ добавлен — продуктовое решение за владельцем (TODO).
- **батч retry per-element** (`cfcce85`): row-↻ на 🔴-строках очереди после батча; `retryQueueItem(idx)` реюзает один слот `startProcessing(false)` (resume, не fresh); флаг `queueSingleRetry` гасит авто-каскад `advanceQueue` (иначе перепрогон терминальных после ретрая середины); гейт `state.recording || state.processing`; рендер очереди переписан на createElement + closure-by-index (chip-паттерн, имена файлов не в атрибутах).

Минорки критиков этой пачки — TODO.md секция «2026-07-06, вечер». Что закрыто — TODO.md секция «Закрыто».

## Предыдущая сессия (2026-07-06 день) — словарь

Три чанка, каждый своей веткой через критик-гейт:

- **DEFAULT_GLOSSARY 49→106** (`8f93a7a`): распространённые IT/бизнес-термины (продукт/аналитика/dev/инфра/AI). Golden-дубликат в tests/renderer.test.js обновлён синхронно (tripwire сохранён). Хвост: 106 терминов не влезают в ~224-токенное окно Whisper initial_prompt — см. TODO.
- **Чипы-UX вкладки Словарь** (`cdf21f2`+`b28d276`): textarea → чип-лист (добавить input/Enter, удалить ×, счётчик «N терминов»), кнопка «Дополнить распространёнными» (case-insensitive мёрж дефолтов, текущий порядок первым), textarea остался скрытым «текстом»-тоглом (двусторонний sync). Критик-reject пойман и исправлен: `data-term`-атрибут с user-строкой (escapeHtml не экранирует `"` → attribute-injection + сломанное удаление) → слушатели через closure-by-index, атрибут удалён; regression-тест с кавычкой в термине. Паттерн обязателен для всех новых чипов: никаких user/LLM-строк в HTML-атрибутах.
- **Авто-пополнение «Предложения»** (`ef42c2d`): новый pipeline-stage `suggest` после summary (всегда, независимо от do_summary; LM недоступен → `[]` + warn, не 🔴); LLM-извлечение кандидатов из транскрипта с жёсткими код-гейтами (substring по транскрипту против инвенций, дедуп через `_term_or_declined_form`, len>2, cap 20); кеш `suggest-{lang}{glossary-suffix}.json` + input_hash транскрипта; suggestions едут в `done`-payload (main.js не менялся — форвардит verbatim). Renderer: presets-поля `glossarySuggestions` (pending, cap 100) / `glossaryDismissed` (никогда не пере-предлагать), секция «Предложения» с ✚/✕/«Принять все». Autouse-фикстура в pytest стабит requests→503 (LM Studio на машине живой — полнопайплайновые тесты больше не бьют в него).

- **Tray в menu bar** (`adf9726`): иконка (template PNG assets/, авто dark/light) с меню «Начать/Остановить запись» (динамический лейбл) / «Открыть Meeting Recorder» / «Выйти»; `tray.setTitle("REC")` при записи. Tray-toggle реюзает renderer-флоу кнопки записи через IPC (`toggleRecording` извлечён, логика записи в main не дублируется); все 3 сайта `state.recording` пушат `recording-state`. Закрытие окна → hide в tray (запись переживает, `recordProc`/`tee` module-level в main), настоящий выход — «Выйти»/Cmd+Q (`before-quit`-флаг). Dock остаётся. Иконка попиксельно не проверялась — первый запуск = smoke (внешний вид, template-tint, REC-тайтл, старт из tray при скрытом окне).

Минорки критика этой сессии — в TODO.md (секция 2026-07-06).

## Push-гейт из чужого cwd (важно для следующих сессий)

Сессия шла из `/Users/filanovskii/SupersetWorkspace` — PreToolUse-hook `auto-critic.sh` исполняется в cwd сессии, там нет `origin` → precheck fail-closed ДО чтения маркера (bypass-строка не помогает). Владелец разрешил обход: временный ref `git -C <session-cwd> update-ref refs/remotes/origin/main HEAD` → marker с `bypass: owner-accepted-risk` → push → `update-ref -d`. Правильный фикс — запускать сессию из каталога репо; harness-gap хука (не резолвит репо из команды) не чинился.

## Предыдущая сессия (2026-07-03, `main` был `75414d0`)

Одиннадцать чанков за день, каждый своей веткой через критик-гейт. Утро (см. git log): 4 минорки критика (`d8c33c8`+`554b4b1`), mix offset xcorr (`468ade2`), auto-«Я» из mic-дорожки (`385ae7d`), секция «Модели» в настройках (`c43c892`) + UX-правка кнопок «Проверить»/«Скачать недостающие» (`23437be`).

Вечер — вкладка Словарь + продиктованный бэклог владельца (митинг-заметка meeting-2026-07-03-123128):

- **📖 Словарь — 4-я вкладка** (`c43af24`): глоссарий уехал из карточки Запись в свой top-level таб; `DEFAULT_GLOSSARY` (48 IT-терминов) подставляется при пустом словаре (in-memory, паттерн authorName; пустой = «дай дефолты» — решение владельца «заполним распространёнными»). Дубликат списка в тесте — golden value, править оба.
- **Настройки-консолидация** (`72bb84f`): HF-токен, authorName и outDir («куда сохранять») уехали в settings overlay (секции «Личные данные», «Куда сохранять»). outDir авто-следует за vault (`<vault>/Meetings`) при создании vault, если не задан вручную (`outDirCustom`); ручной выбор всегда побеждает; без vault — прежний дефолт. Старые заметки не переносятся.
- **Батч-импорт + индикатор записи** (`6af8fd0`): multi-select файлов → последовательная очередь (renderer-side, procProc один слот; статусы ⏳/🔵/🟢/🔴/⏹; фейл элемента → продолжаем, cancel → стоп всего батча; re-pick заменяет очередь); reprocessHistory = очередь-из-1. Пульсирующая красная точка на кнопке 🎙 в topnav — видна с любой вкладки, все 3 сайта state.recording (start/stop/mic-error).
- **История-фиксы** (`439d25e`): сортировка по `stamp` (время записи; mtime телепортировал старые заметки наверх после rename спикеров), кап limit=200 снят (все заметки); календарь-фильтр был логически корректен — исправлены anchored-причины «не работает»: `color-scheme: dark` + `input[type=date]` в тему (пикеры были светлые); поиск словоформ — `ruStem` суффикс-стриппинг (проблема↔проблемы, миграция↔миграций; англ. термины не затронуты), без новых deps; «авто» удалён из языков записи (коэрция stored "auto"→"ru"), в фильтре истории «авто» остался для старых заметок.
- **PARA-UX** (`0022d5b`): спиннер на разбираемой строке при «разобрать все»; root cause стирания разобранных — renderParaInboxView перезапрашивал inbox при каждом входе → `paraInboxLoaded`-флаг (fetch один раз; сброс при vault create/reset); разобранные серые+disabled и живут до «Обновить»/перезапуска; кнопка «Обновить» (⟳, disabled мид-батч); ручное «Разложить» тоже серит (не удаляет); дерево Хранилища collapsed по умолчанию.
- **Сброс приложения** (`75414d0`): кнопка «Сбросить и настроить заново» (danger, секция «Сброс» в настройках) — confirm → ПИШЕТ свежий presets.json из example с `para.root=""` (НЕ unlink — критик-reject поймал воскрешение root из example-fallback; writeJsonAtomic) + saveToken(""), busy-guard по 4 процессам; заметки/записи/index.db не трогаются; после сброса init() + PARA re-render.

## Тесты

`npm test` = JS `node --test` (287/287) + PY pytest (238/238). Всё замокано — живой e2e (RAG, коррекция, auto-«Я», скачивание моделей, батч-импорт + row-retry, reset, suggest-стадия, tray, персист-очередь записей + запись-во-время-обработки) не гонялся; первый реальный запуск = smoke.

## Решения владельца (действуют)

- 2026-06-30: live-транскрипт не нужен; календарь-интеграция выкинута; live smoke пропущен; невалидная PARA-категория → error; reasoning_content в заметку — никогда.
- 2026-07-03 (митинг-заметка): шаблоны и языки остаются; «авто» из языков убрать; хранилище свёрнуто по умолчанию; пустой словарь = заполнить распространёнными терминами.

## Хвосты (TODO.md — источник правды)

- Осталось открытым (полный список TODO.md): VAD-clip auto-«Я» при nonzero delay (+интеграционный тест при калибровке); ASSOC-допущения model-download; ruStem на 1-3-буквенных запросах; renderRail O(n) без виртуализации; chat degraded-бейдж string-match; свежие минорки критиков (осиротевший `_glossary_prompt`, тихий catch PARA-inbox, re-enable не в finally, PARA reverse race, батч retry↔cancel краевые, обратный гейт download→запись — продуктовое решение).
- Калибровка HYPO-порогов auto-«Я» и xcorr по первому реальному прогону (лог пишет per-label mic_ratio/duration).

## Git / процесс

- Remote `ArtemiiF/MeetingRecorder` (private, solo). `main` = origin/main = `a499af7` (автообновлялка, PR #1). Тег `v1.0.0` = релиз с .dmg (перенесён в публичный репо, sha переписан). Фича-ветки спрюнены.
- УСТАРЕЛО (репо публичный, см. шапку): push в main агенту запрещён, только PR. Критик-гейт остаётся перед push ветки. Механика маркера: критик по `git diff origin/main...HEAD` → marker `printf 'verdict: approve\ndiff-sha256: %s\n'` где sha = `printf '%s' "$(git diff origin/main...HEAD)" | sha256sum` (именно `printf '%s'` — прямой pipe оставляет \n → mismatch) → push отдельной командой. Marker одноразовый, TTL 300 c. Marker и push НЕ объединять в одну команду (hook проверяет до выполнения).
- Agent-report'ы (`.claude/agent-reports/`) — untracked, в коммиты не включать.
- Фиксы предсуществующих поломок — отдельным чанком от фичи.

## Окружение

- macOS: `timeout` НЕТ (только `gtimeout`); pytest через `../venv/bin/python -m pytest tests/ -q`; venv: numpy 2.4.4, scipy 1.17.1. Bare `grep` в этой среде мангуется rtk-хуком — субагентам использовать `rtk proxy grep`.
- LM Studio `:1234`: reasoning-модель (max_tokens ≥1500-2500) + embedding-модель для вектора; без неё keyword-only + warn.
- Preflight-панель: LM Studio / разрешения / ffmpeg / модель / HF-токен / embedding. Секция «Модели»: статус кеша + докачка (MLX Whisper ~1.5 ГБ, Silero VAD, pyannote 3.1 ×3).
