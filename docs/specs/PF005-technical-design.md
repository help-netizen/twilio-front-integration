# Technical Design: PF005 — Client Portal

**Дата:** 2026-03-24
**Статус:** Proposed
**Связанный functional spec:** `PF005-client-portal.md`

---

## 1. Design intent

Portal is a public-facing surface, but must still reuse the same backend entities and rendering contracts as the internal app.

Technical goals:

- single portal entry for documents and payments;
- token-based access;
- no second customer account domain;
- shared render path with internal preview.

---

## 2. Frontend architecture

### Public subtree

Portal should be implemented as a public subtree of the existing React app:

- `/portal/:token`
- `/portal/:token/document/:documentType/:documentId`

New frontend files:

- `frontend/src/pages/portal/PortalShell.tsx`
- `frontend/src/pages/portal/PortalInboxPage.tsx`
- `frontend/src/pages/portal/PortalDocumentPage.tsx`
- `frontend/src/pages/portal/PortalBookingsPage.tsx`
- `frontend/src/pages/portal/PortalProfilePage.tsx`
- `frontend/src/services/portalApi.ts`

### Shared document rendering

Estimate/invoice client rendering should reuse the same presentational blocks as internal preview.

That avoids two separate document templates.

---

## 3. Backend architecture

New files:

- `backend/src/routes/portal.js`
- `backend/src/services/portalService.js`
- `backend/src/db/portalQueries.js`

Portal service responsibilities:

- token validation
- contact scoping
- inbox aggregation
- bookings aggregation
- profile updates
- portal event emission

---

## 4. Access model

### Token strategy

- portal links store token hash, not plain token
- token bound to `contact_id`
- optional `scope_type/scope_id` for narrow document links
- support expiration and revocation

### Session tracking

Portal session is lightweight and separate from internal auth:

- no Keycloak account required
- audit via `portal_sessions`
- request auth derived from token, not internal JWT

---

## 5. Inbox aggregation

Portal inbox read model aggregates:

- sent estimates
- sent invoices
- outstanding balances
- document actions

The portal should never query internal admin-only lists directly. It needs a scoped `portal inbox` read model.

---

## 6. Bookings read model

Portal bookings are derived from current job data:

- future jobs
- past jobs
- schedule/time
- address
- service summary
- optional provider display

No self-service reschedule/cancel in P0.

---

## 7. Profile update flow

Portal profile updates must write back into current contact domain.

Write path:

- validate portal token
- update allowed contact fields
- persist audit event
- emit `contact.updated_by_client`

Avoid:

- standalone portal profile storage disconnected from `contacts`

---

## 8. Portal/payment integration

Portal is the main UI for online payment completion.

Portal document page should:

- request checkout link from payment collection service
- redirect or embed provider UX
- show success/failure state
- refresh document aggregate state after payment webhook confirmation

---

## 9. API design

- `POST /api/portal/links`
- `GET /api/portal/session/:token`
- `GET /api/portal/inbox/:token`
- `GET /api/portal/bookings/:token`
- `PATCH /api/portal/profile/:token`
- `GET /api/portal/payments/:token`
- `POST /api/portal/payment-methods/:token`

Document endpoints may live either under:

- `/api/portal/estimates/...`
- `/api/portal/invoices/...`

or be served through one portal document gateway.

---

## 10. Event model

Portal service publishes:

- `portal.opened`
- `estimate.viewed`
- `estimate.approved`
- `estimate.declined`
- `invoice.viewed`
- `invoice.paid`
- `contact.updated_by_client`

Events fan out to:

- `domain_events`
- Pulse timeline
- automation matcher

---

## 11. Rollout plan

### Phase 1

- token access
- inbox + document view

### Phase 2

- document actions
- bookings
- profile

### Phase 3

- payment methods
- internal preview parity
- analytics/audit polish

---

## 12. Main risks

- portal becoming a separate mini-app with duplicated business logic
- drift between internal preview and client view
- weak token scoping/security

### Mitigation

- shared document render blocks
- portal service as scoped adapter, not separate domain
- hashed tokens + expiration + audit trail
