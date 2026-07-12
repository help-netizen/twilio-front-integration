# Тест-кейсы: ONBOARDING-UX-001 — hub /welcome + 4-шаговый чеклист + trial-информер

**Спецификация:** `Docs/specs/ONBOARDING-UX-001.md` · **Дата:** 2026-07-12
**База:** существующий `tests/onboardingChecklist.test.js` (ONBTEL-001 TC-A-01…16) — ОБНОВЛЯЕТСЯ (нормативный payload теперь 4 items), 401/403/изоляция-матрица переиспользуется как есть.

### Покрытие
- Всего: 24 (backend 18, frontend/manual 6)
- P0: 9 | P1: 9 | P2: 5 | P3: 1
- Unit/Integration (Jest+supertest): 18 | Manual/preview (Vite): 6

### Стратегия моков (как в ONBTEL-001)
jest-mock `backend/src/db/connection` (`db.query` по очереди вызовов); jest-mock `emailMailboxService` (`getMailboxStatus`), `stripePaymentsService` (`getStatus`), `billingService` (`getSubscription`); REAL `onboardingChecklistService` + REAL `routes/onboarding.js` + mini-express + supertest; REAL `authenticate` для 401-кейсов, auth-stub для остальных. Внешние API (Twilio/Stripe/Google) не вызываются нигде.

---

### TC-OBX-001: полный happy path — новая компания, 0 of 4 done
- **Приоритет:** P0 · **Тип:** Integration · **Сценарий:** §2.2-1
- **Предусловия:** auth-stub tenant_admin company A; completed_at NULL.
- **Моки:** logo NULL; phone_number_settings EXISTS→false; mailbox null; stripe readiness 'not_connected'; subscription {status:'trialing', trial_ends_at: now+14d}.
- **Ожидаемо:** 200; `visible:true`; `progress {done:0,total:4}`; items ровно 4, порядок company_profile→connect_telephony→connect_email→stripe_payments; каждый item несёт key/title/description/done:false/cta/est_minutes/done_note с нормативными строками спецификации §1.2 (verbatim; в строках нет «Blanc»); `trial.active:true`, `days_left:14`; НИ ОДНОГО UPDATE companies.

### TC-OBX-002: частичный прогресс 2 of 4
- **Приоритет:** P0 · **Тип:** Integration
- **Моки:** logo set; telephony EXISTS→true; mailbox null; stripe 'onboarding_incomplete'.
- **Ожидаемо:** items done = [true,true,false,false]; `progress {2,4}`; `visible:true`; UPDATE не вызывается.

### TC-OBX-003: все 4 done → write-once completed_at
- **Приоритет:** P0 · **Тип:** Integration · **Сценарий:** §2.2-3
- **Моки:** все деривации true (logo set, EXISTS true, mailbox {provider:'gmail',status:'connected'}, readiness 'connected_ready'); completed_at NULL → guarded UPDATE возвращает timestamp.
- **Ожидаемо:** ровно ОДИН guarded UPDATE (сигнатура: only-if-NULL + WHERE id=$1, как в ONBTEL); `visible:false`; `completed_at` = значение из UPDATE; `progress {4,4}`.

### TC-OBX-004: completed_at уже стоит (старая компания, 1-шаговая эпоха) — не ресурфейсим
- **Приоритет:** P0 · **Тип:** Integration · **Сценарий:** §2.2-7
- **Моки:** completed_at = '2026-07-01…'; деривации: telephony true, остальные false.
- **Ожидаемо:** `visible:false` НЕСМОТРЯ на не-done шаги; UPDATE НЕ вызывается; items честно [false,true,false,false]; `progress {1,4}`.

### TC-OBX-005: company_profile деривация — обе ветки
- **Приоритет:** P1 · **Тип:** Unit (service)
- **Входные:** (a) `logo_storage_key:'companies/a/logo.png'` → done:true; (b) NULL → false.
- **Ожидаемо:** SQL к companies параметризован company_id ($1).

### TC-OBX-006: connect_email деривация — матрица статусов mailbox
- **Приоритет:** P1 · **Тип:** Unit (service)
- **Входные:** getMailboxStatus → (a) null; (b) {provider:'gmail',status:'connected'}; (c) {provider:'gmail',status:'reconnect_required'}; (d) {provider:'imap',status:'connected'}.
- **Ожидаемо:** done = false/true/false/false; вызов строго с company_id из companyFilter.

### TC-OBX-007: stripe_payments деривация — матрица readiness
- **Приоритет:** P1 · **Тип:** Unit (service)
- **Входные:** getStatus → readiness ∈ {'not_connected','onboarding_incomplete','payouts_disabled','connected_ready','disconnected'}.
- **Ожидаемо:** done:true ТОЛЬКО для 'connected_ready' (payouts_disabled — false, хотя can_collect true).

### TC-OBX-008: connect_telephony — регресс ONBTEL (EXISTS-запрос без изменений)
- **Приоритет:** P1 · **Тип:** Unit
- **Ожидаемо:** тот же SQL `SELECT EXISTS(... phone_number_settings WHERE company_id = $1)`; released-номер (EXISTS false после completed_at) → инвариант TC-OBX-004.

### TC-OBX-009: trial-математика days_left
- **Приоритет:** P1 · **Тип:** Unit
- **Входные:** trial_ends_at = (a) now+14d → 14; (b) now+25h → 2 (ceil); (c) now+1h → 1; (d) now (граница) / now−1s → trial:null (истёк).
- **Ожидаемо:** `days_left = max(0, ceil(Δms/86400000))`; истёкший → null.

