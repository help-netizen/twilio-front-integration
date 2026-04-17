# EMAIL-001: Gmail Shared Mailbox + Email Workspace — Functional Spec

## Overview

`EMAIL-001` adds:
- `/settings/email` for connecting one shared Gmail / Google Workspace mailbox per company
- `/email` as a dedicated operator workspace for reading, searching, composing, and replying to customer email threads

This is a Front-inspired inbox workflow, but the v1 slice is intentionally limited to:
- connect mailbox
- receive inbound email
- send new email
- reply in-thread
- thread list + thread detail
- search
- attachments

Out of scope in this spec:
- personal mailboxes
- delegated access
- assignment / comments / shared drafts
- snooze/later/done workflow
- merging email into `Pulse`

---

## Workspace Model

### `/settings/email`

Admin settings page for mailbox lifecycle:
- current status
- connect Gmail
- reconnect
- manual sync
- disconnect

### `/email`

Three-pane workspace:
- left rail: connected mailbox identity + system views
- middle pane: searchable thread list
- right pane: thread detail + composer/reply area

System views in v1:
- `Inbox`
- `All`
- `Sent`
- `Unread`
- `With attachments`

These views are derived from local synced data and do not require Gmail label management in v1.

---

## Behavior Scenarios

### B-01: Settings page bootstrap

- Opening `/settings/email` loads current mailbox status for the active company.
- If no mailbox exists, the page shows:
  - `Not connected`
  - explanation that Blanc supports one shared Gmail mailbox per company
  - primary CTA: `Connect Gmail`
- If a mailbox exists, the page shows:
  - connected email address
  - provider badge `Gmail`
  - last sync time
  - current state: `Connected`, `Reconnect required`, `Sync error`, or `Disconnected`

### B-02: Start Gmail connect flow

- Clicking `Connect Gmail` calls the backend to obtain an OAuth URL.
- The frontend redirects the browser to Google consent.
- The user does not manually copy/paste tokens.
- If the company already has a disconnected Gmail mailbox row, reconnect reuses the same mailbox record instead of creating a second mailbox.

### B-03: OAuth callback success / failure

- On successful callback, backend redirects the user back to `/settings/email?connected=1`.
- On failure, backend redirects to `/settings/email?error=...`.
- The settings page must render a user-readable error state rather than a blank page.

### B-04: `/email` bootstrap with no connected mailbox

- If the user opens `/email` without a connected mailbox:
  - thread list does not render a fake inbox
  - page shows an empty state
  - CTA points to `/settings/email`
- If the user lacks `tenant.integrations.manage`, the CTA is replaced with informational text only.

### B-05: `/email` bootstrap with connected mailbox

- `/email` loads:
  - mailbox status
  - current system view
  - first page of threads
- Default view: `Inbox`
- Thread list is ordered by latest activity descending.
- The page must not fetch full message histories for all visible threads.

### B-06: Left rail view switching

- Clicking a left rail system view updates the thread list query without leaving the page.
- View semantics:
  - `Inbox`: all inbound-capable threads except pure sent-only drafts/history placeholders
  - `All`: all synced threads
  - `Sent`: threads where the latest visible activity is outbound or thread contains outbound mail
  - `Unread`: threads with `unread_count > 0`
  - `With attachments`: threads with at least one attachment in any message
- Active view state is visually highlighted.

### B-07: Thread row rendering

- Each thread row shows:
  - primary sender / counterpart
  - subject
  - snippet preview
  - last activity time
  - unread badge when `unread_count > 0`
  - attachment icon when `has_attachments = true`
- Rows are selectable.
- Selected row remains highlighted while the thread is open.

### B-08: Open thread and mark read

- Clicking a thread opens thread detail in the right pane.
- Messages render in chronological order oldest → newest.
- Opening a thread with unread messages marks it read in Blanc local state.
- Mark-read must update both:
  - thread detail state
  - corresponding thread row unread badge

### B-09: Thread detail rendering

- Each message card shows:
  - direction (`inbound` / `outbound`)
  - sender display name/email
  - `To` and `CC`
  - timestamp in company timezone
  - body content
  - attachments
- HTML body may be rendered in a safe container; if HTML is unavailable, text body is shown.
- Empty thread pane state appears when no thread is selected.

### B-10: Compose new email

- Clicking `Compose` opens composer in new-message mode.
- Required fields:
  - at least one `To` recipient
  - `Subject`
  - body text or at least one attachment
- Optional:
  - `CC`
  - attachments/images
- On success:
  - composer resets/closes
  - thread list refreshes
  - sent thread becomes selected

### B-11: Reply to existing thread

