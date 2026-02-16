---
title: "Требования: индикация непрочитанных сообщений в списке контактов"
version: "1.0.0"
language: "ru"
owner: "Product / Frontend"
updated_at: "2026-02-16"
scope:
  screen: "Conversations / Contacts List"
  in_scope:
    - "Выделение контактов с новыми входящими сообщениями"
    - "Dot-индикатор непрочитанного"
    - "Легкий фоновый акцент строки"
    - "Сортировка с приоритетом непрочитанных"
    - "Mark-as-read при открытии диалога"
  out_of_scope:
    - "Фильтр по статусу прочтения (All/Unread/Read)"
    - "Badge с количеством непрочитанных"
business_goal:
  - "Оператор мгновенно видит, где есть новые сообщения"
  - "Сокращение времени до первого ответа"
definitions:
  unread_dialog: "Есть новое входящее сообщение после последнего чтения оператором"
  read_dialog: "Нет новых входящих сообщений после последнего чтения"
  has_unread: "Булево поле непрочитанного статуса"
logic:
  unread_rule:
    primary: "has_unread == true"
    fallback: "last_incoming_at > last_read_at"
  important_notes:
    - "Исходящие сообщения оператора НЕ должны делать диалог непрочитанным"
    - "Системные/служебные события не влияют на has_unread, если не customer-visible"
ui:
  unread_row:
    contact_name_font_weight: "600-700"
    last_message_font_weight: "500-600"
    indicator: "dot"
    background_accent: "required"
  read_row:
    contact_name_font_weight: "400-500"
    last_message_font_weight: "400-500"
    indicator: "none"
    background_accent: "none"
  indicator_spec:
    type: "dot"
    placement: "рядом с именем контакта (leading/trailing по дизайн-системе)"
    size_px: 8
    min_touch_target_px: 24
behavior:
  on_open_dialog:
    - "POST /conversations/{id}/mark-read"
    - "set has_unread=false (optimistic)"
    - "убрать dot и фоновый акцент"
    - "при ошибке API откатить состояние и показать toast"
sorting:
  default: "unread_first"
  rules:
    - "Сначала has_unread=true"
    - "Внутри группы сортировка по last_message_at DESC"
realtime:
  transport: ["WebSocket", "SSE", "Long-poll fallback"]
  update_event: "conversation.updated"
  fields: ["has_unread", "last_message_preview", "last_message_at", "last_incoming_at"]
  batching_ms: "100-300"
data_contract:
  list_item_fields:
    - "contact_id: string"
    - "display_name: string"
    - "last_message_preview: string"
    - "last_message_at: ISO-8601"
    - "last_incoming_at: ISO-8601 | null"
    - "last_read_at: ISO-8601 | null"
    - "has_unread: boolean"
api_contract:
  endpoints:
    - method: "GET"
      path: "/conversations?sort=unread_first|recent"
      purpose: "Получить список контактов/диалогов"
    - method: "POST"
      path: "/conversations/{id}/mark-read"
      purpose: "Снять статус непрочитанного"
a11y:
  requirements:
    - "aria-label для непрочитанных: 'Контакт {name}, есть непрочитанные сообщения'"
    - "Контраст dot и фонового акцента соответствует WCAG AA"
    - "Не полагаться только на цвет: использовать также более жирный текст"
performance:
  requirements:
    - "Виртуализация списка для больших объемов"
    - "Пагинация / lazy loading"
    - "Минимизировать перерисовки строк"
edge_cases:
  - "Новое сообщение пришло в открытый диалог: если сообщение в видимой области, можно сразу считать прочитанным"
  - "Сообщение удалено/отозвано: пересчитать has_unread"
  - "Несколько операторов: read-state per-user (если модель доступа это требует)"
acceptance_criteria:
  - "При новом входящем сообщении контакт получает dot, фоновый акцент и приоритет в сортировке"
  - "После открытия диалога dot и фоновый акцент исчезают ≤ 1 сек при успешном API"
  - "Исходящее сообщение оператора не меняет has_unread на true"
  - "После перезагрузки страницы read/unread состояние сохраняется корректно"
qa_checklist:
  - "[ ] Входящее сообщение выставляет has_unread=true"
  - "[ ] Исходящее сообщение не влияет на has_unread"
  - "[ ] mark-read срабатывает при открытии диалога"
  - "[ ] Dot отображается только у непрочитанных"
  - "[ ] Легкий фоновый акцент отображается только у непрочитанных"
  - "[ ] Сортировка unread_first работает корректно"
---

# Требования: индикация непрочитанных сообщений в списке контактов

## 1. Цель
Сделать визуально очевидным, по каким контактам есть новые входящие сообщения, чтобы оператор быстрее реагировал на обращения.

## 2. Что обязательно в UI
- Для непрочитанных диалогов:
  - **dot-индикатор**;
  - **легкий фоновый акцент строки**;
  - более выраженная типографика (имя и превью).
- Для прочитанных:
  - без dot;
  - без фонового акцента;
  - стандартная типографика.

## 3. Чего не делаем
- Не добавляем фильтр по статусу прочтения.
- Не используем badge с числом непрочитанных — только dot.

## 4. Логика read/unread
Диалог непрочитан, если `has_unread=true`  
(или fallback: `last_incoming_at > last_read_at`).

При открытии диалога:
1. Отправить `mark-read`.
2. Оптимистично снять `has_unread`.
3. Убрать dot и акцент.
4. Если API вернул ошибку — откатить состояние + toast.

## 5. Сортировка
По умолчанию — **Unread first**:
1. `has_unread=true` выше.
2. Внутри группы сортировка по `last_message_at DESC`.

## 6. Минимальный контракт данных
```json
{
  "contact_id": "string",
  "display_name": "string",
  "last_message_preview": "string",
  "last_message_at": "ISO-8601",
  "last_incoming_at": "ISO-8601 | null",
  "last_read_at": "ISO-8601 | null",
  "has_unread": false
}
```

## 7. Realtime
- Поддержать обновления через WebSocket/SSE (fallback: long-poll).
- Событие `conversation.updated` должно обновлять:
  - `has_unread`
  - `last_message_preview`
  - `last_message_at`
  - `last_incoming_at`

## 8. Accessibility
- `aria-label`: “Контакт {name}, есть непрочитанные сообщения”.
- Контраст dot/акцента — WCAG AA.
- Состояние должно читаться не только цветом (жирность + dot).

## 9. Критерии приемки
1. Новое входящее сообщение:
   - включает dot;
   - включает легкий фоновый акцент;
   - поднимает контакт выше прочитанных.
2. После открытия диалога:
   - dot и акцент исчезают ≤ 1 сек (при успешном API).
3. Исходящие сообщения оператора:
   - не включают непрочитанный статус.
4. После перезагрузки:
   - статус read/unread консистентен с сервером.
