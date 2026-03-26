# Спецификация: RF007 — Phone Helper Consolidation

**Дата:** 2026-03-24
**Статус:** Done
**Зависит от:** RF003 (done)

---

## Цель

Консолидировать 3 дублирующихся phone formatter surface в один canonical source.

---

## Проблема

3 файла с одинаковой логикой форматирования US-phone:
1. `utils/phoneUtils.ts::formatPhoneDisplay()` — canonical
2. `lib/formatPhone.ts::formatPhone()` — duplicate (4 consumers)
3. `utils/formatters.ts::formatPhoneNumber()` — duplicate (4 consumers)

## Решение

### Canonical source: `utils/phoneUtils.ts`

- `formatPhoneDisplay(e164: string | null | undefined): string` — сигнатура расширена для backward compat
- `normalizeToE164(input: string): string | null`
- `isLikelyPhoneInput(input: string): boolean`

### Мигрированные consumers (8 файлов)

| Файл | Было | Стало |
|---|---|---|
| `JobInfoSections.tsx` | `lib/formatPhone` | `utils/phoneUtils` |
| `leadsTableHelpers.tsx` | `lib/formatPhone` | `utils/phoneUtils` |
| `LeadDetailPanel.tsx` | `lib/formatPhone` | `utils/phoneUtils` |
| `PulseContactPanel.tsx` | `lib/formatPhone` | `utils/phoneUtils` |
| `ConversationListItem.tsx` | `formatters::formatPhoneNumber` | `utils/phoneUtils` |
| `call-list-item.tsx` | `formatters::formatPhoneNumber` | `utils/phoneUtils` |
| `PulseCallListItem.tsx` | `formatters::formatPhoneNumber` | `utils/phoneUtils` |
| `PulseContactItem.tsx` | `formatters::formatPhoneNumber` | `utils/phoneUtils` |

### Dead code

- `lib/formatPhone.ts` — 0 consumers, can be deleted
- `formatters.ts::formatPhoneNumber` — used only internally by `createPhoneLink()` in same file

### Audio players — deferred

`CallAudioPlayer.tsx` (85 LOC) и `PulseCallAudioPlayer.tsx` (162 LOC) have different UX contexts (legacy vs timeline view). Merging not justified at this stage.

---

## Verified

- ✅ TypeScript: clean (exit 0)
