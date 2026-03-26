# Спецификация: RF003 — Canonical Frontend Transport Layer

**Дата:** 2026-03-24  
**Статус:** Done  
**Зависит от:** RF002 (done)

---

## Цель

Зафиксировать `authedFetch` (`frontend/src/services/apiClient.ts`) как canonical frontend transport layer. Устранить raw `fetch` в новом коде. Существующие axios-based модули не мигрируются в этом slice.

---

## Текущее состояние transport layer

### 3 конкурирующих подхода

| Transport | Файл | Consumers | Тип |
|---|---|---|---|
| `authedFetch` | `services/apiClient.ts` | ~40 файлов (hooks, pages, components) | **Canonical** — bare `fetch` wrapper с auth |
| Axios `apiClient` | `services/api.ts` | `messagingApi.ts`, `callsApi` (в `api.ts`) | Axios instance с auth + 401/403 interceptors |
| Axios clone | `services/pulseApi.ts` | `pulseApi` functions | Отдельный `axios.create()` с тем же auth |

### Устранённое нарушение

| Файл | Было | Стало |
|---|---|---|
| `pages/SuperAdminPage.tsx` | raw `fetch()` с ручным `Authorization` header | `authedFetch()` из `apiClient.ts` |

---

## Transport Policy

### ✅ Для нового кода

1. Все новые API-вызовы должны использовать `authedFetch` из `services/apiClient.ts`
2. Запрещено создавать новые `axios.create()` instances
3. Запрещено использовать raw `fetch()` с ручным `Authorization` header
4. `Content-Type: application/json` добавлять при необходимости явно в `init.headers`

### ⚠️ Существующий код (не трогаем в этом slice)

- `services/api.ts` — axios-based `callsApi` и shared `apiClient` для `messagingApi.ts`
- `services/pulseApi.ts` — отдельный axios clone
- Планируемая миграция → отдельный refactor slice при необходимости

### 🛡️ Protected

- `services/apiClient.ts` — canonical transport, не дублировать

---

## Verified

- ✅ Build проходит (3,093.93 kB, те же warnings)
- ✅ Lint не ухудшился (418 problems vs 419 baseline)
- ✅ `SuperAdminPage.tsx` больше не содержит raw `fetch()` calls
