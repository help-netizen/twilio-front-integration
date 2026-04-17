# EMAIL-001: Gmail Shared Mailbox + Email Workspace — Test Cases

## Backend

### TC-EMAIL-001: Mailbox status is company-scoped (P0)
- **Type:** Integration
- **Verify:** `GET /api/settings/email` returns only the mailbox for `req.companyFilter?.company_id`
- **Files:** `backend/src/routes/email-settings.js`, `backend/src/db/emailQueries.js`

### TC-EMAIL-002: Google connect start requires integrations permission (P0)
- **Type:** Route / Auth
- **Verify:** `POST /api/settings/email/google/start` rejects unauthorized users and returns an auth URL for authorized admins
- **Files:** `src/server.js`, `backend/src/routes/email-settings.js`

### TC-EMAIL-003: OAuth callback persists encrypted mailbox credentials (P0)
- **Type:** Integration
- **Verify:** callback exchanges code, stores encrypted tokens, updates mailbox status to `connected`, and does not expose tokens in response payload
- **Files:** `backend/src/routes/email-oauth.js`, `backend/src/services/emailMailboxService.js`

### TC-EMAIL-004: Initial backfill creates local threads/messages/attachments (P0)
- **Type:** Service
- **Verify:** first sync imports Gmail thread/message hierarchy into `email_threads`, `email_messages`, `email_attachments`
- **Files:** `backend/src/services/emailSyncService.js`, `backend/src/db/emailQueries.js`

### TC-EMAIL-005: Incremental history sync is idempotent (P0)
- **Type:** Service
- **Verify:** replaying the same Gmail history/message payload does not create duplicate local rows
- **Files:** `backend/src/services/emailSyncService.js`, `backend/src/db/emailQueries.js`

### TC-EMAIL-006: Thread list filters by view and search query (P0)
- **Type:** Route / Query
- **Verify:** `GET /api/email/threads` respects `view`, `q`, `cursor`, `limit` and sorts by latest activity
- **Files:** `backend/src/routes/email.js`, `backend/src/db/emailQueries.js`

### TC-EMAIL-007: Thread detail marks read via explicit endpoint (P0)
- **Type:** Route / Query
- **Verify:** `POST /api/email/threads/:threadId/read` zeroes unread count only for the current company thread
- **Files:** `backend/src/routes/email.js`, `backend/src/db/emailQueries.js`

### TC-EMAIL-008: Compose creates a new Gmail thread and local records (P0)
- **Type:** Integration
- **Verify:** compose sends from the connected mailbox, hydrates the sent Gmail message, and returns refreshed local thread detail
- **Files:** `backend/src/routes/email.js`, `backend/src/services/emailService.js`

### TC-EMAIL-009: Reply stays inside the same thread (P0)
- **Type:** Integration
- **Verify:** reply endpoint preserves Gmail thread linkage and appends outbound message to existing local thread
- **Files:** `backend/src/routes/email.js`, `backend/src/services/emailService.js`

### TC-EMAIL-010: Attachment download is tenant-safe (P0)
- **Type:** Route / Security
- **Verify:** `GET /api/email/attachments/:attachmentId/download` rejects attachments from another company with 404
- **Files:** `backend/src/routes/email.js`, `backend/src/services/emailService.js`

### TC-EMAIL-011: Reconnect-required mailbox disables send/reply (P0)
- **Type:** Integration
- **Verify:** compose/reply endpoints return conflict when mailbox status is `reconnect_required`
- **Files:** `backend/src/routes/email.js`, `backend/src/services/emailMailboxService.js`

### TC-EMAIL-012: Search covers sender, recipients, CC, subject, body, attachment filename (P0)
- **Type:** Query
- **Verify:** each supported search field can return the owning thread
- **Files:** `backend/src/db/emailQueries.js`

### TC-EMAIL-013: Manual sync updates mailbox sync status (P1)
- **Type:** Route / Service
- **Verify:** `POST /api/settings/email/sync` transitions status through running → ok/error and updates timestamps
- **Files:** `backend/src/routes/email-settings.js`, `backend/src/services/emailSyncService.js`

### TC-EMAIL-014: History gap triggers bounded backfill path (P1)
- **Type:** Service
- **Verify:** invalid Gmail `historyId` does not crash sync; mailbox enters backfill-required/recovery flow
- **Files:** `backend/src/services/emailSyncService.js`

