# Blanc Contact Center — Changelog

> Лог изменений проекта.

---

## 2026-07-07 — SLOT-ENGINE-NEAREST-FALLBACK-001: Tier-2 «ближайший техник» когда в радиусе никого нет (orchestrate)

**Проблема (с реального звонка):** клиент в Weston MA 02493 — в зоне обслуживания (`checkServiceArea` → in-area), но голосовой помощник предложил дженерик-окна «утро сегодня/завтра/послезавтра» вместо реальных слотов движка. Sara отработала правильно: позвала `recommendSlots`, движок вернул `{fallback:true}`, она корректно упала на generic. Причина — движок отдал 0 рекомендаций: все 5 баз техников/их работы ≥11.8 мили от Weston, а гейт расстояния = 10 миль (дефолт `max_distance_miles`, у компании нет строки `slot_engine_settings`). Сервис-зона шире, чем радиус маршрутизации движка → приграничные ZIP молча теряли слоты.

**Решение (owner-approved, orchestrate 9-фаз):** двухтировый движок.
- **Tier-1 (без изменений):** обычный радиус (10 миль) — плотная маршрутизация. Байт-идентичный сегодняшнему коду (доказано: pre-change `engine.js` против baseline, 8/8 покрытых входов совпали).
- **Tier-2 (новое) — срабатывает ТОЛЬКО когда Tier-1 дал 0 слотов:** тот же цикл кандидатов на КЛОНЕ конфига с поднятыми потолками расстояния до **25 миль** + `allow_empty_day_candidates=true`; берёт ближайшего техника (min из «до базы»/«до ближайшей работы»), непересечение с его работами сохранено (overlap=0 не трогали), свободный техник — выезд от базы. Ранжирование «ближайший первым» даёт существующий скоринг.
- **Решения владельца:** потолок фолбэка 25 миль; свободный техник — от базы. Оба — фиксированные константы (без миграции, без нового company-setting).
- **Файлы:** `slot-engine/src/config.js` (+`fallback_max_distance_miles:25`), `slot-engine/src/engine.js` (`generateCandidates` extract + `deriveFallbackConfig` clone + two-pass), `backend/src/services/slotEngineSettingsService.js` (`buildConfigOverride` отдаёт тот же потолок — на проде география берётся отсюда). Sara/VAPI и `recommendSlots.js` НЕ трогали.
- **Проверка:** slot-engine `node --test` **52/52**; backend jest **238/238** (settings passthrough + agentSkills golden целы). Reviewer APPROVED — 8/8 адверсариальных проверок (Tier-1 byte-identity НЕ циклична; триггер только на пустом Tier-1; клон-не-мутация — load-bearing, т.к. `DEFAULT_CONFIG.geography` — общая ссылка; потолок 25 миль жёсткий: 24.9→спасён, 25.0→0; overlap/feasibility не ослаблены; golden-форма цела; собственный sabotage пойман). Негативный контроль зелёный. GOTCHA: в тест-доке «Weston centroid» был 9.54 мили (внутри гейта) — Tester заменил на измеренные 11.75/15.3/30.6 мили. **Master-ready, NOT deployed** (деплой owner-gated; прод-движок читает конфиг из образа → обычный деплой app).

## 2026-07-07 — NOTE-ZB-AUTHOR-FIX-001: автор не мог редактировать свою заметку на ZB-джобе

**Баг (прод):** техник (non-admin) оставляет заметку на ZB-джобе → сразу после добавления её можно редактировать, но при сохранении — ошибка, а после обновления страницы кнопка редактирования пропадает. «Автор тот же», но отредактировать нельзя.

**Причина:** заметка пишется в приложении с `created_by` = crm_users.id автора, затем **асинхронно синкается в Zenbooker**, который проставляет ей `zb_note_id`. Правило `canMutateNote` (`notesMutationService.js`) считало admin-only **любую** заметку с `zb_note_id` (`note.source === 'zenbooker' || note.zb_note_id`). Оно смешивало два случая: (а) заметки, **пришедшие ИЗ** Zenbooker (нет локального автора) — их правда должен трогать только админ; (б) заметки, **написанные у нас и вытолкнутые В** Zenbooker (есть `created_by`) — их автор должен продолжать редактировать. Отсюда асимметрия: до синка `zb_note_id` ещё нет → редактируется; синк проставил `zb_note_id` → PATCH 403 + кебаб пропал. На проде так залочены 35 заметок (`zb_note_id` + `created_by`); 4223 настоящих ZB-заметок (`zb_note_id`, без `created_by`) остаются admin-only.