### TC-OBX-010: trial отсутствует / не-trialing
- **Приоритет:** P1 · **Тип:** Unit
- **Входные:** getSubscription → (a) null; (b) {status:'active', trial_ends_at:null}; (c) {status:'past_due'}.
- **Ожидаемо:** `trial:null` во всех; ответ 200; items/visible не затронуты.

### TC-OBX-011: ошибка чтения trial НЕ валит чеклист
- **Приоритет:** P0 · **Тип:** Integration
- **Моки:** getSubscription → reject(Error('db down')); деривации отвечают нормально.
- **Ожидаемо:** 200, `trial:null`, console.warn; items/progress/visible полные.

### TC-OBX-012: ошибка деривации item'а → 500 (прежняя семантика ONBTEL)
- **Приоритет:** P1 · **Тип:** Integration
- **Моки:** EXISTS-запрос telephony → reject.
- **Ожидаемо:** 500 `{ok:false, code:'INTERNAL_ERROR'}` (существующий кейс, не деградируем молча).

### TC-OBX-013: 401 без токена (регресс)
- **Приоритет:** P0 · **Тип:** Integration
- **Шаги:** REAL authenticate, запрос без Authorization → 401; с мусорным токеном → 401. Ноль db-вызовов чеклиста.

### TC-OBX-014: 403-матрица ролей (регресс)
- **Приоритет:** P0 · **Тип:** Integration
- **Входные:** role_key ∈ {manager, dispatcher, provider} → 403 `TENANT_ADMIN_ONLY`; без membership → 403 `TENANT_CONTEXT_REQUIRED`; `_devMode` → 200. Ноль checklist-db-вызовов на 403.

### TC-OBX-015: изоляция тенантов — инъекция company_id игнорируется
- **Приоритет:** P0 · **Тип:** Integration
- **Шаги:** auth-stub companyFilter=COMPANY_A; запрос `?company_id=COMPANY_B` + body {company_id:B}.
- **Ожидаемо:** ВСЕ SQL-вызовы и все сервис-моки (mailbox/stripe/billing) получают ТОЛЬКО COMPANY_A; в ответе нет данных B.

### TC-OBX-016: конкурентный guarded UPDATE rowCount:0 (регресс)
- **Приоритет:** P2 · **Тип:** Integration
- **Ожидаемо:** re-read completed_at → `visible:false`; ошибок нет.

### TC-OBX-017: сбой записи completed_at → 200 visible:false (регресс)
- **Приоритет:** P2 · **Тип:** Integration
- **Моки:** UPDATE → reject. **Ожидаемо:** 200, `visible:false`, warn, не 500.

### TC-OBX-018: redirect '/welcome' в POST /api/onboarding
- **Приоритет:** P0 · **Тип:** Integration
- **Моки:** FEATURE_SELF_SIGNUP=true; otp valid; bootstrapCompany → company; trustDevice → cookie.
- **Ожидаемо:** 201, `redirect === '/welcome'`; остальной payload (ok, company.{id,name,timezone}) и cookie — без изменений.

---

### TC-OBX-F01: hub-рендер частичного прогресса (manual/preview)
- **Приоритет:** P0 · **Тип:** E2E manual (Vite preview, dev-mode)
- **Шаги:** /welcome при 2 of 4. **Ожидаемо:** CloudBanner hero + «about 3 minutes» + прогресс-бар «2 of 4 done»; done-карточки: галочка (--blanc-success) + done_note, без CTA; pending: title/description/«~N min»/Set up; клик CTA → нужный route; никаких `<hr>`, hex вне --blanc-*, слова «Blanc».

### TC-OBX-F02: completion-экран
- **Приоритет:** P1 · **Тип:** E2E manual
- **Шаги:** ответ 4 of 4 (можно мокнуть). **Ожидаемо:** тёплый completion-экран, CTA «Go to Pulse» → /pulse; без конфетти; трекер на /pulse отсутствует.

### TC-OBX-F03: компактный трекер на /pulse
- **Приоритет:** P1 · **Тип:** E2E manual
- **Ожидаемо:** одна строка «Finish setting up» + мини-бар + «N of 4 done»; клик → /welcome; при `visible:false` или не-админе — карточки нет; старый collapse-localStorage не влияет.

### TC-OBX-F04: не-админ на /welcome
- **Приоритет:** P1 · **Тип:** E2E manual
- **Шаги:** роль dispatcher, прямой URL /welcome. **Ожидаемо:** мгновенный redirect на /pulse; сетевой 403 не показывается пользователю.

### TC-OBX-F05: trial-информер
- **Приоритет:** P2 · **Тип:** E2E manual
- **Ожидаемо:** «X days left on your trial» + «View plans» → /settings/billing; `trial:null` → блока нет (и нет пустого места/размётки под него).

### TC-OBX-F06: redesign-страницы + mobile
- **Приоритет:** P2/P3 · **Тип:** E2E manual (desktop 1280 + mobile 375)
- **Шаги:** GoogleEmail / TelephonyTwilio / Vapi / MailSecretary not-connected + MarketplaceConnectDialog (smart-slot-engine, ai-repair-advisor).
- **Ожидаемо:** hero-композиция по Stripe-эталону; человечная английская копия; все существующие кнопки/мутации работают (Connect Gmail OAuth-redirect, Twilio-степпер, Enable в диалоге); mobile: одна колонка, диалог читаем; hub адаптивен; горизонтального скролла нет.
