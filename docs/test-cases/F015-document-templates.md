# F015: Document Templates — Test Cases

**Related spec:** `docs/specs/F015-document-templates.md`

Priorities: P0 = must pass before merge. P1 = nice-to-have for first release. P2 = follow-up.

---

## Backend — Schema validation (unit)

| ID | Priority | Type | Case | Expected |
|---|---|---|---|---|
| TC-F015-001 | P0 | unit | Factory descriptor passes Ajv schema v1 | `valid === true` |
| TC-F015-002 | P0 | unit | Missing `brand.name` is rejected | error path `/brand/name`, `required` |
| TC-F015-003 | P0 | unit | Color with invalid hex (`#zzz`) rejected | error path `/theme/accent`, `pattern` |
| TC-F015-004 | P0 | unit | Section with unknown `key` rejected | error `enum` |
| TC-F015-005 | P0 | unit | `body_md` over 8000 chars rejected | error `maxLength` |
| TC-F015-006 | P0 | unit | Empty `sections[]` rejected | error `minItems` |
| TC-F015-007 | P1 | unit | `additionalProperties` at top level rejected | Ajv error |
| TC-F015-008 | P1 | unit | `schema_version != 1` rejected | error `const` |

## Backend — Service layer (`documentTemplatesService`, unit)

| ID | Priority | Case | Expected |
|---|---|---|---|
| TC-F015-010 | P0 | `resolveTemplate(companyId, 'estimate')` returns the active default content for that company | content matches DB row |
| TC-F015-011 | P0 | `resolveTemplate(companyId, 'estimate')` falls back to factory if no row | returns factory descriptor; logs `warn` |
| TC-F015-012 | P0 | `resolveTemplate(companyId, 'estimate')` ignores rows from other companies | returns factory if cross-company only |
| TC-F015-013 | P0 | `update(companyId, id, { content: invalid })` throws `validation_failed` 422 | error code matches |
| TC-F015-014 | P0 | `update(companyId, id, { content: valid })` persists and bumps `updated_at`, sets `updated_by` | row reflects changes |
| TC-F015-015 | P0 | `reset(companyId, id)` overwrites content with factory | content equals factory after call |
| TC-F015-016 | P1 | `update` for cross-company `id` throws `template_not_found` | error code matches |

## Backend — Routes (`/api/document-templates`, integration)

Use existing test harness (`tests/routes/`).

| ID | Priority | Case | Expected |
|---|---|---|---|
| TC-F015-020 | P0 | `GET /` without auth → 401 | middleware blocks |
| TC-F015-021 | P0 | `GET /` with auth but missing permission → 403 | `requirePermission` blocks |
| TC-F015-022 | P0 | `GET /?document_type=estimate` returns only this company's rows | response items all `company_id == req.user.company_id` (verified via SQL spy) |
| TC-F015-023 | P0 | `GET /:id` for other-company id → 404 | not 200 |
| TC-F015-024 | P0 | `PUT /:id` invalid descriptor → 422 with details | body contains `error: 'validation_failed'` |
| TC-F015-025 | P0 | `PUT /:id` valid descriptor → 200, persisted | next GET returns new content |
| TC-F015-026 | P0 | `POST /:id/reset` → 200, content = factory | content matches `factory.estimate()` |
| TC-F015-027 | P1 | `GET /factory/estimate` returns factory regardless of company | content === factory |
| TC-F015-028 | P1 | `POST /:id/preview` with override `content` returns it without persisting | DB row unchanged |

## Backend — Renderer integration

| ID | Priority | Type | Case | Expected |
|---|---|---|---|---|
| TC-F015-030 | P0 | golden | `renderEstimatePdf(estimate, factoryDescriptor)` byte-equals pre-feature snapshot | identical Buffer |
| TC-F015-031 | P0 | unit | `renderEstimatePdf(estimate)` (no descriptor) uses factory | output equals TC-030 |
| TC-F015-032 | P0 | unit | Setting `terms.visible = false` removes "Terms & Warranty" heading | text scan absent |
| TC-F015-033 | P0 | unit | Custom `brand.name` appears in header | text scan present |
| TC-F015-034 | P1 | unit | Custom `theme.accent` color used in totals frame | (visual; assert hex-to-rgb literal in PDF stream) |
| TC-F015-035 | P1 | unit | All sections invisible → still emits at least one page with footer | no throw, page count ≥ 1 |

## Migration

| ID | Priority | Case | Expected |
|---|---|---|---|
| TC-F015-040 | P0 | Run `084_create_document_templates.sql` on a DB that has companies | one row per company for `document_type='estimate'`, `is_default=true`, content equals factory |
| TC-F015-041 | P0 | Re-running migration is idempotent | row count unchanged, no error |
| TC-F015-042 | P0 | Unique partial index prevents two defaults | direct `INSERT` of second default fails with constraint violation |

## Frontend (component / integration)

| ID | Priority | Case | Expected |
|---|---|---|---|
| TC-F015-050 | P0 | List page renders one row per template grouped by type | row visible, default badge shown |
| TC-F015-051 | P0 | Editor opens populated with current descriptor | brand.name appears in input |
| TC-F015-052 | P0 | Editing brand.name and saving calls PUT, refetches | button disabled while saving, list shows new updated_at |
| TC-F015-053 | P0 | Invalid color in theme picker disables Save | client-side validation |
| TC-F015-054 | P0 | Reset confirms then calls POST /:id/reset | descriptor reverts to factory |
| TC-F015-055 | P1 | Toggling section visibility in editor updates live preview | preview re-renders without backend round-trip |
| TC-F015-056 | P1 | Unsaved-changes guard blocks navigation | useBlocker prompt fires |
| TC-F015-057 | P2 | Markdown in terms supports bold and lists | preview renders as `<strong>` and `<ul>` |

## Cross-cutting

| ID | Priority | Case | Expected |
|---|---|---|---|
| TC-F015-060 | P0 | Existing estimate PDF endpoint still returns identical bytes for an unedited tenant | golden Buffer match |
| TC-F015-061 | P1 | Render does not query `document_templates` more than once per estimate request | request-scoped cache works |
| TC-F015-062 | P1 | Adding a fake `document_type='invoice'` row + factory + adapter is sufficient to list it in the UI | Settings page shows the new group |
