# TIMELINE-COMPANY-NUMBER-LEAK-001 — an SMS keyed to the company's own number leaks into every timeline

**Area:** backend only (`backend/src/routes/pulse.js`). No migration.

## Root cause (confirmed on prod)
The Pulse timeline resolves which SMS conversations belong to a contact/timeline by a
set of phone numbers. That set includes **`callPhones` = BOTH `from_number` AND
`to_number` of the timeline's calls**. Every call has the company's OWN number as one
leg, so the company's number always enters the search set. The SMS query then matches
`sms_conversations.customer_e164` against that set:
```sql
SELECT * FROM sms_conversations
WHERE regexp_replace(customer_e164, '\D', '', 'g') = ANY($1) AND company_id = $2
```
So a conversation accidentally keyed with `customer_e164 = <a company number>` (e.g. a
rate-link SMS sent for a job whose customer phone was the company's own main number)
surfaces in **every timeline that has any call** — it looked like a mass send but was one
conversation leaking into all timelines.

Two functions have the identical logic and BOTH must be fixed:
- `discoverTimelineConversations(contact, timeline, companyId)` (~line 322) — the paged
  path (`buildTimelinePage`, used by mobile).
- `buildTimeline(req, res, contact, timeline)` (~line 550) — the non-paged path.

## Fix
Exclude the company's OWN numbers from the phone set used to find SMS conversations, in
BOTH functions.

- Resolve the company's own numbers (digits-normalized set) via the company's sending
  numbers — the same signal already used at pulse.js ~line 793:
  ```sql
  SELECT DISTINCT proxy_e164 FROM sms_conversations
  WHERE company_id = $1 AND proxy_e164 IS NOT NULL
  ```
  Normalize each to digits (`replace(/\D/g,'')`). Cache/compute once per request is fine.
- When assembling the phone-search set, **drop any number whose digits are in the
  company-number set** — specifically filter `callPhones` (the call legs) before adding
  them. KEEP the timeline's own phone (`contact.phone_e164 || timeline.phone_e164`) and
  the contact's secondary phone (those are the customer's, not the company's).
- Extract a small shared helper (e.g. `getCompanyOwnNumberDigits(companyId)` returning a
  `Set<string>` of digit-strings) so the two functions don't duplicate the query/filter.

## Acceptance criteria
1. A conversation whose `customer_e164` equals one of the company's own proxy numbers does
   NOT appear in unrelated timelines. (The two rate-me test messages stop showing in every
   timeline.)
2. A normal customer's SMS still appears in that customer's own timeline — matching by the
   timeline's own phone + secondary + the EXTERNAL call legs still works.
3. Both the paged (`discoverTimelineConversations`) and non-paged (`buildTimeline`) paths
   are fixed; company scoping (`company_id`) preserved everywhere.

## Out of scope
- The one anomalous test conversation (customer_e164 = company number) — a data cleanup
  handled separately; the display fix makes it harmless.
- Any change to how SMS are sent.

## Verify
- `npm test` for the pulse timeline area (report the exact pattern used + exit code).
- Add/extend a jest test proving a conversation with `customer_e164` = the company proxy is
  EXCLUDED from a timeline whose calls involve that company number, while a real customer's
  conversation is still INCLUDED. If no pulse-timeline test file exists, add a focused unit
  test around the phone-set/filter helper. State what you did.