### TC-EMAIL-015: Existing SMS/Pulse routes are unaffected (P1)
- **Type:** Regression
- **Verify:** `/api/messaging` and `/api/pulse` continue to work without reading/writing email tables
- **Files:** `backend/src/routes/messaging.js`, `backend/src/routes/pulse.js`

## Frontend

### TC-EMAIL-016: `/settings/email` route requires integrations permission (P0)
- **Type:** Route / Component
- **Verify:** protected route denies access without `tenant.integrations.manage`
- **Files:** `frontend/src/App.tsx`, `frontend/src/pages/EmailSettingsPage.tsx`

### TC-EMAIL-017: `/email` route requires internal message read permission (P0)
- **Type:** Route / Component
- **Verify:** protected route denies access without `messages.view_internal`
- **Files:** `frontend/src/App.tsx`, `frontend/src/pages/EmailPage.tsx`

### TC-EMAIL-018: No-mailbox empty state links to Settings (P0)
- **Type:** Component
- **Verify:** `/email` renders empty state with CTA to `/settings/email` when mailbox is not connected
- **Files:** `frontend/src/pages/EmailPage.tsx`

### TC-EMAIL-019: Thread list renders unread and attachment indicators (P0)
- **Type:** Component
- **Verify:** thread rows show unread badge, attachment icon, sender, subject, preview, timestamp
- **Files:** `frontend/src/components/email/EmailThreadList.tsx`, `frontend/src/components/email/EmailThreadRow.tsx`

### TC-EMAIL-020: Opening a thread updates selected row and clears unread state (P0)
- **Type:** Component / Query
- **Verify:** selecting a thread loads detail pane and reflects the read mutation in list state
- **Files:** `frontend/src/pages/EmailPage.tsx`, `frontend/src/components/email/EmailThreadPane.tsx`

### TC-EMAIL-021: Compose form validates To/Subject/body-or-attachment (P0)
- **Type:** Component
- **Verify:** composer blocks invalid submit and preserves entered values on backend error
- **Files:** `frontend/src/components/email/EmailComposer.tsx`

### TC-EMAIL-022: Reply mode keeps current thread context (P0)
- **Type:** Component
- **Verify:** reply action opens composer bound to the selected thread and appends the sent message after mutation success
- **Files:** `frontend/src/components/email/EmailThreadPane.tsx`, `frontend/src/components/email/EmailComposer.tsx`

### TC-EMAIL-023: Search query is server-driven (P0)
- **Type:** Component / Query
- **Verify:** entering a search query triggers a remote request rather than local-only filtering
- **Files:** `frontend/src/pages/EmailPage.tsx`, `frontend/src/services/emailApi.ts`

### TC-EMAIL-024: Reconnect-required state disables compose actions (P1)
- **Type:** Component
- **Verify:** mailbox warning appears and send/reply controls are disabled when mailbox status is `reconnect_required`
- **Files:** `frontend/src/pages/EmailPage.tsx`, `frontend/src/pages/EmailSettingsPage.tsx`

### TC-EMAIL-025: Manual sync action is non-blocking (P1)
- **Type:** Component
- **Verify:** clicking `Sync now` shows loading feedback without dropping current thread selection
- **Files:** `frontend/src/pages/EmailPage.tsx`, `frontend/src/pages/EmailSettingsPage.tsx`

### TC-EMAIL-026: Settings dropdown contains Email but top nav does not (P1)
- **Type:** Navigation / Visual
- **Verify:** `Email` is accessible from Settings menu only; no new top-level tab is added
- **Files:** `frontend/src/components/layout/appLayoutNavigation.tsx`

### TC-EMAIL-027: Image attachments open in existing viewer when previewable (P2)
- **Type:** Component / Visual
- **Verify:** previewable image attachments can open in fullscreen viewer without a custom lightbox implementation
- **Files:** `frontend/src/components/email/EmailMessageItem.tsx`, `frontend/src/components/shared/FullscreenImageViewer.tsx`

### TC-EMAIL-028: Workspace mailbox state is readable without integrations-manage permission (P1)
- **Type:** Route / Auth
- **Verify:** `GET /api/email/mailbox` is available to users with `messages.view_internal` and does not expose admin-only connect controls or secret token data
- **Files:** `backend/src/routes/email.js`, `frontend/src/pages/EmailPage.tsx`
