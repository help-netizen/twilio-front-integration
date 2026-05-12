# F015: Document Templates — Detailed Spec

**Status:** Draft
**Related:** `docs/requirements.md#F015`, `docs/architecture.md#F015`

---

## 1. Descriptor schema v1 (canonical)

JSON Schema source: `backend/src/services/documentTemplates/schema/v1.json` (single source of truth, used by Ajv server-side and by the typed frontend form).

```jsonc
{
  "type": "object",
  "required": ["schema_version", "brand", "theme", "sections", "footer"],
  "additionalProperties": false,
  "properties": {
    "schema_version": { "const": 1 },
    "brand": {
      "type": "object",
      "required": ["name", "address", "email", "phone"],
      "additionalProperties": false,
      "properties": {
        "name":    { "type": "string", "minLength": 1, "maxLength": 120 },
        "address": { "type": "string", "maxLength": 240 },
        "email":   { "type": "string", "maxLength": 120 },
        "phone":   { "type": "string", "maxLength": 60 },
        "logo_url":{ "type": ["string", "null"], "maxLength": 500 },
        "ach": {
          "type": ["object", "null"],
          "additionalProperties": false,
          "properties": {
            "bank":           { "type": "string", "maxLength": 80 },
            "routing_number": { "type": "string", "maxLength": 40 },
            "account_number": { "type": "string", "maxLength": 40 }
          }
        }
      }
    },
    "theme": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "ink":     { "type": "string", "pattern": "^#[0-9a-fA-F]{6}$" },
        "muted":   { "type": "string", "pattern": "^#[0-9a-fA-F]{6}$" },
        "faint":   { "type": "string", "pattern": "^#[0-9a-fA-F]{6}$" },
        "surface": { "type": "string", "pattern": "^#[0-9a-fA-F]{6}$" },
        "border":  { "type": "string", "pattern": "^#[0-9a-fA-F]{6}$" },
        "accent":  { "type": "string", "pattern": "^#[0-9a-fA-F]{6}$" },
        "danger":  { "type": "string", "pattern": "^#[0-9a-fA-F]{6}$" }
      }
    },
    "sections": {
      "type": "array",
      "minItems": 1,
      "maxItems": 16,
      "items": {
        "type": "object",
        "required": ["key", "visible"],
        "additionalProperties": false,
        "properties": {
          "key":      { "type": "string", "enum": ["header","ach","client_addresses","summary","items","totals","terms"] },
          "visible":  { "type": "boolean" },
          "body_md":  { "type": ["string", "null"], "maxLength": 8000 }
        }
      }
    },
    "footer": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "show_page_number": { "type": "boolean" },
        "text_md":          { "type": ["string", "null"], "maxLength": 1000 }
      }
    }
  }
}
```

### Section semantics (estimate)
| key                | uses `body_md` | content source |
|--------------------|----------------|----------------|
| `header`           | no             | brand + estimate metadata |
| `ach`              | no             | brand.ach |
| `client_addresses` | no             | estimate.contact_*, estimate.billing_address, estimate.service_address |
| `summary`          | no             | estimate.summary |
| `items`            | no             | estimate.items |
| `totals`           | no             | estimate.subtotal/tax/discount/total |
| `terms`            | yes            | descriptor.sections.terms.body_md |

Unknown keys are rejected by Ajv and by the renderer (defense in depth).

---

## 2. Endpoints

All under `/api/document-templates`. All require `authenticate, requirePermission('tenant.documents.manage'), requireCompanyAccess`. `company_id := req.companyFilter?.company_id || req.user?.company_id`.

### `GET /api/document-templates`
**Query:** `document_type` (optional; default = all types known to the registry)
**Response 200:**
```json
{
  "items": [
    { "id": 1, "document_type": "estimate", "name": "Default", "slug": "default",
      "is_default": true, "schema_version": 1, "updated_at": "2026-05-09T..." }
  ]
}
```
Items are scoped by company; cross-company rows excluded by SQL.

### `GET /api/document-templates/:id`
**Response 200:** full row with `content` JSON.
**404** if not found OR belongs to another company.

### `PUT /api/document-templates/:id`
**Body:** `{ "name"?: string, "content"?: <descriptor> }`
**Validation:** if `content` is present, validated against schema v1; reject with 422 + `{ errors: [...] }` (Ajv error array, sanitized).
**Response 200:** updated row.
**Side effects:** `updated_by = req.user.id`, `updated_at = NOW()`.

