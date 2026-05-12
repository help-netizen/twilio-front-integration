# MAIL-SECRETARY-001: Mail Secretary Marketplace Module

**Status:** Draft
**Related:** `EMAIL-001`, `APP-MKT-001`

---

## 1. Goal

Mail Secretary is an internal Blanc marketplace module that reviews the connected company Gmail mailbox and surfaces only messages that need human attention or action.

The module must be LLM-provider agnostic. Gmail ingestion, normalization, rules, storage, output schemas, and audit records belong to Blanc. Any LLM is a replaceable inference backend behind a provider adapter.

---

## 2. Non-Goals for Phase 1

- No autonomous send, archive, delete, or label changes.
- No raw email persistence for Mail Secretary-specific storage.
- No direct database access from external marketplace apps.
- No OpenAI-specific agent contract.
- No attachment content extraction beyond metadata in the first stage.

---

## 3. Marketplace App

Catalog entry:

```json
{
  "app_key": "mail-secretary",
  "name": "Mail Secretary",
  "provider_name": "Blanc Labs",
  "category": "ai",
  "app_type": "internal",
  "requested_scopes": ["email:read"],
  "provisioning_mode": "none",
  "metadata": {
    "requires_connected_gmail": true,
    "dependency_cta": {
      "label": "Connect Gmail",
      "path": "/settings/email"
    },
    "data_retention": {
      "stores_raw_email": false,
      "persistent_reference": "Gmail message id and thread id",
      "stores_derived_results": true
    }
  }
}
```

Install behavior:

1. Tenant admin clicks `Connect` for Mail Secretary.
2. Marketplace install service loads the app metadata.
3. If `metadata.requires_connected_gmail = true`, Blanc checks `email_mailboxes` for the current `company_id`.
4. If no connected Gmail mailbox exists, install fails with:

```json
{
  "success": false,
  "code": "GMAIL_REQUIRED",
  "message": "Mail Secretary requires a connected Gmail mailbox. Connect Gmail in Settings > Email, then install this module."
}
```

5. UI should render the metadata CTA to `/settings/email`.
6. If Gmail is connected, installation proceeds with `provisioning_mode = none`; no external API credential is issued.

---

## 4. Storage Policy

Mail Secretary stores references and derived outputs, not raw message bodies.

Persistent references:

```json
{
  "provider": "gmail",
  "mailbox_id": "uuid-or-bigint",
  "gmail_message_id": "18f...",
  "gmail_thread_id": "18f...",
  "history_id": "123456",
  "internal_date": "2026-05-11T14:00:00.000Z"
}
```

Allowed derived storage:

- normalized headers and signal flags
- cleaned body text used for triage, if product later decides this is required for audit/debug
- model output JSON
- model/provider metadata
- user feedback
- decision/audit trail

Do not persist:

- Gmail `raw` base64url payload
- attachment binary
- OAuth tokens outside existing encrypted `email_mailboxes` storage

---

## 5. Pipeline

Phase sequence:

```text
Gmail event or synced message reference
-> fetch raw/full message from Gmail
-> MIME parse / Gmail payload normalize
-> cleanup / signal extraction
-> deterministic rules
-> build SecretaryInput JSON
-> LLM adapter
-> validate output schema
-> business confidence gate
-> Blanc attention item
-> user feedback
```

Phase 1 implements only:

```text
company_id + Gmail message id
-> verify connected Gmail mailbox
-> Gmail users.messages.get(format = full | raw | metadata)
-> return transient fetched payload + storage_ref
```

---

## 6. Phase 1: Fetch Gmail Message

Backend service:

```text
backend/src/services/mailSecretaryGmailFetchService.js
```

Public function:

```js
fetchGmailMessage({
  companyId,
  gmailMessageId,
  format = 'full',
  metadataHeaders = null
})
```

Supported formats:

| Format | Use |
|--------|-----|
| `metadata` | cheapest prerequisite/signal fetch; selected headers only |
| `full` | parsed Gmail payload tree; useful when reusing Gmail part structure |
| `raw` | base64url RFC822 message; useful for later `postal-mime` normalization |

Gmail behavior note:
- `full` returns body content parsed in the `payload` field and does not use `raw`.
- `raw` returns body content in `raw` as a base64url string and does not use `payload`.
- `metadata` returns message id, labels, and headers.

Source: Google Gmail API `users.messages.get` / `Format`.

Response shape:

```json
{
  "storage_ref": {
    "provider": "gmail",
    "mailbox_id": "mailbox-1",
    "gmail_message_id": "msg-1",
    "gmail_thread_id": "thread-1",
    "history_id": "99",
    "internal_date": "2026-05-11T14:00:00.000Z"
  },
  "gmail": {
    "id": "msg-1",
    "thread_id": "thread-1",
    "label_ids": ["INBOX"],
    "snippet": "Hello",
    "history_id": "99",
    "internal_date": "1778500000000",
    "size_estimate": 1234,
    "format": "full"
  },
  "payload": {
    "mimeType": "text/plain"
  }
}
```

For `raw` format:

```json
{
  "storage_ref": {
    "provider": "gmail",
    "mailbox_id": "mailbox-1",
    "gmail_message_id": "msg-raw",
    "gmail_thread_id": "thread-raw"
  },
  "gmail": {
    "id": "msg-raw",
    "thread_id": "thread-raw",
    "format": "raw"
  },
  "raw_base64url": "..."
}
```

`raw_base64url` is transient and must be passed directly into normalization, then discarded.

---

## 7. Next Phases

Recommended next module slices:

1. `MAIL-SECRETARY-002`: `postal-mime` normalization for `raw` messages into `normalized_email_json`.
2. `MAIL-SECRETARY-003`: cleanup and signal extraction.
3. `MAIL-SECRETARY-004`: deterministic user rules.
4. `MAIL-SECRETARY-005`: LLM-provider adapter and schema-validated triage output.
5. `MAIL-SECRETARY-006`: attention inbox UI and feedback loop.
