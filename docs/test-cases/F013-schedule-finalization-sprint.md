# Тест-кейсы: F013 Schedule Finalization Sprint

> Scope: closing sprint for the remaining `F013` gaps.

## TC-F013-FIN-001: Create-from-slot action is contract-valid

- Открыть пустой slot в `DayView`, `WeekView`, `TimelineView`
- Выбрать доступный action
- Проверить, что action не приводит к `501 / not implemented`

## TC-F013-FIN-002: Create-from-slot preserves slot time

- Открыть slot на конкретное время
- Запустить create flow
- Проверить, что start/end подставлены из выбранного slot

## TC-F013-FIN-003: Timeline create-from-slot preserves provider context

- Открыть slot в колонке provider
- Запустить create flow
- Проверить, что provider context сохранён

## TC-F013-FIN-004: Drag to Unassigned works for job

- Перетащить `job` в `Unassigned`
- Проверить success path и обновление карточки

## TC-F013-FIN-005: Drag to Unassigned works for task

- Перетащить `task` в `Unassigned`
- Проверить success path и обновление карточки

## TC-F013-FIN-006: Lead stays non-draggable

- Проверить `lead` card в reassignment-capable view
- Убедиться, что lead не участвует в drag flow

## TC-F013-FIN-007: Job type filter affects dataset

- Включить `job type` filter
- Проверить, что в выдаче остаются только matching items

## TC-F013-FIN-008: Buffer minutes save and reload

- Открыть dispatch settings
- Изменить `buffer_minutes`
- Сохранить и перезагрузить страницу
- Проверить, что значение persisted

## TC-F013-FIN-009: Single SSE item update does not require mandatory full reload

- Смоделировать одно entity update событие
- Проверить, что schedule state обновляется targeted-path способом или через explicit fallback only when needed

## TC-F013-FIN-010: Burst SSE events remain debounced

- Отправить несколько update events подряд
- Проверить, что API не вызывается на каждый event отдельно

## TC-F013-FIN-011: Compact card shows customer context

- Открыть `WeekView` или другой compact scenario
- Проверить, что customer context читаем без открытия sidebar

## TC-F013-FIN-012: Compact card does not duplicate status

- Проверить compact card со status
- Убедиться, что status отображён один раз

## TC-F013-FIN-013: Count badge exposes breakdown

- Открыть schedule на период с mixed entity types
- Проверить total count и breakdown semantics

## TC-F013-FIN-014: Canonical sidebar behavior is stable on desktop and mobile

- Проверить desktop behavior
- Проверить mobile/tablet overlay behavior
- Убедиться, что docs и реальный UI описывают одно и то же поведение
