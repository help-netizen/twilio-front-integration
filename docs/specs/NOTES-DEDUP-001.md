# NOTES-DEDUP-001 (OB-22) — duplicate note identity and deterministic ordering

**Date:** 2026-07-21  
**Status:** Implemented and verified locally; not deployed  
**Migration:** 194  
**Builds on:** NOTES-001, NOTES-ID-STABLE-001

## Goal

Repair historical duplicate JSONB note elements and missing creation times across
`jobs.notes`, `leads.structured_notes`, and `contacts.structured_notes`; prevent
future syncs from preserving an already-duplicated array; and make the notes UI
safe and deterministic if malformed duplicate data reaches it again.

The production-confirmed example is job 1486, whose `jobs.notes` contained two
elements with Bubble id `1784577133566x501798706937856000` and notes without a
`created` field.

## Confirmed failure seams

1. `zenbookerSyncService.mergeStructuredNotes` copied `existingNotes` verbatim and
   only deduplicated incoming notes against that copy. An existing duplicate was
   therefore immortal across re-syncs.
2. The separate job sync path, `jobsService.mergeNotes`, indexed existing notes by
   id but did not first collapse an existing collision. Because the production
   example is a job, this path must receive the same treatment.
3. Old array elements predate `normalizeZbCustomerNote` creation-time recovery.
   A Bubble id embeds a millisecond timestamp, but those stored elements were never
   normalized again.
4. `NotesSection` used `note.id` as the React key and menu/edit state identity, so
   duplicate ids could cross-fire. It also used array reversal rather than an
   explicit timestamp sort.

## Decisions taken

### D1 — identity and survivor policy

- Effective identity is `zb_note_id || id`, matching the sync contract.
- Notes without an effective identity remain distinct; content equality is not
  sufficient authority to delete a local note.
- The first array position is retained. If a later collision is richer, its entire
  note object replaces the value at that position.
- Local mutation metadata is authoritative: `deleted_at`, `edited_at`, and
  `created_by` outweigh passive import metadata. Remaining enrichment includes
  `deleted_by`, `edited_by`, non-empty `attachments`, and `created`. Equal richness
  keeps the first survivor.
- Incoming notes are also identity-deduplicated before matching. Existing local
  text, edit metadata, soft-delete metadata, author, creation time, attachments,
  and local id retain the NOTES-001 no-revert behavior.

The shared policy is implemented in
`backend/src/services/noteDeduplication.js` and consumed by both the contact and
job Zenbooker merge paths. Discovery found no Zenbooker/external merge path for
`leads.structured_notes`; Lead routes only perform local add/edit/soft-delete.
Lead history is still repaired by migration 194 and protected by the shared UI.

### D2 — migration 194

Migration 194 runs the same temporary SQL helper over all three arrays. It:

1. expands an array with ordinality;
2. partitions object elements by effective identity while giving every identity-less
   element its own ordinal partition;
3. chooses the richest survivor and retains the first collision position;
4. stamps missing/blank `created` from a valid Bubble millisecond prefix;
5. otherwise stamps from the entity's own `created_at`;
6. leaves the element unchanged only if neither time exists; and
7. updates only rows whose target JSONB column actually changes.

The Bubble range is bounded to a valid JavaScript timestamp before PostgreSQL calls
`to_timestamp`. The output is UTC ISO-8601 with milliseconds. Non-array columns are
not touched. The cleanup intentionally has no tenant predicate: it applies one
data-shape transformation to every tenant and updates only `jobs.notes`,
`leads.structured_notes`, and `contacts.structured_notes`.

The migration is idempotent and was applied twice in one real-PostgreSQL transaction.
Its paired rollback is intentionally a no-op: recreating duplicates or deleting
recovered timestamps would be destructive and cannot restore the exact prior shape.

The read-only remote check immediately before creation returned
`origin/master=0fb32ed283728d6795cb479338b8a20f613a3b98`; its highest migration was
193, so 194 was free.

### D3 — frontend defense in depth

`prepareNotesForDisplay` creates a composite render/action identity of
`<note.id-or-placeholder>:<original-array-index>`. `NotesSection` uses that value
for the React key and for menu/edit state, so two duplicate ids cannot open or edit
each other's card.

Ordering is newest valid `created` first. Missing or invalid `created` is explicitly
oldest; ties, including multiple missing values, use original insertion order. This
is deterministic and does not depend on engine sort behavior.

## Acceptance criteria

- Existing duplicate ids collapse in both structured-note and job-note sync merges.
- The richer Albusto copy survives and incoming ZB data cannot revert a local edit
  or soft-delete.
- Migration 194 repairs all three JSONB columns, backfills usable creation times,
  and a second application is byte-stable.
- Two duplicate ids receive different React/action identities.
- Missing or invalid creation times sort oldest in insertion order.
- Existing NOTES-001 edit/delete behavior, frontend build, and full Vitest remain
  green.

