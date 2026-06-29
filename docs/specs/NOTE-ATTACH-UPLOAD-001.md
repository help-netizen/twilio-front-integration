# NOTE-ATTACH-UPLOAD-001 — Pre-upload note attachments with progress feedback

**Type:** UX bug-fix · backend + frontend · S3 (Tigris) storage · **no migration**.
Fixes: attaching a file then pressing "Add note" freezes the disabled button ~30s (the file uploads at
submit) with zero feedback.

## Goal
1. Upload each attached file **immediately on attach** (staged), not at submit.
2. **Spinner** feedback per file while uploading; error state on failure.
3. **Disable** "Add note"/"Save" while any attachment is still uploading.
Applies to the new-note composer AND the edit-note flow, job/lead/contact, mobile + desktop.

## Key fact (marker for "staged")
Committed attachments ALWAYS have a numeric `note_index` (create: `notes.length`; edit: the note index).
So **staged = `note_index IS NULL`** — unambiguous, no migration. The display join already falls back to
`note_index` for legacy rows, so excluding `note_index IS NULL` hides ONLY staged rows.

## Backend
### `services/noteAttachmentsService.js` (extend)
- `stageAttachments(companyId, entityType, entityId, files, userId)` — validate type/size (reuse limits),
  upload to S3 via `storageService`, INSERT `note_attachments` with **`note_index = NULL`, `note_id = NULL`**
  (staged). Returns `[{ id, fileName, contentType, fileSize }]`.
- `associateStagedAttachments(companyId, entityType, entityId, attachmentIds, noteId, noteIndex)` —
  `UPDATE note_attachments SET note_id=$noteId, note_index=$noteIndex WHERE id = ANY($ids) AND company_id=$c
  AND entity_type=$t AND entity_id=$e AND note_index IS NULL` → returns the now-committed rows
  `[{id,fileName,contentType,fileSize}]`. Enforces `existingCount + ids.length ≤ MAX_FILES_PER_NOTE`.
  Ignores ids that don't match (cross-tenant / already-committed / wrong entity) — only genuinely-staged
  rows owned by this company+entity are associated.
- `getAttachmentsForEntity` — add `AND note_index IS NOT NULL` (exclude staged from display).
- `deleteStaleStagedAttachments(olderThanHours = 24)` — `DELETE … WHERE note_index IS NULL AND created_at <
  now() - interval` (RETURNING storage_key) + best-effort S3 delete each. Returns count. (Cron.)
- `entityExistsInCompany(companyId, entityType, entityId)` — `SELECT 1 FROM {jobs|leads|contacts} WHERE
  id=$1 AND company_id=$2`. Used by the upload route for isolation.

### `routes/noteAttachments.js` (add) — mounted `authenticate, requireCompanyAccess` (existing)
- `POST /upload` — `multer.memoryStorage().array('attachments', MAX_FILES_PER_NOTE)`, body `entity_type`
  (`job|lead|contact`) + `entity_id`. Validates entity_type, `entityExistsInCompany` (else 404), then
  `stageAttachments`. Resp `{ ok, data: { attachments: [{id,fileName,contentType,fileSize}] } }`. Errors:
  400 (bad type/size/entity_type), 404 (entity not in company), 413-ish via 400 for too-large.
- (`GET /:id/url`, `DELETE /:id` already exist — DELETE is the rollback path.)

### Note create/edit routes — accept staged ids instead of raw bytes
- `jobs.js`, `leads.js`, `contacts.js` `POST /:id/notes`: read `attachment_ids` (JSON string field in the
  multipart form, OR `req.body.attachment_ids`). If present → `associateStagedAttachments(company,
  entityType, entityId, ids, noteId, noteIndex)` to build the note's `attachments`, instead of
  `createAttachments(files)`. **Keep the raw-files path** as a fallback (back-compat) when no `attachment_ids`.
- Edit: `notesMutationService.editNote` — accept `attachmentIds` and associate (stamp the note's `note_id`
  + index) when provided, else the existing `files` path. Routes' `PATCH /:id/notes/:noteId` forward
  `attachment_ids`.

### Cron
- Wire `deleteStaleStagedAttachments(24)` into the app scheduler (alongside the other interval schedulers in
  the server bootstrap), e.g. every 6h. Best-effort, logged.

## Frontend
### `services/noteAttachmentsApi.ts` (new)
- `uploadStagedAttachment(entityType, entityId, file)` → POST `/api/note-attachments/upload` (FormData, one
  file) → `{ id, fileName, contentType, fileSize }` (unwrap envelope; throw on !ok).
- `deleteStagedAttachment(id)` → `DELETE /api/note-attachments/:id`.

### `components/shared/NoteAttachmentInput.tsx` (rework)
- New props: `entityType`, `entityId`, and report state up. Internal item model:
  `{ key, file, status: 'uploading'|'done'|'error', id?: number, error?: string }`.
- On attach: validate size/type locally (reuse), then **immediately** `uploadStagedAttachment` each →
  status `uploading` (spinner on the chip) → `done` (store `id`) / `error` (show ⚠ + retry).
- Remove (×): if `id` present → `deleteStagedAttachment(id)` (best-effort); drop the item.
- Expose via `onChange`: the list of uploaded ids + an `uploading` boolean (any item still uploading or in
  error). Parent uses these to gate submit and to send `attachment_ids`.
- Cap MAX_FILES (5) preserved.

### `components/shared/NotesSection.tsx`
- Pass `entityType`/`entityId` to `NoteAttachmentInput`. Track `attachmentIds` + `attachmentsUploading`.
- `handleSubmit` (new note): require `text || attachmentIds.length`; **disabled while
  `attachmentsUploading`**; POST `text` + `attachment_ids` (JSON) instead of raw files. On success reset.
- `saveEdit` (edit): same — send `attachment_ids`, gate Save on uploading.
- Submit button shows a subtle "Uploading…" affordance (disabled) when attachments are in flight.

## Edge cases
- Upload fails → item `error`, submit stays disabled until it's removed or retried succeeds.
- User removes a still-uploading file → cancel/ignore the in-flight result; if it already got an id, delete it.
- Abandon composer (close card / navigate) → staged rows linger → cron sweep deletes them (≥24h). (Explicit
  remove deletes immediately.)
- Submit with a file still uploading → impossible (button disabled).
- Cross-tenant/foreign staged id at associate → ignored (WHERE company_id+entity+note_index IS NULL).
- Edit: removing a surviving committed attachment still uses the existing `remove_attachment_ids` path.
- Back-compat: if `attachment_ids` absent, the route still accepts raw `attachments[]` (old clients / ZB).

## Security / multi-tenant
Upload route: `entityExistsInCompany` (company-scoped) → foreign entity 404. associate/delete/url all filter
`company_id`. Staged rows are company+entity scoped. `uploaded_by = req.user.crmUser.id`.

## Verify
Backend Jest: stage → returns id + row has `note_index NULL`; associate sets note_id/index + ignores
foreign ids; getAttachmentsForEntity excludes staged; deleteStaleStaged removes only old staged; upload
route 404 on foreign entity, 400 on bad type. Frontend: `npm run build` + dev-preview (attach → spinner →
done; submit disabled while uploading; remove deletes staged).