- Reply opens composer in thread context.
- Reply inherits thread subject semantics from Gmail.
- `To` defaults to thread counterpart(s); `CC` may be edited.
- Successful reply stays inside the current thread and appears at the bottom of the thread pane.

### B-12: Search

- Search box filters the current mailbox scope server-side.
- Search fields in v1:
  - sender email/name
  - recipient email
  - CC email
  - subject
  - message body text
  - attachment filename metadata
- Search returns matching threads, not detached individual messages.
- Clearing search restores the current system view list.

### B-13: Attachments

- Attachments can be added in compose/reply via file picker.
- Incoming and outgoing attachments render as chips/cards under the owning message.
- Download/open action goes through backend proxy.
- Image attachments may open in the existing fullscreen image viewer when the UI classifies them as previewable.

### B-14: Manual sync

- Settings page and `/email` rail may expose a `Sync now` action.
- While sync is running, the UI shows a non-blocking loading state.
- Manual sync does not wipe the current thread selection.

### B-15: Reconnect required state

- If Gmail token refresh fails or OAuth grant is revoked:
  - mailbox status becomes `Reconnect required`
  - thread history remains visible read-only
  - send/reply actions are disabled
  - reconnect CTA appears in both `/settings/email` and `/email`

---

## API Contracts

### Settings

#### `GET /api/settings/email`

Returns:

```json
{
  "ok": true,
  "data": {
    "mailbox": {
      "provider": "gmail",
      "email_address": "support@company.com",
      "status": "connected",
      "last_synced_at": "2026-04-17T14:20:00Z",
      "last_sync_status": "ok",
      "last_sync_error": null
    }
  }
}
```

#### `POST /api/settings/email/google/start`

Returns:

```json
{
  "ok": true,
  "data": {
    "auth_url": "https://accounts.google.com/o/oauth2/..."
  }
}
```

#### `POST /api/settings/email/disconnect`

- Marks mailbox `disconnected`
- Revokes further sync/send until reconnect

#### `POST /api/settings/email/sync`

- Triggers immediate sync
- Returns mailbox state + sync status payload

### Workspace

#### `GET /api/email/mailbox`

Returns non-secret mailbox state required by `/email`:
- connected email address
- current mailbox status
- sync health summary

#### `GET /api/email/threads`

Query params:
- `view`
- `q`
- `cursor`
- `limit`

Response:

```json
{
  "ok": true,
  "data": {
    "threads": [
      {
        "id": 101,
        "subject": "Estimate follow-up",
        "participants": [{"name":"Jane Doe","email":"jane@example.com"}],
        "last_message_preview": "Thanks, can you also send...",
        "last_message_at": "2026-04-17T13:30:00Z",
        "last_message_direction": "inbound",
        "unread_count": 1,
        "has_attachments": true
      }
    ],
    "next_cursor": "2026-04-17T13:30:00Z::101"
  }
}
```

#### `GET /api/email/threads/:threadId`

Returns full thread:
- thread metadata
- messages
- attachments per message

#### `POST /api/email/threads/:threadId/read`

- idempotent
- sets `unread_count = 0`

#### `POST /api/email/threads/compose`

`multipart/form-data`:
- `to[]`
- `cc[]`
- `subject`
- `body`
- `files[]`

#### `POST /api/email/threads/:threadId/reply`

`multipart/form-data`:
- `to[]` optional override
- `cc[]`
- `body`
- `files[]`

#### `GET /api/email/attachments/:attachmentId/download`

- streams attachment through backend
- validates tenant scope before proxying

---

## Edge Cases

1. **Initial sync not finished yet**
   - `/email` shows a loading/empty placeholder with sync progress copy, not a broken inbox.

2. **History gap in Gmail**
   - If stored `historyId` becomes invalid, backend marks mailbox `backfill_required` and reruns bounded backfill.

3. **Duplicate Gmail events**
   - Upserts by provider ids must keep sync idempotent.

4. **Missing HTML body**
   - Fallback to text body.

5. **Missing text body**
   - Safe-render HTML body and preserve download access to attachments.

6. **Attachment too large for Gmail**
   - Backend returns validation error before send completes; composer remains open.

7. **User without send permission**
   - `/email` can still render thread list/detail if read permission exists, but compose/reply controls stay disabled/hidden.

8. **Mailbox disconnected after data already synced**
   - Existing local data remains browsable unless product explicitly purges it later.

9. **No threads in current view**
   - Empty state is scoped to the selected view or search, not shown as a global mailbox error.

10. **Search + selected thread**
   - If current thread no longer matches search/view filter, detail pane remains open until user changes selection.
