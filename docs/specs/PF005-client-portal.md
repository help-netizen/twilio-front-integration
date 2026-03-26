# Спецификация: PF005 — Client Portal

**Дата:** 2026-03-24
**Статус:** Proposed
**Приоритет:** P0
**Зависит от:** `PF002`, `PF003`, `PF004`; текущие `Contacts`, `Jobs`, notification/messaging infrastructure

---

## Цель

Создать единый клиентский self-service portal, через который клиент:

- видит estimates и invoices;
- approve / sign;
- видит upcoming/past jobs;
- обновляет contact details.

Portal должен быть единым входом во все клиентские документы и платежи, а не набором разрозненных ссылок.

---

## Что уже есть

- есть `Contacts`, `Jobs`, `Payments`;
- есть SMS/email sending surfaces;
- есть `Pulse` и realtime layer для внутренних уведомлений;
- есть action-required reasons, включая `Estimate approved`.

---

## Встраивание в текущий продукт

### Основной принцип

Клиентские send flows для `Estimate` и `Invoice` должны вести не на "голый документ", а в `Client Portal`.

### Новый public route

- публичный portal route должен быть отдельным, например `/portal/:token`.
- route не должен требовать внутренней auth-сессии сотрудника.

### Internal preview mode

Для внутренних пользователей должен существовать preview mode:

- открывается из send/preview flow;
- показывает unsent docs;
- визуально отличим от реального клиентского режима.

---

## Пользовательские сценарии

1. Клиент получает SMS/email и открывает портал по уникальной ссылке.
2. В portal inbox он видит все отправленные ему estimates и invoices, требующие действия.
3. Клиент approve/sign document и видит outstanding balance/payment history.
4. Клиент открывает `My bookings`, смотрит будущие и прошлые jobs.
5. Клиент обновляет телефон/email.

---

## Функциональные требования

### 1. Access model

P0 portal работает по magic-link/token access.

Требования:

- токен scoped к конкретному client/contact;
- токен имеет срок жизни и возможность revoke/regenerate;
- portal session не должна раскрывать внутренние admin endpoints.

### 2. Portal sections

В P0 обязательны 3 раздела:

- `Inbox`
- `My bookings`
- `Profile`

### 3. Inbox

`Inbox` показывает:

- sent estimates
- sent invoices
- document statuses
- outstanding balances
- actions required

Клиент должен уметь:

- открыть документ;
- approve/decline estimate;
- sign document;
- скачать/просмотреть attachments.

### 4. My bookings

Показывать:

- upcoming jobs
- past jobs
- date/time
- service type
- service location
- assigned provider, если доступен

Для P0 не требуется online reschedule и new booking creation.

### 5. Profile

Клиент может:

- обновить имя
- обновить phone/email
- просмотреть payment history

Обновления должны синхронизироваться в существующую contact model, а не жить только в portal cache.

### 6. Document visibility rules

- клиент видит только документы, которые были отправлены;
- unsent draft доступны только во внутреннем preview mode;
- portal должен показывать историю прошлых документов и платежей, если они принадлежат этому contact/client.

### 7. Portal actions -> internal events

Portal обязан генерировать внутренние события:

- `portal.opened`
- `estimate.viewed`
- `estimate.approved`
- `estimate.declined`
- `invoice.viewed`
- `contact.updated_by_client`

Эти события должны:

- писать timeline item в текущий `Pulse` timeline, где уже находятся SMS/call события;
- быть доступны automation engine;
- при необходимости поднимать action-required.

### 8. Preview mode

Preview mode для внутренних пользователей должен:

- открываться из `Estimate` / `Invoice` send flow;
- позволять проверить рендер документа и portal layout;
- иметь явный preview banner;
- не смешиваться с реальным client analytics.

### 9. Security

Требования:

- tokenized access
- audit по portal access
- rate limiting
- signed links / server-side validation
- изоляция клиента только в пределах его records

---

## Data / API требования

### Backend contracts

Нужны как минимум:

- `POST /api/portal/links`
- `GET /api/portal/session/:token`
- `GET /api/portal/inbox/:token`
- `GET /api/portal/bookings/:token`
- `PATCH /api/portal/profile/:token`
- `GET /api/portal/payments/:token`

### Data model

Нужны сущности/таблицы или эквивалент:

- `portal_access_tokens`
- `portal_sessions`
- `portal_events`

Portal не должен создавать отдельного `client` domain layer. Он работает на текущих `contacts`, `jobs`, `estimates`, `invoices`, `payments`.

---

## Ограничения

- online booking из portal не входит в P0;
- client-to-team messaging inbox внутри portal не входит в P0;
- self-serve reschedule/cancel не входит в P0;
- full password-based customer account system не входит в P0.

---

## Acceptance criteria

- Estimate/invoice send flows ведут в единый portal.
- Клиент видит отправленные документы, jobs и payment history.
- Клиент может approve/sign document и обновлять contact details.
- Все portal actions отражаются в internal events/Pulse.
- Internal preview mode существует и отделён от реального client mode.
- Portal не вводит отдельную параллельную клиентскую модель.
