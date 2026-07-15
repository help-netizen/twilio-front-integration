# FINANCE-PANEL-FIXES-001 — two Job → Finance panel bugs

**Area:** frontend only. **Backend:** no change (PDF routes correctly require auth).

---

## Bug A — ESTIMATE-APPROVE-STAY: keep the estimate panel open after "Approved"

**Now:** In `frontend/src/components/jobs/JobFinancialsTab.tsx` the estimate `onApprove`
handler closes the panel:
```tsx
await approveEstimate(selectedEstimate.id);
toast.success('Estimate approved');
refresh();
setSelectedEstimate(null);   // ← closes the panel
```
So after marking an estimate Approved the user must REOPEN it to click **Create Invoice**.

**Facts:**
- `approveEstimate(id): Promise<Estimate>` returns the UPDATED estimate (status → approved).
- `EstimateDetailPanel` syncs its internal estimate from the `estimate` prop
  (`useEffect(() => setEstimate(initialEstimate), [initialEstimate])`).
- It renders **Create Invoice** when `estimate.status === 'approved' && !estimate.invoice_id`.

**Fix:** keep the panel open and feed it the approved estimate so Create Invoice appears:
```tsx
const updated = await approveEstimate(selectedEstimate.id);
toast.success('Estimate approved');
refresh();
setSelectedEstimate(updated);   // panel stays open, now shows Approved + Create Invoice
```
- Leave `onDecline` unchanged (declining still closes — nothing more to do on a declined estimate).

**Acceptance:**
1. Clicking **Approved** keeps the estimate panel open; its status flips to Approved and the
   **Create Invoice** button is immediately clickable (one click, no reopen).
2. The financials list behind the panel still refreshes.
3. Decline behaviour unchanged.

---

## Bug B — INVOICE-PDF-AUTH (+ estimate PDF): Preview PDF opens the API URL without the Bearer token → 401

**Now:** both open the raw API URL in a new tab, which sends NO `Authorization` header →
the route (`requirePermission('invoices.view' / 'estimates.view')`) returns
`{"code":"AUTH_REQUIRED","message":"Bearer token required"}`:
- `InvoiceDetailPanel` (~line 725): `window.open('/api/invoices/${invoice.id}/pdf', '_blank', …)`
- `EstimateDetailPanel` (~line 542): `window.open('/api/estimates/${estimate.id}/pdf', '_blank', …)`

**Fix:** add ONE shared helper that fetches the PDF WITH auth and opens the resulting blob.
`authedFetch` (frontend/src/services/apiClient.ts) attaches the Bearer token; blob→objectURL
pattern already used in `frontend/src/services/priceBookApi.ts:93-94`.

- New helper, e.g. `frontend/src/lib/openAuthedPdf.ts`:
  `export async function openAuthedPdf(url: string): Promise<void>` — authedFetch(url) →
  if `!res.ok` throw → `res.blob()` → `URL.createObjectURL(blob)` → open in a new tab →
  `setTimeout(() => URL.revokeObjectURL(objUrl), 60_000)`.
- **Popup-blocker-safe:** open the tab **synchronously inside the click handler BEFORE the
  await** (a `window.open()` after an `await` is outside the user-gesture stack and gets
  blocked). Pattern: `const w = window.open('', '_blank')` first (do NOT pass `noopener` —
  that returns null and you lose the handle), then after the blob is ready set
  `w.location.href = objUrl` (fallback to `window.open(objUrl)` if `w` is null). Close `w` on
  error.
- Wire BOTH Preview PDF buttons to it, each wrapped so a failure toasts (e.g. "Could not open
  PDF") instead of throwing:
  `onClick={() => { openAuthedPdf('/api/invoices/${invoice.id}/pdf').catch(() => toast.error('Could not open the PDF')); }}`
  and the estimate equivalent.

**Acceptance:**
1. Preview PDF on an **invoice** opens the rendered PDF in a new tab — no AUTH_REQUIRED.
2. Preview PDF on an **estimate** (same bug) also opens correctly.
3. A failed fetch shows an error toast, not an unhandled rejection / blank AUTH_REQUIRED page.

---

## Out of scope
- Backend PDF routes (auth is correct — the bug is purely how the frontend fetches).
- Any other finance behaviour.

## Verify
- `cd frontend && npm run build` (tsc -b strict + vite build → exit 0).
- No jest harness exists for these panels → no jest required; a tiny unit test for
  `openAuthedPdf` (mock authedFetch + window.open) is welcome if trivial. State what you did.
