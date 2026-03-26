# Спецификация: RF004 — Shared Lead-Form Settings

**Дата:** 2026-03-24
**Статус:** Done
**Зависит от:** RF003 (done)

---

## Цель

Устранить 11 дублирующихся вызовов `/api/settings/lead-form` с одинаковым fetch+parse+error pattern. Единый shared React Query hook с кэшированием.

---

## Решение

### Новый файл: `hooks/useLeadFormSettings.ts`

- React Query hook с `queryKey: ['lead-form-settings']`
- `staleTime: 5 min` — settings меняются редко
- Параметр `enabled` для dialog-based consumers
- Экспортирует canonical `CustomFieldDef` type
- Возвращает `{ customFields, jobTypes, isLoading, error }`

### Мигрированные consumers (11 файлов)

| Файл | Использует |
|---|---|
| `jobs/JobMetadataSection.tsx` | customFields |
| `jobs/JobsFilters.tsx` | jobTypes |
| `leads/LeadDetailSections.tsx` | customFields |
| `leads/EditLeadDialog.tsx` | customFields + jobTypes |
| `leads/CreateLeadDialog.tsx` | customFields + jobTypes |
| `leads/LeadsFilters.tsx` | jobTypes |
| `leads/useConvertToJob.ts` | customFields + jobTypes |
| `conversations/CreateLeadJobWizard.tsx` | jobTypes |
| `hooks/useJobsData.ts` | customFields |
| `hooks/useQuickMessages.ts` | customFields |
| `pages/LeadsPage.tsx` | customFields (searchable) |

### Не мигрирован

- `LeadFormSettingsPage.tsx` — это admin page для CRUD (PUT), использует собственный fetch+save pattern

### Устранённые дупликации

- 4 копии `interface CustomFieldDef` → 1 canonical export
- 11 fetch+parse patterns → 1 React Query hook
- 1 `any` type annotation removed

---

## Verified

- ✅ TypeScript: clean (exit 0)
- ✅ Build: 3,092.78 kB (−1.3 kB from baseline)
- ✅ Lint: 414 problems (−5 from 419 baseline)