## Named sabotage minimum

| Name | Invariant | Minimum deliberate break | Test that must turn red |
|---|---|---|---|
| `SAB-ND-EXISTING-SELF` | Existing arrays deduplicate before incoming matching | Restore the verbatim `existingNotes` copy | focused `zenbookerSyncService` duplicate test receives length 2 |
| `SAB-ND-RICHEST-NO-REVERT` | Rich local edit wins in contact and job merges | Reverse the richness comparison | focused contact and job tests receive bare ZB text |
| `SAB-ND-MIG-IDENTITY` | SQL collapses the same effective id | Partition every element by ordinal | real-PG result retains four elements |
| `SAB-ND-MIG-RICHEST` | SQL keeps the enriched survivor | Sort richness ascending | real-PG result keeps bare ZB text |
| `SAB-ND-MIG-CREATED` | SQL restores a usable time | Disable the created-stamp branch | Bubble-backed note has `created === undefined` |
| `SAB-ND-UI-KEY` | Duplicate ids cannot share a render/action identity | Remove original index from `renderKey` | focused Vitest receives two identical keys |
| `SAB-ND-UI-SORT` | Missing time is deterministic and oldest | Treat missing/invalid time as positive infinity | focused Vitest orders missing notes first |

## MANDATORY Verification

All commands ran from the worktree root unless a different cwd is stated. The real
PostgreSQL suite ran outside the filesystem sandbox against the local database; it
did not self-skip. No browser, watcher, server, or background process was started.

### Automated results

| Gate | Exact command | Result |
|---|---|---|
| Affected backend + real PostgreSQL | `node --use-bundled-ca --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --runInBand --runTestsByPath tests/notesDedupMigration.db.test.js tests/zenbookerSyncService.test.js tests/mergeNotesIdStability.test.js tests/notesEditDelete.test.js --testPathIgnorePatterns /node_modules/` | exit 0; 4 suites, 16 tests passed; migration ran on real PostgreSQL |
| Frontend focused (cwd `frontend`) | `env -u NODE_USE_SYSTEM_CA NODE_OPTIONS=--use-bundled-ca npm test -- src/components/shared/notesDisplay.test.ts` | exit 0; 1 file, 2 tests passed |
| Full frontend Vitest (cwd `frontend`) | `env -u NODE_USE_SYSTEM_CA NODE_OPTIONS=--use-bundled-ca npm test` | exit 0; 51 files, 281 tests passed |
| Frontend production build (cwd `frontend`) | `env -u NODE_USE_SYSTEM_CA NODE_OPTIONS=--use-bundled-ca npm run build` | exit 0; TypeScript + Vite; 3,541 modules transformed; existing chunk warnings only |
| Remote migration collision check | `git ls-remote origin refs/heads/master` | exit 0; remote hash matches local ref; migration 194 remains free |

### Sabotage break → red → restore ledger

Each break was made with one minimal patch, observed red for the stated assertion,
then reversed with the exact inverse patch and rerun green. The final combined gates
above confirm no sabotage remained.

| Sabotage | Red evidence | Restored evidence |
|---|---|---|
| `SAB-ND-EXISTING-SELF` | focused backend command exited 1: expected one survivor, received two | same focused test exited 0 |
| `SAB-ND-RICHEST-NO-REVERT` | two focused backend tests exited 1: both received original ZB text instead of local edit | same two tests exited 0 |
| `SAB-ND-MIG-IDENTITY` | real-PG command exited 1: expected 3 notes, received 4 | same real-PG command exited 0 |
| `SAB-ND-MIG-RICHEST` | real-PG command exited 1: survivor text was `bare Zenbooker copy` | same real-PG command exited 0 |
| `SAB-ND-MIG-CREATED` | real-PG command exited 1: Bubble note creation time was undefined | same real-PG command exited 0 |
| `SAB-ND-UI-KEY` | focused Vitest exited 1: duplicate keys were identical | same focused test exited 0 |
| `SAB-ND-UI-SORT` | focused Vitest exited 1: missing/invalid notes sorted before dated notes | same focused test exited 0 |

Backend sabotage commands used the same Jest binary/options as the automated gate,
plus the relevant `--testNamePattern`. Frontend sabotage commands used the focused
Vitest command plus `-t` for the relevant case.

## Risks and next gate

- Migration 194 scans the three note columns across all tenants and takes row locks
  only where a repaired JSON value differs. Schedule deployment with normal migration
  monitoring on a large dataset.
- Identity-less elements cannot be safely deduplicated and intentionally remain.
- Rollback cannot recreate the corrupt prior data; it is intentionally non-destructive.
- Next: deploy code and migration 194 together, then verify job 1486 has one survivor
  for the confirmed Bubble id and that its menu and ordering are correct.