- **Фикс** (`notesMutationService.canMutateNote` + клиентский фолбэк `NotesSection.tsx`): различаем происхождение по **локальному автору**, а не по одному `zb_note_id`. Admin-only теперь только если `source === 'zenbooker'` ИЛИ нет `created_by`. Заметка с `created_by` (написана в приложении) остаётся редактируемой автором даже с `zb_note_id`. `created_by` матчится по sub ИЛИ crm_users.id (NOTE-AUTHOR-FIX-001 сохранён). Данные не трогаем — фикс кодовый, ретроактивно разлочивает все 35.
- **Проверка:** прод-данные подтвердили (заметка Robert Perre на джобе #657239: `created_by=6d2af8ff` = его crm_users.id, `zb_note_id` проставлен; сам Robert — company_member). jest `notesAuthz`+`notesEditDelete` 18/18 (обновил тест, который кодировал старое поведение, + добавил регрессы на «автор + zb_note_id»); `npm run build` зелёный. Заметки-эдиты пока НЕ пушатся обратно в ZB (отдельный follow-up — расхождение приемлемо, автор может починить свою заметку).

## 2026-07-06 — ONWAY-DEDUPE-001: две кнопки «On the way» на карточке джоба (frontend-only)

**Баг (прод):** на карточке джоба в статусе `Submitted` (ZB `zb_status='scheduled'`) показывались **две** кнопки «On the way». `JobStatusTags.tsx` рисует её в двух независимых блоках: (1) ONWAY-001 primary CTA (градиентная) — при `blanc_status ∈ {Submitted, Rescheduled}` + право `messages.send`, открывает модалку с ETA-SMS клиенту; (2) старая JOB-ACTIONS-SLIM-001 (белый outline) — при `zb_status='scheduled'`, просто дёргает `onMarkEnroute` без SMS. Для Submitted-джоба оба условия истинны → дубль.

- **Фикс** (`JobStatusTags.tsx`): вторую (plain) кнопку гейтим `&& !showOnWayCta` — она подавляется, когда primary CTA уже предлагает «On the way» (то же действие), но **остаётся фолбэком**, когда CTA нет (нет права `messages.send`, либо `scheduled`-джоб, чей `blanc_status` не pre-visit). После фикса Submitted-джоб показывает один «On the way» (CTA с SMS) + «Start job». `npm run build` зелёный.

## 2026-07-06 — SCHEDULE-MOBILE-MAP-001 HOTFIX: пины пропадали при `geocoding_status='not_geocoded'` (frontend-only)

**Баг (прод):** у техника Robert на 9 июля список показывал 4 работы, а карта была пуста. Причина — фильтр карты требовал `geocoding_status === 'success'`, но реальные работы приходят из Zenbooker/импорта с валидными `lat/lng`, а `geocoding_status` у них остаётся `'not_geocoded'` (у лидов статус вообще всегда NULL). Все 4 работы Robert имели корректные координаты MA — их просто отбрасывал слишком строгий гейт.

- **Фикс 1 — гео-гейт** (`ScheduleJobsMap.tsx`): plottable-гейт теперь **только по наличию координат** — `jobs.filter(j => j.lat != null && j.lng != null)`, ровно как в десктопном `CustomTimeModal` (он никогда не смотрит `geocoding_status`, рисует любую работу с truthy lat/lng). Счётчик «N без адреса» теперь считает только работы без координат. Спека (Plottable set, S4) обновлена.

**Баг 2 (прод, тот же день):** совместная (multi-tech) работа Robert+Ali на карте показывалась как работа **Ali под №1**, хотя при просмотре Robert должна быть его остановкой **№3**. Причина — группировка по `assigned_techs[0]` (у совместной работы первый в массиве — Ali), игнорируя активный фильтр по технику.

- **Фикс 2 — группировка** (`ScheduleJobsMap.tsx` + `SchedulePage.tsx`): группировка теперь как в десктопном `buildTechGroups` — работа попадает в маршрут **каждого** назначенного техника (перебор всех `assigned_techs`, а не `[0]`), а активный фильтр (`selectedProviderIds = filters.providerIds`, проброшен пропом) ограничивает, **чьи** маршруты рисуются. При выбранном Robert совместная работа остаётся его остановкой (по времени — №3), пин цвета Robert, лишнего пина Ali нет. Цвет группы берётся из ключа самой группы (`id||name`), а не из `assigned_techs[0]` случайной работы. Счётчик «без адреса» — по distinct entity id (совместная работа может рисоваться на двух маршрутах). Спека (Grouping & numbering, S2b) обновлена.
- **Проверка:** прод-данные подтвердили оба диагноза — 4/4 работы Robert 9 июля `not_geocoded` c координатами (Баг 1); 13 июля 3 работы, из них совместная 1345 Robert+Ali с `assigned_techs[0]=Ali` (Баг 2). `npm run build` зелёный; трассировка по реальным данным даёт Canton №1 · W.Roxbury №2 · Saugus №3 в цвете Robert.

## 2026-07-06 — SCHEDULE-MOBILE-MAP-001: карта работ в мобильном Расписании (переключатель Список↔Карта), orchestrate, frontend-only

На десктопе цветные нумерованные пины по технику уже есть (в слот-пикере `CustomTimeModal`), а в мобильном Расписании карты не было — техник не видел свои работы на карте. Теперь в мобильном view «день» есть карта тех же работ, что в списке (выбранный день + выбранные техники). **Frontend-only, без бэка/миграций** (работы уже геокодированы — `lat/lng`, SCHED-ROUTE-001).

- **Переключатель:** одна icon-кнопка 44×44 слева от шестерёнки в `MobileScheduleBar` — в режиме списка иконка «карта» (aria «Show map»), в режиме карты иконка «список» (aria «Show list»); тап свапает фуллскрин-карту ↔ список. Состояние `mobileMapOpen` в `SchedulePage`, гейт `isMobile && mobileMapOpen`; на десктопе сбрасывается (карта/кнопка только мобильные, десктоп нетронут).
- **Карта** (`components/schedule/ScheduleJobsMap.tsx`, новый, презентационный, берёт `scheduledItems` пропом — уже day-scoped + отфильтрованы по технику): группирует по `assigned_techs[0].id`, сортирует по `start_at`, нумерует 1..N = порядок маршрута; пины `makePinSvg(num, getProviderColor(id||name).accent)` — цвет совпадает с левым бордюром тайлов; прямые `Polyline` между остановками одного техника (без платного Directions); `InfoWindow` по тапу; `fitBounds` + кламп зума ~14; без-гео работы (`geocoding_status!=='success'`) не выводятся, показывается счётчик «N без адреса»; фолбэки «Map unavailable» (нет ключа) и «No mapped jobs» (пусто); чистый unmount (маркеры/polyline/listeners).
- **Reuse:** `makePinSvg` вынесен из `CustomTimeModal` в `utils/mapPins.ts` byte-identical (единственная правка живого слот-пикера — поведение не изменилось); цвета через существующий `getProviderColor`, загрузка через `loadGoogleMaps`.
- **Проверка:** `npm run build` (`tsc -b` strict `noUnusedLocals` + vite) зелёный; orchestrate preview подтвердил — toggle рендерится рядом с фильтром и флипает иконку, `ScheduleJobsMap` монтируется без краша (пины с реальными гео-работами — owner проверяет живьём после деплоя; в dev нет геокоданных работ на сегодня + API-прокси). Reviewer (агент 08) воспроизвёл build + разобрал код (byte-identical extraction, cleanup без утечек, нет infinite-render, десктоп/слот-пикер нетронуты) → T1–T3 APPROVED. У фронта нет jest-харнесса для чистого UI — гейт = strict build + preview + review.


## 2026-07-06 — EMAIL-QUOTE-STRIP-001: входящие письма в ленте Pulse прячут процитированную историю треда (показывается только новый ответ), orchestrate-пайплайн

EMAIL-HTML-RENDER-001 включил HTML-рендер входящих писем в таймлайне — и всплыла его же остаточная OQ-HR-B: письма тащат **весь тред** (каждый ответ содержит процитированную историю переписки → пузырь в ленте очень длинный, новый текст тонет под цитатами). Теперь входящее письмо в пузыре таймлайна Pulse (`EmailListItem`, ветка render-матрицы **M1**) показывает **только новый ответ** — процитированный subtree треда (`On … wrote:` + `.gmail_quote`/`<blockquote>`/…) вырезается, так что HTML-путь M1 наконец совпадает с plain-text путями M2/M3 (те уже quote-stripped на сервере через `toTimelineBody`). Полный прогон через /orchestrate (агенты 01–08). **Только фронтенд. Без бэкенда. Без миграции. Без нового эндпоинта/роута/middleware. Без новой npm-зависимости** (встроенный `DOMParser`). **Без изменений DOMPurify/санитайзера.**

- **Новый чистый DOM-transform** `frontend/src/lib/stripEmailQuote.ts` — `stripEmailQuote(sanitizedHtml): string`, DOM-аналог `toTimelineBody`: парсит **уже-санитизированную** (post-DOMPurify) строку через `new DOMParser().parseFromString(html,'text/html')`, находит границу цитаты по **упорядоченной таблице детекторов клиентов** (1: `.gmail_quote` → 2: `blockquote[type="cite"]` → 3: Outlook `#appendonsend` / `border-top`-div сразу после `From:`/`Sent:`-хедер-рана → 4: `.yahoo_quoted` → 5: guarded top-level `<blockquote>` → 6: text-fallback `On … wrote:`), удаляет boundary-subtree **плюс** непосредственно-предшествующую attribution-строку, режет по **earliest/outermost** совпадению, ре-сериализует `document.body.innerHTML`. DOM-traversal — **никогда** string/regex-splicing tag-soup.
- **Bias UNDER-strip > OVER-strip** (потерять новый ответ — единственный по-настоящему вредный отказ): **over-strip guard** — mid-body `<blockquote>` с реальным контентом после и без attribution перед → **KEEP** (внутритекстовая цитата не теряется); **near-empty fallback** — если после strip остаётся <2 видимых символов И нет meaningful media (`<img>`/`<table>`/`<picture>`) → вернуть **FULL** input (пузырь **никогда не пустой**, image-only ответ не теряется); no-boundary → byte-identical passthrough.
- **Сохранность и устойчивость:** body-level `<style>`, стилящий kept-reply, **переживает** parse→serialize (не дропается/hoist/reorder); **fail-safe** — любой throw → вернуть input неизменным (никогда raw, никогда `''`, никогда не бросает наружу); **идемпотентность** `strip(strip(x)) === strip(x)`.
- **Opt-in seam** — `SafeEmailHtml` получил проп `stripQuotedHistory?: boolean` (default `false`), применяемый **после** `sanitizeEmailHtml(...)` **внутри** существующего sanitize-memo (dep-array расширен флагом → strip раз на сообщение на images-state, не per-scroll): таймлайн (`EmailListItem` M1) включает его **ON**, а `/email` workspace (`EmailMessageItem`) — **OFF** → рабочая почта показывает **полный** тред без изменений. Probe «Show images» перенаправлен на **stripped** (kept-reply) HTML, мемоизированный по `email.id`, не на raw.
- **Проверка:** headless-матрица `scripts/verify-email-quote-strip-001.js` (Node+jsdom, гоняет реальный `.ts` через порт с parity-ассертом) **37/0** — детекция по каждому клиенту + over-strip guard + near-empty + fail-safe + идемпотентность + sabotage negative-control + parity + image-probe; Reviewer (агент 08) воспроизвёл всё и адверсариально подтвердил **23/23** (транспилировал реальный `.ts` через esbuild). Verify поймал 2 дефекта (**S01**: ведущий `<style>` дропался; **A03**: attribution collapsed-wrap мисатрибутировалась) — оба пофикшены до аппрува → **APPROVED**.
- **Хвост:** **ещё НЕ задеплоено.** Deploy-window гейт = прод `tsc -b` build (`noUnusedLocals` строже) + Group-D ручная browser-проверка на prod-копии (`/pulse/timeline/2599` — only-new / workspace-full / all-quote-not-blank / probe-beacon / no-jank) = TASK-EQS-005, owner-consent-gated.

## 2026-07-06 — EMAIL-HTML-RENDER-001: входящие письма в ленте Pulse рендерятся как санитизированный HTML (кликабельные ссылки/кнопки/форматирование), orchestrate-пайплайн

Раньше тело входящего письма в таймлайне Pulse показывалось plain-текстом (`EmailListItem` явно комментировал *«Text-only — no HTML render (v1)»*) — Google Local Services / страховые письма с кнопками-ссылками и разметкой выглядели голым текстом, ссылки было не нажать. Теперь inbound-письмо рендерится **отформатированным санитизированным HTML** (ссылки, кнопки-как-ссылки, таблицы, стили автора), изолированным от остального приложения. Полный прогон через /orchestrate (агенты 01–08). **Без миграции** (тело `body_html` уже лежит в `email_messages` — прокидывается в timeline-item; ноль изменений схемы).

- **`SafeEmailHtml` (общая обёртка)** — host-`<div>` + **open Shadow DOM** (attach однажды) + инъекция 8-декларационного base-`<style>` в shadow: email-разметка стилится/изолируется в обе стороны (author-CSS письма не течёт в app, app-Tailwind не течёт в письмо), без `all:initial`-ресета (author-шрифты/цвета письма выигрывают). Memo по `(messageId ?? hash(html), allowImages)` — sanitize раз на сообщение на images-state, не на scroll/re-render.
- **Единый закалённый DOMPurify-конфиг** (`sanitizeEmailHtml.ts`, ЕДИНСТВЕННЫЙ на всё приложение): дефолты DOMPurify стрипают `<script>`/inline `on*`/`<iframe>`; сверх того — **`FORBID_TAGS`** на form-контролы (`<form>`/`<input>`/`<select>`/`<textarea>`/`<button>` — закрытие найденной P0, см. ниже), `afterSanitizeAttributes`-хук **форсит** `<a target="_blank" rel="noopener noreferrer">` (перезаписывает, не заполняет), **нуллит** `href`, матчащий `^(javascript|data):` (блок js:/data:-ссылок; `mailto:`/`tel:`/`http(s)` живут), remote+`cid:`-картинки блокируются по умолчанию (`src`→`data-blanc-src`, стрип `srcset`/inline-background) с per-email кнопкой **«Show images»**, `data:`-картинки разрешены, `<style>` сохраняется для shadow-scoping (`ADD_TAGS:['style']` + `FORCE_BODY`); **fail-safe → `''`** (любой throw → пустая строка, никогда raw HTML наружу, никогда не бросает).
- **Plain-text / outbound → `linkifyToHtml`** (`linkifyText.ts`, **без новой зависимости**): escape-FIRST (сущности `& < > " '`), затем безопасное оборачивание URL/`www.`/email→`mailto:`/phone→`tel:` в `<a target=_blank rel=noopener>`; `whitespace-pre-wrap` сохранён. Outbound-письма **никогда** не идут через sanitize (direction short-circuit); inbound без `body_html` или с fail-safe→`''` **проваливается** в linkified plain-text (таймлайн не крашится, raw HTML не рендерится).
- **Бэкенд (без миграции)** — `body_html` добавлен в explicit-SELECT `getTimelineEmailByContact` (`WHERE`/`ORDER BY` байт-в-байт, `body_text ILIKE`-поиск не тронут) и прокинут **RAW** (не quote-stripped, не санитизирован на сервере — санитизация только на клиенте) в timeline email-item (`pulse.js`) + в `toEmailItem` для SSE-parity. Response-envelope — superset сегодняшнего.
- **`/email` workspace — на тот же санитайзер** — `EmailMessageItem` перешёл на `SafeEmailHtml`, убран его **второй** inline-DOMPurify-конфиг (`grep DOMPurify.sanitize frontend/src` → теперь ровно ОДИН конфиг); `<pre>`-fallback + галерея вложений сохранены. Benign-письма без регрессии, hostile — строго безопаснее (forced link rel/target, remote-image блок, js:/data:-блок теперь и в workspace).
- **Найдена+закрыта P0:** DOMPurify-дефолты **НЕ** стрипают `<form>` — фишинговая форма («введите пароль») пережила бы санитизацию и отправила бы данные на чужой хост. Закрыто явным `FORBID_TAGS` на `<form>`+form-контролы (поймано верификацией до аппрува, не в проде).
- **Проверка:** headless XSS-матрица `scripts/verify-email-html-render-001.js` (Node+jsdom, реальный frontend-`dompurify` через CJS-порт конфига с char-identical parity-ассертом) **31/0** — hostile-HTML security + linkify escape-first + **sabotage negative-control** (pass-through-вариант ОБЯЗАН краснить H01/H02/H04/H06/H08/H10, иначе детектор мёртв) + config-parity; backend node-jest **5/5** (SELECT+scoping, RAW-mapping, `toEmailItem`-parity, `ILIKE` unchanged). Reviewer (агент 08) воспроизвёл всё + адверсариально подтвердил (fuzzing-обход санитайзера не прошёл) → **APPROVED**.
- **Хвост:** **ещё НЕ задеплоено.** Deploy-window гейт = прод `tsc -b` build (`noUnusedLocals` строже) + Group-D ручные browser-проверки на prod-копии (shadow-изоляция / no-beacon до «Show images» / inline-containment / no-jank на длинном таймлайне / `/email` parity — то, что headless-строка не докажет) = TASK-EHR-012, owner-consent-gated.
## 2026-07-06 — CONTACT-MERGE-001: объединение контактов с подтверждением — confirm-диалог merge/transfer при добавлении чужого телефона/почты (orchestrate-пайплайн)

Раньше добавление контакту адреса, принадлежащего другому контакту, обрабатывалось ТИХО (auto-merge/re-point CONTACT-EMAIL-MERGE-001), телефонная сторона не покрывалась вообще (два контакта тихо делили номер), а скалярный `{email}` из инлайн-редактора Pulse-панели вовсе миновал merge-машинерию — реальный прод-инцидент 2026-07-06 (пара 4175/4228, данные починены вручную). Теперь ни одно действие с чужим контактом не выполняется без явного подтверждения. **Без миграции** (mig 012/025/027/028/079/129/143/149 покрывают все lookup/re-point).

- **409 round-trip в существующем `PATCH /api/contacts/:id`** (нового route нет): при добавлении телефона/почты, занятых ДРУГИМ контактом той же компании, конфликт детектится **в начале tx** (до любого write; `FOR UPDATE` на target + каждого owner'а, lock-ordering по id) → ROLLBACK → **409 `CONTACT_ATTRIBUTE_CONFLICT`** с полным составом обоих контактов (имя + все телефоны + все почты, конфликты по owner'ам сгруппированы, server-computed `transfer_allowed`).
- **Двухколоночный `MergeContactsDialog`** (Контакт 1 = редактируемый / Контакт 2 = владелец, конфликтующий атрибут выделен): **«Merge contacts»** — полное объединение (survivor = редактируемый, его скаляры побеждают, ZB-привязка survivor'а сохраняется без вызовов ZB API; таймлайны/звонки/письма/лиды/задачи переезжают, телефоны дубля доезжают в свободные слоты, дубль удаляется последним); **«Transfer phone/email»** — перенос одного атрибута + его тредов (звонки только этого номера, письма этого адреса; SMS едут query-time по цифрам; primary-телефон донора → promotion secondary); **Cancel** — полный откат, НИЧЕГО не сохранено (round 1 не коммитил). Transfer скрыт, если донору не остаётся ни телефона, ни почты (FR-3) — тихого поглощения email-only авто-контактов больше нет.
- **Тихие D2a/D2b-мерджи CONTACT-EMAIL-MERGE-001 заменены** сентинелом `ContactConflictError` → 409 («no silent path left», даже для конфликта, родившегося внутри tx). Тихими остались только безопасные ветки: inbox-only D3, owner==target, орфанный `mergeOrphanTimelines`, фоновый ingestion (Gmail push, Mail Secretary, VAPI, lead-create).
- **Decision E — скалярный `{email}` обрабатывается server-side эквивалентно `emails[]`**: инлайн-редактор Pulse-панели (payload не менялся) теперь персистит `contact_emails`, проходит детекцию и линкует переписку — дыра 4175/4228 закрыта для ЛЮБОГО клиента route.
- **Обе поверхности** (`EditContactDialog` + Pulse-панель) через общий `useContactConflictFlow`: несколько конфликтов = последовательные диалоги по owner'ам, затем **ОДИН** retry со strict-echo `resolutions[]` (mismatch/stale → свежий 409, никогда устаревшее деструктивное действие; leftover-резолюции игнорируются — retry идемпотентен).
- **Верификация:** jest 90/90 (4 сьюта) + real-DB харнесс `scripts/verify-contact-merge-001.js` **19/19** (P0-гейты: FK-ловушки 3b/CASCADE, cancel byte-identical, cross-tenant ×5 ног, stale-echo, mid-tx rollback, silent-branches byte-for-byte; sabotage-контроль ×3 вкл. feature-stash + собственный sabotage ревьюера на fix-2). Харнесс нашёл **4 продуктовых бага, не ловимых jest-моками** (split phone-lookup под mig-149 BitmapOr; `uq_contacts_email`-коллизия → ранний scalar-sync owner'а; `enrichEmail` heal-insert; D3-линк через route) — все починены. Reviewer (агент 08) — **APPROVED**.
- **Хвост:** прод-деплой отложен (решение владельца); **перед деплоем обязателен I18 volumetric EXPLAIN на prod-copy** (mig-149 index / `idx_calls_timeline_id`, никаких новых Seq Scan).
- **Известные ограничения / флаги:** full-digit владелец выигрывает у last-10-legacy (следующий Save всплывёт следующего владельца); `contact_merged` эмитится post-COMMIT; **ФЛАГ:** `uq_contacts_email` в базовой схеме — ГЛОБАЛЬНЫЙ (кросс-тенантный) unique — проверить на prod-copy, кандидат на отдельную миграцию (НЕ в этой фиче).

## 2026-07-05 — CALLFLOW-BUSY-TO-AGENT-001: все диспетчеры офлайн/заняты → звонок идёт дальше по Flow на голосового помощника (orchestrate, data-only)

Раньше входящий в группу «Dispatch Team» при всех офлайн/занятых диспетчерах утыкался в voicemail-уведомление («Hello! Our team is currently assisting other customers…»). Разбор показал: это НЕ зашитая автоматика — fallback-ребро очереди (`queue.timeout queue.not_answered queue.failed`) в активном Flow компании указывало на вершину Voicemail, а runtime уже умеет мгновенно (без гудков) идти по ребру при `agents.length===0` (`availableAgentsForGroup` фильтрует и офлайн-presence, и занятых busy-identities). **Фикс = data-only правка графа Flow (`call_flows cf-bbd3689d`, формат редактора): продуктовый код НЕ менялся, деплой не нужен** (флоу перечитывается из БД на каждый звонок).

- **Дельта графа (4 изменения, идемпотентно):** добавлена выделенная vapi-вершина `n-vapi-bh-backup` «AI Backup» (config скопирован с существующей AI Greeting — та же Sara; переиспользование отклонено: рёбра принадлежат вершине, и Sara-fail днём улетал бы в after-hours voicemail); fallback-ребро очереди перенаправлено на неё (одно ребро покрывает все 3 случая по решению владельца: нет свободных — мгновенно; не взяли за 25с; dial-сбой); + hidden success-ребро (`vapi.completed`→Done) и видимое fallback-ребро «AI unavailable / failed» (`vapi.no_target vapi.failed vapi.timeout`→Voicemail БИЗНЕС-часов) — голосовая почта остаётся последним рубежом, но только после попытки Sara. After-hours ветка байт-в-байт нетронута. `answerOnBridge="true"` уже в renderVapiNode.
- **Инструменты:** `scripts/apply-callflow-busy-to-agent-001.js` — чистая функция `applyBusyToAgentTransform` (экспорт) + CLI (dry-run по умолчанию с diff и BEFORE-payload для отката; `--apply` = BEGIN→SELECT FOR UPDATE→P1–P6 префлайты→одно-строчный UPDATE→post-commit self-check; hardcoded ids …0001/cf-bbd3689d; exit 0/2/1); `scripts/verify-callflow-busy-to-agent-001.js` — real-DB харнесс (8 кейсов, hard-guard только-localhost).
- **Гарантии, проверенные кодом/тестами:** `ensureFlowForGroup`/callFlows-GET регенерят граф только при ПУСТОМ states → кастомный граф durable; все поля дельты в whitelist `reactFlowToGraph` → редактор сохраняет дельту при open+save; `collapseDuplicateVapiEdges` не сливает новую пару (разные цели); tenant-изоляция (одна строка WHERE id AND company_id, сентинелы нетронуты); при dial-action TwiML вершины Sara возвращается прямо в HTTP-ответ → бесшовно для звонящего.
- **Проверка:** jest G1 27/27 (байт-точная дельта, fixed-point, 8 refusal + sabotage) + G2 18/18 (runtime-путь на трансформированном графе, negative-контроль на старом графе) + real-DB G3 8/8 (dry-run read-only, apply, NOOP, сентинелы, editor-инварианты, durability против реального ensureFlowForGroup, runtime-spot, 2 sabotage) + регресс callflow-сьютов 28/28 (73/73 одним процессом). Reviewer (агент 08) воспроизвёл всё, адверсариально проверил прод-безопасность → **T1–T3 APPROVED, prod-apply SAFE**.
- **Прод-применение** (data-change, консент владельца в запросе): dry-run → диф 4 изменения + BEFORE-payload в лог → `--apply` → повторный прогон NOOP → editor-smoke. Откат = одно-строчный UPDATE BEFORE-строкой. Эффект — со следующего входящего звонка; in-flight звонки живут на своём снапшоте графа.

## 2026-07-05 — AGENT-SKILLS-002: identity take-latest + верификация L2→L1 + lead-aware booking (инкремент на 001, orchestrate)

Живые правки после тест-звонков владельца. Три вещи: (1) несколько контактов на один номер → Sara «тупила» (уходила в дизамбигуацию); (2) слишком много трения — на каждый существующий-клиентский скил спрашивала имя+ZIP; (3) клиента с лежащим ЛИДОМ (заявка в review / письмо от страховой, диспетчер не успел открыть) Sara не узнавала как «уже в системе» и рисковала создать дубль. **Без миграции** (leads уже держат hold-колонки, contacts — created_at).

- **Identity take-latest** (`identityResolver.js`): при >1 контакте на телефонном пути резолвим детерминированно — claim-pin → предпочтение по имени+ZIP → самый свежий (`created_at DESC`, id-tiebreak). `ambiguous` остаётся ТОЛЬКО на name-path (нет телефона). Всё company-scoped (cross-company twin → `new`), fail-closed. Конец «тупит».
- **Верификация L2→L1** (`registry.js` + 3 body-guarda): по решению владельца «узнали по телефону — уже достаточно, sensitive-инфо тут нет» — 5 скилов (getJobHistory/getEstimateSummary/getInvoiceSummary/reschedule/cancel) опущены L2→L1: опознанный (по телефону ИЛИ имя+ZIP) звонящий обслуживается БЕЗ повторного name+ZIP-подтверждения. **P0-инварианты целы:** company-изоляция, per-`contactId` ownership-пречек (только СВОИ джобы/лиды), retention на отмене, карты голосом — никогда, L0 всё ещё отказывается (L1 — пол, не L0), клиентский `verified:true` игнорируется (гейт перевыводит из БД). name+ZIP теперь — способ ОПОЗНАТЬ (masked/страховой), не гейт.
- **Lead-aware + `bookOnLead`** (новый L1-write скил + `leadsService.getOpenLeadsByContact` non-suppressing read): `getCustomerOverview`/`getJobStatus` теперь показывают открытый лид (`hasOpenLead`/`openLeadStatus`/`leadProposedWindow`) — клиент с заявкой узнаётся с реальным состоянием, не «работ нет». `bookOnLead` пишет выбранный слот как schedule-blocking HOLD на СУЩЕСТВУЮЩИЙ лид через `updateLead` (те же hold-колонки/`tzCombine`, что VAPI-SLOT-ENGINE; без `status` → без FSM-churn/badge; **никогда не дублирует** пока лид открыт; нет открытого → делегирует createLead ровно один раз). Диспетчер конвертит. `svc.book_on_lead` в MCP.
- **Sara-конфиг** (`lead-qualifier-v2.json`, 14→15 tools): существующий-клиент = phone-identify → приветствие по имени → обслуживание БЕЗ трения; новая секция «book on existing request» (подтвердить предложенное окно / recommendSlots → `bookOnLead`); страховой no-phone → имя+ZIP → найти лид → забукать. Retention/no-card/confirm-don't-disclose сохранены.
- **Проверка:** jest 256 (15 сьютов) + `scripts/verify-agent-skills-002.js` **10/10 на реальном Postgres** (identity take-latest, bookOnLead-hold-без-дубля, L1-релаксация-всё-ещё-изолирована, сюрфейс без утечек; sabotage-контроль на каждый P0) + golden 21/21. Verify поймал 2 продуктовых бага (BUG-1: 3 sensitive-read всё ещё требовали L2 в теле → релаксация была инертна; BUG-2: MCP рекламировал L2) — оба пофикшены. Reviewer (агент 08) воспроизвёл всё, адверсариально подтвердил отсутствие дыр в изоляции при L2→L1 → **APPROVED**.
- **Owner-accepted tradeoffs:** shared-phone → обслуживается самый свежий контакт (свои данные, своя компания — не чужие); финансовые сводки теперь L1 (обратимо двухстрочным откатом registry).

## 2026-07-05 — MAIL-MUTE-001: исключённый в Mail Secretary отправитель теперь глушит и EMAIL-сигнал в ленте Pulse (только email-канал; звонки/SMS не затронуты, orchestrate-пайплайн)

Раньше `from:`-правило в Mail Secretary только не плодило задачу по письму — сам email продолжал линковаться в тред контакта, поднимать контакт наверх и всплывать в ленте Pulse. Теперь исключённый отправитель (только `from:`-правила) дополнительно **перестаёт обновлять и показывать таймлайн контакта в Pulse** — строго по **email-каналу**: входящие звонки и SMS того же контакта по-прежнему всплывают и бампят строку. Существующий список `exclusion_rules` — единственный source of truth и единственный user-facing surface; **нового UI/поля/эндпоинта нет**, реверс = снять правило («выпало из следующего набора запроса»). Полный прогон через /orchestrate (агенты 01–08). **Без миграции** (param-passing поверх существующих таблиц).

- **`mailAgentService` (T1)** — два экспорта поверх 60s-кэша `getActiveState` (0 лишних DB-read на письмо, матчер `matchEmail` не форкается): `isSenderMuted(companyId, msg)` (from-only вердикт для ingestion-seam) и `getMutedSenderSet(companyId) → {emails, domains}` (литеральные не-негированные `from:`-токены для list-seam; regex/негация не проецируются в SQL-набор). Внутренний `fromOnlyRules` дропает subject/body/any/mixed-строки — ядро DECISION-B (subject/body-правила остаются task-only). Обе **fail-open** (любой throw → `false` / пустой набор).
- **Ingestion-seam (T2)** — `emailTimelineService.linkInboundMessage` получает ранний `return {skipped:'muted_sender'}` **после** outbound/draft-гардов и **до** `findEmailContact`, гейтед на `!opts.skipAgent`: from-muted входящее не линкуется, не флипает unread, не бампит Pulse, не шлёт SSE и **не авто-создаёт контакт** (muted first-time sender не материализует контакт).
- **List-seam (T3)** — `getUnifiedTimelinePage` получил опциональные `mutedEmails`/`mutedDomains` (default `[]`) + per-row `email_muted` и гейт `AND NOT email_muted` на **5 email-термах**; email-only muted-тред выпадает из списка и из `COUNT(*) OVER()`, phone+email-контакт теряет только email-вклад в ordering/unread. Пустой набор ⇒ `email_muted` всегда false ⇒ каждый существующий caller (LIST-PAGINATION-001) байт-в-байт не затронут. PULSE-PERF-001-дисциплина: ноль нового Seq Scan / per-row regex, `contact_emails` EXISTS по `contact_id`-индексу.
- **Route-стык (T4)** — `GET /api/calls/by-contact` фетчит `getMutedSenderSet(req.companyFilter.company_id)` и прокидывает набор в `getUnifiedTimelinePage`; единственный caller с не-пустым набором. Middleware/gate/response-envelope неизменны (fail-open → на ошибке пустой набор, route не 500).
- **Проверка (T5):** jest 87/87; `scripts/verify-mail-mute-001.js` **12/12 на реальном Postgres** — link-skip + no-auto-create (s1), **email-only drop-out + restore (P0)**, **channel-split ranking: звонок/SMS бампят, muted-email нет (P0)**, **cross-tenant isolation (P0)**, multi-email EXISTS-suppression, retained-but-hidden mid-thread, redelivery-идемпотентность, negative-control (feature off = строка present), sabotage-контроль, **EXPLAIN perf-parity ~0.3s на prod-copy (P0)**. Reviewer (агент 08) — **APPROVED**.
- **Хвост:** прод-деплой (owner-gated) — **ещё НЕ задеплоено**. T6 (опциональный P3 микро-копирайт в UI правил) намеренно не делался — фича полностью функциональна без него.

## 2026-07-06 — MOBILE-TECH-APP-002: tech-workflow parity мобильного приложения (финансы на джобе + Tasks + поиск) — orchestrate-пайплайн

Мобильное приложение техника (albusto-mobile, v1 M00–M11) догнало прод-веб по воркфлоу техника. Полный прогон /orchestrate (агенты 01–08, auto-run, 5 волн, 12 задач MT2-01..12, все Reviewer-APPROVED с sabotage-контролем). **Ноль изменений бэкенда** (AC-11: миграции остались на 155; контракт-аудит подтвердил — прод-изменения 149–155 мобильный API-контракт НЕ ломали; scheduleService.rescheduleItem расширялся контракто-сохранно).

- **Финансы на джобе (online-only):** секция Estimates & Invoices в JobDetail (`JobFinanceSection`), просмотр документа (`doc/[kind]/[id]`), editor-first создание/редактирование (`doc/editor` — POST только на первый Save, G4), Price Book picker (Category→Group→Item, группа = bulk-add, client-side фильтр групп — G9) + freeform-строки, отправка email/SMS (`SendDocumentSheet`, маппинг 409/422/402 → «ask the office» строго по status/code — G6, русская серверная строка не всплывает). Платёжных действий НЕТ (Tap-to-Pay = v1.5).
- **AC-3 стержень:** dirty-flag builder в `lib/documents` — untouched → PUT без ключа `items`, touched → полный массив, emptied → `[]` (семантика INVOICE-EDIT-ITEMS-001), payload проходит verbatim насквозь UI→lib→api (reference-identity тесты).
- **Tasks:** третий таб (бейдж `useTaskCount`, fail-silent), серверный scoping (приложение не шлёт owner-фильтров — TC-API-3 негативные ассерты), optimistic complete с revert и pre-flip partition (строка не прыгает между группами), композер с pinned-job из JobDetail или пикером своих джоб из SQLite-кэша (read-only).
- **Поиск:** модальный экран — ярус 1 мгновенный локальный по кэшу джобов, ярус 2 серверный `GET /api/jobs?search=` (дедуп String(id), latest-wins, debounce 400ms), ярус 3 контакты → tel:. JobDetail получил §5.5 online-fallback: cache-miss → `GET /api/jobs/:id` в state, БЕЗ записи в SQLite (TC-SEC-4: write-callers идентичны v1).
- **Фундамент:** `client.ts` теперь парсит вложенный error-envelope `{ok:false,error:{code,message}}` (G1, test-first: TC-CLI-1 падал на старом коде); `useOnlineQuery` (4-state, focus-refetch, latest-wins) + `NeedsConnection`; чистые либы documents/priceBook/tasks/search.
- **Пойманы пайплайном:** Tester W2 — реальный контракт-баг `discount_type:'pct'` vs бэкендовский `'fixed'|'percentage'` (400 на сохранении %-скидки; починен на wire-границе); Reviewer W4 — draft-wipe race (нестабилизированный pinnedJob стирал набранный текст задачи при каждом sync; useMemo-фикс).
- **Гейты:** jest 21 suites / 209 tests, tsc clean, expo prebuild clean ×2, static-греп TC-SEC-1/2/3/4 PASS, SCHEMA_VERSION=1. Артефакты: requirements/architecture/tasks + Docs/specs/MOBILE-TECH-APP-002-SPEC.md + Docs/test-cases/MOBILE-TECH-APP-002.md. Коммиты albusto-mobile: 303a17d → a9edebf → 90d1229 → cfdb6d9 (master, не задеплоено; TestFlight/manual suite G — owner-gated).

---

## 2026-07-04 — AGENT-SKILLS-001: agent-agnostic skill-слой CRM + existing-customer voice-скилы (P1–P3) + service-MCP (orchestrate-пайплайн)

~50% входящих звонков — существующие клиенты (статус, перенос, отмена, «сколько по эстимейту»), а Sara гнала их по new-lead потоку. Теперь у CRM есть **провайдер-нейтральный слой скилов**: голосового агента можно заменить на любого другого, и всё продолжит работать, потому что **вся логика скилов живёт внутри приложения**, а агенты (VAPI/Sara, MCP-клиенты, будущие) — тонкие адаптеры. Полный прогон через /orchestrate (агенты 01–08, auto-run). **Без миграции** (read/route-слой + 2 guarded-write по существующим таблицам).

- **Skill-слой** `backend/src/services/agentSkills/`: `index.runSkill(name, companyId, ctx, input)` — единая точка входа (resolve registry → серверный `verificationGate` → `skill.run` → try/catch→SAFE_FALLBACK, никогда не течёт `err.message`/SQL/PII); `registry.js` = манифест 14 скилов (9 новых + 5 релоцированных live-tools) с ленивым require; `verificationGate.js` = ЕДИНСТВЕННОЕ серверное место L0/L1/L2 (перевыводит уровень из БД каждый вызов, клиентский `verified:true` физически игнорируется — AC-8; L2 = телефон-матч + подтверждённое имя ≥2 токенов + ZIP/улица); `identityResolver.js` резолвит через leads+contacts+jobs (мост «lead=null когда есть джоб»); `statusMap.js` по реальным `BLANC_STATUSES` (нет ключа `Scheduled`).
- **9 скилов:** `identifyCaller` (L0, ветвит разговор), `getCustomerOverview`/`getJobStatus`/`getAppointments` (L1 read, speech-safe, окна из `listJobs`), `getJobHistory`/`getEstimateSummary`/`getInvoiceSummary` (L2 sensitive-read, redaction внутренних/тех-нот, itemCount без line-items, **никаких карт голосом** — только защищённая ссылка/человек), `rescheduleAppointment`/`cancelAppointment` (L2 write, ownership-пречек `getJobById(jobId, companyId)`+contact до мутации, audit-нота «AI Phone» + domain-event).
- **Адаптер REST (тонкий):** `vapi-tools.js` 396→142 строк (−64%), нулевая бизнес-логика — генерик-диспатч `runSkill(name, DEFAULT_COMPANY_ID, …)`, экспонирует все 14 скилов; убран старый leak `{error: err.message}` (SAFE_FALLBACK). 5 legacy-tools остались **байт-в-байт** (golden-снимок).
- **Адаптер MCP (новый, AR-3):** параллельный `svc.*`-триплет (`agentSkillsMcp{Registry,Executor,ProtocolService,PublicAuth}` + routes + stdio, serverInfo `albusto-service-crm-mcp`), **переиспользует** `crmMcpSchemaValidator`/`crmMcpResponse` sales-MCP КАК ЕСТЬ и диспатчит в тот же `runSkill`; sales-стек не тронут. Tenant только из контекста (клиентский `company_id` игнорируется); OUTER framework-гейт (write-permission + confirmation) композится с INNER L2; public-writes off по умолчанию; ошибки санитизированы.
- **ZB write-through (AR-4):** закрыт пробел — `scheduleService.rescheduleItem` теперь пушит `zenbookerClient.rescheduleJob` (job-only, linked, non-canceled), локальная запись авторитетна, ZB-исход сигналится (`zb:{linked,pushed,skipped}` + throw-409 при сбое = blocking-with-recovery, реконсиляция от мастера). Контракт для диспетчерского UI-переноса сохранён (404/400 как были, `zb`-ключ аддитивен). Отмена уже пушила в ZB.
- **Дефолты (owner может переопределить):** отмена бесплатна до визита + причина; ссылку на estimate/invoice шлём каналом SEND-DOC-001; existing-customer звонок только апдейтит джоб (НЕ плодит Review-лид).
- **Проверка:** jest 174/174 (9 сьютов: gate/identity/reads/sensitive/writes/MCP/ZB-seam/vapi-tools/golden) + `scripts/verify-agent-skills-001.js` **18/18 на реальном Postgres** (6 P0-гейтов G1–G6 + sabotage-контроль на каждый, подтверждён вне харнесса правкой продукта) + golden `--check` 21/21 + sales-crmMcp 54/54 (нетронут). Reviewer (агент 08) воспроизвёл всё, адверсариальный зонд гейта (фейковые verified/L2 → все бросают verification_required) → **T1–T10 APPROVED, ноль P0-дыр**.
- **Owner-gated хвост:** прод-деплой; чтобы Sara реально ИСПОЛЬЗОВАЛА новые скилы — обновить её конфиг ассистента `30e85a87` (декларации 9 новых tool'ов + prompt-ветвление existing-customer) и живой PATCH. Скилы вызываемы через vapi-tools/MCP сразу после деплоя, но Sara начнёт их звать только после апдейта её конфига.


## 2026-07-04 — VAPI-SLOT-ENGINE-001: Sara подбирает engine-ranked окна на звонке; выбор звонящего становится schedule-blocking hold'ом на лиде (orchestrate-пайплайн)

Раньше голосовой агент Sara при записи просто предлагал «утро» — реальный подбор времени не работал. Теперь Sara на звонке зовёт существующий slot-engine (SLOT-ENGINE-001), оффёрит звонящему 2–3 ранжированных ТОЧНЫХ окна, а при выборе — созданный лид получает `lead_date_time`/`lead_end_date_time` + координаты, т.е. **держит слот в расписании** (виден дисптечеру, занимает время у движка) пока дисп. не конвертирует лид→джоб (слот забирает джоб) или не потеряет/отменит лид (слот освобождается). НЕ создаёт Zenbooker-джоб. Полный прогон через skill /orchestrate (агенты 01–08, auto-run); артефакты в `docs/specs/`, `docs/test-cases/`, requirements/architecture/tasks. **Без миграции** (схема лидов из mig 004/023 уже держит TIMESTAMPTZ+NUMERIC coords; `FIELD_MAP` мапит все четыре; `idx_leads_lead_date_time` покрывает range/order).

- **Backend занятость (T1)** — `slotEngineService.buildScheduledJobs` расширен held-lead occupancy sub-read'ом: открытые лиды с `lead_date_time`+координатами в окне эмитятся движку как area-occupancy (`{id:'lead:<id>', assigned_technicians:[]}`, техи-агностик), чтобы то же окно не переоффёрилось. Фильтр `LOWER(status) NOT IN ('converted','lost','spam')` + `company_id=$1` + coords/date-window guards; jobs-loop не тронут. **Case-fix (несущий):** `scheduleQueries.js:141` leads-ветка UNION → `LOWER(l.status)` (совпадает с jobs-веткой `LOWER(j.blanc_status)`) — без него капсовые `Converted`/`Lost` НЕ покидали бы occupancy+Schedule и слот бы не освобождался. Сегодня 0 затронутых строк (никто не писал `lead_date_time` до этой фичи) — фикс латентный, но фича его триггерит.
- **Backend VAPI-tool (T2)** — новый gated safe-fail tool `recommendSlots` (`vapi-tools.js`): зовёт `slotEngineService.getRecommendations({new_job})` НАПРЯМУЮ, маппит recs → ≤3 keyed окна (`date|start|end`), deeper-mode через `excludeSlots`/`daysAhead`, label «Wed Jul 8, 10:00–13:00», location lat/lng→address→zip. **Весь хендлер safe-fail:** app-не-подключён / движок недоступен / пусто / любой throw → `{available:false,slots:[],fallback:true}`, HTTP 200 — **никогда не роняет живой звонок 500-кой**. `handleCreateLead` расширен персистом слота (`chosenSlot`+lat/lng → `LeadDateTime`/`LeadEndDateTime`/`Latitude`/`Longitude` через `tzCombine`), back-compat байт-в-байт без `chosenSlot`, malformed `chosenSlot` трактуется как absent (никогда не блокирует создание лида). Company hardwired `DEFAULT_COMPANY_ID`; endpoint за `x-vapi-secret` fail-closed.
- **Repo assistant (T3)** — `voice-agent/assistants/lead-qualifier-v2.json`: `recommendSlots` шестым tool'ом (тот же `function`/`server` shape, 8 параметров) + `createLead` получил `chosenSlot`-параметр; scheduling-prompt переписан (steps 6+9): звать `recommendSlots` после zip/address, оффёрить top 2–3, «none suit» → re-call с `excludeSlots`/`daysAhead`, on pick → `chosenSlot` в `createLead`, graceful fallback на `available:false`. **Правит ТОЛЬКО repo-JSON — live PATCH ассистента `30e85a87` НЕ выполнялся (owner-gated prod-шаг).**
- **DRY-cleanup** — `tzCombine`/`tzOffsetMinutes` были третьей копией DST-движка; спека ошибочно утверждала «в бэкенде combine нет». `tzCombine` сведён к тонкому адаптеру над каноническим `backend/src/utils/companyTime.js:dateInTZ` (единый источник offset-математики, сам зеркалящий frontend `companyTime.ts`); дублированный `tzOffsetMinutes` + его тест-хук удалены. Поведение байт-в-байт (перепроверено).
- **Проверка (T4)** — jest 93/93 (3 сьюта: occupancy/tz 11 + recommendSlots 14 + slot-persist 5 + регрессия proxy 23 + createLead-back-compat); `scripts/verify-vapi-slot-engine-001.js` 8/8 на реальной БД: P0-гейты VSE-INT-01 (held-lead блокирует, capsed Converted/Lost/geo-less/out-of-window исключены), VSE-INT-05 (persist+render), VSE-U-01 (tz-DST), VSE-INT-07/08 (convert+markLost реально ОСВОБОЖДАЮТ слот — доказывает case-fix), EXPLAIN (`idx_leads_lead_date_time`, join-free), sabotage-контроль. Reviewer (агент 08) воспроизвёл все сьюты + независимый mutation-тест (откат `LOWER` → VSE-INT-01/07/08 краснеют) → **T1–T4 APPROVED**.
- **Owner-gated хвост:** живой PATCH ассистента VAPI `30e85a87` (вставить `recommendSlots` + новый prompt, подставить `VAPI_TOOLS_SECRET` вместо плейсхолдера) и прод-деплой — оба ждут явного согласия владельца.


## 2026-07-04 — EMAIL-LEAD-ORIGIN-001: email-only таймлайны в Pulse — карточка контакта + лид из письма (orchestrate-пайплайн)

Раньше email-only таймлайн (контакт без телефона — напр. авто-контакт из письма Google Local Services) в Pulse показывал только письмо: карточка контакта/лида была жёстко под телефонным гейтом, а лид рождался только от телефона. Теперь email-only контакт виден как полноценная карточка, и из него можно создать лид (телефон опционален). Полный прогон через /orchestrate (агенты 01–08, auto-run); артефакты в Docs/. Без миграции (схема лидов уже держит phone NULL + email + contact_id, миграции 004/023).

- **Backend** — `leadsService.getLeadByContact(contactId, companyId)` (байт-в-байт клон getLeadByPhone: тот же team-agg, фильтр «контакт с джобом → null», status NOT IN Lost/Converted, индекс idx_leads_contact_id); роут `GET /api/leads/by-contact/:contactId` (leads.view|pulse.view, над /:uuid, company-scoped). POST /api/leads: валидация релаксирована до phone(≥5) ИЛИ email ИЛИ selected_contact_id (resolveContact уже умеет безтелефонность; createLead NULL-омитит phone); guard от зануления телефона существующего контакта в update_contact-режиме. Phone-origin путь байт-в-байт.
- **Frontend** — useLeadByContact хук + leadsApi; usePulsePage резолвит `lead = override || byPhone || byContact`; гейт карточки PulsePage:361 → `(p.phone || p.contact?.id)` (email-only больше не подавляется); PulseContactPanel null-guard первичного телефона + **новая кнопка «+ Create Lead»** (шапка + пустое состояние), открывающая визард в Dialog-панели; CreateLeadJobWizard phone-опционален, email/contactId-origin, «Create Lead & Job» скрыт при отсутствии телефона (ZB-джоб требует телефон → email-origin = ТОЛЬКО лид).
- **FR-B4 (сигнал лида в юнифайд-списке) ОТЛОЖЕН** — горячий getUnifiedTimelinePage не тронут (PULSE-PERF-001): email-origin лид и так виден через email-сигнал в сайдбаре, на странице Leads и в карточке через by-contact lookup.
- **GAP-FIX (T5):** трёх-состояние карточки рендерит визард только при отсутствии контакта — для email-only контакта (контакт ЕСТЬ) шёл в PulseContactPanel, где кнопки создания лида не было → Part B был бы недостижим. Пойман оркестратором при само-проверке ДО верификации; закрыт кнопкой в панели.
- **Проверка** — jest 30/30 (leadByContact + регрессия leadsNewCount/convert); scripts/verify-email-lead-origin-001.js 12/12 на реальной БД: P0 безтелефонный create (phone NULL, без фейка), P0 cross-tenant, lookup-фильтры (job/Lost/newest), phone-путь байт-в-байт, EXPLAIN idx_leads_contact_id, sabotage control. Reviewer (агент 08) воспроизвёл всё → T1–T5 APPROVED. Замечание на будущее: визард Step1→2 гейтится ZIP сервис-территории (как и для phone-origin) — «email+имя без ZIP» не доходит до submit через UI (бэкенд создаёт без ZIP).


## 2026-07-04 — CONTACT-EMAIL-MERGE-001: добавление имейла в контакт сливает его почтовый таймлайн (orchestrate-пайплайн)

Аналог телефонного слияния для почты. Раньше добавление телефона в контакт перецепляло орфан-таймлайны и звонки (mergeOrphanTimelines), а для email такого не было — и PATCH-роут даже не писал contact_emails. Теперь при добавлении имейла в контакт его почтовая переписка сливается в таймлайн этого контакта. Полный прогон через skill /orchestrate (агенты 01–08, auto-run); артефакты в Docs/specs/CONTACT-EMAIL-MERGE-001.md, Docs/test-cases/ (34 кейса), requirements/architecture/tasks.

- **Новый `contactEmailMergeService`** — `resolveAddedEmail` (4-ветвевой диспатч): inbox-only письма (contact_id NULL) линкуются на таймлайн контакта; адрес принадлежит ОТДЕЛЬНОМУ email-only авто-контакту (нет телефона/джобов/лидов/… — проверка по 14 identity-таблицам) → ПОЛНОЕ слияние (перецепка писем/задач/таймлайна) + удаление пустого контакта; принадлежит контакту СО своими данными → только перецепка писем, контакт сохраняется; уже наш → no-op. FK-порядок строгий (открытые задачи re-home с орфан-таймлайна ДО его удаления — ловушка tasks.thread_id CASCADE; контакт удаляется последним). Cross-tenant guard (survivor.company_id === dup === companyId) стреляет до любой мутации.
- **PATCH /api/contacts/:id** — принимает emails[] (мульти-имейл), персистит через enrichEmail, держит scalar contacts.email = primary; каждый НОВЫЙ адрес прогоняется через resolveAddedEmail в ОДНОЙ транзакции (contact+emails+merge атомарны — сбой откатывает всё); FR-8 удаление имейла не деструктивно (снимает contact_emails, историю не отвязывает). Фоновые фазы (phone-merge, leads-cascade, ZB) — после commit, без изменений.
- **Frontend** — мульти-email список в EditContactDialog (primary неудаляем, «Set as primary», «+ Add email» как «+ Secondary Phone»); типы contactsApi/contact.ts.
- **Без миграции** (mig 025 contact_emails + 129/079 + mig-143 индекс покрывают всё). Reexport enrichEmail/getAdditionalEmails + client-параметры на findOrCreateTimelineByContact/findEmailContact/linkMessageToContact для атомарности.
- **Проверка** — jest 29/29 + 46/46 регрессия; scripts/verify-contact-email-merge-001.js 12/12 на реальной БД: P0 full-merge (dup удалён, 0 висячих FK, задача re-home а не CASCADE-удалена), P0 cross-tenant (вкл. leads-покрытие), идемпотентность, sabotage-control. Reviewer (агент 08) воспроизвёл всё → NEEDS FIXES только по одному: leads был мисклассифицирован как без company_id (миграция 012 = динамический ALTER-цикл, разведка пропустила) → фикс применён, плечи leads company-scoped.


## 2026-07-04 — TASKS-COUNT-BADGE-001: счётчик открытых задач на навигации Tasks (orchestrate-пайплайн)

Над пунктом «Tasks» в навигации теперь бейдж с числом ОТКРЫТЫХ задач, видимых текущему пользователю — ровно то, что он видит в /tasks с фильтром Only Open (менеджер с tasks.manage видит все задачи компании, остальные — только свои). Полный аналог бейджа Leads. Прогон через skill /orchestrate (агенты 01–08, auto-run); артефакты в Docs/specs/TASKS-COUNT-BADGE-001.md, Docs/test-cases/ (41 кейс), Docs/requirements.md, Docs/architecture.md.

- **Backend** — `tasksQueries`: общий предикат вынесен в `buildTaskListFilters(companyId, filters)`, который вызывают И `listTasks`, И новый `countTasks` (COUNT(*) без SELECT_TASK-джойнов) → WHERE байт-в-байт идентичен, счётчик не разъедется со списком. Роут `GET /api/tasks/count` (tasks.view, envelope {ok,data:{count}}) смонтирован ВЫШЕ `/:id`, зеркалит ветку видимости `GET /` (manager → все; иначе scopeOwnerId).
- **Realtime** — новый `tasksService.emitTaskChange(companyId)` шлёт PII-free событие `task.changed` с payload РОВНО `{company_id}` (клиент лишь рефетчит серверно-скоупленный счёт — не считает сам); точки эмита: POST create, PATCH (только при смене status|owner_user_id), DELETE, и INSERT-ветка `createTask` с гардом provenance IN ('user','agent') — system/automation НЕ шлют. Запись в eventCatalog.
- **Frontend** — `AppLayout.openTasksCount` + `fetchOpenTasksCount` (mount/route-change/60s poll), клон бейджа Leads (десктоп+мобилка, pulse-unread-badge, 9+, скрыт при 0); `task.changed` зарегистрирован в ОБОИХ SSE-списках (useRealtimeEvents.genericEventTypes + sseManager.namedEvents).
- **Проверка** — jest 60/60 (tasksCount+tasksEmit+routes/tasks; drift-guard байт-в-байт); `scripts/verify-tasks-count-001.js` — 17/17 PASS на реальной БД: load-bearing инвариант `countTasks === listTasks().length` через дельта-цепочку, кросс-тенант изоляция (P0), саботаж-контроль. Reviewer (агент 08) независимо воспроизвёл всё → T1–T4 APPROVED. Без миграции.


## 2026-07-03 — EMAIL-OUTBOUND-001: исходящие-первые email-треды видимы в Pulse (orchestrate-пайплайн)

Диспетчер пишет клиенту первым (email-only лид) — тред теперь всплывает в юнифайд-листе Pulse с иконкой исходящего письма (MailCheck), сортируется по времени отправки, НЕ помечается непрочитанным. Ранее CTE списка цеплялся только за входящие (`from_email`), и такие треды были невидимы. Полный прогон через skill `/orchestrate` (агенты 01–08, auto-run): артефакты в `Docs/requirements.md`, `Docs/architecture.md`, `Docs/specs/EMAIL-OUTBOUND-001.md`, `Docs/test-cases/EMAIL-OUTBOUND-001.md`, `Docs/tasks.md`.

- **`timelinesQueries.getUnifiedTimelinePage`** — CTE `email_by_contact` = двухплечевой `UNION ALL`: плечо 1 (входящие, текст-матч через `contact_emails`) байт-в-байт как раньше (индекс mig 143 сохранён); плечо 2 (исходящие) читает ТОЛЬКО персистентную линковку mig 129 (`contact_id`/`on_timeline`), без `to_recipients_json` в горячем запросе; `DISTINCT ON (contact_id)` с новым детерминирующим tie-break `email_thread_id DESC`. Скоупинг `$1` в обоих плечах.
- **Миграция 155** — идемпотентный logged-бэкфилл исторических исходящих (contact_id IS NULL): TO-only матчинг получателей (`jsonb WITH ORDINALITY`, first-match-wins, зеркало `findEmailContact`), драфт-гард по `message_id_header`, find-or-create таймлайна (reuse → усыновление орфана с перенацеливанием звонков → INSERT с partial-index арбитром `ON CONFLICT (contact_id) WHERE contact_id IS NOT NULL`), финальный re-home задач по образцу mig 144; `unread_count` не трогает; NOTICE-счётчики; повторный прогон = нули.
- **Тесты** — jest 34/34 (`listPaginationByContact`, +9 новых SQL-shape кейсов, замороженные ассерты нетронуты); интеграционный харнесс `scripts/verify-email-outbound-001.js` — 24/24 PASS на реальной БД (S1–S8 + 9 edge + SEC01/02 кросс-тенант) с саботаж-контролем; EXPLAIN-гейт: оба плеча на своих индексах (mig 143 / mig 129), спекулятивный индекс mig 156 не понадобился.
- **Reviewer (агент 08)**: T1–T4 APPROVED (независимо воспроизвёл jest/харнесс/EXPLAIN). Прод-половины перф-гейта (P01/P02/P04 на прод-копии) — в окно деплоя.
- ~~Флаг: poll-реконсайлер не запланирован~~ — **флаг оказался ложным** (проверено 2026-07-04): планировщик живёт в `src/server.js` (EMAIL-TIMELINE-001 TASK-ET-4, `runTimelineLinkPoll`, тик 5 мин, без гейтов) и дренирует нелинкованные входящие И исходящие; подтверждено прод-логами. Архитектор греп-ил только `backend/src` и не увидел runtime shell.


## 2026-07-03 — MOBILE-TECH-APP-001 Phase 0: бэкенд-пререквизиты нативного приложения ЗАДЕПЛОЕНЫ В ПРОД

Backend-фундамент нативного iOS-приложения для техников (репо `albusto-mobile`, вне этого репо) задеплоен на прод (Vultr, `master c8943da`). Аддитивно, provider-scoped; Boston Masters (seed `…0001`) не затронут. Приложение по дефолту смотрит в прод → живой вход + синк разблокированы. Статус приложения и дальнейшие шаги — `albusto-mobile/STATUS.md`.

- **`GET /api/sync/jobs`** — provider-scoped delta-синк (ядро чтения приложения): forward-курсор `(updated_at,id)`, `changed/unassigned/tombstones`, `scope_empty`; скоуп `company_id` + `crm_users.id` через `@>`. Новый `backend/src/db/syncQueries.js` в существующем `routes/sync.js`.
- **`POST/DELETE /api/devices`** — реестр APNs device-токенов (own-only, cross-tenant scoped, 409 `NO_CRM_USER`); `pushService.sendToUser` (APNs http2 + ES256, fail-soft без `.p8`-env). Плюс Tap-to-Pay payment-intent роут (409 `NOT_READY` до онбординга Stripe Terminal).
- **Миграции 150** (`job_tombstones`) **+ 151** (`device_tokens`) — применены к проду (`CREATE TABLE IF NOT EXISTS`, verified). Перенумерованы с 149/150 (master уже занял 149 под PULSE-PERF `contacts_phone_digits`).
- **Keycloak `crm-mobile`** — публичный PKCE S256 клиент (realm `crm-prod`, redirect `albusto://auth`, realm_roles + audience мапперы), создан вживую через `kcadm` (не переимпортом realm). Authorize отдаёт форму логина (200).
- **Верификация.** jest Phase 0 **73/73**; эндпоинты 401 без токена; **синк-запрос прогнан против РЕАЛЬНЫХ прод-данных** (read-only psql — то, что мокнутый jest не ловит): у топ-провайдера 277 назначенных работ → начальный синк **113**, изоляция тенанта (провайдер в 1 компании), forward-пагинация 113→112, `scope_empty`=0, read-path вложений чист. Приложение: standalone Release-билд рендерит экран входа против прода; встроенный конфиг = прод (без dev-утечек). **НЕ проверено: визуальный клик-through ПОСЛЕ входа** (нужен пароль техника в форму — граница, бот не логинится). `⚑ Откат:` бэкап `dumps/predeploy_20260703_063013.sql`, образ `31a0ba7906b9`, `rollback_150/151`.

---

## 2026-07-02 — ONBTEL-001: онбординг новой компании → Marketplace «Telephony — Twilio» → фиксы изоляции Twilio

Зонтичная фича из трёх частей (полный 9-агентный оркестрационный прогон: требования → архитектура → спека → тест-кейсы → план из 14 задач → реализация → верификация). Продукт в UI — **Albusto**. `src/server.js` не менялся. Boston Masters (seed `…0001`) — поведение байт-в-байт. **НЕ задеплоено** (по подтверждению владельца).

- **Часть A — онбординг-чеклист на `/pulse`.** Первый пользователь новой компании (`tenant_admin`) видит полноширинную карточку-чеклист В ПОТОКЕ страницы (не оверлей; сдвигает контент вниз) с единственным пока пунктом «Connect telephony» → ведёт в Marketplace-визард. Статус пункта **derived** («у компании ≥1 купленный номер»), не хранится; один write-once `completed_at` в `companies.settings` JSONB (новой миграции НЕТ). Виден только `tenant_admin` (inline `role_key`-гейт на бэке + `isTenantAdmin()` на фронте); collapse в localStorage; dismiss нет by construction. Новый `GET /api/onboarding/checklist` (route-level `requireCompanyAccess` + tenant_admin), `onboardingChecklistService` (data-driven каталог), `OnboardingChecklistCard` + `useOnboardingChecklist`.
- **Часть B — Marketplace-приложение «Telephony — Twilio».** Подключение телефонии переехало из прямого `/settings/telephony` в Marketplace: seed-плитка (mig 145, `provisioning_mode='none'`), **derived-connected overlay** из `company_telephony` (install-строка НЕ создаётся никогда — канон google-email; subaccount SID наружу не отдаётся; `installApp` → 409 `DERIVED_CONNECTION_APP` для derived-приложений). Трёхшаговый Connect-визард `/settings/integrations/telephony-twilio` (шаг деривится из серверного состояния, устойчив к перезаходу): (1) субаккаунт [reuse `POST /connect`], (2) тариф — **новый план Pay-as-you-go** ($0/мес, 0 включённых минут, $0.04/мин звонки, $0.03/SMS, 1 номер — mig 146; активируется через новую ветку `billingService.subscribe` для планов ≤$0 БЕЗ Stripe) ИЛИ пакет starter/pro/huge [существующий Stripe checkout + `return_path` с path-only-валидацией], (3) поиск/покупка номера [reuse search/buy] с upsell на 422 `NUMBER_LIMIT`. Settings→Telephony остаётся управлением подключённой телефонией; неподключённая компания редиректится в визард (`TelephonyLayout`), локальный connect в `PhoneNumbersPage` убран. PAYG-списания идут существующим `overageScheduler`/wallet-конвейером — ноль новых биллинг-механик.
- **Часть C — 5 фиксов изоляции Twilio** (аудит выявил 2 критичных + 3 средних). **C1:** входящий звонок на неизвестную/бесхозную компанию → `<Reject/>` + структурный лог `inbound_call.rejected` (был generic voicemail без company-контекста); master AccountSid всегда → DEFAULT (Boston Masters не может быть отклонён даже при отказе БД). **C2:** `phone_number_settings.company_id` → NOT NULL + backfill (mig 147). **C2b:** master-sync в `phoneSettings.js` биндит DEFAULT (смежный лик — чужой tenant claim'ил master-номера, найден архитектором). **C3:** guarded UNIQUE ×2 (mig 148 — на prod no-op, uniques уже есть). **C4:** wallet-гейт на резолвнутой компании (убран null-обход). **C5:** softphone-токен fail-closed 409 `SOFTPHONE_NOT_PROVISIONED` для не-дефолтных компаний (был тихий фолбэк на master env creds).
- **Верификация.** 5 jest-файлов (onboardingChecklist/billingPaygSubscribe/marketplaceTelephonyOverlay/twilioInboundIsolation/voiceTokenFailClosed) + обновлённые фикстуры соседей — **jest-свип 171/171 зелёный** (с регрессиями billingUI/googleEmail/keycloak/call-bugs). Frontend `npm run build` exit 0. Миграции 145–148 прогнаны РЕАЛЬНЫМ SQL против схемы 107+ в rollback-транзакции (идемпотентны; 148 no-op на существующих uniques). Защищённые файлы не тронуты. **Live-DB QA (T14) поймала реальный баг**, невидимый мокнутому jest: write-once `completed_at` не персистился (`jsonb_set` с 2-уровневым путём — no-op, если родительский ключ не существует) → починено deep-merge через `||`; проверено вживую. `⚑ Деплой:` prod ОБЯЗАН иметь mig 107 (`billing_plans.max_phone_numbers`) до mig 146 — проверить перед выкатом.

## 2026-07-02 — LAYER-STACK-PHANTOM-001: closed dialogs no longer push open layers off-screen

Owner (real device) reported single overlays rendering dimmed + shifted toward the center (the job card sat at `translateX(-494px) scale(0.94) brightness(0.72)` while being the ONLY visible layer) and the "SoftPhone Ready" modal flying off to the left. Root cause: the custom `DialogContent` registered itself in the `OverlayStack` with a **hardcoded `open=true`** (and the mobile drag hook with `open: isMobile`) — but the wrapper's hooks run even for CLOSED dialogs (Radix unmounts only the portal'd subtree, never the wrapper), so **every closed `<Dialog>` in a page's JSX counted as an open z-140 overlay**. Measured live: 5 phantom entries at boot on /jobs, 19 with a job card open → the one visible panel computed `layersAbove=19` and got the full card-stack recede. (LAYER-Z-FIX-001 below fixed the *ordering* of real entries; the phantom *registration* is this separate bug.)

- **Fix:** a `DialogOpenProbe` rendered INSIDE the portal'd content (mounted ⇔ the dialog is really open, per Radix Presence) feeds a `contentMounted` state; the OverlayStack registration and the mobile drag hook now key on it instead of `true`/`isMobile`. One file (`ui/dialog.tsx`), frontend-only, no migration.
- **Verified live** in dev-preview (fresh page, real interactions): boot stack empty (was 5 phantoms); job card open → stack `[80]` only, panel untransformed & right-anchored; nested Reschedule modal → `[80, 140]`, the panel recedes exactly one step (−26px, the intended card-stack), the modal stays centered on top; close → back to `[80]`, panel restores; repeated open/close cycles → no accumulation. Build green (strict tsc).

---

## 2026-07-02 — LAYER-Z-FIX-001: reschedule/time-picker modal no longer flies off-screen behind the job card

Owner (real device) reported the reschedule time-picker (`CustomTimeModal`) "layout broke — the window moved off-screen." Root cause: the OVERLAY-CANON-002 desktop card-stack ranked overlays by **open-order only, ignoring z-index**. Opened INSIDE the non-modal job card (`FloatingDetailPanel`, z-80), the modal (`DialogContent`, z-140) got the "recede" transform (scale + dim + translateX) and flew to the top-left, clipped — while the job card stayed put.

- **Fix:** made `OverlayStack` **z-aware** — an overlay recedes only for layers that PAINT above it (higher z-tier, or same tier opened later). A non-modal panel (z-80) can no longer push a modal (z-140) back; it recedes UNDER it. Threads each tier's z (panel 80 / modal 140 / sheet 200 / lightbox 1000) from `Overlay`/`dialog` into `useOverlayDismiss`/`useOverlayStack`.
- **Byte-identical for same-z stacks** (dialog-over-dialog, sheet-over-sheet), so only the panel-under-modal case changes. Reproduced in an isolated preview harness (pixel-match to the report) and verified fixed under StrictMode + prod build; adversarially reviewed (same-z equivalence, single `isTop`, cross-z direction, mobile — all verified). 4 files, frontend-only, no migration.

---

## 2026-07-02 — LIST-PAGINATION-001: Pulse conversation list is one properly-paginated set (calls + SMS + email)

Owner: heavy lists (especially Pulse) should send the first ~50 then load more, not everything. The Pulse sidebar (`GET /api/calls/by-contact`) had infinite-scroll UI, but the BACKEND paginated only call-timelines then **bulk-merged up to 200 SMS-only rows** out-of-band (no offset, and un-scoped by company — a latent cross-tenant leak), re-sorting in JS per page → it effectively loaded everything and paged incorrectly. Email was not a source at all.

- **Fix:** rebuilt `by-contact` as ONE timeline-rooted, offset-paginated (50/page) SQL query unifying **calls + SMS + email**: `last_interaction_at = GREATEST(call, sms, email)`, the 3-band sort (Action-Required → unread → recency) fully in SQL + `timeline_id` tiebreak, `COUNT(*) OVER()` total, SQL-level orphan-shadow dedup. Deleted the JS append/dedup/re-sort and the read-path timeline write; SMS ingest now guarantees a timeline. **Closes the cross-tenant SMS leak.** Email folds in for known contacts (Scope A: `from_email → contact_emails → contact → timeline`). Migration **143** = functional email index. Frontend unchanged (existing infinite-scroll). 25 jest tests; adversarially reviewed (2 regressions caught + fixed: open-task-only rows dropped, contact/orphan duplicates).

---

## 2026-07-01 — PULSE-MOBILE-FULLSCREEN-001: Pulse mobile list scrolls the app scroll area (no floating container / bottom void)

Owner (real device) reported the mobile list pages put the list in a floating sub-container that leaves an empty gap at the bottom (worst in the installed PWA), unlike Schedule which fills the screen. Jobs/Leads/Tasks were already converted to Schedule's model (scroll `.app-main`, no inner container) in the mobile layout pass above — **Pulse was the remaining offender**: `PulsePage` set `appMain.style.overflow = 'hidden'` and scrolled its own `.pulse-sidebar-card` → `.pulse-sidebar-scroll` inner box.

- **Fix (mobile-only, desktop byte-identical):** the `overflow:hidden` effect is now gated behind `useIsMobile()` (desktop still needs it for its two independent columns); on mobile `.app-main` stays scrollable. In `PulsePage.css` `@media (max-width:767px)` list mode, the `.pulse-layout`/`.pulse-sidebar-card`/`.pulse-sidebar-scroll` chain drops its fixed-height/overflow (→ `display:block; overflow:visible`, flat full-bleed, transparent bg, 8px inset) so the list flows into `.app-main` like Schedule. The conversation content panel keeps its own scroll.
- **Verified** in dev-preview at 375px with an injected **34px safe-area** (iOS PWA proxy): Pulse last-item→nav gap constant (40px) at inset 0 and 34px (nav clearance tracks the inset), no void, no frame, no horizontal overflow. Jobs/Leads/Tasks cross-checked sufficient under 34px safe-area too. Build green.
- NOTE: the Jobs/Leads/Tasks + Telephony + this Pulse fix were all merged to master but were **NOT on prod** — a parallel deploy (running image built 2026-07-01T23:53Z) predated commit `581e108`, so the fixes need a deploy to reach devices.

---

## 2026-07-01 — Mobile layout pass: canonical list shell + Telephony sub-nav (TASKS-MOBILE-TILES-001 + TELEPHONY-MOBILE-SIDEBAR-001)

Two mobile-layout fixes from one 375px audit (empirical dev-preview sweep + code root-cause). Frontend-only, no migration; desktop byte-identical (all behind `useIsMobile()`).

- **TASKS-MOBILE-TILES-001** — a canonical mobile list shell (`components/layout/MobileListPage.tsx` + `.mobile-list-page*` in AppLayout.css) adopted by mobile Jobs/Leads/Tasks. **Tasks** was a centered `mx-auto max-w-4xl` list → now full-width tiles (359px, matching Jobs). **Leads** inset 20px→8px (edge-to-edge). **Scroll/clearance root-cause fixed:** the pages scrolled an inner `flex-1 overflow-y-auto` that made `.app-main`'s `padding-bottom: calc(60px + safe-area)` (fixed-nav clearance) inert — and a flex-column scroll child drops its trailing padding in Chromium/WebKit. The shell is now `display:block` scrolling `.app-main`, so the last tile clears the bottom nav (+36px, was ~8px/under-nav), a short list no longer shows a `flex:1` background void / visible "container frame," and empty states are vertically centered. Day-group sticky headers offset to the 62px bar height. Independent review APPROVED.
- **TELEPHONY-MOBILE-SIDEBAR-001** — the Telephony section's fixed **220px left sub-nav** (`TelephonyNav`) ate content width on phones (only ~155px left). On mobile the sub-nav is now a **horizontal scrollable tab strip** at the top and `TelephonyLayout` stacks in a column, so content is full-width (375px, no horizontal overflow); active tab highlighted, tap-to-navigate intact. Desktop keeps the 220px sidebar/row unchanged. `minHeight` `100vh`→`100dvh`. (Follow-up to TELEPHONY-AUTONOMOUS-MODE-001, whose mobile fix only covered the working-hours editor.)

Consolidated `npm run build` green (both together). Deferred (task-chipped): mobile tile views for Contacts/Payments (still desktop-on-mobile); telephony active-chip scroll-into-view.

---

## 2026-07-01 — TELEPHONY-AUTONOMOUS-MODE-001: company-wide "Autonomous mode" + mobile hours editor

Two parts on the telephony settings surface.

- **Autonomous mode** — a company-level toggle (top of `/settings/telephony`, gated `tenant.telephony.manage`, **confirm-on-enable**; disable is immediate) that forces **every inbound call, in every flow, down its After-Hours branch** regardless of the working-hours schedule. Backend: new `company_telephony.autonomous_mode` (migration **142**); `callFlowRuntime.startExecution` reads it and sets `context.isBusinessHours = false` when ON — so each flow's existing `after_hours` edge (`isBusinessHours === false`) is taken (VM / AI / forward, whatever it routes to). **OFF (default) is byte-identical to previous routing**; the flag read is **fail-open** (a DB error degrades to normal-hours routing, never rejects a call). API `GET /api/telephony/provider/autonomous-mode` (readable by any authenticated company user — the banner needs it) + `PATCH` (gated). A persistent, non-dismissible **bottom banner** ("Autonomous mode is ON — all incoming calls are handled as after-hours") shows app-wide for all roles while ON, via a shell-mounted `useAutonomousMode` hook + context.
- **Mobile working-hours editor fix** — the real per-group business-hours editor (`GroupFormModal` in `UserGroupsPage`) was unusable on a phone: a hardcoded `width:600` modal overflowed and the time-select rows didn't wrap. Now a full-width bottom sheet on mobile with wrapping time selects and larger tap targets (desktop unchanged, all `isMobile`-gated).

Orchestrated: parallel backend + frontend implementers → independent adversarial review **APPROVED** (routing override verified: OFF byte-identical, ON forces after-hours everywhere, `group.company_id` always present, fail-closed→now fail-open, multi-tenant clean) → 2 hardenings (fail-open + a `condExpr`-path test). **25 backend jest green** (incl. voice/callFlows regression) + frontend `npm run build` green. Multi-tenant `company_id`-scoped throughout.

---

## 2026-07-01 — PRICEBOOK-002: Items tab → spreadsheet-style inline-editable grid

Replaced the Price Book **Items & products** tab's row-list + per-item slide-over editor with an inline **editable grid**: all 7 fields (Name, Description [single line at rest, expands to ≥3 lines / fits content on focus, collapses on blur], Code/SKU, Unit, Unit price, Taxable, Category) are edited in place, a pinned **"+ Add row"** starts a blank item, and the whole sheet is persisted at once via a single **Save changes** button (atomic). Groups & Categories tabs unchanged.

- **Backend:** new **`PUT /api/price-book/items/bulk`** (company-scoped, gated `price_book.manage`) → `estimateItemPresetsService.bulkSaveItems` validates the whole batch first (name required per non-deleted row, price finite ≥0, description ≤4000, `category_id` must belong to the company) then `estimateItemPresetsQueries.bulkSaveItems` applies creates/updates/archives in ONE `db.getClient()` transaction (modeled on `priceBookQueries.setGroupItems`), reusing `insertPreset`/`updatePresetScoped`/`archivePresetScoped` with the shared client. **All-or-nothing:** any invalid row / foreign category rejects with a structured `422 { details:[{scope,index,field,error}] }` and writes nothing; a stale/foreign update id → structured 422 (pre-validated via new `findActiveIdsScoped`) or 409 on a true TOCTOU race — never a generic 500. Update rows carry only the 7 grid fields, so `default_quantity`/`usage_count`/`last_used_at`/`created_by` are preserved. Idempotent already-archived delete = skip. `listForManage` cap raised 200→1000. Per-row endpoints kept for back-compat (CSV import).
- **Frontend:** `ItemsTab` rewritten as a draft grid (`RowDraft` status `pristine|new|edited|deleted` + stable key); loads all items once (`?limit=500`) and filters **client-side** so unsaved edits survive search. Per-row trash marks a server row deleted (undo-able) and archives it on Save; new rows drop locally. **Save changes** (dirty-gated) + **Discard**; 422 `details` highlight the offending cells. Unsaved-changes guard on tab switch + `beforeunload`. `ItemPanel` removed from the Items flow — a **documented exception** to the right-side "layer" canon (inline table edit; Blanc tokens/fonts, no decorative separators, `overflow-x-auto` on narrow screens). `priceBookApi.bulkSaveItems` + bulk types.
- **Bug found & fixed during live testing:** the browser's autofill / form-value-restoration wrote into the grid's first text input on load, firing React `onChange` → wiping the first item's name and falsely marking the row dirty. Fixed by opting all grid inputs out of autofill (`autoComplete="off"` + `data-1p-ignore`/`data-lpignore` + `spellCheck=false`).
- **Verified end-to-end on the local stack (screenshots):** grid edit + "+ add row" + per-row delete/undo + single atomic Save (`1 added · 1 updated · 1 archived`, all committed together, DB confirmed); client-side search; empty-name → `422` with red-bordered cell and nothing persisted; clean reload keeps all names + non-dirty (autofill fix holds). `tests/priceBookBulk.test.js` + `tests/priceBookBulkQueries.test.js` (query-layer transaction/rollback) — **26/26** across 3 suites incl. PRICEBOOK-001 regression; frontend `tsc -b` green. Reviewer pass (adversarial) returned one blocker (generic-500 on stale id) — fixed + re-tested. Spec `Docs/specs/PRICEBOOK-002.md`, tests `Docs/test-cases/PRICEBOOK-002.md`. No migration, no new permission. NOT deployed.

---

## 2026-07-01 — PRICEBOOK-001: Price Book (Category → Group → Item) editor + estimate/invoice integration

Evolved the flat `estimate_item_presets` catalog into a 3-level **Price Book**. **Item** = the existing presets table extended with `category_id`/`code`(SKU)/`unit` (data preserved). **Category** (`price_book_categories`) groups items & groups but is never added to a document. **Group** (`price_book_groups` + M2M `price_book_group_items` with per-item `quantity`+`sort_order`) — selecting a group in an estimate/invoice inserts ALL its active items as line items; the group itself isn't stored.

- **Backend:** migration **141** (3 tables + preset columns + perm backfill); new `price_book.view`/`.manage` perms (050 for new companies + 141 backfill + `permissionCatalog.js`); `priceBookQueries` + `priceBookService` (categories/groups CRUD, membership replace, group expansion that snapshots price/qty and **skips archived** items, in `sort_order`); `estimateItemPresets` queries/service extended (category/code/unit + paginated management list with category join); `/api/price-book` router (reads `price_book.view`, writes `price_book.manage`, company-scoped); **bulk** `POST /api/estimates|invoices/:id/items/bulk` (one status-reset + ONE recalc + ONE `items_added` event, vs N round-trips).
- **Frontend:** **Settings → Price Book** page (`/settings/price-book`, gated `price_book.manage`) — tabs Items/Groups/Categories with list+search+create/edit dialog+archive; group editor picks items + qty. `ItemPresetSearchCombobox` gains a Groups section (`onPickGroup`); Estimate/Invoice panels expand a picked group into its items via the bulk endpoint. `priceBookApi.ts` + bulk helpers.
- **Independent gap-review before coding fixed:** stale migration number (G1→141), N-round-trip expansion → bulk endpoint (G2), archived-item skip + snapshot + order (G4/G5), group total (G6), `permissionCatalog` registration (G7), item `code`/`unit` (G8). A jest failure also caught a `NaN` item_id leak in `normalizeItems` (now filtered).
- **UX canon:** editors rewritten from center Dialogs → canonical **right-side slide-over "layer"** (`DialogContent variant="panel"` + `FloatingField`/`FloatingSelect`, mirroring `EstimateItemDialog`; mobile auto→bottom-sheet). The "layers = right-side panel, never a center modal for view/edit" rule is now recorded in the project **CLAUDE.md** (top UI principle) + `docs/specs/FORM-CANON.md`.
- **Import/Export (CSV):** Import/Export buttons at the top of the page open a right-side layer with a drop-zone + "Download the fill-in template" link + Export button. Columns `Name, Description, Code, Unit, Unit Price, Taxable, Category, Group, Group Quantity` (header order flexible). Import upserts items by name, **find-or-creates** the named Category & Group and adds the item to the group with quantity (existing category/group → item added there); partial-success with a per-row error summary. Export = one row per (item, active membership), round-trips. Endpoints `GET /template|/export` (view) + `POST /import` (manage); hand-rolled CSV (no lib).
- **Verified end-to-end on the local stack:** migration 141 applied; API create category→items→group (total=355); **CSV import round-trip** (2 items → 1 category + 1 group, total=330 → export round-trips); Price Book page + all editors + the Import/Export layer rendered live (screenshots). `tests/priceBook.test.js` 10/10 (CRUD + expansion + CSV import); frontend `tsc -b` green. No cost/brand/images, no read/unread, snapshot semantics. Spec `Docs/specs/PRICEBOOK-001.md`. NOT deployed.

---

## 2026-07-01 — LEADS-NEW-BADGE-001: "new leads" counter badge in the nav

Dispatchers didn't notice incoming leads. Added a number-in-a-circle badge on the **Leads** nav item (like the Pulse "new events" badge) showing the company's count of **new/unactioned** leads — `status ∈ {Submitted, New, Review}` and `lead_lost = false` (Submitted is the creation default; New/Review are the other pre-contact states). **No read/unread**: purely status-derived, so it does NOT clear on opening the page — only as leads get actioned (a persistent "N awaiting triage" indicator). Company-scoped; visibility follows `leads.view`.

- **Backend:** `leadsService.countNewLeads(companyId)` + exported `NEW_LEAD_STATUSES` (single source of truth); `GET /api/leads/new-count` (gated `leads.view`, `req.companyFilter.company_id`) placed **above** `/:uuid` so Express doesn't match it as `uuid="new-count"`.
- **Freshness = hybrid:** mount + route-change fetch + **60s poll** + **live SSE** (`lead.created`/`lead.updated`). Emits from `leadsService`: `lead.created` on `createLead` (single creation chokepoint → covers manual + VAPI + web-form/integration), `lead.updated` on `updateLead` (status change), `markLost`, `activateLead`, `convertLead`. Emits are best-effort; poll is the fallback for missed events/reconnects.
- **SSE is a global broadcast** (no per-tenant channel), so the event payload is **minimal & PII-free** (`{company_id, status, lead_id}`) and the client refetches its own company-scoped count only when `event.company_id === company.id`. Routed via the existing `useRealtimeEvents` generic-event channel (added the two event types; consumed by `onGenericEvent`) — a minimal additive touch to the protected hook.
- **UI:** reuses `.pulse-unread-badge` (number, "9+"), desktop + mobile, `position:relative` added to the Leads trigger.

Independent plan review caught + fixed: route-ordering trap (G1), global-SSE→client company-filter + PII-free payload (G2), status emits needed in 5 functions not 1 (G3), `position:relative` (G4). No migration (indexes + `lead_lost` exist). `tests/leadsNewCount.test.js` (7 cases: count scoping/null-guard, PII-free emit, best-effort, no-company); frontend `tsc -b` green; existing convert test stays green. Spec `Docs/specs/LEADS-NEW-BADGE-001.md`. NOT deployed.

**Follow-up (local manual testing caught a live-update bug):** `sseManager.connect()` attaches native `EventSource` listeners only for a **hardcoded `namedEvents` array**, so adding `lead.created`/`lead.updated` to `useRealtimeEvents` alone wasn't enough — the events never fired client-side and the badge only refreshed via the 60s poll. Fixed by adding `lead.created`/`lead.updated` to `sseManager` `namedEvents`. Verified live on the local stack (backend :3000 + frontend :3001 vs the dev DB, company …0001): create Submitted lead → badge 1→2, mark-lost → 2→1, instantly via SSE. Full jest suite: 1297 pass / 14 pre-existing failures in unrelated subsystems (slot-engine, inbox, fsm, state-machine, routeGuards `/e/:token`); the 4 feature-relevant suites 42/42 green.

---

## 2026-07-01 — INVOICE-EDIT-ITEMS-PERSIST-001: full-editor invoice edit now persists line-item changes

Follow-up to INVOICE-ITEMS-HYDRATE-001 (found while diagnosing it). Editing an existing invoice through the **full editor** (`InvoiceEditorDialog`) silently dropped all line-item changes — added/removed/edited items were lost; only scalar fields (tax/discount/notes/terms) persisted. Root cause: `PUT /api/invoices/:id` → `invoicesService.updateInvoice()` only wrote the scalar allowlist and **never touched `data.items`** (unlike `createInvoice`, which loops `addInvoiceItem`). The editor always posts the full `items` array (no per-item id). The inline `InvoiceDetailPanel` was unaffected — it edits items through the granular `/:id/items` endpoints.

- **Backend fix** (backend-only, no migration): new `invoicesQueries.replaceInvoiceItems(invoiceId, items)` — an **atomic** delete-then-reinsert on a dedicated `db.getClient()` transaction (`BEGIN` → `DELETE` → per-item `INSERT` reusing `addInvoiceItem`'s column/amount logic → `COMMIT`; `ROLLBACK` + `release()` on failure), so a partial write never leaves a torn item set. `invoicesService.updateInvoice` now reconciles items **only when `Array.isArray(data.items)`** and recalculates totals when items were reconciled *or* a totals-affecting scalar changed.
- **Critical guard:** `data.items` **absent** ⇒ items left untouched — the inline panel's scalar-only auto-saves (`{notes}`, `{tax_rate}`, `{discount_amount}`, `{due_date}`) must never wipe items. `items: []` ⇒ clears all items (summary-only invoices are valid) and zeroes totals. The existing revision-snapshot-before-update ordering is preserved so a non-draft snapshot captures the OLD items; multi-tenant `company_id` guard (`getInvoiceById` → NOT_FOUND) unchanged.
- **Orchestrated:** independent adversarial review **APPROVED** (regression guard verified against every payload shape — `undefined`/`null`/`{}`/non-array all skip reconcile — no exploit found). Tests: `tests/invoicesUpdateItems.test.js` (service reconcile incl. the no-items-key regression guard + `items:[]` + foreign-invoice NOT_FOUND + snapshot-before-replace) and `tests/invoicesQueriesReplaceItems.test.js` (query-layer transaction: BEGIN→DELETE-before-INSERT→COMMIT ordering, `items:[]`=DELETE-only, INSERT-failure→ROLLBACK+release). **69 backend Jest green** (20 new/changed + 49 regression across estimate-convert / stripe / provider-finance). Frontend untouched.

---

## 2026-07-01 — INVOICE-ITEMS-HYDRATE-001: invoice detail showed "no items" though items were saved

Reported on a job invoice: create an invoice with a line item → the total is right, but reopening the invoice shows an empty item list and "This invoice has no items"; adding another item makes the previously-saved one reappear, and the count appears to grow by one each reopen→add cycle. The items were **never lost** — prod DB confirmed all rows present with the correct total.

Root cause (frontend-only): `InvoiceDetailPanel` rendered whatever `invoice` prop it was handed and **never fetched the full record on open** — it only refetched (via `refreshAfterItemChange → fetchInvoice`) *after* an item add/edit/delete. But the callers pass a **list row**: `JobFinancialsTab`/`LeadFinancialsTab` `openInvoice` and the Invoices list all hand over `i.*` from `GET /api/invoices` (list), which returns **no `items`** (only `getInvoiceById`/`GET /api/invoices/:id` includes them). So `hasItems = !!invoice.items?.length` was false on open → the empty-state; the first inline add then triggered a full refetch that revealed **all** persisted items at once — the "reappear / grows by one" illusion.

- **Fix** (`InvoiceDetailPanel.tsx`): hydrate the full invoice on open. The prop-sync effect now also `fetchInvoice(id)`s when `initialInvoice.items` is absent, and a `hydrating` flag shows a brief "Loading items…" row instead of flashing the "no items" warning. A genuinely empty invoice (items `[]` present) skips the fetch and correctly shows the CTA. Also enriches `contact_email/phone` + freshest totals. One extra lightweight GET per open; covers every caller (Job/Lead Financials + Invoices list) in one place.
- **Verified:** prod DB shows the 3 items + correct total were always stored; in dev-preview, opening the item-less list row now fires `GET /api/invoices/:id` (the hydrate) on open; `npm run build` green. Frontend-only, no backend/migration.
- **Adjacent (NOT fixed here):** editing an invoice through the *full editor* (`PUT /api/invoices/:id`) drops item changes — `invoicesService.updateInvoice` ignores `data.items` (only the granular `/:id/items` endpoints persist items, which the inline panel uses). Flagged separately.

---

## 2026-07-01 — ONBOARD-FIX-001: tenant-isolation leak fix + onboarding access + phone mask + theme audit

Follow-up to GOOGLE-SSO-FIX-001, four parts.

**SEC (P0) — cross-tenant leak.** `requireCompanyAccess` resolved the tenant as `req.authz?.company?.id || req.user?.company_id`. `req.user.company_id` mirrors `crm_users.company_id`, which **migration 012 backfilled to the seed company `…0001` (Boston Masters)** — so any user with **no active membership** but a stale shadow resolved to Boston Masters and could read its data. Fix: `const companyId = req.authz?.company?.id || null;` — tenant scope now comes **only** from an active membership (`company_memberships` via `resolveAuthzContext`); no membership → `403 TENANT_CONTEXT_REQUIRED`. Also: the `!FEATURE_AUTH` dev bypass (which hard-codes the same seed company) now **fails closed in production** (`NODE_ENV==='production'` → `500 AUTH_MISCONFIGURED`). **Migration 140** clears `crm_users.company_id` wherever it isn't backed by an active membership (neutralizes the backfill; logs affected count; idempotent). Verified `resolveAuthzContext` only ever sets `company` from `membership.company_id`, and the remaining `req.user.company_id` refs are audit-log-only (`tenant-safety-allow`). Jest: 4 new cases (deny-without-membership-even-with-shadow, allow-scopes-to-membership, platform-only-denied, dev-fail-closed) — 27/27 green.

**A — onboarding landed on "no access" + flicker.** After `POST /api/onboarding` created the company + tenant_admin membership, the SPA navigated client-side to `/pulse` but the authz context (loaded once at app init, pre-company) was never refreshed → `OnboardingGate` looped back to `/onboarding` (flicker) and `/pulse` `ProtectedRoute` denied. Fix: `AuthProvider` exposes `refreshAuthz()` (re-`GET /api/auth/me`; backend resolves from DB so no token refresh needed), and `OnboardingPage.createCompany` awaits it before navigating (success + `ALREADY_ONBOARDED`). The reporter's own case is UNCONFIRMED: the actual Google signup account was `help@abchomes-appliance.com` (the `office@bostonmasters.com` seen earlier was on a confirm page, possibly a different test). A fresh cross-domain email is unlikely to be a pre-seeded Boston Masters member, so this may be a genuine leak — MUST be verified with a prod DB check (a post-mig-012 new user would have `company_id=NULL` → 403, so seeing Boston Masters implies a seed `company_id`). The SEC fix closes the structural hole regardless.

**B — masked phone.** Onboarding "Verify your phone" masks input via the shared `formatUSPhone` util (same as the New Lead `PhoneInput`) and sends `toE164(phone)` to the OTP endpoints; onboarding's own input styling kept.

**C — theme audit.** The albusto theme ships only its own CSS, so non-overridden pages render unstyled. Themed the 6 reachable-but-missing templates: `login-otp`, `select-authenticator`, `login-reset-password`, `login-update-password`, `error`, `idp-review-user-profile` (all via `registrationLayout` + `.field`/`.btn`).

Frontend `tsc -b` green. Spec `Docs/specs/ONBOARD-FIX-001.md`, tests `Docs/test-cases/ONBOARD-FIX-001.md`. NOT deployed. Deploy: backend + frontend + `up -d --force-recreate keycloak` (theme cache) + run migration 140.

---

## 2026-07-01 — KC-ROOT-BRAND-001: auth.albusto.com root no longer exposes raw Keycloak

`https://auth.albusto.com/` (the bare root) `302`-redirected into Keycloak's **raw Administration Console** (`/admin/…`) — an unbranded "bare Keycloak" page. The branded `albusto` theme only wraps the *login flow*; nothing wrapped the root. Fixed at the **reverse-proxy (Caddy) layer** on prod, not in app code:

- **Root redirect** — added `@root path /` + `redir @root https://app.albusto.com/ 302` to the `auth.albusto.com` block in `/etc/caddy/Caddyfile`. The bare root now bounces to the app; unauthenticated users pick up the branded Albusto login from there. The matcher is **root-only** (exact `path /`) — the login flow, OIDC discovery, `/resources/*`, and the admin console are untouched.
- **Admin console kept** — `/admin` stays reachable (login-gated) for browser-based Keycloak administration; only the *bare-root shortcut* into it is removed (owner's call).
- **Infra now tracked** — the prod Caddyfile was previously untracked (lived only on the box). Added a reference copy at `infra/Caddyfile` + `infra/README.md` (apply/rollback procedure). The live `/etc/caddy/Caddyfile` stays authoritative.

Applied live + verified: root → `302 https://app.albusto.com/`; `/admin/` → KC console (`302 …/admin/master/console/`); `.well-known/openid-configuration` → `200`; login flow → `200` branded (`albusto-login` / `Shipped recently` markers present). `caddy validate` clean, graceful `systemctl reload caddy`, timestamped backup on the box for rollback. **No app code, migration, or app deploy** — a proxy-config change independent of the release pipeline.

---

## 2026-07-01 — GOOGLE-SSO-FIX-001: fix "Continue with Google" (frontend init/PKCE) + Keycloak IdP hardening

«Continue with Google» на `/signup` не работал: в консоли `TypeError: Cannot read properties of undefined (reading 'login')`. Причина — **фронт**, а не Keycloak: прод-realm `crm-prod` уже имеет рабочий `google` identity provider (бро́кер корректно уходит на `accounts.google.com`, client `730558866466-…`, scope `openid email profile`). Но публичная страница `/signup` пропускает `kc.init()` (guard `publicPage` в `AuthProvider`), поэтому `getKeycloak().login()` вызывался на инстансе без `adapter` — и без `pkceMethod` из `init()` не проставлялся PKCE `code_challenge`, который клиент `crm-web` требует (`Missing parameter: code_challenge_method`).

**Фикс (первопричина):** новый `loginWithIdp()` в `AuthProvider` лениво инициализирует общий инстанс `kc.init({ pkceMethod:'S256', checkLoginIframe:false })` (без `onLoad` → без авто-редиректа, только adapter+PKCE) и затем `kc.login({ idpHint:'google', redirectUri: origin+'/onboarding' })`. keycloak-js хранит PKCE-verifier в callback-storage, поэтому страница возврата `/onboarding` (init с `onLoad:'login-required'`, тот же `pkceMethod`) завершает обмен code→token. `SignupPage` использует `loginWithIdp`.

**Сопутствующее:** (1) устранён **дрейф конфигурации** — `keycloak/realm-export.json` теперь содержит `identityProviders[google]` (секреты через `${GOOGLE_IDP_CLIENT_ID/SECRET}`, `trustEmail:true`), мапперы `given_name→firstName` / `family_name→lastName` / `email`, и flow **«first broker login auto link»** (`idp-review-profile` DISABLED, `idp-create-user-if-unique` + `idp-auto-link` ALTERNATIVE) → **авто-связывание** Google-идентичности с существующим аккаунтом по verified email без ручного prompt'а. (2) Т.к. realm-import НЕ переконфигурирует уже импортированный realm, добавлен идемпотентный `scripts/setup-google-idp.sh` (Admin REST create-or-update) для применения к живому проду. (3) `login.ftl` (+ CSS) теперь рендерит «Continue with Google» и на странице **входа**. (4) `.env.example`: `GOOGLE_IDP_CLIENT_ID/SECRET` (отдельно от Gmail `GOOGLE_CLIENT_ID`).

**Данные из Google:** полное имя + email тянутся автоматически (`userService.findOrCreateUser` уже пишет `full_name`+`email` из токена) — без изменений; given/family — через мапперы. `picture`/`locale` намеренно не берём (нет колонки аватара). **Onboarding не тронут** — Google-юзер проходит существующий шаг телефон→SMS→компания (SMS оставлен по решению). Миграций БД нет; защищённые файлы не тронуты. Фронт: `tsc -b` зелёный. Спека `Docs/specs/GOOGLE-SSO-FIX-001.md`, тест-кейсы `Docs/test-cases/GOOGLE-SSO-FIX-001.md`. НЕ задеплоено.
## 2026-07-01 — OVERLAY-CANON-002: overlay-system overhaul (mobile sheets everywhere, shared core, desktop card-stack, settings modernization)

Frontend design-system overhaul — 6 phases, each independently adversarially-reviewed (APPROVED) + build-green; not yet deployed. Spec: `docs/specs/OVERLAY-CANON-002.md`.
- **Consistent overlay behavior + stacking foundation.** Centralized ad-hoc z-index (`z-50…z-9999`) into one named scale in `overlayLayout.ts` (`OVERLAY_Z`); new `OverlayStack` registry so stacked overlays cooperate — Esc + focus-trap now fire on the topmost layer only (fixes focus escaping between layers).
- **5 overlay surfaces → one shared core.** New render-prop `Overlay` core; `BottomSheet`/`FloatingDetailPanel`/`AIAssistantModal`/`FullscreenImageViewer` are now thin variant wrappers over it (public APIs + visuals unchanged); `dialog.tsx` stays on Radix. Removed the duplicated portal/backdrop/dismiss plumbing.
- **All desktop modals + dropdowns become bottom sheets on mobile.** `dialog.tsx` mobile gains the canonical grab-handle + drag-to-dismiss (30 dialogs, Radix state preserved), and `Select`/`DropdownMenu`/`Popover` render the canonical `BottomSheet` on mobile (~36 call sites, from 3 primitive edits; desktop unchanged). Converted the last narrow-centered mobile modals (2FA gate, User-Groups modal, schedule slot menus). Removed a dead component (`OverflowPopover`).
- **Desktop card-stack.** Opening a second overlay slides the lower one left + dims it (a peeking "pile"); mobile keeps simple top-covers-lower.
- **Modernized the dated settings pages.** `QuickMessages` + `Lead & Job Settings` moved off narrow-centered columns + hardcoded cool-grays onto the Blanc design system + full-width shell (deleted the bespoke `.lfsp-*` CSS); widened 6 other centered settings pages.

Frontend-only, no backend/migration. `npm run build` green throughout. Deferred non-blocking edges noted in the spec.

---

## 2026-06-30 — JOB-PROVIDER-MULTI-001: multi-provider assignment on the job card + Zenbooker sync + "Provider" rename

Three refinements to a job's assignee (the job card "Technician" control):
- **Renamed "Technician" → "Provider" across the UI** (job card, Schedule provider label, Settings → Providers page heading/labels, New-Job & On-the-way & Custom-time modals, recommendation settings, AI-assistant blurb, role hint, and the customer invoice page). Internal identifiers, API paths (`/api/zenbooker/team-members`, the `/settings/technicians` route), the `provider` role key, and component/file names are unchanged.
- **Changing the provider now syncs to Zenbooker.** `scheduleService.reassignItem` updated the local `assigned_techs` and recalced routes but **never called Zenbooker** — so a card reassignment silently didn't reach ZB. It now computes the old→new provider diff and calls `zenbookerClient.assignProviders(zbJobId, { assign, unassign })` (best-effort; a ZB failure is logged, never rolls back the local change). Since this is the shared reassign path, Schedule drag-reassign now syncs to ZB too.
- **Multiple providers, then Save.** The picker was single-select and applied on click; it's now a **multi-select list with a Save button** — toggle any number of providers, then Save. `assigned_techs` was already a JSONB array and the Schedule board already reads it as multi (`filterItemsByProviderTags` uses `.some()`), so multi jobs surface under each provider. **On mobile the picker is now the canonical bottom sheet** instead of a dropdown. `reassignJob`/`reassignItem`/the reassign route accept a providers array (legacy single `assignee_id` still supported for the drag path).

Backend: `scheduleQueries.reassignJob(assignees[])`, `scheduleService.reassignItem(assignees[])` + ZB diff push, `routes/schedule.js` accepts `assignees` OR legacy single. The reassign also **refreshes the internal visibility mirror** (`assigned_provider_user_ids`, resolved from the ZB team-member ids via `resolveAssignedProviderUserIds`) so an assigned provider sees the job on their own (mobile) schedule immediately, and dedupes provider ids. Frontend: `scheduleApi.setJobProviders`, rewritten `JobTechnicianControl` (multi-select + Save + mobile `BottomSheet`). Independent review APPROVED after fixes (mirror-refresh + dedup were review-caught). Tests: `scheduleReassign` + `scheduleRoute` updated for the array contract + multi/dedup/mirror cases; all green. `npm run build` green. No migration.

---

## 2026-06-30 — NOTE-AUTHOR-FIX-001: a non-admin can edit/delete their own note again

A non-admin (e.g. a provider) who left a note on a job/lead/contact couldn't edit or delete it — the ⋮ menu never appeared. Cause: a note's `created_by` is stamped with the author's `crm_users.id`, but both the frontend kebab check and the backend `canMutateNote` compared it to the Keycloak `sub` (which differs), and `buildNoteActor` even set its `crmUserId` to `sub`. Admins were unaffected (they bypass the check), which is why it hid until a provider tried.

Fix (server is the authority): `canMutateNote` now matches `created_by` against **either** the `sub` **or** the real `crm_users.id`; `buildNoteActor` carries the real `crmUser.id` (jobs/leads/contacts); both the note GET response AND the actual `editNote`/`softDeleteNote` **enforcement** pass that crm id (an independent review caught that the enforcement path initially only forwarded `sub` — which would have shown the ⋮ but 403'd the mutation); the GET returns a per-note **`can_edit`** flag and the shared `NotesSection` shows the ⋮ from it instead of guessing the author id (the client only knows `sub`). No over-grant (both ids are random UUIDs; a different id can't match). Handles existing notes with **no backfill**. `tests/notesAuthz.test.js` gains a service-level regression guard; backend-only, no migration.

---

## 2026-06-30 — NOTES-ID-STABLE-001: fix "add a note → editing/deleting it right away fails" on ZB-linked jobs

Adding a note to a job and then editing or deleting it immediately failed ("Note not found") until the page was refreshed. Root cause: on a Zenbooker-linked job, when Zenbooker echoed the new note back (`job.note_added`), `jobsService.mergeNotes` couldn't correlate the echo to the just-created local note — its text-match fallback was gated on `!ln.id`, but a freshly-created note has a local `id` (UUID) and no `zb_note_id` yet — so it **re-id'd the note to the Zenbooker id**. The client kept using the now-stale UUID, so `PATCH/DELETE /notes/:id` 404'd; a refresh re-read the new id and worked.

Fix (`mergeNotes`): (1) text-match **any** not-yet-correlated local note (dropped the `!ln.id` gate) so the echo re-correlates and **preserves the local id**; (2) carry forward Albusto-authored notes Zenbooker hasn't echoed yet (`id` + `created_by`, not soft-deleted, no `zb_note_id`) so a sync firing before the echo can't drop or re-id a fresh note. Genuine ZB-side deletes of already-correlated notes are still honoured. Exported `mergeNotes` + added `tests/mergeNotesIdStability.test.js` (6 cases: id-preserved-on-echo, no-drop, no-dup, ZB-delete-honoured, soft-delete-not-resurrected, local-edit-wins); existing notes + jobsService tests stay green.

Also checked **Tasks** (per the report): NOT affected — `createTask` returns the real serial id and `TaskStack` refetches, with no Zenbooker sync, so create→edit/delete works immediately. Leads/contacts notes aren't Zenbooker-synced, so this was job-only. Backend-only, no migration.

---

## 2026-06-30 — JOB-CARD-TITLE-001: job card title is the job type (not the contact name)

The job detail card used the **contact's name** as its big heading, with the job type (service) duplicated in small font up in the eyebrow (`JOB · #832990 · Repair`). The list tile, meanwhile, already titles each job by its **service**. Now the card matches the list: the large heading is `job.service_name` (falling back to "Job"), and the redundant service is removed from the eyebrow (which is now just `JOB · #<number>` + the ZB link). The customer is unchanged in the **Contact** row just below (still a link to the contact), so nothing is lost — the title just stops linking to a person (a service name shouldn't), and the card/list read consistently.

`frontend/src/components/jobs/JobDetailHeader.tsx` only (shared by mobile + desktop job cards): `mainTitle = job.service_name || 'Job'`; dropped `showServiceInEyebrow` + `customerName`; title is now plain text (the `contactInfo`/`navigate` props stay on the interface — passed by `JobDetailPanel` — but are no longer read here, to avoid a prop-removal cascade up the tree). `npm run build` green. Frontend-only, no migration. (Visual confirmation pending on live job data.)

---

## 2026-06-30 — AR-TASK-UNIFY-001: Pulse "Action Required" is now a Task

"Action Required" and Tasks were two views of the same `tasks` table seen through disjoint windows — a Pulse thread-task (via `thread_id`) was invisible to the Stacks UI. They're now **one model**: a Pulse **timeline (thread) is a first-class task parent** (`parent_type='timeline'`, reusing the existing `tasks.thread_id` column), and **"Action Required" = the timeline has an open task** (derived, not a separate flag).

- **Flagging a timeline** (the `⋮ → Action Required` action) now **creates a default "Follow up" task** on that timeline (assigned to the current user) and **immediately opens the task editor** (slide-over) to refine it — cancel keeps the default, so it's flagged either way. Replaces the old bare `set-action-required` flag write.
- **The timeline's tasks show in its view card**, a `TaskStack` **beside the Notes** in `PulseContactPanel` — add / edit / complete / snooze, exactly like a Job or Lead stack. A timeline can hold **many** open tasks.
- **Everywhere AR is shown** — the sidebar "Action Required" section (PULSE-LIST-GROUP-001), the `action_required` filter chip, the `PulseContactItem` badge (now shows the task title + "+N" + due), and the content-column AR bar — is driven by **`has_open_task`** instead of `is_action_required`. Completing the last open task (or "Mark Handled", which closes all open thread tasks) clears it automatically.
- **Global `/tasks`**: user-created timeline tasks appear like any entity task (labeled by contact/phone, click → opens the Pulse conversation). System/automation auto-tasks stay **Pulse-only** (excluded from the global list) so it doesn't flood.
- **Inbound / unread: untouched.** The deprecated, config-gated inbound auto-AR path is left as-is per owner instruction.

Backend: **migration 139** drops the `uq_tasks_one_open_per_thread` unique index (a timeline can now hold many open tasks); `timelinesQueries.createTask` replaces its `ON CONFLICT (thread_id)` upsert with an app-level "find-open-auto-task-or-insert" so inbound/rules keep a single auto-task per thread and **never clobber a user task**; `tasksQueries` gains the `timeline` parent (SELECT projection + company-scoped `timelines`/`contacts` joins + a global-list filter that shows only user-created timeline tasks); the sidebar list query swaps its `LEFT JOIN tasks` (which would fan out duplicate rows now) for a `LATERAL … LIMIT 1` + `open_task_count`, exposing `has_open_task`. Frontend: `TaskStack` gains an `onTasksChanged` hook so card edits refresh the sidebar AR.

Verify: `npm run build` green; backend syntax-checked (`tasksQueries` loads `timeline` as a valid parent). Independent adversarial review **found + fixed one blocker** — SMS-only timelines (a call-less inbound text, the dominant Action-Required case) are built in a *second* `calls.js` code path that wasn't emitting `has_open_task`, so they'd have lost their AR indicator; that branch now batch-loads open tasks too. Also broadened the background auto-unsnooze to task-only threads. All other review checks (SQL fan-out, upsert provenance, multi-tenant scoping, AR-derivation completeness, permissions, mark-handled) passed. Live-data visual confirmation pending (authed Pulse data can't load against the local backend). **NOT yet merged/deployed.**

---

## 2026-06-30 — PULSE-LIST-GROUP-001: Pulse conversation list — Action Required section + day grouping + mobile full-bleed

The Pulse sidebar (the list of conversations/timelines) was a flat list. Now it's organized like the Jobs list:
- **"Action Required" section pinned at the top** — conversations flagged `is_action_required` and not currently snoozed (snoozing still drops them out of the pinned section).
- **The rest grouped by activity day** (`last_interaction_at` in company TZ) with **sticky day headers** (Today / Yesterday / "EEE, MMM d"), most-recent day first; within a day the backend's recent-first order is kept. (Same component on desktop + mobile, so both get the grouping.)
- **Mobile full-bleed:** the sidebar's floating `.pulse-card` box (border/radius/shadow/bg) is stripped on mobile so the list runs edge-to-edge on the screen; the desktop floating card is unchanged.

Implemented as a render-only change in `PulsePage.tsx` (an O(n) grouping `useMemo` + a shared `renderItem` helper so every `PulseContactItem` keeps all its callbacks) + `PulsePage.css` (sticky header + mobile rule). Filter chips (all/unread/action_required), infinite scroll, dedup, active-highlight, real-time, and send are all untouched; a `NO_DATE` guard prevents a crash if a conversation lacks any timestamp. Grouping logic demo-verified (AR pinning, snoozed→day, descending days, every item placed once); `npm run build` green. Frontend-only, no backend/migration. (Visual confirmation pending on a device with live conversations.)

---

## 2026-06-30 — DETAIL-PANEL-MOBILE-CLOSE-002: mobile detail close is a top-right × (no content shift)

Follow-up to DETAIL-PANEL-MOBILE-BACK-001: the back-arrow lived in a thin top BAR that pushed the card content down. Replaced it with a close **× at the panel's top-right corner** (mobile only), rendered as a *child* of the full-screen panel so it stays visible (same stacking fix), with NO content shift. Headers that have a top-right cluster get a mobile-only right-gutter (`max-md:pr-14`) so the cluster sits just left of the × — e.g. JobDetailHeader's `⋮` kebab and ContactDetailPanel's action icons now read `[ … ⋮ × ]`. The × is a single 40px affordance shared by every `FloatingDetailPanel` card; the redundant own `md:hidden` ×'s in the Estimate/Invoice/Transaction detail panels were removed (no more double-× on mobile; their nested Radix-dialog render keeps its own ×). Desktop hover-left × + Esc/backdrop untouched. Independent review APPROVED (verified the own-close removal is safe at all 7 render sites and `onClose` was dead-wired only to the removed button); `npm run build` green; frontend-only.

---

## 2026-06-30 — JOB-TILE-PAYMENT-001: readable paid/due payment status on the mobile job tile

The mobile job tile showed "{status} · ${invoice_total}" (e.g. "Partial · $100") — it paired the Zenbooker status with the invoice *total*, so it never revealed how much was actually owed (and mixed a Zenbooker-cached total with a locally-summed `amount_paid`). Now the tile reads paid vs. due from one consistent source and shows it plainly:

- **Fully paid** → `Paid · $100` (green). **Partial** → `$30 paid · $70 due` (amber). **Nothing paid** → `$100 due` (red). **No invoice / nothing billed** → no pill. Money is compact (whole = no decimals, fractional = 2; thousands separators).
- **Data:** the jobs list query's existing per-job batch aggregate (one query, no N+1, company-scoped) now also sums `invoices.balance_due` alongside `amount_paid`, **excluding void/voided/refunded** invoices so a refund can't skew it. `total = paid + due`. A job with no local invoice gets `balance_due = null` → the tile falls back to the coarse Zenbooker `invoice_status` pill (unchanged for those). New `LocalJob.balance_due` field; no migration.
- **Logic** lives in a pure, exported `jobPaymentDisplay()` + compact `money()` in `JobMobileCard.tsx` (overpay clamped, NaN/null → no amount, `paid<=0` ⇒ "unpaid" not "partial"). Gated by `canViewFinance` (unchanged). Desktop table + `ScheduleItemCard` untouched (candidates for the same treatment later).
- **Verify:** logic demo across all states/edges (paid/partial/unpaid/$0/overpaid/fractional/large/ZB-fallback/draft) ✓; independent review APPROVED (backend sums, company scope, void-exclusion, null-signal correct); `npm run build` green. Frontend + a 1-line backend aggregate; no migration.

---

## 2026-06-30 — DETAIL-PANEL-MOBILE-BACK-001: restore the close affordance on mobile detail cards (regression fix)

On a phone, opening a detail card (Job/Lead/Contact + a few pages — all use the shared `FloatingDetailPanel`) left no visible way to close it and return to the list. **Regression from OVERLAY-CLOSE-CANON-001:** the mobile close `<OverlayClose variant="corner">` was a *sibling* of the panel with `z-index:auto`, while the mobile panel is full-screen `z-index:120` — so the panel painted over the close button and it was buried/untappable. (Desktop's hover-left × is `z-[141]`, so only mobile broke.) Fix: replaced it with a mobile-only **back-arrow (←) at the top-left**, rendered as a *child* of the panel (inside its stacking context → visible), in a slim `md:hidden` top bar so the content flows below it. Tapping it calls `onClose` → back to the list. Applies to every `FloatingDetailPanel` mobile detail card. Desktop unchanged. Independent review APPROVED; `npm run build` green; frontend-only.

---

## 2026-06-30 — JOBS-MOBILE-ORDER-001: mobile Jobs reads earliest-first within each day

On the mobile Jobs list (date-grouped tiles) the jobs inside each day were ordered latest→earliest — the first job of the day sat at the bottom. The list is globally `start_date` DESC for coherent date-grouped paging, so each day rendered bottom-up. Fixed in `JobsMobileList.tsx` by sorting each *dated* day-bucket ascending by `start_date` (earliest→latest) inside the grouping `useMemo`; the day-group order (most-recent day first) and the "No date" bucket are untouched, and paging/loadMore + the desktop table are unaffected. Frontend-only; independent review APPROVED; `npm run build` green.

---

## 2026-06-29 — OVERLAY-CLOSE-CANON-001: one shared close logic for every overlay

Overlay "close" had grown two dialects (slide-over hover-left × from LAYER-CLOSE-CANON-001 vs the bottom-sheet's own ×/swipe/backdrop) and the close BEHAVIOR (Esc/backdrop/scroll-lock/focus) was hand-re-implemented in every non-Radix overlay. Now there is **one source of truth** — edit it once, it changes everywhere.

- **`hooks/useOverlayDismiss.ts` (behavior):** one hook encapsulating Esc, backdrop-click, **ref-counted** body-scroll-lock (nested overlays no longer clobber each other's restore), focus-trap/restore, and swipe-down drag-to-dismiss — each independently togglable. The drag/focus/Esc logic was lifted verbatim from BottomSheet, so no behavior changed.
- **`components/ui/OverlayClose.tsx` (affordance):** one renderer of the close control — `variant="corner"` (inside top-right ×) and `variant="slideover"` (desktop hover-left ×, anchored via the shared `PANEL_CLOSE_RIGHT` table or an `anchorRight` override). `forwardRef` + prop-spread so it drops into `<DialogPrimitive.Close asChild>`.
- **Adopted by all hand-rolled overlays:** `BottomSheet` (keeps its fixed height + all 4 close methods — ×/swipe/backdrop/Esc — now from the hook), `FloatingDetailPanel` (stays non-modal on desktop: no scroll-lock/focus-trap; keeps its 420px/`--blanc-layer-width` widths via `anchorRight`), `FullscreenImageViewer` (Esc+scroll-lock; keeps arrow/zoom keys), `AIAssistantModal` (Esc+backdrop, **gains** scroll-lock). `ui/dialog.tsx` keeps Radix's native Esc/scroll-lock/focus and only adopts the shared `OverlayClose` affordance. `TwoFactorGate` stays intentionally non-dismissible. Decisions: sheets keep all 3 affordances; Radix keeps its own behavior; all hand-rolled overlays unified.
- **Net:** removed ~330 lines of duplicated close boilerplate; deleted the dead `.blanc-floating-close-*` CSS. Independent review APPROVED (after fixing a panel-width regression — panels are NOT resized). `npm run build` green; dev-preview confirmed a bottom sheet still closes via × / swipe / backdrop / Esc at its fixed height, app error-free. Frontend-only, no backend/migration. Cosmetic side-effects to confirm: centered-modal × now uses the shared soft-pill look.

---

## 2026-06-29 — SHEET-CANON-001: one canonical mobile BottomSheet (guaranteed-equal heights)

Mobile bottom sheets rendered at inconsistent heights. Root cause: **two parallel mechanisms** that shared no code — a real `ui/BottomSheet.tsx` component (used only by Schedule "View options") and a hand-rolled `.blanc-mobile-sheet` CSS class copy-pasted across ~9 sheets — and **every one of them was content-driven `max-height`**, so a filter sheet with many rows and one with few rows were genuinely different heights no matter the cap. (The earlier 70→85vh cap bump couldn't fix that.)

- **Canonical component:** evolved `ui/BottomSheet.tsx` into the single source of truth — `size` variants where **`standard`/`full` are a FIXED `dvh` height** (`var(--blanc-sheet-h, 85dvh)` / `92dvh`) so any two standard sheets are pixel-identical, with the body scrolling internally (flex column, `min-height:0`). `auto` stays content-sized (capped) for small action menus. Unified `dvh` (was `vh` — fixes the iOS URL-bar resize), radius (22px), animation (`blancSlideUp`), backdrop colour, z-index (190/200), plus drag-to-dismiss, focus trap/restore, body-scroll-lock, SSR guard.
- **Migrated all 9 sheets** to it (mobile branch only — desktop popovers byte-for-byte untouched): Jobs/Leads/Payments **filters** + Jobs "Visible Fields" → `standard`; Payments/DateRange **date pickers** → `full`; Snooze / Assign owner / Quick messages → `auto`. The Schedule/Jobs/Leads "View options" bars are explicitly `standard`.
- **Removed** the `.blanc-mobile-sheet` / `-header` / `-backdrop` CSS (kept the `blancSlideUp`/`blancFadeIn` keyframes, still used by `dialog.tsx`). FORM dialogs (`ui/dialog.tsx`) are a separate canon — untouched, only share tokens.
- **Proof:** dev-preview at 375×812 — Jobs / Leads / Schedule "View options" all measure **690px (0.850 × viewport)**, identical, where they previously varied. Independent review APPROVED (height guarantee confirmed structurally; no z-index occlusion in the 9). `npm run build` green. Frontend-only, no backend/migration. Note: Schedule's sheet animation/radius shifted (0.22s/28px → 0.25s/22px) — intentional, now matches the system.

---

## 2026-06-29 — JOBS-UX-RBAC-001: mobile UX polish + technician finance access

Six related changes (one orchestrated pass, independently reviewed — verdict APPROVED, 0 blockers). Spec: `docs/specs/JOBS-UX-RBAC-001.md`.

- **SHEET-HEIGHT-001** — mobile filter/settings sheets were inconsistent (Schedule "View options" = 85vh `BottomSheet`; Jobs/Leads filters = 70vh `.blanc-mobile-sheet`). Raised `.blanc-mobile-sheet` `max-height` 70vh→**85vh** to match Schedule; dropped the now-redundant DateRange inline override. It's a *max*-height, so small dropdowns (Snooze/Quick-Messages/etc.) are unaffected.
- **TILE-CITY-001** — the full address took its own row in the mobile job tile **and** was a Google-Maps link → techs mis-tapped it instead of opening the job. Now the tile shows **"Customer, City"** on one line after the title as plain text (no Maps link), and the title + name·city lines are unified to one size / lighter weight (more air, fewer lines). New backend `jobs.city` column (migration **137**) populated from Zenbooker sync (`service_address.city`) + structured create, refreshed on re-sync (COALESCE), with a heuristic backfill for existing rows; exposed on `LocalJob` + `ScheduleItem`. Applies to `JobMobileCard` + the `ScheduleItemCard` **agenda** layout (classic untouched).
- **PROVIDER-FINANCE-001** — the Technician (`provider`) role is now **full self-serve finance**: view payments + financials, view/create/**send** estimates & invoices, and **collect** (online link / offline / keyed / terminal). **No refunds.** Seeded in `050` (covers new companies via the onboarding bootstrap) + backfilled to existing companies in migration **138** (idempotent). Unlocks the Finance tab + Payments nav for techs; job visibility stays scoped to their own jobs.
- **SOURCE-PERM-001** — new permission **`lead_source.view`** (granted to Admin/Manager/Dispatcher, **denied to Technician**) hides the lead/job marketing **source** — both display (job/lead tiles, detail headers, tables — header *and* cell) and the source **filter** column (Jobs/Leads/Schedule) — from anyone without it.
- **JOB-ACTIONS-SLIM-001** — the job card's status actions were three stacked layers (primary buttons + plain-text secondary links + an all-statuses "quick buttons" row). Slimmed to a curated set of **framed primary buttons per state** — Submitted → [On the way] + [Start job]; En-route → [Start job]; In Progress → [Complete job] — and removed the secondary text-links + the quick-buttons row. Cancel and any non-standard transition stay available via the existing status dropdown under the job title. Shared mobile + desktop.

Backend Jest: `tests/providerFinanceRbac.test.js` (14) + `tests/jobsRbacGates.test.js` regression (12) — 26/26 green; provider blocked from `payments.refund`. `npm run build` green. Backend + migrations 137/138 (no schema risk; both re-runnable). Not yet deployed.

---

## 2026-06-29 — RBAC-FSM-FIX-001: technicians can operate their jobs + role-model audit

Owner-reported 403s. Two things: (1) the reporter (`a5085140320`) is a **tenant_admin** whose
403 was an **onboarding race** — the account existed ~40 s before the company's role configs
were seeded, resolving to 0 perms in that window (verified on the live resolver; a re-login fixes
their client). (2) The real bug: the **Technician (`provider`) role genuinely can't operate jobs.**

- **Provider FSM/notes gates (jobs.js):** `start` / `enroute` / `PATCH /:id/status` and notes
  `POST`/`PATCH`/`DELETE /:id/notes` required `jobs.edit` (which `provider` lacks) — only
  `complete` had the provider-friendly gate. Now all accept `requirePermission('jobs.edit',
  'jobs.done_pending_approval')`. Handlers already scope to the assignee (`getProviderScope` →
  404 on a foreign job) and note edit/delete stay author-only (`notesMutationService`), so a tech
  can run/annotate **only their own** job. Managers/dispatchers/admins are unaffected (they have
  `jobs.edit`).
- **Cancel stays dispatch-only:** the `/status` closing guard was **split** — `Canceled` requires
  `jobs.close`; `Job is Done` allows `jobs.close` OR `jobs.done_pending_approval`. An adversarial
  review caught a **parallel side-door** (`fsm.js POST /:machineKey/apply`) with the old un-split
  guard that let a `dispatcher` cancel — mirrored the split there too.
- **Resolver lockout fix (authorizationService.js):** `resolveEffectivePermissionsAndScopes` no
  longer early-returns `[]` on a missing role config — the MANDATORY_ADMIN baseline still applies
  for `tenant_admin` (never 0-perms / locked out of their own company).
- **Audit:** full 4-role × main-entity gate matrix in `docs/specs/RBAC-FSM-FIX-001.md` — the only
  false-403s were the provider FSM + notes gaps (fixed); `tasks` PATCH/DELETE's `tasks.view` gate
  is correct (inner `canActOn` enforces own/manage); no over-grants found.
- **Tests:** `tests/jobsRbacGates.test.js` (provider start/enroute/status/done pass, cancel blocked,
  view-only blocked, `/apply` cancel side-door blocked, resolver baseline) — 12; regression suites
  green. Backend-only, no migration (providers already hold `jobs.done_pending_approval`). Deploy:
  app rebuild (frontend bundle unchanged).

---

## 2026-06-29 — LAYER-CLOSE-CANON-001: one slide-over close affordance (hover-left)

Every slide-over "layer" now closes the SAME way — a hover-reveal × to the **left, outside** the panel (the
`FloatingDetailPanel` pattern). The inside top-right × on desktop is gone; it remains only for the mobile
bottom-sheet and for genuinely centered modals.

- **`ui/dialog.tsx` (`variant="panel"`):** the hover-left close now renders for **all** panel sizes
  (previously only default/sm), with `right` anchored to the panel's actual width so it sits just outside
  the left edge even on the full-width document editors. The inside top-right × is now `md:hidden` for **all**
  panel sizes (desktop hidden, mobile sheet keeps it). This fixes the Estimate/Invoice editors + Estimate
  preview (`size="full"`) and unifies every form dialog (New job, task, etc.).
- **Hand-rolled drawers → `FloatingDetailPanel`:** `RoutingLogsPage` "Call Details" (read-only) and
  `AutomationPage`'s rule-editor + run-history drawers dropped their bespoke `position:fixed`/backdrop/×
  markup and now render inside `FloatingDetailPanel` (hover-left, ESC, adaptive width).
- Centered modals (User Groups, Workflow Builder) keep the conventional top-right × — they're not slide-over
  layers. Frontend-only, no migration; `npm run build` green; dev-preview confirmed (desktop: hover-left
  shown, inside × hidden; mobile flips).

---

## 2026-06-29 — ZIP normalization made consistent across services (0a3830c follow-up)

The leading-zero ZIP fix (0a3830c) only normalized inside `vapi-tools.js`, so other service-area lookups
still missed on a dropped zero. Promoted `normalizeZip` to a shared util (`backend/src/utils/zip.js`) and
applied it **inside the service-territory query layer** (`serviceTerritoryQueries.findByZip`/`search`/
`create`/`bulkReplace`/`remove`) — so **every** caller now recovers a dropped leading zero, not just
vapi-tools. This fixes `GET /api/zip-check` (the SPA serviceability check), which previously passed the raw
zip (`"1721"`) straight to the exact-text lookup and silently missed `"01721"`. `vapi-tools.js` now imports
the shared util (deduped). Also fixed a **stale test**: `vapi-tools.test.js` "zip outside service area"
expected `{inServiceArea:false}` but the fix correctly echoes the normalized `{inServiceArea:false,
zip:"03801"}`. No migration; backend-only. New `tests/serviceTerritoryZip.test.js`; route suite 22/22 green.

---

## 2026-06-29 — NOTE-ATTACH-UPLOAD-001: pre-upload note attachments with progress

Fixes the silent ~30s freeze when adding a note with a file (the file used to upload at submit, with the
button merely disabled + no feedback). Now files **upload immediately on attach** (staged), show a **spinner**
per file, and **"Add note"/"Save" is disabled until uploads finish** — for both the new-note composer and the
edit flow, all entities (job/lead/contact), mobile + desktop.

- **Backend:** new `POST /api/note-attachments/upload` stages files to S3 with `note_index = NULL` (the
  staged marker — excluded from display). `noteAttachmentsService`: `stageAttachments`,
  `associateStagedAttachments` (note-create/edit stamps `note_id`+`note_index` onto staged rows; ignores
  foreign ids), `getAttachmentsForEntity` excludes staged, `deleteStaleStagedAttachments` + `entityExistsInCompany`.
  Note POST/PATCH on jobs/leads/contacts + `notesMutationService.editNote` accept `attachment_ids` (associate)
  with the raw-files path kept as fallback. **No migration** (reuse nullable columns). Company-isolated.
- **Cleanup:** removing a file deletes it immediately (`DELETE /api/note-attachments/:id`); a new
  `stagedAttachmentCleanupScheduler` (6h) sweeps abandoned staged rows (>24h) + their S3 objects.
- **Frontend:** new `services/noteAttachmentsApi.ts`; `NoteAttachmentInput` uploads on attach (spinner /
  error+retry / remove), reports staged ids + a `blocked` flag; `NotesSection` gates submit on `blocked`,
  sends `attachment_ids`, and no longer collapses the composer mid-upload.
- **Verify:** backend Jest 22/22 (stage/associate/exclude/cleanup/route isolation), existing note suites
  green; `npm run build` green; dev-preview confirmed (attach → "Uploading…" spinner + filename chip,
  "Add note" disabled during upload, composer stays open).

---

## 2026-06-29 — TASKS-FORM-PANEL-001: task form as a right-side panel

The New/Edit Task form (`TaskFormDialog`) now opens as a **right-side slide-out layer**
(`<DialogContent variant="panel">`) — the same mechanic as estimate creation — instead of a centered modal,
for **both** create ("New task") and edit (pencil) modes. Fields adopt the FORM-CANON floating-label style
(`FloatingField` description textarea, `FloatingSelect` assignee, `FloatingLabel`-wrapped date+time). All
behavior unchanged (required description, self-default assignee, deadline → ISO in company TZ, Delete on
edit, toasts); no prop/contract change, callers untouched. Frontend-only; `npm run build` green;
dev-preview confirmed the panel renders with floating labels. Spec: `docs/specs/TASKS-FORM-PANEL-001.md`.

---

## 2026-06-28 — TASKS-001: cross-entity Tasks (no standalone card)

A **Task** = assignee + deadline (date **and** time) + description, always attached to **one** parent
(Job / Lead / Contact / Estimate / Invoice) with **no standalone view**. Spec: `docs/specs/TASKS-001.md`.

- **In the parent card:** tasks render as a **stack** pinned at the top of the Notes feed (Job/Lead/Contact,
  via shared `NotesSection`) with an **"Add task"** button beside "Add note"; on Estimate/Invoice (no notes
  feed) the same stack is a compact block near the top. One task → a card; many → a stack that **expands on
  click**. Per task: **Done** (optimistic + undo), **Snooze** (15 min / 1 h / 3 h / tomorrow 08:00 / pick a
  date → 08:00, company TZ — reschedules `due_at`), and a **pencil** edit dialog.
- **Global `/tasks` page** (new nav tab, gated `tasks.view`): cross-entity list grouped by due bucket
  (Overdue/Today/Tomorrow/This week/Later/No date); clicking a row opens the **parent entity's card**
  (jobs/leads/contacts by path, estimates/invoices via the existing `?openId`). Mobile = date-grouped tiles.
- **Data:** migration **136** extends the existing `tasks` table (job/lead/estimate/invoice FK +
  `author_user_id` + indexes; `contact_id` already existed; **no breaking CHECK**). Task text lives in the
  NOT NULL `title` column, exposed to the API as `description`.
- **RBAC:** new `tasks.view` / `tasks.create` / `tasks.manage` — seeded for existing companies (136) **and**
  new-company bootstrap (`050`), + added to `permissionCatalog.js` so the Roles & Access editor lists them.
  Provider (Technician) gets view+create and acts on **own** tasks; manage ⇒ see/act on all. Visibility:
  `tasks.manage` → all company tasks, else own (assigned).
- **API:** new `routes/tasks.js` (`/api/tasks`) — `GET /` (role-scoped list), `GET /assignees`,
  `GET /entity/:type/:id`, `POST /`, `PATCH /:id`, `DELETE /:id`; all `company_id`-scoped, foreign id → 404,
  exactly-one-parent enforced in-app, author/owner = `crmUser.id`. New `db/tasksQueries.js`.
- **Verify:** backend `tests/routes/tasks.test.js` **23/23**; full route suite **223/223**; R4 suite 15/15
  (catalog edit non-breaking); frontend `npm run build` (tsc -b strict) green; dev-preview verified (Tasks
  page renders grouped rows + Done/Snooze, snooze popover shows the 5 presets, no console errors). Independent
  adversarial backend review APPROVED after fixing the new-tenant seeding gap (the `050` addition above).

---

## 2026-06-29 — JOB-TECH-ASSIGN-001: reassign the technician from the Job card (no reschedule)

Owner: changing a job's technician used to require the **Reschedule** flow, which also
moves the appointment time. Now the technician can be assigned / changed / unassigned
straight from the job-detail card, leaving the schedule untouched.

- **Frontend:** new `JobTechnicianControl` (a "Change"/"Assign" button → popover with a
  **searchable** technician list + an **Unassign** row that asks to confirm) replaces the
  read-only "Providers" block in `JobInfoSections`. Gated on `schedule.dispatch` (non-
  dispatchers see the tech read-only); optimistic update + parent refresh. New
  `hooks/useProviders.ts` (lazy `/api/zenbooker/team-members`). Desktop + mobile; not on list tiles.
- **Backend (two bugs fixed in the reused reassign path — they also hit the Schedule
  drag-reassign):** `scheduleQueries.reassignJob` **appended** the new tech (and stored a
  nameless `{id}`) instead of replacing → reassigning an already-assigned job accumulated
  stale, unnamed techs. Now it **replaces** with exactly `[{id,name}]` (or `[]` to unassign);
  the display name is threaded through `reassignItem`/the route/`scheduleApi`. And the
  reassign route rejected `assignee_id: null`, so **Unassign was impossible** — now `null`
  is the explicit unassign sentinel (only a *missing* field is a 400). Never touches `start_at`/`end_at`.
- **Tests:** `tests/scheduleReassign.test.js` (replace / null-unassign / name) + updated
  `tests/scheduleRoute.test.js` (name threading, null→200, missing→400); 12 green. Frontend
  build green; independent review found+confirmed both backend bugs (fixed). Spec:
  `docs/specs/JOB-TECH-ASSIGN-001.md`. Deploy: app rebuild (frontend bundle changed → logout-all).

## 2026-06-28 — RBAC-ROLES-EDITOR-001 (RBAC-AUDIT-001 Wave 2 / R4): in-app access-grid editor

Closed the one missing piece from the audit: the role matrix + per-member overrides existed as data +
resolution but had no editor. New desktop-only **Settings → Roles & Access** page (gated `tenant.roles.manage`).
No DB migration (tables 046/047 already exist).

- **Backend:** new `services/permissionCatalog.js` (runtime `PERMISSION_CATALOG` for the 56 seeded permission
  keys, grouped by area + labels — single UI source) + new gated route `routes/rolesPermissions.js`
  (`/api/settings/roles`): `GET /` (catalog + per-role permission maps, lazy-seeds role configs),
  `PUT /:roleKey/permissions` (toggle a role permission — **rejects the locked Admin role** + validates the
  key), `GET /members`, `PUT /members/:membershipId/overrides` (per-user allow/deny/clear). Added
  `roleQueries.setRolePermission` + `ensureRoleConfigs`, `membershipQueries.setPermissionOverride`,
  `userService.listUsers` membership_id. Writes use `crmUser.id`; all tenant-scoped; audited.
- **Frontend:** `RolesAccessPage` — **Roles** tab (permission×role matrix, Admin column locked, optimistic
  toggles) + **People** tab (per-member tri-state Inherit/Allow/Deny overrides); desktop-only (mobile notice).
  New `services/rolesApi.ts`, route in App.tsx, gated nav item.
- **Guards (reviewer-verified):** Admin uneditable; cross-tenant isolation (no IDOR); **last-admin lockout
  impossible** (resolver always re-adds MANDATORY_ADMIN_PERMISSIONS); resolver/seeds untouched. Edits apply
  on the affected user's next request (no cache). Backend test 15/15; full route suite 200/200; frontend
  build green. Spec: `docs/specs/RBAC-ROLES-EDITOR-001.md`.

---

## 2026-06-28 — RBAC-AUDIT-001 (Wave 1): role-system audit + hardening

Audited the RBAC system (4 preset roles tenant_admin/manager/dispatcher/provider, 42 permissions, 5 scopes,
per-company role configs + per-member overrides). Verdict: **core is solid** — roles seeded + resolve;
business routes (payments/invoices/estimates/leads/jobs/contacts) heavily permission-gated + company-scoped;
recent features respect RBAC; the mobile reworks did not regress gating. Audit report: `docs/specs/RBAC-AUDIT-001.md`.

Wave 1 remediation (R1 UI gating + R2 hardening + R3 route gating):
- **R1 (frontend):** permission-gate action buttons so a role doesn't see actions it can't perform —
  Create Lead (`leads.create`), New Job (`jobs.create`), Send estimate/invoice (`estimates.send`/
  `invoices.send`), Collect/Record payment (`payments.collect_online|offline`); desktop + mobile.
- **R3 (backend) — add `requirePermission` to authed-but-ungated routes** (matches their frontend route
  gating; over-gating reviewed — no legit role loses access): telephony admin (overview/provider/
  phoneNumbers/callFlows/userGroups[except GET /my]/phoneSettings) → `tenant.telephony.manage`; `vapi` →
  `tenant.integrations.manage`; `quick-messages` + `text-polish` → `messages.send`; `notification-settings`
  PUT → `tenant.company.manage` (GET left open for the SSE bridge).
- **R2 (hardening):** `vapi-tools` now **fails closed** (503 when `VAPI_TOOLS_SECRET` unset, was open
  "dev mode"). `crmMcpPublic` reviewed = **already protected** (env-flag + timing-safe bearer + company/user
  scope + write-gating); no change.
- Backend suite green for affected routes (6 route-test mocks updated to grant the new permissions; the 21
  pre-existing unrelated failures are unchanged). Frontend `npm run build` green. Reviewer APPROVED.
- **Deferred → Wave 2:** R4 (in-app editor for the access grid — role permission matrix + per-member
  overrides; schema/resolution exist but no edit API/UI yet). Frontend-only Wave 1, no migration.

---

## 2026-06-28 — LEADS-MOBILE-001: mobile Leads view (tiles + one-gear filters)

The Leads twin of JOBS-MOBILE-001. On mobile the Leads page rendered the desktop `<table>` (horizontal
scroll); reworked the **mobile** view (desktop ≥768 untouched) to tiles + a one-gear bottom-sheet.

- **Tiles** grouped by **created date** (Today/Yesterday else date; null → "No date") — new
  `components/leads/LeadMobileCard.tsx`: **name (hero) → phone → "Job type · Source"**, a **worded status
  chip** top-right (`getLeadStatusPillStyle`/`LEAD_STATUS_COLORS`), **left border = status color**, no
  id/email/address, no call button (tap opens the lead detail); `LeadLost` → dimmed. New
  `components/leads/LeadsMobileList.tsx` (grouping + **"Load more"**).
- **One gear ⚙** → `ui/BottomSheet` "View options" — new `components/leads/LeadsMobileBar.tsx`: search in
  the header; sheet holds status/source/job-type filters + date range + only-open toggle + sort
  (Created/Name/Status) + reset + New lead.
- **Desktop-safe refactor:** extracted `components/leads/LeadsFilterBody.tsx` (shared by desktop
  `LeadsFilters` + the mobile sheet — behavior-preserving). `LeadsPage.tsx` branches on `useIsMobile`;
  added `loadMoreLeads()` (append via `offset: leads.length`; desktop `loadLeads`/offset-effect/prev-next
  untouched); date grouping uses `company?.timezone`.
- Tap a tile → existing lead detail (`/leads/:id`). Frontend-only, no backend/migration. `npm run build`
  (tsc -b strict) green; reviewer APPROVED (desktop no-regression verified). **Verified on dev preview**
  (tiles grouped by date + worded status chips + the filter bottom-sheet). Spec:
  `docs/specs/LEADS-MOBILE-001.md`. Tests deferred — no frontend component-test harness.

---

## 2026-06-28 — JOBS-MOBILE-001: mobile Jobs view (tiles + one-gear filters)

On mobile the Jobs page rendered the desktop `<table>` (horizontal scroll, unusable on a phone). Reworked
the **mobile** view (desktop ≥768 untouched) to mirror the Schedule mobile pattern; techs can now read jobs
on a phone.

- **Tiles instead of a table** (`useIsMobile` branch in `pages/JobsPage.tsx`): jobs **grouped by date**
  (Today/Tomorrow/Yesterday else `EEE, MMM d`; null `start_date` → trailing "No date" group) rendered as
  Schedule-style tiles — new `components/jobs/JobMobileCard.tsx`: time hero → service → customer → address
  (same size), technician + colored status dot (`BLANC_STATUS_COLORS`) top-right, 4px left provider border,
  **no job number**, plus a **payment pill** (Paid/Partial/Unpaid · $total) gated by finance permission + a
  real `invoice_status` (draft/void show no pill). New `components/jobs/JobsMobileList.tsx` (grouping +
  **"Load more"**).
- **One-gear toolbar** — new `components/jobs/JobsMobileBar.tsx`: title + search + a single gear ⚙ →
  `ui/BottomSheet` "View options" holding all secondary controls (filters, date range, sort, reset, export,
  New job). Filters reset each session (no persistence); default shows ALL jobs.
- **Shared, desktop-safe refactor:** extracted the filter UI into `components/jobs/JobsFilterBody.tsx` (used
  by both desktop `JobsFilters` and the mobile gear sheet — behavior-preserving). `hooks/useJobsData.ts`
  gained `loadMoreJobs()` (append; desktop prev/next `loadJobs` untouched) + a once-only mobile
  `start_date desc` default sort (ref-guarded; never affects desktop).
- Tap a tile → existing job detail (`/jobs/:id`). Frontend-only, no backend/migration. `npm run build`
  (tsc -b strict) green; reviewer APPROVED (desktop no-regression verified). Spec:
  `docs/specs/JOBS-MOBILE-001.md`. Tests deferred — the frontend has no component-test harness.

---

## 2026-06-27 — SCHED-TILE-001: Schedule job-tile recomposition (agenda layout)

Owner feedback: a job tile in the calendar list had too many rows in a weak order (job# → status →
title → time → …). Recomposed into a **timeframe-led** card — applied to the **mobile agenda** and the
**desktop List view** only; all time-positioned views (day-grid, timeline, week, month) untouched.

- New `layout` prop on `components/schedule/ScheduleItemCard.tsx`: `'classic'` (default — today's exact
  rendering, byte-for-byte, everywhere it's already used) and `'agenda'` (additive early-return branch).
  Plus `detailed?` (desktop List adds a customer-phone row).
- Agenda composition: **timeframe = hero (largest, top-left)** → title → customer → address (customer &
  address same 13px size). **Technician name + small colored status dot top-right** (status Variant A);
  the left 4px border keeps the technician color. Job number, the uppercase status line, subtitle, and
  the geocoding hint are dropped from this layout (all remain in the JobDetailPanel / classic views).
- Edge cases: no time → title becomes the hero; missing customer/address/phone → row omitted (Blanc:
  no empty placeholders); `Unassigned` when no tech; status dot omitted when no status; Maps + `tel:`
  links keep `stopPropagation`; tap-to-open + Enter/Space preserved.
- Call sites changed: DayView mobile branch (`layout="agenda"`) and ListView (`layout="agenda" detailed`).
- Frontend-only, no backend/migration. `npm run build` (tsc -b strict) green; reviewer APPROVED.
- Spec: `docs/specs/SCHED-TILE-001.md`. **Test deviation:** the spec's Jest+RTL cases were not written —
  the frontend has no component-test harness (no RTL/jsdom/vitest); verified by strict build + adversarial
  review. Adding a frontend test harness is a separate infra follow-up.

---

## 2026-06-27 — SCHED-MOBILE-002: mobile Schedule week strip (date navigation)

Follow-up to SCHED-MOBILE-001 (owner feedback): the standalone **Today button confused** — it sat on
screen on every date, so you'd read "Today" while looking at another day. Replaced the `‹ / Today / ›`
row with a swipeable **7-day week strip** (mobile only; desktop untouched).

- New `WeekStrip` (`components/schedule/WeekStrip.tsx`): one row of 7 day cells (Sun→Sat) — weekday label,
  a **day-of-month circle**, and a **job-count caption**. **Selected day = filled accent circle**
  (`--sched-job`); **today = thin accent ring** (distinct even on different days). **Tap** a day to load
  its agenda; **swipe** left/right to page weeks — swiping changes only the **visible** week, the selection
  stays put until you tap (a swipe can't accidentally select — the synthesized click is swallowed).
- New `useWeekJobCounts` (`hooks/useWeekJobCounts.ts`): fetches the visible 7-day range with the same
  filters as the agenda, applies the **same provider/tag filter**, and buckets scheduled items by
  **company-TZ day** (`dateKeyInTZ`) → per-day counts that match what each day shows when tapped.
  Client-side, best-effort (error → no counts). **No backend, no migration.**
- `MobileScheduleBar`: the big date headline is now a **button — tap returns to today** (and snaps the strip
  to today's week); a subtle ↺ affordance shows only when off-today. The old nav row + total-count pill are
  gone. Refactor: the agenda's provider/tag filter was extracted to a shared pure
  `services/scheduleFilters.ts#filterItemsByProviderTags` (used by both the hook and the strip; behavior
  identical → desktop unaffected).

Frontend-only; `npm run build` green (strict); independent review APPROVED (extraction byte-identical,
desktop provably untouched, counts/today-marker consistent with the existing DayView agenda).
Spec: `docs/specs/SCHED-MOBILE-002.md`. Deploy: app rebuild + logout-all (bundle changed).

## 2026-06-27 — SCHED-MOBILE-001: mobile Schedule reworked for the field technician

Mobile-only Schedule rework (desktop unchanged). On a phone the toolbar is now just the
**date as the hero** (large) + ‹ Today › nav + a single **gear ⚙** button; below it the
existing clean job-list agenda. Every secondary control — search, filters, technician
selector, reset, and (dispatch-only) New job / AI Assistant / Settings — moved into a new
**bottom-sheet** (`ui/BottomSheet.tsx`) that slides up full-width (max 85vh + scroll, safe-
area), fixing the old filters popover that ran off-screen (fixed 520px, right-anchored).
The giant page title and the Unscheduled drag-panel are hidden on mobile (dispatch chrome).
`CalendarControls` was refactored to share `ScheduleFilterBody`/`ScheduleProviderChips`
between the desktop popover and the mobile sheet (same filter/provider/search state — no
duplication). New `MobileScheduleBar`. All behind `isMobile`; reviewer APPROVED, build green.

## 2026-06-27 — MOBILE-NO-SOFTPHONE-001: hide the browser softphone on mobile

The softphone is a Twilio WebRTC Device — unreliable on mobile browsers (backgrounded/locked tab drops
registration → no ring; flaky audio). On mobile it only caused confusion (warm-up modal on every
load/login + a non-working incoming-call screen). Decided to disable it on mobile; desktop unchanged.

- `AppLayout.tsx`: `softPhoneEnabled = !isMobile && …` (reuses `useIsMobile`, bp 768). On mobile this
  fully disables it — **Twilio Device never registers** (no token/register/getUserMedia), no nav button,
  no warm-up modal, no incoming auto-open; the `<SoftPhoneWidget>` render is also gated on `!isMobile`.
  (Verified the Device tears down via `destroy()` if the viewport flips desktop→mobile.)
- `ClickToCallButton`: on mobile the per-row "Call" button opens the **native dialer** (`tel:`) instead of
  the dead in-browser softphone (so you can still call from your phone); desktop keeps the in-app dialer.

Frontend-only; no backend/Twilio/Keycloak/DB change. `npm run build` green; reviewer APPROVED (desktop
byte-for-byte unchanged; no other softphone UI on mobile). Deploy: app rebuild + logout-all.

## 2026-06-27 — AUTH-SESSION-001: stay logged in on mobile (30-day Remember Me)

Owner: mobile browser logged out after ~5 min of backgrounding. Root cause: `rememberMe=false` →
Keycloak's SSO identity cookie was a non-persistent **session cookie**, which mobile browsers drop when
they discard a backgrounded tab → cold reload finds no session → login. (The 5-min timing is the
`accessTokenLifespan`, which is fine and stays at 300s.)

- **Keycloak realm (crm-prod):** `rememberMe=true`, `ssoSessionIdleTimeoutRememberMe` +
  `ssoSessionMaxLifespanRememberMe` = **2592000 (30 days)**. Applied live via kcadm; mirrored in
  `keycloak/realm-export.json` for fresh imports. A remembered session now sets a **persistent** cookie
  that survives mobile background/restart.
- **Login theme** (`login.ftl`): the "Remember me" checkbox is **default-checked** so users get the
  persistent 30-day session automatically.
- **Frontend** (`AuthProvider.tsx`): on tab resume (`visibilitychange`/`focus`) the Keycloak token is
  refreshed immediately, so a woken mobile tab never calls the API with an expired token (complements the
  existing 30s interval + onTokenExpired + apiClient 401-refresh).

**Tradeoff:** a 30-day persistent session means a lost/shared device stays logged in for 30 days
(accepted). Access tokens stay short (5 min). **One more login is needed** to mint the new persistent
cookie (deploy does a logout-all). Frontend build green; no DB migration.

## 2026-06-27 — ADDR-UX-001: base-address entry UX fix (Company + technician base)

Owner-reported: the base-address editors **auto-saved** the instant you picked a Google suggestion (no
chance to add an apt/unit), and on **Edit** showed the saved address as a string with an empty form below.

Root cause: the base editors MISUSED the (otherwise-correct controlled) `AddressAutocomplete` — passing a
constant `value={EMPTY_ADDRESS}` + `onChange={save}` (commit-on-coords), and storing only a composed
string + lat/lng (mig 125, no structured fields). Lead/job/contact forms use it correctly — left alone.

- **Frontend:** new shared `BaseAddressForm` holds a `draft: AddressFields`, renders the controlled
  autocomplete (no auto-save), with explicit **Save / Cancel**. `CompanyBaseAddress` + the per-tech base
  editor (`TechnicianPhotosPage`) now pre-fill the form on Edit (structured-first; `parseDescription`
  fallback for pre-migration string-only rows), keep the Apt field editable until Save, and surface a
  geocode-fail 422 as a toast while staying in edit. `addressAutoHelpers.fieldsFromStored` does the pre-fill.
- **Backend:** migration **135** adds `technician_base_locations.{street,apt,city,state,zip}` (additive);
  the upsert/list persist + return them. Manual entry (no Google pick → lat/lng null) **geocodes on save**
  (existing fallback); geocode-fail → 422 `GEOCODE_FAILED` (no row written). lat/lng/string/label kept for
  the slot-engine.

**Tests:** `tests/baseLocationStructured.test.js` (12) + existing tech-base/slot-engine/jobsEta (140) =
152 green; frontend build green. Reviewer APPROVED. Deploy: migration 135 + app rebuild + logout-all.

## 2026-06-27 — COMPANY-PROFILE-001: editable Company Profile in Settings

Owner couldn't change the company name that goes out in the "on the way" SMS, and wanted a real
company profile (name, contacts, address, logo, bank details).

- **Settings → Company** (`/settings/company`) is now a full profile editor (was address-only):
  company **name** (flows into the ONWAY customer SMS — `jobs.js` already reads `companies.name` —
  and into email subjects), contact email/phone, billing email, the existing address block, a
  **logo** upload (S3 via storageService, mirrors technician photos), and **bank/payment details**
  (bank name, account name, account number, routing, SWIFT, free-text instructions).
- Backend: tenant-scoped `GET/PATCH /api/settings/company-profile` + `POST .../logo`
  (`companyProfileService`, permission `tenant.company.manage`, whitelisted fields — never status/
  company_id/keys). Migration **134** adds `companies.logo_storage_key` + `payment_*` columns.
- **Documents source-of-truth:** `documentTemplatesService.resolveTemplate` now overlays the company
  profile brand (name/address/email/phone/logo/ach) onto the **factory** descriptor, so a tenant
  without a custom template gets its real brand on invoices/estimates instead of the "ABC Homes /
  Bank of America" placeholder. **A stored template still wins** ("templates can override") — so
  Boston Masters' invoices keep their "ABC Homes" DBA; only the SMS/display name follows the profile.
  Overlay only applies non-empty fields and safe-fails (never throws / never mutates the frozen factory).
- Fixed a stale `documentTemplatesService` test (`invoice` is a registered type since SEND-DOC-001;
  now asserts a genuinely-unknown type → null).

**Tests:** `tests/companyProfile.test.js` (13) + `documentTemplatesService` (14) green; frontend
build green. Pre-existing unrelated failures (PDF `@react-pdf/renderer` ESM-in-Jest, etc.) untouched.
Deploy: migration 134 + app rebuild + logout-all (frontend changed).

## 2026-06-27 — ZB-ISO-001 (SECURITY): fix Zenbooker cross-tenant data leak

**Owner-reported, P0.** The Schedule technician quick-filter showed technicians from
*another* company. Root cause: `zenbookerClient.getClientForCompany()` fell back to the
shared env `ZENBOOKER_API_KEY` (the default/Boston-Masters account) for **any** tenant
without its own key, so every tenant saw the default account's team — and, via the same
fallback, its jobs/services/territories/timeslots. `GET /api/zenbooker/team-members` made it
worse by not passing `companyId` at all.

Fix (`backend/src/services/zenbookerClient.js` + routes):
- The shared env key now belongs to ONE company — `ZENBOOKER_DEFAULT_COMPANY_ID` (env,
  default = seed company `…0001`). `getClientForCompany` returns the env client **only** for
  that company; any other tenant without its own `zenbooker_api_key` gets **null** (no
  cross-tenant fallback).
- Callers degrade safely: `getTeamMembers` → `[]`; `/api/zenbooker/team-members` now passes
  `companyId`; `POST /api/jobs/sync` no-ops with a clear message; `GET /api/integrations/
  zenbooker/jobs` (customer jobs) uses the company client (was global) → `[]` for non-connected
  tenants. The default company (Boston Masters) is unaffected.

**Note:** "jobs/leads empty on mobile" was NOT a bug — that session was logged into a different,
empty tenant; the leaked technician names made it look like the wrong company.

**Tests:** `tests/zenbookerTenantIsolation.test.js` (null for non-default, env only for default,
`[]` roster for non-connected) + 162 existing Zenbooker-caller tests green. No migration.
## 2026-06-27 — AUTH-FLOW-FIX-001: post-signup email-verify UX + 2FA SMS loop & throttle

Owner-reported after a real prod signup. Spec: `Docs/specs/AUTH-FLOW-FIX-001.md`.

**2FA SMS loop killed (P0).** After onboarding, `phone_verified_at` was set but the device wasn't
trusted, so landing on `/pulse` returned `401 PHONE_VERIFICATION_REQUIRED` → the "Confirm it's you"
gate opened and **auto-sent an SMS**; a full-page reload re-mounted the gate → another SMS → loop.
Fixes: (1) `routes/onboarding.js` now **trusts the device** (sets the `albusto_td` cookie, same attrs
as trust-device) on signup completion → no immediate gate/2nd SMS; (2) `OnboardingPage` lands via
client-side navigation instead of a hard `window.location` reload; (3) `apiClient.rawFetch` +
`TwoFactorGate.authFetch` now send `credentials:'include'` so the trust cookie actually sticks on the
retry (was the root of the reopen loop on a cross-origin API base); (4) the gate auto-sends **at most
once per open** and treats `429` as a soft "wait" state.

**Escalating per-phone SMS throttle (R6).** `otpService.sendCode` replaces the flat 5/hr+30s with a
ladder counted per E.164 across purposes, **since the last successful verify** (1h idle reset): ≤3
sends keep the 30s base cooldown, then min-gap 1 min → 5 min → 15 min → 1 h before each further send.
Throttled sends return `429 { code:'OTP_RATE_LIMITED', message, retry_after_sec }`. `verifyCode` stamps
`verified_at` to reset the ladder. Migration **133** adds `phone_otp.verified_at`. Applies to both
`/api/public/otp/send` (signup) and `/api/auth/otp/send` (login).

**Email-verification UX (Keycloak `albusto` theme).** New `info.ftl` (calls the layout with
`displayMessage=false` → **no more duplicated text**; auto-proceeds past KC's "» Click here to proceed"
via meta-refresh + `location.replace`; terminal state is a branded "You're all set" success page with
a **"Sign in to Albusto"** button) + `login-verify-email.ftl` + `messages/messages_en.properties` +
`theme.properties` `appUrl`. "Why Albusto" benefits stay signup-only; product name stays Albusto.

**Tests:** `tests/otpThrottle.test.js` (ladder + reset-on-verify), updated `otpService.test.js` to the
new semantics; full backend suite + frontend `npm run build` green. Reviewer APPROVED-WITH-NITS (the
flagged stale test fixed; nits addressed). Deploy: backend rebuild + migration 133 + KC
`up -d --force-recreate` (theme gzip cache).

## 2026-06-27 — SEND-DOC-001: send Estimate/Invoice by email or SMS + Gmail→marketplace app

**Send (was a non-functional stub):** the "Send" button on the Estimate/Invoice view now actually delivers. A dialog (email | SMS, editable recipient + message) sends: **email** = the document **PDF attached** + a link to the online doc (`emailService.sendEmail`); **SMS** = text + link (`conversationsService`, wallet-gated). Status flips to `sent`+`sent_at` **only after dispatch succeeds** (fixes the invoice flip-first bug). Error matrix: 400 (recipient/channel), 409 `MAILBOX_NOT_CONNECTED` (→ connect CTA), 402 `WALLET_BLOCKED`, 422 `NO_PROXY`/`NO_PHONE`, 404/403.

**Estimate public page (new):** migration 131 `estimates.public_token`; public routes `GET /api/public/estimates/:token` (PII-safe view JSON) + `/pdf`; branded view-only SPA page `/e/:token` (mirrors the invoice pay page). Invoice link uses the existing `/pay/:token` pay page. `EstimateSendDialog` upgraded to `InvoiceSendDialog` parity; `JobFinancialsTab`/`LeadFinancialsTab` route through the dialog (no more empty-recipient sends).

**Gmail connect → marketplace app (declutter settings):** migration 132 seeds a `google-email` marketplace app; its connected-state is a backend overlay off the REAL mailbox (`marketplaceService`, no install row). Connect reuses the existing Google OAuth (callback now redirects to `/settings/integrations/google-email`). The standalone `/settings/email` route + nav item are removed (route → redirect; refs repointed; `mail-secretary` dependency_cta repointed); `EmailSettingsPage` → `GoogleEmailSettingsPage` under the marketplace.

**Tests:** 45 backend (public routes/tenant-safety, dispatch + status-after-success ordering for both docs, full error matrix, marketplace overlay) + frontend build green. Reviewer APPROVED. Migrations 131/132 run on deploy.

## 2026-06-26 — EMAIL-TIMELINE-001: email in the contact timeline

Email now lives in the same contact conversation as SMS and calls — inbound Gmail
lands on the timeline and replies go back out as email, with the composer routing
by channel. Run through the full orchestration (Product → Architect → Spec →
Test-cases → Planner → Implement → Test → Review).

### Follow-up — outbound emails on the timeline
- **Both sides now show.** Previously only inbound was linked (matched by `from_email`),
  so a contact's timeline showed one side of the conversation. Outbound emails — the
  agent's replies, **including ones sent directly from Gmail** — now land right-aligned
  on the contact's timeline, matched by **recipient** (`to_recipients_json` / `msg.to`)
  via the existing `findEmailContact`.
- New `emailTimelineService.linkOutboundMessage` mirrors the inbound linker but: matches
  by recipient (first match wins), **excludes drafts** (the `DRAFT` label is dropped — draft
  activity still creates **zero** timeline entries), sets **no unread / no Action-Required**
  (the agent sent it), and publishes the `message.added` SSE so a Gmail-sent reply appears
  live. Wired into push (route by direction) and the 5-min poll (a second outbound
  reconciliation pass over the new `emailQueries.listUnlinkedOutboundForTimeline`).
- A one-time backfill links pre-existing outbound rows so historical sent emails surface.

### Receive
- **Real-time push:** Gmail `users.watch` (INBOX) → Google Pub/Sub → `POST /api/email/push/google`.
  The endpoint mounts BEFORE `express.json` with a raw body parser (like the Stripe
  webhook), verifies first (shared `?token=` primary / OIDC `aud` secondary), then
  **fast-acks 200** and ingests detached so Pub/Sub never retry-storms.
- **Fallback:** the existing 5-min poll (`EMAIL_SYNC_INTERVAL_MS`) reconciles inbound,
  so email keeps landing on the timeline even before Pub/Sub is provisioned.
- Inbound filtering: **draft/sent excluded**, `from_email` matched to a contact,
  body **quote-stripped** (latest reply only), persisted **unread**.

### Send
- Reply-to-thread (keeps the Gmail thread) or initiate a fresh email.
- Composer is **channel-routed**: phone selected → SMS, email selected → email; a
  **connect CTA** is shown instead when the company's Gmail isn't connected yet.

### Plumbing
- **MailProvider abstraction** — `GmailProvider` today, IMAP-ready seam
  (`startWatch`/`renewWatch`/normalized pull) behind a provider registry.
- **Migration 129** (`129_email_timeline_link.sql`) — email↔timeline link.
- New env (see `.env.example`): `GMAIL_PUBSUB_TOPIC`, `GMAIL_PUSH_VERIFICATION_TOKEN`,
  `GMAIL_PUSH_OIDC_AUDIENCE`, `GMAIL_PUBSUB_SA_EMAIL`, `GMAIL_WATCH_RENEW_INTERVAL_MS`.

**OPS prerequisite for LIVE push:** a GCP Pub/Sub **topic** + a **push subscription**
targeting `https://<host>/api/email/push/google?token=<GMAIL_PUSH_VERIFICATION_TOKEN>`,
and **Pub/Sub Publisher** on the topic for `gmail-api-push@system.gserviceaccount.com`.
Until that's provisioned, inbound runs on the 5-min poll.

**Pending:** **NOT yet deployed** — run migration 129 against prod + deploy + provision
GCP Pub/Sub (topic/subscription/IAM) for real-time push.

## 2026-06-26 — REC-SETTINGS-002: `max_distance_miles` now drives empty-day coverage

Follow-up to REC-SETTINGS-001. **Problem (verified on prod):** `max_distance_miles` only drove the engine's GEO pre-filter, but empty-day candidates were then rejected by the engine's internal travel-feasibility caps (`travel.max_extra_travel_minutes:35` / `max_edge_travel_minutes:45`, haversine MVP @ 25 mph) — so effective coverage was only ~5 mi regardless of the setting.

**Fix:** `slotEngineSettingsService.buildConfigOverride` now also emits a `travel` block scaled from `max_distance_miles` (D), so the GEO radius is the binding constraint and the technician workday is the natural ceiling (customer decision: radius = limit, no extra hard drive-time cap). Formula derived from the engine source (`slot-engine/src/geo.js` `driveMinutes=(D/25·60)·1.10+10`, `engine.js` empty-day `extra=2(K·D+10)−10`):
- `K=2.64`, `BUF=10`; `max_edge_travel_minutes = max(45, ceil((2.64·D+10)×1.10))`; `max_extra_travel_minutes = max(35, ceil((5.28·D+10)×1.10))`.
- Floored at the engine defaults (45/35) → never more restrictive than before. D=10 → 45/70, D=25 → 84/157, D=1 → 45/35, D=100 → 302/592.

**Verified on the live prod engine:** at D=10, empty-day coverage now extends to the full ~10 mi radius (then the geo gate cuts at 11 mi) vs ~5 mi before; the Newton centroid (7 mi from nearest base) went 0 → 24 feasible candidates. D=25 → ~25 mi.

**Scope:** one function (`buildConfigOverride`) + tests only. No engine change/redeploy (config_override already deep-merges `travel.*`), no UI change, no migration. Tests: `tests/slotEngineSettings.test.js` extended (TC-RS2-001..014) — 81 passing across it + `slotEngineProxy.test.js`. Reviewer APPROVED (formula cross-checked against engine source). Specs: `docs/specs/REC-SETTINGS-002.md`.

**Pending:** deploy (rsync `slotEngineSettingsService.js` + rebuild app; no migration, no engine rebuild).

## 2026-06-26 — REC-SETTINGS-001: per-company configurable recommendation settings

Replaces the **hardcoded** engine `config_override` in `slotEngineService` (previously `{ geography: { allow_empty_day_candidates: true, max_distance_from_base_if_empty_day_miles: 40 } }`) with **5 per-company parameters** a dispatcher edits in the UI. Defaults tightened: the empty-day base radius drops 40 → **10 mi** (one shared radius now governs both the base-distance and the nearest-existing-job checks). No engine change / redeploy — the deployed engine already honors `config_override` (deep-merge).

**The 5 editable parameters** (defaults): `max_distance_miles` (10) → mapped to BOTH `geography.max_distance_from_existing_job_miles` and `geography.max_distance_from_base_if_empty_day_miles`; `overlap_minutes` (0 = no overlap) → `overlap.max_timeframe_overlap_minutes`; `min_buffer_minutes` (15) → `feasibility.min_required_slack_minutes`; `horizon_days` (3) → `planning.horizon_days` (also widens the snapshot date window); `recommendations_shown` (3) → `ranking.top_n`. Two values stay fixed/hidden and are always injected: `geography.allow_empty_day_candidates=true`, `workload.max_day_utilization=0.95`.

**Backend**
- Migration **128** `slot_engine_settings(company_id PK→companies ON DELETE CASCADE, config jsonb, timestamps)` — idempotent, `updated_at` trigger (mirrors 125).
- `slotEngineSettingsQueries.js` (getByCompany / upsert ON CONFLICT / ensureSchema) + `slotEngineSettingsService.js` — `DEFAULTS`, `get` (row-or-defaults, per-key fallback, propagates DB error), `resolve` (safe-fail → DEFAULTS, never throws — engine path), `validate` (server-authoritative ranges: distance 1–100, overlap/buffer 0–240, horizon 1–14, shown 1–10 → 422 `INVALID_SETTINGS` + offending `field`), `save`, `buildConfigOverride`.
- `slotEngineService` now resolves per-company settings and builds the override from them (hardcode + `HORIZON_DAYS` removed; horizon comes from settings); existing safe-failure + base-coverage reporting preserved.
- Routes `GET`/`PUT /api/settings/slot-engine-settings` (`requirePermission('tenant.company.manage')`; `company_id` ONLY from `req.companyFilter`). GET uses `get` → a hard DB error surfaces **500** (UI shows defaults + "couldn't load" toast) rather than masking it.

**Frontend**
- `slotEngineSettingsApi.ts` (get/save + typed `SlotEngineSettingsError` carrying the server's 422 message/field; DEFAULTS + range mirrors for first-paint/load-failure).
- `RecommendationSettings.tsx` — Albusto card on **Settings → Technicians**, under the company base-address block: 3 number inputs (max distance / horizon / shown) + 2 minute-pickers (overlap, buffer) with `0/30/60/Custom` presets; Save dirty-gated, inline range hints, 422 → server message. The 2 fixed values are not shown.

**Tests:** `tests/slotEngineSettings.test.js` (44 — service / validate / queries / routes / migration) + `tests/slotEngineProxy.test.js` extended to 23 (config_override now built from resolved settings) = **67 passing**; frontend `npm run build` green. Reviewer **APPROVED** (multi-tenant scoping, safe-failure, override mapping, idempotent migration confirmed).

**Pending:** run migration 128 against prod + deploy.

## 2026-06-26 — ONWAY-001: «On the way» / ETA-уведомление клиента

Техник, выезжая на работу, жмёт главную CTA-кнопку **«On the way»** в карточке
работы → открывается окно с расчётным ETA и пресетами → по «Notify client»
клиенту уходит SMS, работа переходит в статус **«On the way»**, а сообщение
появляется в таймлайне переписки с клиентом. Прогон через оркестрацию
(Product → Architect → Spec → Test-cases → Planner → Implement → Test → Review).

### Новый статус работы «On the way» (FSM)
- Миграция `127_job_fsm_on_the_way.sql` — идемпотентно (по образцу `095`) внедряет
  состояние `On_the_way` в активную published SCXML-машину каждой компании:
  переходы **в** статус из Submitted/Rescheduled, **из** статуса → Visit completed/
  Canceled. Зеркала: `fsm/job.scxml`, seed `073`, hardcoded fallback
  `BLANC_STATUSES`/`ALLOWED_TRANSITIONS` в `jobsService.js`, цвет `#0EA5E9`.
- Чистый хелпер `fsm/onTheWayTransform.js` (`injectOnTheWay`) — DB-free путь для
  тестов; inline-SQL миграции byte-identical его выводу. Только additive (FSM-001
  не ломается). Без ZB-маппинга для нового статуса.

### Бэкенд (jobs router, requirePermission('messages.send'), company_id из req.companyFilter)
- `POST /api/jobs/:id/eta/estimate { origin:{lat,lng} }` → `{ eta_minutes|null }`
  (pure-read; `routeDistanceService.computePair`; null если нет origin/адреса/ключа).
- `POST /api/jobs/:id/eta/notify { eta_minutes }` → резолв телефона клиента
  (422 NO_PHONE) + sending-DID (MRU `sms_conversations` → `SOFTPHONE_CALLER_ID`,
  422 NO_PROXY) → `conversationsService.sendMessage` (wallet-gate внутри, пишется в
  таймлайн как outbound) → затем `updateBlancStatus('On the way')`; если статус не
  обновился после отправки → `{ ok:true, warning:'status_not_advanced' }` (SMS не
  откатываем). SMS: `Hi! Your technician {tech} from {company} is on the way and
  should arrive in about {eta} minutes.`

### Фронтенд
- `OnTheWayModal.tsx` — одна геолокация (`getCurrentPosition`, таймаут 8с); если
  координаты есть → показывает «Google ETA · ~N min», иначе «ETA unavailable —
  location is off». Плитки **10/15/20/30/45/60** + «Set custom time» (1–600);
  ровно один выбор; «Notify client» заблокирован до выбора и во время отправки
  (без дабл-сенда); коды ошибок → дружелюбные тосты.
- Главная CTA **«On the way»** в `JobStatusTags.tsx` показывается только для
  статусов Submitted/Rescheduled и при праве `messages.send`; после успеха —
  авто-рефреш карточки (`onNotified`→`afterMutation`).

Тесты: `tests/jobsEta.test.js` — **45/45** (estimate/notify контракты, NO_PHONE/
NO_PROXY/wallet/SMS-fail/status-after-send, мультитех, изоляция company_id, FSM
additive + идемпотентность transform). `tsc -b` green. Docs: requirements
(OW-R1..R7), architecture, спека `specs/ONWAY-001.md`, тест-кейсы, tasks.

⚠️ Деплой этой фичи требует применить миграцию **127** на проде (FSM-машины).

---

## 2026-06-26 — SLOT-ENGINE-001: UX-полировка пикера рекомендаций (Albusto)

Закрыт набор дефектов дизайн-критики поверх уже слитой фичи рекомендаций слотов
(движок не переделывался, архитектура/контракты/БД/мультитенант не менялись —
только UX/консистентность/копирайт). Прогон через оркестрацию (Product → Architect
→ Spec → Test-cases → Planner → Implement → Test → Review).

### Движок (slot-engine)
- **P0:** `explain(m)` теперь возвращает чистую английскую причину (раньше — русский
  текст с опечаткой «технік» в полностью английском UI, плюс дублировал
  дату/время/имя техника). Только плюсы: `tech already working nearby · little extra
  driving · comfortable schedule gap`; фолбэк `Good fit for this route`. Сигнатура
  упрощена до `explain(m)`, функция экспортируется для юнит-тестов.
- Тесты: новый `slot-engine/test/explain.test.js` (EXP-01..12) — английский-only,
  отсутствие кириллицы/snake_case/префикса, граничные пороги. `node --test` → 39/39.

### Фронтенд (CustomTimeModal — пикер слота)
- **Сигнал качества:** вместо сырых `score`+`confidence`+жаргона — тонкий
  вертикальный «температурный» мини-бар на кромке карточки (заполнение ∝ score,
  цвет по confidence: high→`--blanc-success`/Best match, medium→`--blanc-job`/Good
  fit, low→`--blanc-warning`/Worth a look). Голое число ушло с лица карточки в
  `title`/`aria-label` (для диспетчера).
- **Точность адреса:** `Dispatch confirm` → человеческое `Approx. address — confirm`
  (янтарная пилюля, только при `requires_dispatch_confirmation`).
- **Словарь:** панель `Suggested times` → `Recommended times`; пилюля
  скопированного техника `Suggested` → `Preselected`; рекомендации движка — везде
  `Recommended`. Убрана утечка snake_case `reason_codes` в фолбэке.
- **Пустой результат:** при включённом движке и нуле рекомендаций панель больше не
  исчезает молча — показывает `No nearby openings — try another day` (лесенка
  состояний: loading → unavailable → empty → list).
- **Тёплые токены Albusto** в таймлайне/date-nav/часовых метках/карте
  (`--muted-foreground`/`--border` → `--blanc-ink-3`/`--blanc-line`); удалены
  мёртвые dark-фолбэки.
- **Кнопки/доступность:** стрелки пагинации техников → `Button variant="ghost"
  size="icon"` (как стрелки даты); бэнды-рекомендации на таймлайне получили
  клавиатурную доступность (`role/tabIndex/onKeyDown`/`aria-label`); убраны эмодзи
  🕓🔧 из инфо-окна карты. Удалён мёртвый CSS `.ctm-timelines__dots/__footer/__legend*`.
- Инвариант: режим reschedule/edit не затронут (бар/панель/бэнды не рендерятся при
  `isNewJob===false`). `tsc -b` → green.

Docs: `requirements.md` (SE-UX-1..7 / AC-1..16), `architecture.md`, спека
`specs/SLOT-ENGINE-001-UX-POLISH.md`, тест-кейсы `test-cases/SLOT-ENGINE-001-UX-POLISH.md`,
`tasks.md` (PT-1..PT-5).

---

## 2026-06-24 — JOB-CREATE-001: Direct Job creation (one-form, Zenbooker-linked)

Jobs can now be created directly (previously only via lead→job conversion), from
a "+ New Job" button on the Jobs page. Single form, no steps, modeled on a phone
call: **Contact · Address · Time & technician · Work**. Creating a job still
creates the linked Zenbooker job (territory from ZIP, customer, address, service,
the picked slot + technician); on a Zenbooker failure the local job is kept and a
warning is surfaced. Built UI/UX-first — minimal fields only, no price/duration/
territory/internal fields.

### Backend
- `jobsService.createDirectJob(companyId, input)` — verify an existing contact
  (tenant-scoped) or dedupe-create, build the ZB payload, create the Zenbooker job
  (reuses `zenbookerClient.createJob` + `ensureAddressState`), persist the local
  job from the synced ZB detail; on ZB error persist a company-scoped local-only
  job and return `zb_warning` (real reason via `error.message`).
- `POST /api/jobs` — `requirePermission('jobs.create')`, company from
  `req.companyFilter`; returns `{ job_id, zenbooker_job_id, zb_warning }`.
- Tests `tests/jobsCreate.test.js` (8): permission gate, cross-company contact
  isolation, ZB-failure keeps local + warns, happy path.

### Frontend
- `NewJobDialog` — one-screen form reusing `AddressAutocomplete`, contact search
  (`contacts/search-candidates`), and the reschedule slot engine `CustomTimeModal`
  (one slot pick = arrival window + technician). `+ New Job` button on the Jobs
  page; `jobsApi.createJob`.

Merge-to-master only — not deployed (pending broader QA).

---

## 2026-06-14 — F018 / STRIPE-PAY-001: Stripe Payments — Phases 3–5

Completed the remaining phases on top of the Phase 1–2 foundation. Tap to Pay
on-device NFC remains blocked on a native/RN mobile shell (web-only SPA); its
backend is shipped so a mobile client can integrate without further backend work.

### Backend
- `stripeConnectProvider`: `createPaymentIntent` (direct-charge manual card),
  `createConnectionToken`, `createTerminalLocation`, `createTerminalPaymentIntent`
  (card_present), `cancelPaymentIntent`, `createRefund` (all with idempotency keys).
- `stripePaymentsService`: `createManualCardSession` (Phase 3), `getConnectionToken` /
  `createTapToPayIntent` / `cancelTerminalIntent` (Phase 4), `refundStripePayment` +
  idempotent `applyStripeRefund` (Phase 5). Webhook now handles `charge.refunded`
  (idempotent refund recording, invoice reversal) and `charge.dispute.created`
  (marks tx, audit). Manual-card/Tap-to-Pay success reconciles via the existing
  `payment_intent.succeeded` webhook path.
- Migration 111 `stripe_terminal_locations`; migration 112 seeds
  `payments.collect_keyed` / `payments.collect_terminal` to roles
  (admin/manager both; dispatcher keyed; provider terminal) + dev-mode list.
- Routes: invoice + job `stripe-manual-card-session` (`payments.collect_keyed`) and
  `tap-to-pay/payment-intent` (`payments.collect_terminal`); `routes/stripeTerminal.js`
  (`/connection-token`, `/payment-intents/:id/cancel`); `POST /api/payments/:id/stripe-refund`
  (`payments.refund`). Ledger `source` filter (`stripe`/`zenbooker`/`manual`).

### Frontend
- `utils/loadStripe.ts` (dependency-free Stripe.js loader, direct-charge stripeAccount);
  `components/invoices/ManualCardDialog.tsx` (Payment Element) wired into the Collect menu.
- Public `pages/PublicInvoicePayPage.tsx` at unauthenticated `/pay/:token` (added to
  `PUBLIC_AUTH_PATHS`); `InvoiceSendDialog` "Include payment link" toggle.
- TransactionsPage **Source** filter (Stripe/Zenbooker/Manual); refunds on Stripe
  payments routed through the Stripe refund endpoint in `useTransactions`.

### Tests
- `tests/stripePayments.test.js` now 26 passing (added manual-card session, terminal
  connection token, refund flow + refund idempotency, non-Stripe refund rejection).
  Frontend `tsc --noEmit` 0 errors. No billing/payments regressions.

### Still requires a mobile shell
- On-device Tap to Pay NFC UI (the web SPA cannot drive the Terminal SDK). Backend is
  ready: connection-token + card_present payment-intent + cancel endpoints.

---

## 2026-06-14 — F018 / STRIPE-PAY-001: Stripe Payments Marketplace (Phases 1–2)

Tenant customer payments via Stripe Connect (direct charges, no application fee),
delivered through the `orchestrate` pipeline. Extends PF004's canonical ledger,
reuses the F016 VAPI marketplace pattern, and stays fully separate from the
platform-billing Stripe code (ADR-001 / BILLING-UI). Tap to Pay and manual card
entry deferred; refunds/reporting are later phases.

### Backend
- Migrations 107–110: `stripe_connected_accounts`, `stripe_payment_sessions`,
  `stripe_webhook_events`, seed `stripe-payments` marketplace app; partial unique
  index `payment_transactions(company_id, external_id) WHERE external_source='stripe'`
  for ledger idempotency. Wired into `marketplaceQueries.ensureMarketplaceSchema`.
- `services/stripeConnectProvider.js` — zero-SDK Connect REST (account create,
  account links, getAccount, direct-charge Checkout Session with `Stripe-Account`
  header + idempotency key, `parseConnectWebhook` HMAC verify via a SEPARATE
  `STRIPE_CONNECT_WEBHOOK_SECRET`).
- `services/stripePaymentsService.js` — readiness state machine + gating,
  connect/onboarding/refresh/disconnect, invoice payment-link create/reuse/send,
  public Pay-now, and idempotent webhook → ledger sync via
  `paymentsService.createTransaction` (`external_source='stripe'`), invoice
  paid/partial via the canonical path. Tenant-scope verified by connected-account id.
- `db/stripePaymentsQueries.js`; `paymentsQueries.findByExternalSourceId` (idempotency).
- Routes: `routes/stripePayments.js` (`/api/stripe-payments/*`, `tenant.integrations.manage`),
  `routes/stripePaymentsWebhook.js` (raw body, no auth, mounted before `express.json`,
  separate from `/api/billing/webhook`), invoice payment-link endpoints in
  `routes/invoices.js` (`payments.collect_online` / `payments.view`), public
  `pay-info` / `pay` in `routes/public-invoices.js`. `src/server.js` mount-only.

### Frontend
- `pages/StripePaymentsSettingsPage.tsx` (Blanc design) — checklist, readiness
  panels, Connect/Resume/Refresh/Dashboard/Disconnect; `services/stripePaymentsApi.ts`.
- `pages/IntegrationsPage.tsx` — `stripe-payments` card → setup page (mirrors VAPI).
- `App.tsx` route `/settings/integrations/stripe-payments` (guard `tenant.integrations.manage`).
- `components/invoices/InvoiceDetailPanel.tsx` — split into **Collect payment**
  (send/copy Stripe link; card/Tap to Pay shown "soon") and **Record offline payment**.

### Tests
- `tests/stripePayments.test.js` — 20 passing: readiness state machine, webhook
  signature, event + ledger idempotency, tenant-scope rejection, link reuse, gating.
  No regressions to platform billing / payments suites (pre-existing env-dependent
  paymentsRoute failures unchanged).

### Follow-ups (not in this run)
- Public Pay-now has backend endpoints; a dedicated public pay page/CTA is a small
  frontend follow-up. Invoice send-dialog "Include payment link" toggle to be wired
  into the existing send dialog. Phases 3–5 (manual card, Tap to Pay, refunds,
  reporting filters) tracked in STRIPE-PAY-001.

## 2026-06-14 — SCHED-ROUTE-001: Schedule routes & address geocoding (SR-09…SR-12)

Completes the route-scheduling feature on top of the backend foundation
(migration 107, route engine, workers). Branch-only — NOT deployed; migrations
107 + 108 and the seed script run on prod only after explicit approval.

### Backend
- **C-3 tz-aware day filter** (`scheduleQueries.getScheduleItems`) — jobs/leads/
  tasks day boundaries are grouped in the company timezone (sargable `AT TIME
  ZONE` on the date bounds only) so the route day matches the visible day.
  Validated against ephemeral postgres (a 22:00-local job no longer leaks into
  the next UTC day).
- **Schedule read exposes geocoding state** — `lat/lng/normalized_address/
  geocoding_status` added to the unified UNION (jobs real, leads lat/lng, tasks
  null) plus a generated `google_maps_url`; zero Google calls on read.
- **SR-10 backfill** — migration 108 marks coord-bearing jobs
  `geocoding_status='success'` with no paid call (idempotent); `scripts/
  backfill-route-segments.js` seeds today+future tech-days per company-local tz
  via the idempotent `reconcileTechDay` (with `--dry-run`).

### Frontend
- Clickable Google Maps address on schedule cards (stopPropagation) + job
  detail panel; subtle geocoding hint (Locating… / Approx. / No location).
- Route connectors between consecutive jobs in List / Timeline-Week (stacked)
  and Timeline (hourly grid — leg label anchored to each card, pointer-events
  -none); shows `distance · duration` or a human status. Pure formatters in
  `utils/routeFormat.ts`. No client-side Google calls.
- New Job modal (title + AddressAutocomplete) on slot click → `createFromSlot`
  with address/coords (server skips paid geocode when coords present). Created
  unassigned by design (slot ids are ZenBooker ids, not crm_users.id).

### Tests
- SR-12 fills recalc edge cases: address-change re-stale+recalc, reconcile
  idempotency, multi-tech fan-out + before/after dedupe, schedule-read makes
  zero Google calls. Full suite 85/85 green. Frontend: `tsc` + production build
  clean (no frontend test runner in this project).

### Gap closure (SR-13…SR-16) — full implementation before deploy
- **FR-002 job location editing** — `PATCH /api/jobs/:id/location` +
  `jobsService.updateJobLocation`: edits the service address (and/or coords from
  AddressAutocomplete), sets `geocoding_status`, enqueues async geocode when an
  address arrives without coords, and recalcs the affected technician/day
  segments (capturing before-tech-days so a moved job repairs its old sequence).
  `/:id/coords` is now recalc-aware. Inline AddressAutocomplete editor added to
  the job detail Location section.
- **FR-001.4 assign-on-create** — NewJobModal passes the lane provider (ZenBooker
  shape); `createManualJob` resolves the internal crm_users.id mirror via the
  provider bridge, so a job created in a lane is both assigned and routed
  correctly (C-2).
- **C-12 ZenBooker best-effort sync** (enabled) — `FEATURE_ZENBOOKER_SYNC`
  (default ON) + async `zb_job_sync` agent: one-shot, dedupe-guarded (skips if a
  `zenbooker_job_id` already exists), stores the returned id, marks
  `jobs.zb_sync_status`, and never rolls back the local job on ZB failure.
  Migration 109 adds `jobs.zb_sync_status`.
- **C-13 retention** — `purgeStaleSegments(>30d)` + `pruneRouteCache(>180d)` +
  `scripts/purge-route-data.js` (`--dry-run`) so neither table grows unbounded.
- Tests: +10 gap cases (location edit, assign resolve, ZB dedupe/success/failure,
  flag default, retention SQL). Full SCHED-ROUTE-001 suite 95/95 green; migration
  109 idempotency verified on ephemeral postgres; frontend `tsc` + build clean.
- Known follow-up: distance units still `mi`-only (no company unit/locale field
  yet); ZB job-address PATCH not available in their API, so address edits on an
  already-synced job are recorded locally only.

---

## 2026-06-14 — AUTH-2FA-GATE: global 2FA re-verification gate (P1 lockout fix)

Functional testing of new-tenant signup found a P1 bug: the frontend had ZERO
handling of `401 PHONE_VERIFICATION_REQUIRED`, so a user with a verified phone
got locked out of the whole app (raw "HTTP 401") once the trusted-device cookie
expired (30d) or on a new device.

### Frontend
- `services/twoFactorGate.ts` — coordinator deduping concurrent 401s into one
  in-flight re-verification.
- `services/apiClient.ts` `authedFetch` — intercepts 401
  `PHONE_VERIFICATION_REQUIRED`, surfaces the gate, awaits re-trust, retries once.
- `components/auth/TwoFactorGate.tsx` — Blanc overlay; auto-sends a code to the
  user's stored phone (masked hint, no re-entry), 6-digit input + resend, verify
  -> trust-device (30d cookie) -> unblock. Mounted at App root.

### Confirmed (no change needed)
- Phone reuse across accounts already works (identity = email; trusted-device
  keyed by user.id; no phone uniqueness constraint or "in use" check).

### Backend
- Unchanged (authDevice.js endpoints already existed, 2FA-exempt).

### Validation
- tsc clean; browser E2E on prod (qa-test): gate -> auto-send -> resend -> verify
  -> trusted -> billing loaded seamlessly, no re-login; device stays trusted.

---

## 2026-06-13 — PAY-CONS-001: consolidate zb_payments into the canonical ledger (debt #6)

Zenbooker is the master payment system, so its data is authoritative. The legacy
`zb_payments` cache is now projected into the canonical `payment_transactions`
ledger, removing the dual-source read in analytics. `zb_payments` is kept as the
Zenbooker staging cache (the payments UI reads its denormalised fields).

### Backend
- Migration `104_consolidate_zb_payments_into_ledger.sql` — partial unique index
  `uq_payment_tx_external_zb (company_id, external_id) WHERE external_source='zenbooker'`
  + idempotent backfill of `zb_payments` → `payment_transactions`
  (`payment_method='zenbooker_sync'`, status mapped succeeded→completed /
  failed / voided, job resolved via `jobs.zenbooker_job_id`). Zenbooker-priority
  on conflict. Does NOT touch `fact_payments`/marts (external /pulse ETL).
- `zenbookerPaymentsSyncService.projectCompanyLedger(companyId)` — write-through
  called after each sync so the ledger stays current (idempotent, non-fatal).
- `analyticsService.listJobs` now reads only `payment_transactions` with
  Zenbooker-priority (prefer `zenbooker_sync` rows when present, else native);
  the `zb_payments` fallback is gone.

### Validation (prod-data copy)
- Backfill 1027 rows; ran twice — idempotent. Per-job paid totals **0/1164
  mismatches** vs the legacy path; grand total $197,253.26 identical to the cent.
- Write-through projection re-verified independently: 1027 rows, ledger total =
  zb succeeded total.

### Tests
- `tests/paymentsConsolidation.test.js` — projection SQL (Zenbooker-priority
  upsert, status mapping, company scope) + analytics single-source read. Full
  suite: 699 pass, 22 pre-existing failures unchanged (no new regressions).

### Decisions (owner-confirmed mapping; recommended defaults elsewhere)
- Master = Zenbooker → zb data wins on conflict (owner, 2026-06-13).
- Keep `zb_payments` as staging (not dropped) — reversible, UI depends on it.
- `fact_payments`/marts untouched (fed externally).

---

## 2026-06-13 — ARM-001: faithful AR-config → rules migration (debt #3)

Closes the un-blocked half of refactor debt #3 so flipping
`FEATURE_RULES_ENGINE_AR` on prod no longer silently resets customised
action-required behaviour.

### Backend
- `ruleActions.create_task` now accepts `sla_minutes` → computes a relative
  `due_at` (an explicit `due_at` still wins). Carries the legacy AR
  `task_sla_minutes` faithfully.
- `rulesSeed.js` refactored around a shared `buildRulesFromConfig(config)`:
  - `seedDefaultRules` — static defaults for fresh companies, `ON CONFLICT DO
    NOTHING` (never clobbers admin edits).
  - `migrateCompanyARConfig` — reads the company's real
    `action_required_config` (priority / SLA / enabled) and upserts the system
    rules `DO UPDATE` (authoritative cutover).
- `POST /api/automation/rules/migrate-ar` (`tenant.company.manage`) triggers the
  per-company cutover.
- `voicemail` trigger intentionally not migrated — no domain-event source yet
  (documented in REFACTOR-REPORT §7).

### Tests
- `tests/arConfigMigration.test.js` — 8 tests: config→rule mapping (custom
  priority/SLA, disabled propagation, legacy defaults), `migrate-ar` DO UPDATE +
  scope, `seed-defaults` DO NOTHING, and `create_task` SLA→dueAt (relative,
  explicit-wins, null). Existing `automationE2E` still green. Full suite: 696
  pass, 22 pre-existing failures unchanged (no new regressions).

### Still open (not done tonight)
- Debt #3 physical removal: gated on prod verification of
  `FEATURE_RULES_ENGINE_AR` (no deploy per owner).
- Debt #5 (Redis/BullMQ queue): deferred until load grows.
- Debt #6 (`payment_transactions`↔`zb_payments` consolidation): needs owner
  sign-off on mapping semantics — analytics-regression risk.

---

## 2026-06-12 — BILLING-UI: subscription & billing cabinet (tenant-admin)

UX-first subscription cabinet at `/settings/billing` (`tenant.company.manage`),
completing the Stripe foundation from ADR-001 / commit 588c0d8.

### Frontend
- New `frontend/src/pages/BillingPage.tsx` — owner-facing cabinet on the Blanc
  design system: plan + status (trial "N days left", human "Free until <date>"),
  this-month usage bars (Text messages / Call minutes / Automations run) with
  green/amber/red thresholds against per-plan allowances, plan cards with Stripe
  Checkout upgrade, and an invoice list (date · amount · status · hosted link).
  No technical IDs (customer_id / subscription_id) surfaced.
- `frontend/src/services/billingApi.ts` client; route in `App.tsx`; "Billing"
  entry in the settings nav (`appLayoutNavigation.tsx`).
- Degraded mode: when online payments aren't enabled, upgrade buttons disable
  with an explanatory note; status/usage/invoices still render.

### Backend
- Migration `103_billing_included_units.sql` — `billing_plans.included_units`
  jsonb allowances (sms / call_minutes / agent_runs) backfilled for
  trial/starter/pro. Idempotent; verified on a prod-schema copy.
- `billingService.getInvoices`, `providerConfigured`; `GET /api/billing` now
  returns `invoices` + `billing_enabled`; new `GET /api/billing/invoices`.
- `routes/billingWebhook.js` — Stripe webhook (raw body, no auth, signature
  verified), mounted in `src/server.js` before `express.json` (path-scoped, no
  effect on other routes).
- `createCheckout` returns 422 `PROVIDER_NOT_CONFIGURED` when `STRIPE_SECRET_KEY`
  is absent (degraded mode).
- `bootstrapCompany` starts the 14-day trial on signup (idempotent, non-blocking).
- Hardened `stripeProvider.parseWebhook`: length-guard before `timingSafeEqual`
  (a malformed signature now rejects cleanly instead of throwing `RangeError`)
  and a try/catch around `JSON.parse`.

### Tests
- `tests/billingUI.test.js` — 8 tests: trial start idempotency, usage/invoice
  mapping + tenant scope, degraded-mode 422, webhook signature accept/reject,
  route isolation. Full suite: no new regressions vs `master` (22 pre-existing
  failures unchanged, unrelated to billing).

---

## 2026-06-03 — CRM-SALES-MCP Stage 6 Testing and Rollout

### Backend
- Mounted `/api/crm` and `/api/crm/mcp` in `src/server.js` behind `authenticate, requireCompanyAccess`.
- Mounted public `/mcp/crm` transport separately with token/env-context guards.
- Hardened MCP error detail sanitization so arrays containing objects are redacted instead of leaking nested data.

### Tests
- Added rollout gate coverage for CRM/MCP route mounts, 401/403 behavior, tenant isolation SQL scopes, write permission gates, no delete tools, secret redaction, stale activity queries, slippage/history calculations, and predefined Sales workflow lists.
- Full rollout run passed: `npm test -- --runInBand tests/routes/crmAuthGate.test.js tests/routes/crm.test.js tests/routes/crmMcp.test.js tests/routes/crmMcpPublic.test.js tests/routes/crmServerMount.test.js tests/cli/crmMcpStdio.test.js tests/services/crmMcpToolRegistry.test.js tests/services/crmMcpSchemaValidator.test.js tests/services/crmMcpResponse.test.js tests/services/crmListsService.test.js tests/services/crmDealsService.test.js tests/services/crmTasksService.test.js tests/services/crmNotesService.test.js tests/services/crmWriteAuditService.test.js tests/services/crmPipelineService.test.js tests/db/crmQueries.test.js` — 16 suites / 105 tests.

---

## 2026-06-03 — CRM-SALES-MCP Stage 5 Sales Workflow Selections

### Backend
- Added `crm.list_sales_workflows` discovery metadata for ready-made Sales workflow selections.
- Centralized Sales workflow keys and defaults in `crmListsService`.
- Exposed explicit read-only MCP workflow aliases for my open deals, closing this month/quarter, deals without activity, deals without next step, risky deals, top accounts by pipeline, accounts needing follow-up, contacts missing role/title/email, and tasks due this week.
- Changed `crm.find_deals_without_activity` to support the workflow default inactivity window when `days` is omitted.
- Made `tasks_due_this_week` use the current calendar week instead of a rolling seven-day window.
- Closed Stage 5 gaps: workflow date windows now use company timezone, `my_open_deals` requires current actor scope and rejects cross-owner scope, and invalid explicit `days` values are no longer masked by defaults.

### Tests
- Full CRM/MCP run passed: `npm test -- --runInBand tests/routes/crmAuthGate.test.js tests/routes/crm.test.js tests/routes/crmMcp.test.js tests/routes/crmMcpPublic.test.js tests/routes/crmServerMount.test.js tests/cli/crmMcpStdio.test.js tests/services/crmMcpToolRegistry.test.js tests/services/crmMcpSchemaValidator.test.js tests/services/crmMcpResponse.test.js tests/services/crmListsService.test.js tests/services/crmDealsService.test.js tests/services/crmTasksService.test.js tests/services/crmNotesService.test.js tests/services/crmWriteAuditService.test.js tests/services/crmPipelineService.test.js tests/db/crmQueries.test.js` — 16 suites / 105 tests.

---

## 2026-06-03 — CRM-SALES-MCP Stage 4 Write Tools

### Backend
- Added typed MCP write tools for the allowed update surface: `deal.next_step`, `deal.stage`, `deal.forecast_category`, `deal.close_date`, `deal.amount`, `deal.risk_summary`, `deal.competitor`, and `task.status`.
- Kept writes routed through CRM services so tenant scope, allowlist checks, before/after responses, request id propagation, and audit logging stay centralized.
- Added runtime schema support for `number` and nullable typed write values; `amount` rejects negative/non-number values and `close_date` rejects invalid calendar dates before dispatch.
- Closed Stage 4 gaps: executor now generates `crm-mcp-*` request ids when upstream context is missing, generic `crm.update_deal_field` validates `value` by selected field, create task/note write tools return before/after envelopes, and empty `forecast_category` clears to `null`.
- Confirmed no bulk/delete MCP tools are registered.

### Tests
- Full CRM/MCP run passed: `npm test -- --runInBand tests/routes/crmAuthGate.test.js tests/routes/crm.test.js tests/routes/crmMcp.test.js tests/routes/crmMcpPublic.test.js tests/routes/crmServerMount.test.js tests/cli/crmMcpStdio.test.js tests/services/crmMcpToolRegistry.test.js tests/services/crmMcpSchemaValidator.test.js tests/services/crmMcpResponse.test.js tests/services/crmListsService.test.js tests/services/crmDealsService.test.js tests/services/crmTasksService.test.js tests/services/crmNotesService.test.js tests/services/crmWriteAuditService.test.js tests/services/crmPipelineService.test.js tests/db/crmQueries.test.js` — 16 suites / 105 tests.

---

## 2026-06-03 — CRM-SALES-MCP Cross-stage Audit

### Backend
- Verified Stage 0-3 CRM/MCP alignment across `/api/crm`, MCP registry/executor, public/SSE/stdio transports, read-only tools, and pipeline/forecast analytics.
- Tightened MCP runtime schema validation so required typed fields reject `null`; nullable typed write values remain allowed only for explicit field clearing.
- Confirmed registry has 40 read tools and 11 write tools; all write tools require confirmation and `sales.crm.write`; no bulk/delete tools are registered.

### Tests
- Targeted CRM/MCP run passed: `npm test -- --runInBand tests/routes/crmAuthGate.test.js tests/routes/crm.test.js tests/routes/crmMcp.test.js tests/routes/crmMcpPublic.test.js tests/routes/crmServerMount.test.js tests/cli/crmMcpStdio.test.js tests/services/crmMcpToolRegistry.test.js tests/services/crmMcpSchemaValidator.test.js tests/services/crmMcpResponse.test.js tests/services/crmListsService.test.js tests/services/crmDealsService.test.js tests/services/crmTasksService.test.js tests/services/crmNotesService.test.js tests/services/crmWriteAuditService.test.js tests/services/crmPipelineService.test.js tests/db/crmQueries.test.js` — 16 suites / 105 tests.

---

## 2026-05-10 — INV-001 Invoices MVP (with manual payment recording)

### Goal
Allow users to create invoices from approved estimates with full UX parity to the new estimate detail panel (inline edit, auto-save, item search combobox, document-templates PDF). Manual payment recording reflects directly in invoice status and balance.

### Backend
- Migration `backend/db/migrations/086_document_templates_invoice.sql`: extends `document_templates.document_type` CHECK to `('estimate','invoice')` and seeds a default invoice template per company.
- `backend/src/services/documentTemplates/factory.js`: added `INVOICE_FACTORY` with the teal accent (`#0f766e`) to visually distinguish invoices from estimates. **Terms & Warranty body is now shared with estimates** (`DEFAULT_INVOICE_TERMS = DEFAULT_TERMS_AND_WARRANTY`) per product spec.
- `backend/src/services/documentTemplates/invoiceAdapter.js`: renderer adapter for `document_type='invoice'`, registered alongside the estimate adapter in `documentTemplates/index.js`.
- `backend/src/services/documentTemplates/invoicePdfDocument.js`: react-pdf Document mirroring estimate layout. Section headings: "Summary", "Items", "Totals", "Terms & Warranty". Totals additionally show Amount paid (green), Balance Due with status badge (PAID / PARTIALLY PAID / OVERDUE / AMOUNT DUE / VOID).
- `backend/src/services/invoicesService.js`: added `generatePdf(companyId, id)`; `updateInvoice` now recalculates totals when `tax_rate` or `discount_amount` change.
- `backend/src/db/invoicesQueries.js`: `updateInvoice` allowedFields now includes `discount_amount`.
- `backend/src/routes/invoices.js`: replaced 501 PDF stub with working `GET /:id/pdf`. Added `getCompanyId(req)` helper and applied to every route (fix for a latent bug — old code read `req.companyId` which was never set by middleware). `POST /:id/sync-items` falls back to the invoice's linked `estimate_id` when body is empty.

### Frontend
- Rewrote `frontend/src/components/invoices/InvoiceDetailPanel.tsx` for full UX parity with `EstimateDetailPanel`:
    - Two-column layout (main + aside); header shows invoice number (linked to Job when present), status, Balance Due / Total.
    - Inline auto-save (no separate editor dialog) via `updateInvoice` + optimistic state.
    - Summary section (Notes field, labeled "Summary") with pencil-to-edit dialog (reuses `EstimateSummaryDialog`).
    - Items list with pencil-edit + trash-delete; per-item dialog reuses `EstimateItemDialog`.
    - `ItemPresetSearchCombobox` for adding items (shared catalog with estimates via `estimate_item_presets`).
    - Inline editable Tax rate, Discount, Due date, Payment terms.
    - **Manual payment recording** is behind a footer button → opens a `Popover` with Amount + Full-balance shortcut + Method (Card / Cash / Check / ACH / Other) + Submit. Recording immediately refreshes invoice totals, balance, and status.
    - "Preview PDF" button opens `/api/invoices/:id/pdf` in a new tab.
- `frontend/src/pages/InvoicesPage.tsx`: switched `FloatingDetailPanel` to `wide`; passes `onChanged` to refresh the list; added `?openId=<id>` URL param handler that auto-opens an invoice on arrival.
- `frontend/src/components/estimates/EstimateDetailPanel.tsx`: fixed missing `FileText` icon import; `Create Invoice` button now navigates to `/invoices?openId=<id>` so the new invoice opens automatically.
- `frontend/src/services/invoicesApi.ts`: corrected endpoint paths (`record-payment`, `sync-items`) to match backend routes.

### Decisions
- **PDF via F015 document templates**, not the legacy hardcoded builder. One adapter per document type; per-tenant customization is through stored descriptors.
- **Shared item catalog** between estimates and invoices via `estimate_item_presets` (table name kept to avoid migration churn; data is genuinely per-company shared).
- **Manual payment recording only** — no payment-gateway integration in this iteration. Recorded payments are stored as `invoice_events` of type `payment_recorded` plus immediate `amount_paid` / `balance_due` / `status` updates.
- Invoices share Terms & Warranty text with estimates — companies want one canonical warranty disclosure across both documents.

---

## 2026-05-07 — TWC-001 Twilio API Client Singleton

### Backend
- Added `backend/src/services/twilioClient.js` — process-wide lazy singleton via `getTwilioClient()`. One `twilio(sid, token)` instance per process; one `https.Agent` keep-alive pool toward `api.twilio.com`.
- Removed per-call `twilio(sid, token)` instantiation in `backend/src/services/reconcileStale.js`, `backend/src/services/callAvailability.js`, `backend/src/services/inboxWorker.js`, and `backend/src/routes/phoneSettings.js` — all now resolve the client lazily via `getTwilioClient()`.
- Migrated existing module-level singletons in `backend/src/services/conversationsService.js`, `backend/src/services/twilioSync.js`, and `backend/src/services/reconcileService.js` to thin lazy `Proxy` wrappers around `getTwilioClient()`. Public surface (`client.calls`, `client.conversations`, etc.) unchanged at every call site.
- Webhook signature validation (`backend/src/webhooks/twilioWebhooks.js`, `backend/src/webhooks/conversationsWebhooks.js`, `src/routes/webhooks.js`) and JWT minting (`backend/src/services/voiceService.js`) untouched — they use static `twilio.validateRequest` / `twilio.jwt.AccessToken` factories, not REST clients.

### Documentation
- Added requirement TWC-001 to `docs/requirements.md` (resource NFRs, multi-tenant scope guard).
- Added architecture section TWC-001 to `docs/architecture.md` (module map, failure modes, operational acceptance check).
- Added spec `docs/specs/TWC-001-twilio-client-singleton.md`.
- Added test cases `docs/test-cases/TWC-001-twilio-client-singleton.md` (9 cases, 5 P0 / 3 P1 / 1 P2).
- Added task plan to `docs/tasks.md`.

### Tests / Verification
- Added `tests/services/twilioClient.test.js` — 5 unit tests (singleton identity, lazy init, missing-env errors, recovery after env becomes available).
- Added `tests/services/twilioClient.regression.test.js` — guard against re-introducing per-request `twilio(process.env...)` in the four hot-spot files.
- Added `tests/services/twilioClient.bootstrap.test.js` — confirms requiring Twilio-using modules without `TWILIO_*` env does not throw.
- All 16 new tests pass. Adjacent suites verified green: `tests/zenbookerSyncService.test.js`, `tests/routes/integrations-analytics.test.js`, `tests/middleware/integrationScopes.test.js`.

### Decisions
- Singleton is process-global only. Per-tenant Twilio credentials (analogue of `getClientForCompany` in `zenbookerClient.js`) are out of scope for TWC-001.
- Deferred: custom `https.Agent` tuning. Twilio SDK defaults are sufficient once a single agent is shared across the process.

### Operational acceptance (post-deploy on `abc-metrics`)
- Steady-state outbound HTTPS connections to Twilio CloudFront should drop from ~199 to ≤20.
- CLOSE_WAIT count should drop from ~28 to ≤5.
- No expected change in node memory footprint or in Twilio API behavior at call sites.

---

## 2026-04-27 — PF002-R2 Estimates Composer Refresh

### PDF Generation
- Implemented `GET /api/estimates/:id/pdf` for client-facing estimate PDFs.
- PDF output includes ABC Homes company details, customer/job context, Summary, items, totals, default Terms & Warranty, and ACH payment details.
- Added `PDF` action to estimate detail and `tests/estimatePdfService.test.js`.

### Product / UX
- Reworked estimates around Lead/Job-context creation rather than global creation.
- Added Summary-before-items flow, Add custom item dialog, client-facing Preview, read-only default Terms & Warranty, discount controls, signature toggle, and disabled `Deposit required: No`.
- `/estimates` is now a searchable list/detail workspace with `Only Open / All` archive visibility, not a global create surface.

### Backend
- Added migration `082_pf002_r2_estimates_refresh.sql` for `summary`, discount type/value, archive fields, approved snapshots, signature fields, estimate sequence, and future Price Book item references.
- Rebuilt estimate queries/service/routes around `approved`, archive/restore, non-mutating send stub, decline reason, company-scoped Lead/Job numbering, and draft reset after edits.
- Portal document access now rejects archived estimates.

### Frontend
- Updated `estimatesApi` types/actions for `approved`, archive/restore, Summary, discount type/value, and signature fields.
- Rebuilt editor/detail/send/preview components and integrated them into Lead/Job Financials plus `/estimates`.

### Tests
- Added `tests/estimatesLifecycleR2.test.js`.
- Updated `tests/estimatesConvert.test.js` from `accepted` to `approved`.
- Targeted estimate tests pass; frontend production build passes. Full Jest still has pre-existing unrelated failures in payments/Twilio worker/webhook/state-machine suites.

---

## 2026-04-22 — F014: Ads Analytics Microservice

### New Feature
- **External read-only analytics API** for Google Ads / ABC Homes weekly reporting
- 4 token-authenticated endpoints under `/api/v1/integrations/analytics/*`:
  - `GET /summary` — aggregated funnel metrics (calls → leads → jobs → revenue)
  - `GET /calls`, `GET /leads`, `GET /jobs` — paged raw rows for drill-down
- New scope `analytics:read` — keeps Ads reporting key isolated from `leads:create`
- Period in `America/New_York` (ABC Homes TZ); hard cap 92 days
- Default tracking DID `+16176444408`; overridable via `tracking_number` query param

### Database
- Migration 080: `COMMENT ON COLUMN api_integrations.scopes` — no-op DDL marker documenting the canonical scope list (`leads:create`, `analytics:read`)

### Backend
- `backend/src/services/analyticsService.js` — `getSummary`/`listCalls`/`listLeads`/`listJobs` with shared CTE trio `tracked_calls → period_leads → attributed_leads`
- `backend/src/routes/integrations-analytics.js` — 4 GET endpoints mirroring `integrations-leads` middleware chain (`rejectLegacyAuth → validateHeaders → authenticateIntegration → rateLimiter`) + `requireScope('analytics:read')` guard
- `src/server.js` — 3-point patch (require, mount at `/api/v1/integrations`, boot log)
- `backend/scripts/issue-analytics-key.js` — CLI to generate and persist `analytics:read` API keys (peppered SHA-256 hash, secret printed once)

### Tests
- `tests/routes/integrations-analytics.test.js` — 11 tests (happy path, 403 scope, 400 validation pass-through, 500 on unexpected, paged list endpoints)
- `tests/services/analyticsService.test.js` — 4 tests for pure helpers (`parsePeriod` cases, `normalizePhone` cases)
- Full Jest run: **15 / 15 passing**

### Docs
- Added F014 entry to `docs/requirements.md`
- Added F014 slice to `docs/architecture.md`
- Added `docs/test-cases/F014-ads-analytics-microservice.md`
- Added F014 task breakdown (8 tasks) to `docs/tasks.md`

---

## 2026-04-17 — F013 Schedule Finalization Sprint Scope

### Documentation
- Создан consolidated closing spec: `docs/specs/F013-schedule-finalization-sprint.md`
- Создан test-cases пакет: `docs/test-cases/F013-schedule-finalization-sprint.md`
- В `docs/feature-backlog.md` schedule gap больше не размазан по старым `F013` sprint-итерациям
- В `docs/current_functionality.md` schedule updated как implemented core + one remaining finalization sprint

### Product Planning Decision
- Все оставшиеся недоработки `F013 Schedule` сведены в один sprint scope
- После завершения этого scope `F013` должен считаться закрытым
- Дальнейшие schedule-улучшения должны идти уже отдельными enhancement-пакетами

---

## 2026-04-17 — EMAIL-001 Implementation (Full Stack)

### Backend
- Created migration `079_create_email_tables.sql`: 5 tables (`email_mailboxes`, `email_threads`, `email_messages`, `email_attachments`, `email_sync_state`), 12 indexes, 4 triggers
- Created `backend/src/db/emailQueries.js`: full CRUD + sync queries with tenant isolation
- Created `backend/src/services/emailMailboxService.js`: AES-256-GCM token encryption, HMAC-signed OAuth state, mailbox lifecycle
- Created `backend/src/routes/email-settings.js`: 4 settings endpoints (GET status, POST connect, POST disconnect, POST sync)
- Created `backend/src/routes/email-oauth.js`: public Google OAuth callback with state validation
- Created `backend/src/services/emailSyncService.js`: Gmail backfill, incremental history sync, interval scheduler
- Created `backend/src/services/emailService.js`: raw MIME send/reply, sent-message hydration, attachment proxy
- Created `backend/src/routes/email.js`: 7 workspace endpoints (mailbox, threads, thread detail, mark-read, compose, reply, attachment download)
- Modified `src/server.js`: mounted 3 route groups + email sync scheduler at boot

### Frontend
- Created `frontend/src/services/emailApi.ts`: typed API wrapper for all email endpoints
- Created `frontend/src/pages/EmailSettingsPage.tsx`: mailbox status, connect/reconnect/disconnect, manual sync
- Created `frontend/src/pages/EmailPage.tsx`: three-pane workspace (rail, thread list, thread detail)
- Created email components: `MailboxRail`, `EmailThreadList`, `EmailThreadRow`, `EmailThreadPane`, `EmailMessageItem`, `EmailComposer`
- Modified `frontend/src/App.tsx`: added `/settings/email` and `/email` routes
- Modified `frontend/src/components/layout/appLayoutNavigation.tsx`: added Email to Settings dropdown

### Tests
- Created 3 test suites (41 tests): `emailMailboxService.test.js`, `emailSyncService.test.js`, `email.test.js`
- Coverage: encryption round-trip, OAuth state signing, parsing helpers, route guards, CRUD operations

### Dependencies
- Added `googleapis` npm package

---

## 2026-04-17 — EMAIL-001 Pipeline Docs

### Architecture
- В `docs/architecture.md` добавлен полноценный architecture slice для `EMAIL-001`.
- Зафиксированы:
  - отдельные backend routes/services/query-layer для Gmail mailbox, sync и `/email`
  - отдельная `email_mailboxes` persistence layer для encrypted OAuth credentials
  - локальная thread/message/attachment sync-модель вместо live-only Gmail reads
  - отдельный `/email` workspace без изменения top-level navigation

### Spec / Test Cases / Tasks
- Создан новый spec: `docs/specs/EMAIL-001-gmail-shared-mailbox-workspace.md`
- Создан новый test-cases файл: `docs/test-cases/EMAIL-001-gmail-shared-mailbox-workspace.md`
- В `docs/tasks.md` добавлен полный task breakdown для `EMAIL-001`:
  - migration
  - OAuth/settings
  - sync service
  - send/reply service
  - backend routes
  - frontend settings page
  - `/email` workspace UI
  - verification

### Requirements Alignment
- В `docs/requirements.md` уточнён persistence slice:
  - `company_settings` оставлен для non-secret email prefs / UI metadata
  - добавлена отдельная `email_mailboxes` table для mailbox state и secure token storage

## 2026-04-16 — EMAIL-001 Requirements Alignment

### Documentation
- В `docs/requirements.md` добавлен новый formalized requirement `EMAIL-001: Gmail Shared Mailbox + Email Workspace`.
- Зафиксированы продуктовые решения для первой итерации:
  - отдельный route `/email`, без выноса в top navigation
  - отдельная settings page для подключения Gmail в `Settings`
  - один shared Gmail mailbox на компанию
  - scope v1 ограничен `send / receive / thread / search / attachments`
  - personal mailbox, delegated access, comments, shared drafts, assignment, snooze/later/done остаются вне scope

### Backlog
- В `docs/feature-backlog.md` обновлён email-эпик:
  - вместо `Email in Pulse` теперь зафиксирован отдельный `Gmail shared mailbox + /email workspace`
  - сохранена связь с текущими `Pulse`/Contacts/Leads/Jobs через deep-links, без слияния email в существующий `Pulse` timeline на этой фазе

## 2026-04-16 — Backlog Status Refresh

### Documentation
- Актуализирован `docs/feature-backlog.md` под фактическое состояние продукта на 2026-04-16.
- Добавлены:
  - legend по статусам `done / partial / planned`
  - отдельный status-summary по backlog-эпикам
  - обновлённый раздел "Что уже есть как база"
- Стало явно видно, что уже не является чистым backlog:
  - `Schedule` уже в активной разработке
  - `Estimates / Invoices / Transactions` уже существуют как реальные routes/pages
  - `Client Portal` уже имеет backend/API foundation
  - `AI communication` уже частично реализован через summary/transcript/polish
  - `Automation`, `Tasks`, `Voicemail`, `Phone ops` имеют partial baseline, а не zero-state

### Current Functionality
- Обновлён `docs/current_functionality.md`
- Добавлен новый раздел с кратким статусом более новых модулей:
  - `Schedule`
  - `Estimates / Invoices / Transactions`
  - `Client Portal foundation`
  - `Company / Admin / Territory management`
  - `Workflow editor / FSM builder`


## 2026-04-15 — RL-001: Routing Logs — Real Data + Day Grouping

### Improvement
- **Routing Logs page** (`/settings/telephony/routing-logs`) now displays real call data from `GET /api/calls` instead of mock data
- **Day grouping** — calls grouped by date with Pulse-style DateSeparator headings (no lines)
- **Redesigned UI** — Blanc design system: call rows with direction icons, contact names, result badges, duration, time
- **Detail panel** — click a call to see session ID, flow path, and latency
- **200 most recent calls** loaded by default

### Files Modified
- `frontend/src/pages/telephony/RoutingLogsPage.tsx` — full rewrite with day grouping and Blanc design
- `frontend/src/services/telephonyApi.ts` — `listLogs()` now calls real `/api/calls` endpoint, maps to `RoutingLogEntry`
- `frontend/src/types/telephony.ts` — added `direction` and `contact_name` fields to `RoutingLogEntry`

---

## 2026-04-15 — SCHED-LIST-001: Schedule List View

### New Feature
- **List view mode** for Schedule page — vertical job lists per technician column
- Jobs grouped by day with Pulse-style DateSeparator headings (no lines/borders)
- Each job tile shows time slot (start – end) via existing `ScheduleItemCard`
- Provider columns sorted alphabetically, "Unassigned" always last
- Empty days are not rendered (no empty headings)
- DnD reassign between provider columns supported
- Week-based navigation (same as Team Week view)

### Files Added
- `frontend/src/components/schedule/ListView.tsx` — new list view component

### Files Modified
- `frontend/src/hooks/useScheduleData.ts` — added `'list'` to ViewMode, dateRange, navigateDate
- `frontend/src/components/schedule/CalendarControls.tsx` — added List to VIEW_OPTIONS and getDateLabel
- `frontend/src/pages/SchedulePage.tsx` — added `case 'list'` with ListView import

---

## 2026-04-15 — IMG-001: Fullscreen Image Viewer

### New Feature
- **Shared fullscreen image viewer** (lightbox) component at `frontend/src/components/shared/FullscreenImageViewer.tsx`
- Opens on click in AttachmentsSection preview area (Telegram-like UX)
- Arrow key navigation between images, side buttons
- 90-degree rotation with scale compensation for sideways images
- Thumbnail strip at bottom, body scroll lock
- Close via Escape / backdrop click / X button
- Open original in new tab

### Files Added
- `frontend/src/components/shared/FullscreenImageViewer.tsx` — exports `FullscreenImageViewer`, `RotatableImage`

### Files Modified
- `frontend/src/components/payments/PaymentDetailPanel.tsx` — removed inline `FullscreenViewer` + `RotatableImage`, imports from shared

---

## 2026-04-06 — ELK-LAYOUT-001: Production ELK Layered Auto Layout

### Improvement
- **Replaced basic ELK layout** with production-grade `layoutWithElkLayered()` per `elk_layered_auto_layout_spec.md`
- **Layer constraints**: Root/initial nodes → FIRST_SEPARATE (top), Final nodes → LAST_SEPARATE (bottom)
- **Improved config**: ORTHOGONAL edge routing, NETWORK_SIMPLEX layering, BRANDES_KOEPF node placement, TWO_SIDED greedy switch, PREFER_NODES model order
- **Real node sizes**: Uses `node.measured.width/height` with 220×72 fallback (was hardcoded 200×60)
- **Stable ordering**: Nodes sorted by `data.order` then `id` before layout for deterministic results
- **Port support**: Multi-handle nodes use ELK ports with FIXED_ORDER constraint
- **Disconnected components**: `elk.separateConnectedComponents = true`
- **fitView after layout**: Canvas auto-fits viewport after layout recalculation via `ReactFlowInstance.fitView()`

### Files Changed
- `frontend/src/utils/workflowElkLayout.ts` — Full rewrite (spec-compliant `layoutWithElkLayered`)
- `frontend/src/pages/workflows/WorkflowBuilderPage.tsx` — `useReactFlow` instance for fitView, updated layout calls

---

## 2026-04-06 — Visual Workflow Builder

### New Feature
- **Full-screen visual FSM editor** at `/settings/workflows/:machineKey` replacing embedded Monaco editor
- **@xyflow/react canvas** with custom WorkflowStateNode, WorkflowFinalNode, WorkflowInsertableEdge components
- **Inspector sidebar** (300px): Flow properties, State inspector, Transition inspector with full SCXML attribute editing
- **SCXML codec**: Bidirectional `scxmlToGraph()` / `graphToScxml()` conversion
- **Toolbar**: Undo/Redo, Auto Layout, Add State, Validate, Save, Publish, Export
- **Edge insertion**: "+" button on edge hover to splice new states
- **Edge healing**: Deleting a node reconnects incoming→outgoing edges

### Files Added
- `frontend/src/pages/workflows/WorkflowBuilderPage.tsx`
- `frontend/src/pages/workflows/workflowScxmlCodec.ts`
- `frontend/src/pages/workflows/workflowNodeTypes.tsx`
- `frontend/src/pages/workflows/workflowInspectors.tsx`
- `frontend/src/utils/workflowElkLayout.ts`

### Files Modified
- `frontend/src/App.tsx` — Route `/settings/workflows/:machineKey`
- `frontend/src/components/workflows/MachineList.tsx` — Navigate to full-screen builder
- `frontend/src/pages/LeadFormSettingsPage.tsx` — Simplified Workflows tab

---

## 2026-04-06 — FSM-001: FSM/SCXML Workflow Editor

### New Features
- **SCXML-based workflow engine** replacing hardcoded status constants for Jobs and Leads
- **Admin Workflow Editor** (tab inside Lead & Job Settings):
  - Monaco SCXML editor with live diagram preview via state-machine-cat
  - Validation with error/warning display and click-to-navigate
  - Draft/Publish version management with audit logging
  - Version history with restore capability
- **Dynamic action buttons** (ActionsBlock) in Job cards driven by published SCXML transitions
- **Manual status override** for users with `fsm.override` permission
- **Feature flags**: `FSM_EDITOR_ENABLED`, `FSM_PUBLISHING_ENABLED` (default: true)

### Database
- Migration 072: `fsm_machines`, `fsm_versions`, `fsm_audit_log` tables
- Migration 073: Seed Job and Lead FSM machines per company
- Migration 074: FSM permission roles (`fsm.viewer`, `fsm.editor`, `fsm.publisher`, `fsm.override`)

### Backend
- `backend/src/services/fsmService.js` — SCXML parser, validator, CRUD, runtime (transition resolution, action filtering, caching)
- `backend/src/routes/fsm.js` — 12 API endpoints (read, write, runtime)
- `jobsService.js` — FSM delegation with hardcoded fallback
- `leadsService.js` — FSM validation on status changes with fallback

### Frontend
- `WorkflowEditor.tsx` — Split-pane SCXML editor + diagram preview
- `DiagramPreview.tsx` — SCXML→smcat→SVG rendering with zoom/pan
- `MachineList.tsx` — Machine selector in Workflows tab
- `ProblemsPanel.tsx` — Validation errors/warnings display
- `VersionHistory.tsx` + `PublishDialog.tsx` — Modals
- `ActionsBlock.tsx` — Dynamic FSM-driven action buttons with confirmation dialogs
- `useFsmEditor.ts` + `useFsmActions.ts` — React Query hooks

### Tests
- 98 tests (58 parser/runtime unit tests + 40 API integration tests) — all passing

### Dependencies
- Backend: `fast-xml-parser`
- Frontend: `@monaco-editor/react`, `state-machine-cat`


## 2026-05-09 — F015: Document Templates Customization (estimates)

**Added**
- New backend module `backend/src/services/documentTemplates/` with factory descriptor (estimate), inline JSON-Schema validator (no Ajv dep), renderer registry, and estimate adapter.
- DB layer `backend/src/db/documentTemplatesQueries.js`; service `backend/src/services/documentTemplatesService.js` with `resolveTemplate`, list/get/update/reset.
- REST API at `/api/document-templates` (list, get, update, reset, factory, preview), mounted in `src/server.js` behind `tenant.integrations.manage` (P0; dedicated `tenant.documents.manage` to follow).
- Migration `backend/db/migrations/084_create_document_templates.sql` — table + unique partial index for one default per (company, document_type) + idempotent factory seed per existing company.
- Frontend Settings: `pages/DocumentTemplatesPage.tsx` (list grouped by document type), `pages/DocumentTemplateEditorPage.tsx` (form-based editor: brand / theme / sections visibility / Terms & Warranty Markdown / reset). Routes `/settings/document-templates[/:id]`. Typed API client in `services/documentTemplatesApi.ts`; types in `types/documentTemplates.ts`.

**Changed**
- `backend/src/services/estimatePdfService.js` now accepts an optional `descriptor` parameter (DocumentTemplateDescriptor v1); falls back to factory when omitted; legacy exports `COMPANY_PROFILE` and `DEFAULT_TERMS_AND_WARRANTY` preserved (now derived from factory). Section rendering iterates `descriptor.sections` honoring per-section `visible` flag.
- `backend/src/services/estimatesService.js#generatePdf` resolves the company's default template via `documentTemplatesService.resolveTemplate('estimate')` and passes it to the renderer.

**Tests**
- `tests/services/documentTemplatesService.test.js` — validator + service unit tests (12 cases).
- `tests/services/estimatePdfRendererTemplate.test.js` — renderer integration: factory fallback, descriptor parity, section toggling, brand override (5 cases).
- Existing `tests/estimatePdfService.test.js` continues to pass.

**Notes**
- No new runtime dependencies (validator is hand-rolled, ~80 lines).
- Designed for `invoice` and `work_order`: extending `document_type` CHECK + adding a factory + registering an adapter is sufficient; the Settings page already lists by registered type label.

## 2026-06-03 — F016: VAPI AI Marketplace Integration + Call Flow Gating

**Added**
- New marketplace app `vapi-ai` registered via `backend/db/migrations/088_seed_vapi_ai_marketplace_app.sql` (provisioning_mode: none, category: telephony, status: published).
- `backend/src/db/marketplaceQueries.js` — migration 088 added to `ensureMarketplaceSchema`, idempotent seed runs on startup.
- `frontend/src/services/vapiApi.ts` — typed API client for `/api/vapi/*`: `getConnections`, `createConnection`, `getResources`, `createResource`.
- `frontend/src/pages/VapiSettingsPage.tsx` — full settings page at `/settings/integrations/vapi-ai`: step 1 API key verify, step 2 SIP resource, Finish Setup → marketplace install. View mode when already connected. Disconnect with confirmation.
- Route `/settings/integrations/vapi-ai` registered in `App.tsx` with `tenant.integrations.manage` permission.

**Changed**
- `frontend/src/pages/IntegrationsPage.tsx` — VAPI AI tile shows "Configure"/"Manage" button that navigates to `VapiSettingsPage` instead of opening the generic `MarketplaceConnectDialog`.
- `frontend/src/pages/telephony/CallFlowBuilderPage.tsx` — `vapi_agent` node gated behind active VAPI connection: on mount fetches `GET /api/vapi/connections`, hides node from insert picker if no active connection found.

**Tests**
- `tests/routes/vapi.test.js` — 8 test cases covering: connections list, missing api_key (400), invalid key (400), network error (400), missing resource fields (400), API key not exposed in response, server mount middleware.
- `tests/routes/marketplaceMount.test.js` — 2 new cases: migration 088 file content check, marketplaceQueries.js loads 088.

**Architecture**
- Connection flow: `POST /api/vapi/connections` → `POST /api/vapi/resources` → `POST /api/marketplace/apps/vapi-ai/install` (provisioning_mode: none → instant connected).
- Disconnect: standard `POST /api/marketplace/installations/:id/disconnect`.

## AUTO-001 — Automation/Rules Engine E2E (2026-06-13)
Делает заложенный в ADR-001 rules-engine рабочим end-to-end.
- **eventCatalog.js** + `GET /api/automation/catalog` — каталог событий/действий/agent-типов для редактора.
- **agentWorker.js** + **agentHandlers.js** — фоновый исполнитель kind=agent задач (atomic claim FOR UPDATE SKIP LOCKED, queued→running→succeeded/failed, эмит agent_task.*); хендлеры mcp_tool (вызов CRM MCP в tenant-контексте), summarize_thread, noop.
- **rulesSeed.js** + `POST /rules/seed-defaults` — AR-эквивалентные системные правила (sms.inbound, call.missed), идемпотентно.
- conversationsService/inboxWorker эмитят `sms.inbound`/`call.missed`; legacy AR за флагом FEATURE_RULES_ENGINE_AR; arConfigHelper → @deprecated.
- Frontend: AutomationPage + RuleEditor (trigger→conditions→actions, превью шаблонов) + run history + nav `/settings/automation` (tenant.company.manage).
- API: agent-tasks list + retry (409 на running, 404 на чужой).
- Миграция 102 (is_system marker). Тесты: 13 новых (worker claim, handlers, route guards 422/404/409, seed идемпотентность). Полный сьют 687 pass.

## NOTES-001 — Unified Notes: edit, soft-delete, attachment edit & audit (2026-06-25)

Unified the notes thread across Jobs/Leads/Contacts onto the single `NotesSection` component and added full lifecycle management.

**Backend**
- Migration `124_notes_edit_delete_audit.sql`: stable `id` backfilled onto every note in `jobs.notes` / `leads.structured_notes` / `contacts.structured_notes`; `note_attachments.note_id` added + backfilled from the positional `note_index` (idempotent).
- New `services/notesMutationService.js`: `canMutateNote` (admin → any; owner → own; legacy/no-author/Zenbooker → admin-only), `editNote` (text + add/remove attachments), `softDeleteNote` (`deleted_at` tombstone, element retained).
- New endpoints (PATCH + DELETE `…/notes/:noteId`) on jobs/leads/contacts, `requirePermission('*.edit')` + server-side ownership/admin gate (non-admin editing another's note → 403; cross-company → 404). New notes now stamp `id` + `created_by` (Keycloak sub).
- Soft-deleted notes excluded from every GET /notes and from `getEntityHistory`. `eventService` logs `note_edited` (old→new + attachment deltas) and `note_deleted`, rendered in History.
- Zenbooker merge preserves locally-edited text (`edited_at`) + `created_by`/`deleted_at`/`id` across re-sync.

**Frontend**
- `NotesSection`: per-note kebab (⋮, shown only when permitted) → Edit / Delete; edit mode (textarea + ✕ to remove each attachment + add new files), `window.confirm` delete; refetch after.
- `HistorySection`: icons for `note_edited` (Pencil) / `note_deleted` (Trash2).
- Removed dead `StructuredNotesSection.tsx` + `JobNotesSection.tsx`; extracted `JobDescription.tsx`.

**Out of scope:** Estimate "Summary" and Invoice "Notes" (separate single document fields).

**Verification:** backend Jest `tests/notesAuthz.test.js` + `tests/notesEditDelete.test.js` (13 cases) green; frontend `npm run build` green. Migration reviewed (idempotent) but not yet run against a live DB; full end-to-end click-through pending a deploy.

## SLOT-ENGINE-001 Phase 2+3 — Albusto integration of the slot recommendation engine (2026-06-25)

Marketplace-gated integration of the standalone `slot-engine` (Phase 1) into the schedule slot-picker.

**Backend**
- Migration 125 `technician_base_locations` (per-tenant tech base coords); migration 126 seeds the
  `smart-slot-engine` marketplace app (+ added to the `ensureMarketplaceSchema` replay list).
- Base-location CRUD: `GET/PUT/DELETE /api/settings/technician-base-locations` (`tenant.company.manage`),
  Zenbooker roster merge, geocode-on-save fallback (`googlePlacesService`).
- `marketplaceService.isAppConnected` gating helper.
- `slotEngineService` assembles the engine snapshot (techs + bases + local jobs → window/duration/status,
  company-tz) and calls `SLOT_ENGINE_URL` with a 4s timeout + safe-failure.
- Proxy `POST /api/schedule/slot-recommendations` (`schedule.dispatch`), gated on install.
- Jest: technicianBaseLocations + slotEngineProxy (34 cases); no schedule regressions (48/48).

**Frontend**
- `slotRecommendationsApi` + `technicianBaseLocationsApi`.
- Base-location editor on `/settings/technicians` (address autocomplete → geocode).
- `CustomTimeModal` (new jobs only): recommendation cards side panel (click applies slot+tech) +
  `Recommended` tech-bar pill + clickable timeline overlay bands; graceful when disabled/engine-down.

`SLOT_ENGINE_URL` added to `.env.example`. Verified: 34 + 48 backend tests, frontend build green, engine 18/18.
