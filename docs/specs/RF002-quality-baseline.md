# Спецификация: RF002 — Quality Baseline

**Дата фиксации:** 2026-03-24  
**Статус:** Зафиксирован и классифицирован  
**Зависит от:** RF001 (done)

---

## Цель

Зафиксировать измеримый и воспроизводимый baseline качества проекта: backend тесты, frontend build, frontend lint. Каждый последующий refactor slice должен сверяться с этим baseline и не ухудшать показатели.

---

## 1. Backend Jest Baseline

**Команда:** `npm test -- --runInBand`

| Метрика | Значение |
|---|---|
| Test Suites | 5 failed, 3 passed, 8 total |
| Tests | 18 failed, 84 passed, 102 total |
| Время | ~1.5 s |

### Падающие suites — классификация

| Suite | Failed Tests | Root Cause |
|---|---|---|
| `keycloakAuth.test.js` | 3 | Auth middleware возвращает 403 вместо 401 при отсутствии header; тесты ожидают старый контракт |
| `paymentsRoute.test.js` | 2 | Тесты `GET /:id (detail)` — расхождение между мокам и текущим route-контрактом |
| `inboxWorker.test.js` | 7 | Тесты ожидают старые named exports (`normalizeVoiceEvent`, `upsertMessage`, `processEvent`); worker code refactored |
| `stateMachine.test.js` | 1 | `shouldFreeze` function не экспортируется/не управляется из теста; `sync_state` остаётся `active` вместо `frozen` |
| `twilioWebhooks.test.js` | 5 | Webhook handler теперь отклоняет запросы через Twilio signature validation (403), тесты не предоставляют валидную сигнатуру |

### Проходящие suites

| Suite | Tests |
|---|---|
| `callFormatter.test.js` | All pass |
| `jwtService.test.js` | All pass |
| `reconcileService.test.js` | All pass |

---

## 2. Frontend Build Baseline

**Команда:** `cd frontend && npx tsc -b && npx vite build`

| Метрика | Значение |
|---|---|
| Результат | ✅ Success |
| Время | ~14 s |

### Warnings

| Warning | Описание | Impact |
|---|---|---|
| Mixed import `jobsApi.ts` | Файл одновременно statically и dynamically imported — dynamic import не разделяет chunk | Code-splitting не работает для `CreateLeadJobWizard.tsx` |
| Chunk size 3,094 kB | Единый JS-бандл значительно превышает 500 kB рекомендацию | Влияет на initial load time |

---

## 3. Frontend Lint Baseline

**Команда:** `cd frontend && npx eslint .`

| Метрика | Значение |
|---|---|
| Total problems | 419 |
| Errors | 392 |
| Warnings | 27 |

### Классификация по правилам

| Rule | Count | Type | Описание |
|---|---|---|---|
| `@typescript-eslint/no-explicit-any` | 177 | error | Нетипизированные `any` по всему frontend |
| `react-hooks/refs` | 155 | error | Неверное использование refs в React hooks (новое правило eslint-plugin-react-hooks v7) |
| `react-refresh/only-export-components` | 32 | error | Файлы экспортируют не-компоненты (helpers, types) рядом с компонентами |
| `react-hooks/exhaustive-deps` | 28 | warning | Missing dependencies в useEffect/useCallback/useMemo |
| `react-hooks/set-state-in-effect` | 11 | error | setState вызывается внутри effects (потенциальные infinite loops) |
| `@typescript-eslint/no-unused-vars` | 6 | error | Неиспользуемые переменные |
| `no-empty` | 5 | error | Пустые catch/if блоки |
| `react-hooks/preserve-manual-memoization` | 4 | error | Неверное использование memo/useMemo |
| `react-hooks/purity` | 1 | error | Side effect в render path |
| `react-hooks/immutability` | 1 | error | Мутация immutable структур |

---

## 4. Frontend Automated Tests

**Статус:** Отсутствуют. В `frontend/` нет test runner, тестовых файлов и devDependencies для тестирования.

---

## Правило baseline

> **Ни один refactor slice не должен увеличить количество падающих Jest suites, build warnings или lint errors.**
> При добавлении нового кода `no-explicit-any` не допускается.
> Исправление существующих lint errors приветствуется, но не обязательно в рамках каждого slice.

---

## Воспроизводимость

Baseline воспроизводим на текущем коммите. Команды для проверки:

```bash
# Jest
cd twilio-front-integration && npm test -- --runInBand

# Frontend build
cd twilio-front-integration/frontend && npx tsc -b && npx vite build

# Frontend lint
cd twilio-front-integration/frontend && npx eslint .
```
