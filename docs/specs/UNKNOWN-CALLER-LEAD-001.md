# UNKNOWN-CALLER-LEAD-001 — Preserve resolved caller identity on AI Phone leads

Status: Implemented  
Date: 2026-07-18

## Problem

Inbound call ingest already resolves the company-scoped contact and links the call timeline. The voice `createLead` skill discarded that server-derived identity and created an unlinked `Unknown Caller` lead from model-provided name fields. Production confirmed the incident timeline was linked to contact `4093` while its AI Phone lead had `contact_id = NULL`.

## Required behavior

| Server-derived identity | Lead behavior |
|---|---|
| Exactly one contact, with a stored name | Write that `contact_id`; split the stored display name into `FirstName`/`LastName`; ignore model name for identity. |
| No resolved contact | Preserve the existing `Unknown Caller` fallback and leave `contact_id` null. |
| Resolver reports ambiguity | Preserve the existing fallback and leave `contact_id` null. |
| Phone produced more than one distinct contact before voice-gate ranking | Preserve the existing fallback and leave `contact_id` null; do not attach the take-latest selection. |

## Security and isolation invariants

- `companyId` continues to come from the dispatcher, never the tool payload.
- `createLead` removes model/client `contactId` before verification. A supplied `contactId` or `contact_id` cannot pin or populate the lead.
- Contact resolution remains the existing company-scoped `agentSkills/identityResolver`; `contactDedupeService` is not used.
- `identityResolver` exposes its distinct pre-ranking `phoneCandidateCount` in the server-only verified context. Existing voice-gate take-latest behavior remains unchanged for other skills; only lead attachment fails closed when the count exceeds one.
- A linked lead takes its name only from `verifiedContext.customerName`. If a resolved contact has no stored display name, the skill does not attach it and retains the legacy fallback.

## Implementation

- `agentSkills/index.js`: omit untrusted `contactId` from the `createLead` identity block.
- `identityResolver.js`: retain the company-scoped phone candidate count before ranking.
- `verificationGate.js`: propagate that count in server-derived verified context.
- `skills/createLead.js`: use a non-ambiguous L1/L2 identity with at most one phone candidate to set `contact_id` and the stored real name; otherwise preserve existing behavior.

No schema migration and no production data mutation are included.

## Tests

- Unique known caller links the lead and replaces model/fallback naming with the stored contact name.
- Unknown and ambiguous callers remain unlinked `Unknown Caller` leads.
- A shared phone remains unlinked even though the general voice resolver retains its take-latest selection.
- Model-supplied contact IDs are removed before resolution and never written.
- Resolver and insert remain scoped to the dispatcher-provided tenant.

## Deferred debt (out of scope)

- Pulse display precedence (`leadName` before `contactName`).
- `contactDedupeService` redesign.
- Zenbooker duplicate-contact cleanup.

## Read-only safe-backfill candidate query

This lists AI Phone leads with no contact link whose normalized phone matches exactly one contact in the same company. It performs no mutation.

```sql
SELECT
    l.id AS lead_id,
    l.uuid AS lead_uuid,
    l.company_id,
    l.created_at,
    l.job_source,
    l.status,
    l.first_name,
    l.last_name,
    l.phone AS lead_phone,
    match.matched_contact_id,
    c.full_name AS contact_name,
    c.phone_e164,
    c.secondary_phone
FROM leads l
JOIN LATERAL (
    SELECT
        COUNT(DISTINCT candidate.id) AS match_count,
        MIN(candidate.id) AS matched_contact_id
    FROM contacts candidate
    WHERE candidate.company_id = l.company_id
      AND (
          RIGHT(REGEXP_REPLACE(COALESCE(candidate.phone_e164, ''), '[^0-9]', '', 'g'), 10)
              = RIGHT(REGEXP_REPLACE(COALESCE(l.phone, ''), '[^0-9]', '', 'g'), 10)
          OR RIGHT(REGEXP_REPLACE(COALESCE(candidate.secondary_phone, ''), '[^0-9]', '', 'g'), 10)
              = RIGHT(REGEXP_REPLACE(COALESCE(l.phone, ''), '[^0-9]', '', 'g'), 10)
      )
) match ON match.match_count = 1
JOIN contacts c
  ON c.id = match.matched_contact_id
 AND c.company_id = l.company_id
WHERE l.contact_id IS NULL
  AND l.job_source IN ('AI Phone', 'AI Phone (Invalid)')
  AND LENGTH(REGEXP_REPLACE(COALESCE(l.phone, ''), '[^0-9]', '', 'g')) >= 10
ORDER BY l.created_at DESC, l.id DESC;
```