### `POST /api/document-templates/:id/reset`
Overwrites `content` with `factory.estimate()` (or appropriate factory for the row's `document_type`).
**Response 200:** updated row.

### `POST /api/document-templates/:id/preview`
**Body:** optional `{ "content": <descriptor>, "fixture_id"?: number }`. If `content` omitted, uses stored content.
**Response 200:**
```json
{
  "descriptor": { ... },
  "estimate": { ... fixture or real estimate ... },
  "rendered_at": "..."
}
```
Frontend renders the HTML preview from this; PDF preview is the existing `/api/estimates/:id/pdf` endpoint, now using the resolved descriptor.

### `GET /api/document-templates/factory/:document_type`
**Response 200:** `{ "document_type": "estimate", "schema_version": 1, "content": <factory descriptor> }`
Read-only; no auth on company scope (factory is global), but route still requires authentication.

---

## 3. Factory descriptor (estimate)

Lives in `backend/src/services/documentTemplates/factory.js`, frozen at module load. Mirrors current hardcoded values exactly:

```js
const ESTIMATE_FACTORY = Object.freeze({
  schema_version: 1,
  brand: {
    name: 'ABC Homes',
    address: '2502 Village Rd W, Norwood, MA 02062, USA',
    email: 'help@bostonmasters.com',
    phone: '(508) 290-4442',
    logo_url: null,
    ach: {
      bank: 'Bank Of America',
      routing_number: '011000138',
      account_number: '466020155621',
    },
  },
  theme: {
    ink: '#172033', muted: '#5f7085', faint: '#eef3f8',
    surface: '#fbfcfe', border: '#d8e0ea',
    accent: '#2563eb', danger: '#be123c',
  },
  sections: [
    { key: 'header', visible: true },
    { key: 'ach', visible: true },
    { key: 'client_addresses', visible: true },
    { key: 'summary', visible: true },
    { key: 'items', visible: true },
    { key: 'totals', visible: true },
    { key: 'terms', visible: true, body_md: '<DEFAULT_TERMS_AND_WARRANTY verbatim>' },
  ],
  footer: { show_page_number: true, text_md: null },
});
```

The migration's seed inlines `JSON.stringify(ESTIMATE_FACTORY)` into the SQL (script, not hand-written) to guarantee parity.

---

## 4. Renderer adapter contract

```js
// backend/src/services/documentTemplates/rendererRegistry.js
register('estimate', {
  render(estimate, descriptor) { /* returns Buffer (PDF bytes) */ },
  renderHtml(estimate, descriptor) { /* returns serializable preview model */ }
});
```

`estimatePdfService.renderEstimatePdf(estimate, descriptor)`:
- `descriptor` defaults to `factory.estimate()` if undefined.
- All references to `COMPANY_PROFILE.*` replaced with `descriptor.brand.*`.
- All references to `DEFAULT_TERMS_AND_WARRANTY` replaced with `findSection('terms')?.body_md ?? ''`.
- All references to `COLORS.*` replaced with `descriptor.theme.*`.
- Sections rendered in `descriptor.sections` array order; sections with `visible: false` are skipped.
- Backwards-compatible exports: module still exports `COMPANY_PROFILE` and `DEFAULT_TERMS_AND_WARRANTY` (now derived from factory descriptor) so existing imports keep working.

---

## 5. Error taxonomy

`DocumentTemplateServiceError(code, httpStatus, message, details?)`:

| code | http | when |
|---|---|---|
| `template_not_found` | 404 | `:id` not found or other company |
| `validation_failed` | 422 | Ajv errors |
| `unknown_document_type` | 400 | `document_type` not in registry |
| `default_required` | 409 | attempt to delete the only default |
| `forbidden` | 403 | permission/company guard (handled by middleware) |

Routes map errors uniformly: `try/catch` → `if (err instanceof DocumentTemplateServiceError) res.status(err.httpStatus).json({ error: err.code, message: err.message, details: err.details })`.

---

## 6. Markdown rendering

- **PDF path:** the renderer parses Markdown into a small AST (paragraphs, bold, lists, line breaks) and emits via existing `paragraph`/`text` operations. No raw HTML, no images, no links (P0).
- **HTML preview path:** Markdown rendered with `marked` + `DOMPurify` allowlist (`p, strong, em, ul, ol, li, br`).
- Use a tiny in-house parser for PDF (10–20 lines) to avoid pulling another dep into backend.

---

## 7. Edge cases

- Empty `sections` array → schema rejects (`minItems: 1`).
- All sections `visible: false` → renderer outputs an almost-empty page with footer; not blocked.
- `terms` section without `body_md` → renders the heading only (consistent with current behavior when the constant is empty); P0 keeps `body_md` mandatory in factory.
- Missing template row at render time (race during migration) → fallback to factory; logged as `warn`.
- Concurrent PUT on the same template: last write wins (P0); `updated_at` lets the editor refuse stale saves with `If-Unmodified-Since` (P1, not P0).
- Validation errors during PUT preserve the previous row (no partial writes).

---

## 8. Frontend behavior

### List page (`/settings/document-templates`)
- Table grouped by `document_type` heading.
- Columns: Name, Default, Updated, Actions (Edit, Reset).
- Empty state per type: "No templates yet — Reset to factory" (resolves by inserting a fresh row from factory).

### Editor page (`/settings/document-templates/:id`)
- Two-column layout: left = form, right = live HTML preview.
- Form sections (collapsible cards): **Brand**, **Theme**, **Sections** (visibility checkboxes per registered key), **Terms & Warranty** (Markdown textarea + char counter), **Footer**.
- Save button disabled until dirty AND valid (client-side schema check).
- Discard restores last-saved descriptor.
- Reset button calls `POST /:id/reset`, then refetches.
- Unsaved-changes guard via `useBlocker` (React Router v6 `unstable_useBlocker` or equivalent existing helper).

---

## 9. Tests (links to `docs/test-cases/F015-document-templates.md`)

Coverage targets:
- Schema validation: positive/negative cases per field.
- Service layer: resolve, update, reset, factory fallback.
- Routes: 401/403/404 isolation, 422 validation.
- Renderer: golden test (factory descriptor produces byte-identical PDF to legacy renderer pre-feature snapshot).
- Frontend: list renders, editor edits and saves, reset works, preview reflects in-progress state.
